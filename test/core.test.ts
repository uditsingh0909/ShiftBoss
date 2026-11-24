import { describe, expect, test } from 'bun:test';
import { healthOf, loopKeys, overlapsOf } from '../server/analysis';
import { Store } from '../server/db';
import { nameOf, parseAgentList } from '../server/herdr';
import { buildReport } from '../server/report';
import { parseFooter } from '../server/statusline';
import { applyLine, type TranscriptState } from '../server/transcripts';
import type { Session } from '../shared/types';

const mem = () => new Store('', ':memory:');
const session = (over: Partial<Session> = {}): Session => ({
  name: 's1', paneId: 'w5:p1', sessionId: 'x', status: 'working', cwd: 'C:\\work', model: 'claude-opus-5-5', contextTokens: 0, contextWindow: 1e6, contextPct: 20,
  tokensToday: 0, tokens5h: 0, lastActivity: new Date().toISOString(), lastTool: null, lines: [], heat: [], filesTouched: [], lane: '', slots: 2, handoffPath: null, handoffAgeMin: null, prUrls: [], ...over,
});

describe('store', () => {
  test('task ids count up and events are logged', () => {
    const s = mem();
    const a = s.addTask({ title: 'One' });
    const b = s.addTask({ title: 'Two', session: 'vdp' });
    expect(a.id).toBe('T-1');
    expect(b.id).toBe('T-2');
    expect(a.stage).toBe(0);
    expect(b.stage).toBe(1); // assigned on create = queued
    s.updateTask('T-1', { stage: 3 });
    expect(s.events('T-1')[0].text).toContain('PR open');
  });
  test('import is keyed on extId, so running it twice updates instead of duplicating', () => {
    const s = mem();
    const a = s.importTask({ extId: 'board:x', title: 'First', stage: 2 });
    const b = s.importTask({ extId: 'board:x', title: 'First, renamed', stage: 5 });
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
    expect(s.listTasks().length).toBe(1);
    expect(s.getTask(a.id)!.stage).toBe(5);
    expect(s.events(a.id)[0].text).toContain('Live');
  });
  test('a promise without a task gets one, and telling the requester keeps it', () => {
    const s = mem();
    const p = s.addPromise({ to: 'Sam', said: "I'll update here when it's live", where: '#platform' });
    expect(p.taskId).toBe('T-1');
    expect(s.getTask('T-1')!.title).toContain('Sam');
    const linked = s.addPromise({ to: 'Sam', said: 'Second one', taskId: 'T-1' });
    expect(linked.taskId).toBe('T-1');
    s.updateTask('T-1', { stage: 6 });
    expect(s.listPromises().every((x) => x.state === 'kept')).toBe(true);
  });
  test('promises made before the rule get a task on startup', () => {
    const s = mem();
    s.db.query("INSERT INTO promises (to_person, said, created_at) VALUES ('Ann', 'Will check', '2026-11-24T10:00:00Z')").run();
    expect(s.linkOrphanPromises()).toBe(1);
    expect(s.listPromises()[0].taskId).toBe('T-1');
    expect(s.linkOrphanPromises()).toBe(0);
  });
  test('stage outside 0-6 is refused', () => {
    const s = mem();
    s.addTask({ title: 'x' });
    expect(() => s.updateTask('T-1', { stage: 9 as any })).toThrow();
  });
  test('a need can only be answered once', () => {
    const s = mem();
    const n = s.addNeed({ kind: 'Decision', title: 'Restore?', answers: ['Yes', 'No'] });
    s.answerNeed(n.id, 'Yes');
    s.answerNeed(n.id, 'No');
    expect(s.listNeeds()[0].answer).toBe('Yes');
  });
  test('settings merge over defaults', () => {
    const s = mem();
    s.saveSettings({ ...s.settings(), thresholds: { ...s.settings().thresholds, warn: 60 } });
    expect(s.settings().thresholds.warn).toBe(60);
    expect(s.settings().thresholds.replace).toBe(85);
  });
});

