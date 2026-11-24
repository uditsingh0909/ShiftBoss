import { describe, expect, test } from 'bun:test';
import { healthOf, loopKeys, overlapsOf } from '../server/analysis';
import { Store } from '../server/db';
import { nameOf, parseAgentList } from '../server/herdr';
import { onboardingPrompt } from '../server/onboarding';
import { buildReport } from '../server/report';
import { parseFooter } from '../server/statusline';
import { applyLine, type TranscriptState } from '../server/transcripts';
import type { Session } from '../shared/types';
import { baseName, checkSpawnMany, HANDOFF_MARKER, HANDOFF_SECTIONS, handoffCheck, handoffPathFor, handoffRequest, modelArg, nextReplacementName, replacementPrompt } from '../server/fleet';
import { tmpdir } from 'node:os';

const mem = () => new Store('', ':memory:');
const session = (over: Partial<Session> = {}): Session => ({
  name: 's1', paneId: 'w5:p1', sessionId: 'x', status: 'working', cwd: 'C:\\work', model: 'claude-opus-5-5', contextTokens: 0, contextWindow: 1e6, contextPct: 20,
  tokensToday: 0, tokens5h: 0, lastActivity: new Date().toISOString(), lastTool: null, lines: [], heat: [], filesTouched: [], lane: '', slots: 2, handoffPath: null, handoffAgeMin: null, prUrls: [], usesShiftbossTools: false, exactUsage: false, ...over,
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
  test('intake pause, catch-up resume and checkpoint', () => {
    const s = mem();
    const t1 = new Date(Date.now() - 3 * 3600e3).toISOString();
    const t3 = new Date(Date.now() - 3600e3).toISOString();
    s.intakeCheckpoint(t1);
    expect(s.intakeState().since).toBe(t1);
    s.pauseIntake(null);
    expect(s.intakeBegin().paused).toBe(true);
    const caught = s.resumeIntake(true);
    expect(caught.paused).toBe(false);
    expect(caught.since).toBe(t1); // reads the gap
    expect(caught.catchUpFrom).toBe(t1);
    s.intakeCheckpoint(t3);
    expect(s.intakeState().catchUpFrom).toBeNull();
    s.pauseIntake(null);
    const skipped = s.resumeIntake(false);
    expect(Date.parse(skipped.since!)).toBeGreaterThan(Date.parse(t3)); // gap skipped
    expect(() => s.pauseIntake('2000-01-01T00:00:00Z')).toThrow();
    expect(() => s.intakeCheckpoint('not a time')).toThrow();
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
  test('open auto needs are listed until answered', () => {
    const s = mem();
    const n = s.addNeed({ kind: 'Permission', title: 'x is waiting', answers: ['Open in herdr'], session: 'x', auto: true });
    s.addNeed({ kind: 'Decision', title: 'Restore?', answers: ['Yes'] });
    expect(s.openAutoNeeds().map((x) => x.id)).toEqual([n.id]);
    s.answerNeed(n.id, 'Session closed');
    expect(s.openAutoNeeds()).toEqual([]);
  });
  test('onboarding backfill sends the intake back and unpauses it', () => {
    const s = mem();
    s.pauseIntake(null);
    const from = new Date(Date.now() - 3 * 864e5).toISOString();
    const st = s.backfillIntake(from);
    expect(st.paused).toBe(false);
    expect(st.since).toBe(from);
    expect(st.catchUpFrom).toBe(from);
    expect(s.onboarding().backfillFrom).toBe(from);
    expect(() => s.backfillIntake(new Date(Date.now() + 864e5).toISOString())).toThrow();
    expect(() => s.backfillIntake(new Date(Date.now() - 40 * 864e5).toISOString())).toThrow();
    s.saveOnboarding({ asked: { a: from } });
    expect(s.onboarding()).toMatchObject({ asked: { a: from }, backfillFrom: from, doneAt: null });
  });
  test('the onboarding prompt names the session and changes nothing else', () => {
    const t = onboardingPrompt('Sam', 'billing-fix', 'C:/x/shiftboss');
    expect(t).toContain('session "billing-fix"');
    expect(t).toContain('Do not change');
    expect(t).toContain('C:/x/shiftboss/cli/shiftboss.ts');
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

describe('fleet: start many', () => {
  const dir = tmpdir();
  test('every row is checked like a single spawn, before any starts', () => {
    const ok = checkSpawnMany([{ name: 'fix-1', cwd: dir, model: 'opus', prompt: ' go ' }, { name: 'fix-2', cwd: dir }], ['lead']);
    expect(ok).toEqual([{ name: 'fix-1', cwd: dir, model: 'opus', prompt: 'go' }, { name: 'fix-2', cwd: dir, model: null, prompt: null }]);
    expect(() => checkSpawnMany([{ name: 'a b', cwd: dir }], [])).toThrow('letters, digits');
    expect(() => checkSpawnMany([{ name: 'lead', cwd: dir }], ['lead'])).toThrow('already running');
    expect(() => checkSpawnMany([{ name: 'x1', cwd: dir }, { name: 'x1', cwd: dir }], [])).toThrow('listed twice');
    expect(() => checkSpawnMany([{ name: 'x1', cwd: dir + '/no-such-folder-here' }], [])).toThrow('does not exist');
    expect(() => checkSpawnMany([{ name: 'x1', cwd: dir, model: 'gpt' }], [])).toThrow('unknown model');
    expect(() => checkSpawnMany([], [])).toThrow('at least one');
    expect(() => checkSpawnMany(Array.from({ length: 21 }, (_, i) => ({ name: 'n' + i, cwd: dir })), [])).toThrow('At most 20');
  });
});

describe('fleet: replace', () => {
  test('next free -vN name', () => {
    expect(baseName('lead-v3')).toBe('lead');
    expect(baseName('billing')).toBe('billing');
    expect(nextReplacementName('billing', ['billing', 'other'])).toBe('billing-v2');
    expect(nextReplacementName('billing-v2', ['billing-v2'])).toBe('billing-v3');
    expect(nextReplacementName('billing', ['billing', 'billing-v2', 'billing-v4'])).toBe('billing-v5');
    expect(nextReplacementName('billing', ['billing', 'billing-api-v9'])).toBe('billing-v2'); // another base
    expect(nextReplacementName('a'.repeat(40), []).length).toBeLessThanOrEqual(40);
  });
  test('model: exact id when known, else the family', () => {
    expect(modelArg('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(modelArg('Opus 4.5 (1M context)')).toBe('opus');
    expect(modelArg('something else')).toBeNull();
    expect(modelArg(null)).toBeNull();
  });
  test("handoff path: the session's own, else HANDOFF-<name>.md in its folder", () => {
    expect(handoffPathFor('s1', 'C:/work', 'C:/handoffs/s1.md')).toBe('C:/handoffs/s1.md');
    expect(handoffPathFor('s1', 'C:/work', null).replace(/\\/g, '/')).toBe('C:/work/HANDOFF-s1.md');
  });
  test('the handoff request names every section and the marker', () => {
    const t = handoffRequest('Sam', 's1', 'C:/h/s1.md');
    for (const h of HANDOFF_SECTIONS) expect(t).toContain('## ' + h);
    expect(t).toContain(HANDOFF_MARKER);
    expect(t).toContain('C:/h/s1.md');
  });
  test('a handoff is complete only with every heading and the final marker', () => {
    const full = HANDOFF_SECTIONS.map((h) => `## ${h}\nnone\n`).join('\n') + '\n' + HANDOFF_MARKER + '\n';
    expect(handoffCheck(full)).toEqual({ complete: true, missing: [] });
    expect(handoffCheck(full.replace('## Promises owed', '## Promises'))).toEqual({ complete: false, missing: ['Promises owed'] });
    expect(handoffCheck(full.replace(HANDOFF_MARKER, '')).missing).toEqual([HANDOFF_MARKER]);
    // The marker must be the last line: a file still being written is not complete.
    expect(handoffCheck(full + '\nmore notes').complete).toBe(false);
    expect(handoffCheck(full.replace(HANDOFF_MARKER, '**HANDOFF COMPLETE**')).complete).toBe(true);
    expect(handoffCheck('').missing.length).toBe(HANDOFF_SECTIONS.length + 1);
  });
  test('the replacement prompt points at the handoff, the transcript and my_tasks', () => {
    const t = replacementPrompt({ newName: 's1-v2', oldName: 's1', handoffPath: 'C:/h/s1.md', transcriptPath: 'C:/t/x.jsonl', shiftbossCli: 'C:/sb/cli/shiftboss.ts' });
    expect(t).toContain('C:/h/s1.md');
    expect(t).toContain('C:/t/x.jsonl');
    expect(t).toContain('my_tasks with session "s1-v2"');
  });
  test("store: rows, compare-and-set, and moving a session's state", () => {
    const s = mem();
    const r = s.addReplacement({ oldName: 's1', newName: 's1-v2', cwd: 'C:/work', model: 'opus', handoffPath: 'C:/h/s1.md', sessionId: 'abc', transcriptPath: null });
    expect(r.state).toBe('pending');
    expect(s.activeReplacementFor('s1')?.id).toBe(r.id);
    expect(s.claimReplacement(r.id, ['pending'], 'requested')).toBe(true);
    expect(s.claimReplacement(r.id, ['pending'], 'requested')).toBe(false); // only one caller wins
    s.updateReplacement(r.id, { missing: ['Next steps'] });
    expect(s.getReplacement(r.id)!.missing).toEqual(['Next steps']);
    s.setMeta('s1', { lane: 'billing', slots: 3 });
    const open = s.addTask({ title: 'Open', session: 's1' });
    const told = s.addTask({ title: 'Told', session: 's1' });
    s.updateTask(told.id, { stage: 6 });
    const other = s.addTask({ title: 'Other', session: 's2' });
    const q = s.addNeed({ kind: 'Decision', title: 'Ship it?', answers: ['Yes', 'No'], session: 's1' });
    const moved = s.moveSessionState('s1', 's1-v2');
    expect(moved).toEqual({ tasks: [open.id], needs: 1 });
    expect(s.getTask(open.id)!.session).toBe('s1-v2');
    expect(s.getTask(told.id)!.session).toBe('s1'); // finished work stays as history
    expect(s.getTask(other.id)!.session).toBe('s2');
    expect(s.events(open.id)[0].text).toBe('Moved from s1 to s1-v2: s1 was replaced');
    expect(s.listNeeds().find((n) => n.id === q.id)!.session).toBe('s1-v2');
    expect(s.meta('s1-v2')).toEqual({ lane: 'billing', slots: 3, handoffPath: null });
    expect(s.moveSessionState('s1', 's1-v2').tasks).toEqual([]); // safe to run twice
    s.updateReplacement(r.id, { state: 'done' });
    expect(s.activeReplacementFor('s1')).toBeNull();
    expect(s.listReplacements().length).toBe(1); // finished today: still shown
  });
  test('the replacements table migration is safe to re-run', () => {
    const s = mem();
    (s as any).migrate();
    expect(s.listReplacements()).toEqual([]);
  });
});