describe('herdr', () => {
  test('keeps only claude panes in the workspace', () => {
    const json = JSON.stringify({ result: { agents: [
      { agent: 'claude', agent_status: 'idle', cwd: 'D:\\', focused: false, pane_id: 'w5:p1', terminal_title_stripped: 'vdp', workspace_id: 'w5' },
      { agent: 'claude', agent_status: 'idle', cwd: 'D:\\', focused: false, pane_id: 'w6:p1', terminal_title_stripped: 'other', workspace_id: 'w6' },
      { agent: 'shell', agent_status: 'idle', cwd: 'D:\\', focused: false, pane_id: 'w5:p2', workspace_id: 'w5' },
    ] } });
    const a = parseAgentList(json, 'w5');
    expect(a.map(nameOf)).toEqual(['vdp']);
    expect(parseAgentList(json, '').length).toBe(2);
    expect(nameOf({ ...a[0], name: 'intake', terminal_title_stripped: 'Rename intake' })).toBe('intake');
  });
});

describe('status line footer', () => {
  test('reads context, 5h and 7d', () => {
    const f = parseFooter('  someone@example.com | Opus 5.5 | ctx 16% | 5h 9% (4h 2m) | 7d 41% (3d 2h)')!;
    expect(f.ctxPct).toBe(16);
    expect(f.fiveHourPct).toBe(9);
    expect(f.weeklyPct).toBe(41);
    expect(f.model).toBe('Opus 5.5');
  });
  test('returns null when nothing matches', () => expect(parseFooter('hello')).toBeNull());
});

describe('transcripts', () => {
  const blank = (): TranscriptState => ({ path: '', offset: 0, partial: '', model: null, contextTokens: 0, usage: [], tools: [], lines: [], lastActivity: null, prUrls: [] });
  test('usage, tools, files and output lines', () => {
    const st = blank();
    const ts = new Date().toISOString();
    applyLine(st, JSON.stringify({ type: 'assistant', timestamp: ts, message: { model: 'claude-opus-5-5', usage: { input_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, output_tokens: 5 },
      content: [{ type: 'text', text: 'Fixing it' }, { type: 'tool_use', name: 'Edit', input: { file_path: 'D:\\a\\B.java' } }] } }));
    applyLine(st, JSON.stringify({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', content: 'ok done' }] } }));
    applyLine(st, 'not json');
    expect(st.model).toBe('claude-opus-5-5');
    expect(st.contextTokens).toBe(1012);
    expect(st.tools[0].files).toEqual(['D:\\a\\B.java']);
    expect(st.lines.map((l) => l.kind)).toEqual(['say', 'tool', 'out']);
  });
  test('sidechain usage does not move the context number', () => {
    const st = blank();
    applyLine(st, JSON.stringify({ type: 'assistant', isSidechain: true, timestamp: new Date().toISOString(), message: { usage: { input_tokens: 999999 }, content: [] } }));
    expect(st.contextTokens).toBe(0);
  });
});

describe('health and overlaps', () => {
  const nowMs = Date.now();
  const bash = (cmd: string, minsAgo: number) => ({ at: nowMs - minsAgo * 60e3, name: 'Bash', key: 'Bash:' + cmd, files: [] });
  test('three identical commands in a row is a loop', () => {
    expect(loopKeys([bash('mvn test', 9), bash('mvn test', 6), bash('mvn test', 3)], 3, nowMs).size).toBe(1);
    expect(loopKeys([bash('mvn test', 9), bash('ls', 6), bash('mvn test', 3)], 3, nowMs).size).toBe(0);
  });
  test('blocked pane is waiting; idle with queued work is stuck', () => {
    const settings = mem().settings();
    expect(healthOf(session({ status: 'blocked' }), [], [], settings).verdict).toBe('waiting');
    const old = new Date(nowMs - 40 * 60e3).toISOString();
    const task = { id: 'T-1', title: 't', ask: '', requester: '', source: '', sourceUrl: null, session: 's1', stage: 1 as const, prio: 'P2' as const, held: false, createdAt: old, updatedAt: old };
    expect(healthOf(session({ status: 'idle', lastActivity: old }), [], [task], settings).verdict).toBe('stuck');
    expect(healthOf(session({ contextPct: 90 }), [], [], settings).verdict).toBe('heavy');
  });
  test('same file and same migration number across sessions', () => {
    const o = overlapsOf([
      { name: 'a', files: ['D:\\r\\src\\SecurityConfig.java', 'D:\\r\\flyway\\V1.1009__one.sql'] },
      { name: 'b', files: ['d:/r/src/SecurityConfig.java', 'D:\\r\\flyway\\V1.1009__two.sql'] },
    ], []);
    expect(o.map((x) => x.kind).sort()).toEqual(['Same file', 'Same migration number']);
  });
});

describe('report', () => {
  test('plain report lists what went live today', () => {
    const s = mem();
    s.addTask({ title: 'Recordings back at the north store' });
    s.updateTask('T-1', { stage: 5 });
    const r = buildReport('plain', s.listTasks(), []);
    expect(r.text).toContain('Recordings back at the north store');
  });
});

describe('overlap ignore list', () => {
  test('shared memory and handoff files are not overlaps', () => {
    expect(overlapsOf([
      { name: 'a', files: ['C:\\Users\\u\\.claude\\projects\\x\\memory\\MEMORY.md', 'C:\\work\\handoffs\\lead.md'] },
      { name: 'b', files: ['C:/Users/u/.claude/projects/x/memory/MEMORY.md', 'C:/work/handoffs/lead.md'] },
    ], []).length).toBe(0);
  });
});

import { parsePrUrl, targetStage, taskIdsIn } from '../server/github';
import { resolveLead } from '../shared/types';
describe('lead session', () => {
  const s = (name: string) => ({ name });
  test('the newest replacement is the lead', () => {
    expect(resolveLead([s('lead-manager'), s('lead-manager-v2'), s('vdp')], 'lead-manager')?.name).toBe('lead-manager-v2');
    expect(resolveLead([s('lead-manager-v10'), s('lead-manager-v9')], 'lead-manager')?.name).toBe('lead-manager-v10');
    expect(resolveLead([s('lead-manager')], 'lead-manager')?.name).toBe('lead-manager');
  });
  test('other names never match', () => {
    expect(resolveLead([s('lead-manager-old'), s('my-lead-manager'), s('lead-manager-v2x')], 'lead-manager')).toBeNull();
    expect(resolveLead([s('lead-manager')], '')).toBeNull();
  });
});

describe('github auto-advance', () => {
  test('finds task ids in title, body and branch', () => {
    expect(taskIdsIn('fix(analytics): name screens (T-74)\nShiftBoss: t-75\nfeat/t76-chat')).toEqual(['T-74', 'T-75', 'T-76']);
    expect(taskIdsIn('UTF-8 and DT-12 are not tasks')).toEqual([]);
  });
  test('parses PR links', () => {
    expect(parsePrUrl('https://github.com/acme/api/pull/3376')).toEqual({ repo: 'acme/api', number: 3376 });
    expect(parsePrUrl('https://example.com/x')).toBeNull();
  });
  test('stage from PR state and deploys, never told', () => {
    expect(targetStage({ state: 'OPEN' }, false, false)).toBe(3);
    expect(targetStage({ state: 'MERGED' }, false, false)).toBe(3);
    expect(targetStage({ state: 'MERGED' }, true, false)).toBe(4);
    expect(targetStage({ state: 'MERGED' }, true, true)).toBe(5);
    expect(targetStage({ state: 'CLOSED' }, false, false)).toBeNull();
  });
});
