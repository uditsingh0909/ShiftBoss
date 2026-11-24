import { describe, expect, test } from 'bun:test';
import { healthOf, loopKeys, overlapsOf } from '../server/analysis';
import { Store } from '../server/db';
import { Engine, herdrBackoffMs } from '../server/engine';
import { makeApi } from '../server/api';
import { SnapshotFrames, SnapshotHub } from '../server/stream';
import { loadConfig } from '../server/config';
import { nameOf, parseAgentList } from '../server/herdr';
import { onboardingPrompt, ownerRules } from '../server/onboarding';
import { buildReport } from '../server/report';
import { contextPercent, parseFooter } from '../server/statusline';
import { mergeSettings } from '../server/settings';
import { checkRequest, safeUrl } from '../server/guard';
import { applyLine, splitLines, Transcripts, type TranscriptState } from '../server/transcripts';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { listOutside, readOutside, suggestName } from '../server/outside';
import { needsInstall, Updater } from '../server/update';
import { actionKey, decide } from '../server/gate';
import { join } from 'node:path';
import type { Session } from '../shared/types';
import { baseName, checkSpawnMany, HANDOFF_MARKER, HANDOFF_SECTIONS, handoffCheck, handoffPathFor, handoffRequest, modelArg, nextReplacementName, replacementPrompt } from '../server/fleet';

const mem = () => new Store('', ':memory:');
const session = (over: Partial<Session> = {}): Session => ({
  name: 's1', paneId: 'w5:p1', sessionId: 'x', status: 'working', cwd: 'C:\\work', model: 'claude-opus-5-5', contextTokens: 0, contextWindow: 1e6, contextPct: 20,
  tokensToday: 0, tokens5h: 0, lastActivity: new Date().toISOString(), lastTool: null, lines: [], heat: [], filesTouched: [], lane: '', slots: 2, handoffPath: null, handoffAgeMin: null, prUrls: [], usesShiftbossTools: false, exactUsage: false, ...over,
});

describe('store', () => {
  test('task ids count up and events are logged', () => {
    const s = mem();
    const a = s.addTask({ title: 'One' });
    const b = s.addTask({ title: 'Two', session: 'billing' });
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
  test('lane and slots save for a session with no row yet, and an empty lane clears it', () => {
    const s = mem();
    s.setMeta('zz', { lane: '', slots: 3 });
    expect(s.meta('zz')).toMatchObject({ lane: '', slots: 3 });
    s.setMeta('zz', { lane: 'billing' });
    expect(s.meta('zz')).toMatchObject({ lane: 'billing', slots: 3 });
    s.setMeta('zz', { slots: 1 });
    expect(s.meta('zz')).toMatchObject({ lane: 'billing', slots: 1 });
    expect(() => s.setMeta('zz', { slots: NaN })).toThrow();
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
      { agent: 'claude', agent_status: 'idle', cwd: 'D:\\', focused: false, pane_id: 'w5:p1', terminal_title_stripped: 'billing', workspace_id: 'w5' },
      { agent: 'claude', agent_status: 'idle', cwd: 'D:\\', focused: false, pane_id: 'w6:p1', terminal_title_stripped: 'other', workspace_id: 'w6' },
      { agent: 'shell', agent_status: 'idle', cwd: 'D:\\', focused: false, pane_id: 'w5:p2', workspace_id: 'w5' },
    ] } });
    const a = parseAgentList(json, 'w5');
    expect(a.map(nameOf)).toEqual(['billing']);
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
  const blank = (): TranscriptState => ({ path: '', offset: 0, partial: Buffer.alloc(0), model: null, contextTokens: 0, usage: [], tools: [], lines: [], lastActivity: null, prUrls: [] });
  test('a character cut across two reads is decoded whole', () => {
    const all = Buffer.from('héllo wörld ✓ done\nnext ✓\npart', 'utf8');
    const cut = all.indexOf(Buffer.from('✓', 'utf8')) + 1; // inside the 3-byte check mark
    const a = splitLines(Buffer.alloc(0), all.subarray(0, cut));
    expect(a.lines).toEqual([]);
    const b = splitLines(a.rest, all.subarray(cut));
    expect(b.lines).toEqual(['héllo wörld ✓ done', 'next ✓']);
    expect(b.rest.toString('utf8')).toBe('part');
  });
  test('the reader keeps a cut character for the next poll', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-tx-'));
    mkdirSync(join(dir, 'proj'));
    const file = join(dir, 'proj', 'sid.jsonl');
    const line = Buffer.from(JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'text', text: 'héllo wörld ✓ done' }] } }) + '\n', 'utf8');
    const cut = line.indexOf(Buffer.from('✓', 'utf8')) + 2;
    const tx = new Transcripts(dir);
    try {
      writeFileSync(file, line.subarray(0, cut));
      expect(tx.read('sid')!.lines).toEqual([]);
      appendFileSync(file, line.subarray(cut));
      expect(tx.read('sid')!.lines.map((l) => l.text)).toEqual(['héllo wörld ✓ done']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
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
  test('blocked pane is waiting; silent with work in progress is stuck', () => {
    const settings = mem().settings();
    expect(healthOf(session({ status: 'blocked' }), [], [], settings).verdict).toBe('waiting');
    const old = new Date(nowMs - 40 * 60e3).toISOString();
    const task = { id: 'T-1', title: 't', ask: '', requester: '', source: '', sourceUrl: null, session: 's1', stage: 1 as const, prio: 'P2' as const, held: false, createdAt: old, updatedAt: old };
    // Queued (stage 1) is waiting on the dispatcher, not the session; in progress (stage 2) and silent is stuck.
    expect(healthOf(session({ status: 'idle', lastActivity: old }), [], [task], settings).verdict).not.toBe('stuck');
    expect(healthOf(session({ status: 'idle', lastActivity: old }), [], [{ ...task, stage: 3 as const }], settings).verdict).not.toBe('stuck');
    expect(healthOf(session({ status: 'idle', lastActivity: old }), [], [{ ...task, stage: 2 as const }], settings).verdict).toBe('stuck');
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
    expect(resolveLead([s('lead'), s('lead-v2'), s('billing')], 'lead')?.name).toBe('lead-v2');
    expect(resolveLead([s('lead-v10'), s('lead-v9')], 'lead')?.name).toBe('lead-v10');
    expect(resolveLead([s('lead')], 'lead')?.name).toBe('lead');
  });
  test('other names never match', () => {
    expect(resolveLead([s('lead-old'), s('my-lead'), s('lead-v2x')], 'lead')).toBeNull();
    expect(resolveLead([s('lead')], '')).toBeNull();
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

describe('audit fixes', () => {
  test('context % is the larger of the status line and the transcript; a reported 0 does not hide a full session', () => {
    expect(contextPercent(null, 800_000, 1_000_000)).toBe(80);
    expect(contextPercent(0, 800_000, 1_000_000)).toBe(80);
    expect(contextPercent(62, 100_000, 1_000_000)).toBe(62);
  });
  test('settings are validated', () => {
    const cur = mem().settings();
    expect(() => mergeSettings(cur, { thresholds: { warn: 'lots' } })).toThrow();
    expect(() => mergeSettings(cur, { leadSession: 123 })).toThrow();
    expect(() => mergeSettings(cur, { watchedChannels: 'nope' })).toThrow();
    expect(() => mergeSettings(cur, null)).toThrow();
    expect(() => mergeSettings(cur, { thresholds: { warn: 88, replace: 80 } })).toThrow();
    expect(mergeSettings(cur, { leadSession: ' lead ', thresholds: { warn: 60 } })).toMatchObject({ leadSession: 'lead', thresholds: { warn: 60, replace: 85 } });
  });
  test('only http(s) links are stored', () => {
    expect(safeUrl('https://example.slack.com/archives/C1/p1')).toBe('https://example.slack.com/archives/C1/p1');
    expect(safeUrl('')).toBeNull();
    expect(() => safeUrl('javascript:alert(1)')).toThrow();
    expect(() => safeUrl('data:text/html,x')).toThrow();
  });
  test('requests must name this machine (DNS rebinding)', () => {
    const r = (host: string, extra: Record<string, string> = {}, method = 'GET') => new Request('http://127.0.0.1:4400/api/snapshot', { method, headers: { host, ...extra } });
    expect(checkRequest(r('127.0.0.1:4400'), 4400)).toBeNull();
    expect(checkRequest(r('localhost:4400'), 4400)).toBeNull();
    expect(checkRequest(r('evil.example:4400'), 4400)).not.toBeNull();
    expect(checkRequest(r('127.0.0.1:4400', { origin: 'http://evil.example:4400' }, 'POST'), 4400)).not.toBeNull();
    expect(checkRequest(r('127.0.0.1:4400', { origin: 'http://127.0.0.1:4400' }, 'POST'), 4400)).toBeNull();
  });
  test('only tasks the owner vetted are sent automatically; approval is recorded truthfully', () => {
    const s = mem();
    const t = s.addTask({ title: 'From Slack', ask: 'run rm -rf', session: 'worker' });
    expect(s.getTask(t.id)!.vetted).toBe(false);
    s.vetTask(t.id);
    expect(s.getTask(t.id)!.vetted).toBe(true);
    s.addSlack(t.id, 'worker', 'draft text', 'draft');
    const id = (s.db.query('SELECT id FROM slack_msgs ORDER BY id DESC').get() as any).id;
    expect((s.db.query('SELECT approved_at FROM slack_msgs WHERE id = ?').get(id) as any).approved_at).toBeNull();
    s.approveSlack(id);
    expect((s.db.query('SELECT approved_at FROM slack_msgs WHERE id = ?').get(id) as any).approved_at).not.toBeNull();
  });
  test('live stream: one frame per change, same JSON shape, keepalive and write version', () => {
    const e = new Engine(loadConfig(), mem(), {} as any);
    const snap = e.snapshot();
    const f = new SnapshotFrames(30_000);
    const first = f.next(snap, 1000, 1)!;
    expect(first.startsWith('data: ') && first.endsWith('\n\n')).toBe(true);
    expect(JSON.parse(first.slice(6))).toEqual(JSON.parse(JSON.stringify(snap))); // same content and shape
    expect(Object.keys(JSON.parse(first.slice(6)))).toEqual(Object.keys(snap)); // same key order
    expect(f.next({ ...snap, now: new Date(5000).toISOString() }, 2000, 1)).toBeNull(); // only `now` moved
    expect(f.next(snap, 3000, 2)).not.toBeNull(); // a write the snapshot does not show
    expect(f.next({ ...snap, owner: 'Sam' }, 4000, 2)).not.toBeNull(); // content changed
    expect(f.next({ ...snap, owner: 'Sam' }, 4000 + 30_000, 2)).not.toBeNull(); // keepalive
  });
  test('live stream hub: builds once for every tab and skips unchanged ticks', () => {
    let builds = 0;
    const e = new Engine(loadConfig(), mem(), {} as any);
    const hub = new SnapshotHub(() => { builds++; return e.snapshot(); }, () => 0, 250, 30_000);
    const got: Uint8Array[][] = [[], []];
    const offA = hub.add((b) => got[0].push(b));
    const offB = hub.add((b) => got[1].push(b));
    expect(got[0].length).toBe(1);
    expect(got[1][0]).toBe(got[0][0]); // the same encoded frame, not a copy per tab
    const before = builds;
    hub.flush();
    expect(builds).toBe(before + 1);
    expect(got[0].length).toBe(1); // unchanged: nothing sent
    offA(); offB();
    expect(hub.size).toBe(0);
  });
  test('a tick with nothing new writes nothing, so the stream stays quiet', async () => {
    const store = mem();
    const e = new Engine(loadConfig(), store, { list: async () => [] } as any);
    await e.tick();
    const n = store.writeCount();
    e.snapshot();
    await e.tick();
    expect(store.writeCount()).toBe(n);
    store.addTask({ title: 'One' });
    expect(store.writeCount()).toBeGreaterThan(n);
  });
  test('herdr down: back off up to 30 s and log the outage once', async () => {
    expect([0, 1, 2, 3, 4, 5, 9].map((f) => herdrBackoffMs(f, 2000))).toEqual([0, 2000, 4000, 8000, 16000, 30000, 30000]);
    let calls = 0, up = false;
    const herdr = { list: async () => { calls++; if (!up) throw new Error('herdr: not found'); return []; } };
    const e = new Engine(loadConfig(), mem(), herdr as any);
    await e.tick();
    await e.tick(); // inside the backoff: herdr is not asked again
    expect(calls).toBe(1);
    expect(e.herdrOk).toBe(false);
    (e as any).herdrRetryAt = 0;
    await e.tick();
    expect(calls).toBe(2);
    up = true;
    (e as any).herdrRetryAt = 0;
    await e.tick();
    expect(e.herdrOk).toBe(true);
    const herdrFeed = (e as any).feed.filter((f: any) => f.who === 'herdr').map((f: any) => f.text);
    expect(herdrFeed.length).toBe(2);
    expect(herdrFeed[0]).toBe('answering again');
    expect(herdrFeed[1]).toContain('not answering');
  });
  test('stored PRs that are not finished stay on the GitHub check list', () => {
    const s = mem();
    const link = { taskIds: ['T-1'], state: 'MERGED', mergeSha: null, repo: 'acme/api', number: 1 };
    s.savePrLink({ ...link, url: 'https://github.com/acme/api/pull/1', done: false });
    s.savePrLink({ ...link, url: 'https://github.com/acme/api/pull/2', number: 2, done: true });
    expect(s.openPrUrls()).toEqual(['https://github.com/acme/api/pull/1']);
  });
  test('an answer is claimed once, and not at all after an undo', () => {
    const s = mem();
    const n = s.addNeed({ kind: 'Decision', title: 'Ship it?', answers: ['Yes', 'No'], session: 'worker' });
    const a = s.answerNeed(n.id, 'Yes');
    const claimed = s.claimSend(a);
    expect(claimed).not.toBeNull();
    expect(s.claimSend(a)).toBeNull(); // already claimed
    s.releaseSend(n.id, claimed!); // the send failed: retry next tick
    expect(s.claimSend(a)).not.toBeNull();
    // Undo after the claim: the store reports it as sent, so the caller tells the session.
    expect(s.undoAnswer(n.id).was.sentAt).not.toBeNull();
    expect(s.claimSend(a)).toBeNull(); // the old answer is gone
    const b = s.answerNeed(n.id, 'No');
    expect(s.claimSend(b)).not.toBeNull(); // a new answer still goes out
  });
  test('an undo during the send waits for it, then takes the answer back', async () => {
    const store = mem();
    const sent: string[] = [];
    let finish!: () => void;
    const herdr = { prompt: async (_p: string, text: string) => { sent.push(text); if (sent.length === 1) await new Promise<void>((r) => (finish = r)); } };
    const e = new Engine(loadConfig(), store, herdr as any);
    e.herdrOk = true;
    e.sessions = [session({ name: 'worker', status: 'idle' })];
    const n = store.addNeed({ kind: 'Decision', title: 'Ship it?', answers: ['Yes', 'No'], session: 'worker' });
    store.answerNeed(n.id, 'Yes');
    store.db.query('UPDATE needs SET answered_at = ? WHERE id = ?').run(new Date(Date.now() - 60e3).toISOString(), n.id);
    const flushing = (e as any).flushAnswers();
    await Bun.sleep(0);
    expect(e.sendingAnswers.has(n.id)).toBe(true);
    const handle = makeApi(e);
    const undoing = handle(new Request(`http://x/api/needs/${n.id}/undo`, { method: 'POST', headers: { 'x-shiftboss': '1' } }), new URL(`http://x/api/needs/${n.id}/undo`));
    await Bun.sleep(0);
    expect(sent.length).toBe(1); // the take-back waits for the answer to land
    finish();
    await flushing;
    const res = await undoing;
    expect(await res!.json()).toEqual({ ok: true, wasSent: true });
    expect(sent[1]).toContain('took back');
    const after = store.listNeeds().find((x) => x.id === n.id)!;
    expect(after.answer).toBeNull();
    expect(after.sentAt).toBeNull(); // open again, so the next answer is sent
  });
  test('auto-dispatch sends only vetted tasks, and never one that is already being sent', () => {
    const store = mem();
    const e = new Engine(loadConfig(), store, { prompt: async () => {} } as any);
    e.sessions = [session({ name: 'worker', status: 'idle', slots: 2 })];
    const t = store.addTask({ title: 'Queued from Slack', session: 'worker' });
    expect(store.getTask(t.id)!.stage).toBe(1);
    expect(e.readyToDispatch()).toEqual([]);
    store.vetTask(t.id);
    expect(e.readyToDispatch()).toEqual([t.id]);
    e.dispatching.add(t.id);
    expect(e.readyToDispatch()).toEqual([]);
    expect(e.briefFor(t.id)).not.toContain('Ask: ');
  });
  test('moving back from Requester told reopens the promises it closed; re-import only moves forward; overdue is computed', () => {
    const s = mem();
    const t = s.addTask({ title: 'Ship it' });
    s.addPromise({ to: 'Sam', said: 'will tell you', taskId: t.id });
    s.updateTask(t.id, { stage: 6 });
    expect(s.listPromises()[0].state).toBe('kept');
    s.updateTask(t.id, { stage: 5 });
    expect(s.listPromises()[0].state).toBe('open');
    expect(() => s.updateTask(t.id, { prio: 'P9' as any })).toThrow();
    s.importTask({ extId: 'X-1', title: 'Imported', stage: 4 });
    const again = s.importTask({ extId: 'X-1', title: 'Imported', stage: 1, prio: 'P1' });
    expect(s.getTask(again.id)).toMatchObject({ stage: 4, prio: 'P1' });
    const late = s.addPromise({ to: 'Ann', said: 'by Monday', taskId: t.id, dueAt: new Date(Date.now() - 864e5).toISOString() });
    expect(s.listPromises().find((p) => p.id === late.id)!.state).toBe('due');
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

describe('sessions outside herdr', () => {
  test('names come from /rename, else the folder and the id; always unique and herdr-safe', () => {
    const taken = new Set(['billing-fix']);
    expect(suggestName('Billing Fix!', 'C:/work/api', 'abcd1234-0000-0000-0000-000000000000', taken)).toBe('billing-fix-2');
    expect(suggestName(null, 'C:/work/My API/', 'abcd1234-0000-0000-0000-000000000000', new Set())).toBe('my-api-abcd');
    expect(suggestName('__', '/', 'abcd1234-0000-0000-0000-000000000000', new Set())).toMatch(/^[a-z0-9][a-z0-9_-]+$/);
  });
  test('a history file gives its folder, last name and first ask; running sessions are left out', () => {
    const root = mkdtempSync(join(tmpdir(), 'sb-outside-'));
    try {
      const id = '11111111-2222-3333-4444-555555555555', other = '66666666-7777-8888-9999-000000000000';
      mkdirSync(join(root, 'proj'));
      writeFileSync(join(root, 'proj', id + '.jsonl'), [
        JSON.stringify({ type: 'user', isMeta: true, message: { content: '<command-name>/x</command-name>' } }),
        JSON.stringify({ type: 'user', cwd: root, message: { content: 'Fix the export, please' } }),
        JSON.stringify({ type: 'custom-title', customTitle: 'first' }),
        JSON.stringify({ type: 'custom-title', customTitle: 'export-fix' }),
      ].join('\n') + '\n');
      writeFileSync(join(root, 'proj', other + '.jsonl'), JSON.stringify({ type: 'user', cwd: root, message: { content: 'hi' } }) + '\n');
      writeFileSync(join(root, 'proj', 'not-a-session.jsonl'), '{}\n');
      const one = readOutside(join(root, 'proj', id + '.jsonl'))!;
      expect(one).toMatchObject({ sessionId: id, cwd: root, cwdExists: true, title: 'export-fix', firstAsk: 'Fix the export, please', recent: true });
      const list = listOutside(root, new Set([other]), new Set(), 14);
      expect(list.map((o) => o.sessionId)).toEqual([id]);
      expect(list[0].suggestedName).toBe('export-fix');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});


describe('self-update', () => {
  const sh = (cwd: string, ...a: string[]) => { const r = Bun.spawnSync(['git', ...a], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }); if (r.exitCode) throw new Error(a.join(' ') + ': ' + r.stderr.toString()); };
  test('only fast-forwards a clean copy, and goes back when the new version does not build', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sb-upd-'));
    try {
      const origin = join(root, 'origin.git'), dev = join(root, 'dev'), mine = join(root, 'mine');
      sh(root, 'init', '--bare', '-b', 'main', origin);
      sh(root, 'clone', '-q', origin, dev);
      mkdirSync(join(dev, 'server'));
      writeFileSync(join(dev, 'server', 'index.ts'), 'export const v = 1;\n');
      sh(dev, 'add', '-A'); sh(dev, 'commit', '-qm', 'v1'); sh(dev, 'push', '-q', 'origin', 'HEAD:main');
      sh(root, 'clone', '-q', origin, mine);
      const logs: string[] = [];
      const up = new Updater({ busy: () => null, log: (t) => logs.push(t), supervised: false, repo: mine });
      expect((await up.check(true)).state).toBe('up-to-date');

      writeFileSync(join(dev, 'server', 'index.ts'), 'export const v = 2;\n');
      sh(dev, 'commit', '-qam', 'v2'); sh(dev, 'push', '-q', 'origin', 'HEAD:main');
      expect((await up.check(false)).state).toBe('available');
      writeFileSync(join(mine, 'server', 'index.ts'), 'export const v = 99; // my edit\n');
      expect((await up.check(true)).state).toBe('blocked');
      sh(mine, 'checkout', '--', '.');
      const busy = new Updater({ busy: () => 'your answers are sent', log: () => {}, supervised: false, repo: mine });
      expect((await busy.check(true)).note).toContain('waiting until');
      const done = await up.check(true);
      expect(done.state).toBe('updated');
      expect(readFileSync(join(mine, 'server', 'index.ts'), 'utf8')).toContain('v = 2');

      writeFileSync(join(dev, 'server', 'index.ts'), 'export const v = ;\n'); // does not build
      sh(dev, 'commit', '-qam', 'broken'); sh(dev, 'push', '-q', 'origin', 'HEAD:main');
      const bad = await up.check(true);
      expect(bad.state).toBe('failed');
      expect(readFileSync(join(mine, 'server', 'index.ts'), 'utf8')).toContain('v = 2');
      expect(needsInstall(['web/a.tsx'])).toBe(false);
      expect(needsInstall(['bun.lock'])).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 60_000);
});

describe('handoff request', () => {
  test('an existing handoff keeps its own format; a missing one gets the template', () => {
    const fresh = handoffRequest('Sam', 'billing', 'C:/h/billing.md', false);
    const kept = handoffRequest('Sam', 'billing', 'C:/h/billing.md', true);
    expect(kept).toContain('Keep its existing structure');
    expect(kept).not.toContain('replace whatever is there');
    expect(fresh).not.toContain('Keep its existing structure');
    for (const t of [fresh, kept]) { expect(t).toContain('## Open tasks'); expect(t).toContain(HANDOFF_MARKER); }
  });
});

describe('modes and approvals (gate)', () => {
  test('who decides: the owner always runs; Dry run records; Ask first waits; Safe auto waits only for risky', () => {
    expect(decide('dry', 'owner', 'spawn')).toBe('run');
    expect(decide('dry', 'session', 'dispatch')).toBe('record');
    expect(decide('ask', 'auto', 'dispatch')).toBe('ask');
    expect(decide('safe', 'auto', 'dispatch')).toBe('run');
    expect(decide('safe', 'session', 'spawn')).toBe('ask');
    expect(decide('safe', 'session', 'prompt')).toBe('ask');
    expect(decide('auto', 'session', 'replace')).toBe('run');
  });
  test('one approval per repeated action; a decision happens once; leaving Dry run reviews or drops', () => {
    const s = mem();
    const a = s.holdAction({ kind: 'dispatch', key: actionKey('dispatch', { taskId: 'T-1' }), params: { taskId: 'T-1' }, summary: 'send T-1', actor: 'auto', by: 'dispatcher', state: 'waiting' });
    const again = s.holdAction({ kind: 'dispatch', key: actionKey('dispatch', { taskId: 'T-1' }), params: { taskId: 'T-1' }, summary: 'send T-1', actor: 'auto', by: 'dispatcher', state: 'waiting' });
    expect(again.fresh).toBe(false);
    expect(again.item.id).toBe(a.item.id);
    expect(s.hasOpenAction(actionKey('dispatch', { taskId: 'T-1' }))).toBe(true);
    expect(s.setActionState(a.item.id, ['waiting'], 'approved')).toBe(true);
    expect(s.setActionState(a.item.id, ['waiting'], 'approved')).toBe(false); // a second click does nothing
    s.holdAction({ kind: 'spawn', key: 'k1', params: {}, summary: 'x', actor: 'session', by: 's', state: 'dry' });
    s.holdAction({ kind: 'spawn', key: 'k2', params: {}, summary: 'y', actor: 'session', by: 's', state: 'dry' });
    expect(s.settleDryActions(true)).toBe(2);
    expect(s.listActions().filter((x) => x.state === 'waiting').length).toBe(2);
  });
  test('a new install starts in Dry run; an install from before modes keeps Autopilot', () => {
    expect(mem().settings().mode).toBe('dry');
    const dir = mkdtempSync(join(tmpdir(), 'sb-mode-'));
    try {
      const old = new Store(dir);
      old.db.query("INSERT INTO settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ leadSession: 'lead' }));
      old.db.close();
      const reopened = new Store(dir);
      expect(reopened.settings().mode).toBe('auto');
      reopened.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('through the engine: Dry run records, Ask first waits, Approve runs it once, Reject runs nothing', async () => {
    const store = mem();
    const sent: string[] = [];
    const e = new Engine(loadConfig(), store, { prompt: async (_p: string, t: string) => { sent.push(t); } } as any);
    e.sessions = [session({ name: 'worker', status: 'idle' })];
    const meta = { actor: 'session' as const, by: 'lead', summary: 'send a prompt to worker' };
    const r1 = await e.act('prompt', { session: 'worker', text: 'hello' }, meta);
    expect(r1.status).toBe('dry');
    expect(sent).toEqual([]);
    store.saveSettings({ ...store.settings(), mode: 'ask' });
    store.settleDryActions(false);
    const r2 = await e.act('prompt', { session: 'worker', text: 'hello' }, meta);
    expect(r2.status).toBe('waiting');
    expect(sent).toEqual([]);
    await e.approveAction((r2 as any).id);
    expect(sent).toEqual(['hello']);
    await expect(e.approveAction((r2 as any).id)).rejects.toThrow();
    expect(sent).toEqual(['hello']);
    const r3 = await e.act('prompt', { session: 'worker', text: 'other' }, meta);
    e.rejectAction((r3 as any).id);
    expect(sent).toEqual(['hello']);
    const r4 = await e.act('prompt', { session: 'worker', text: 'mine' }, { ...meta, actor: 'owner' });
    expect(r4.status).toBe('done');
    expect(sent).toEqual(['hello', 'mine']);
  });
});

describe('owner instructions and thread checks', () => {
  test("the owner's way of working ends every prompt; nothing is added when it is empty", () => {
    expect(ownerRules('Sam', '')).toBe('');
    expect(ownerRules('Sam', '  ')).toBe('');
    expect(ownerRules('Sam', 'Review PRs before merge')).toContain("Sam's way of working");
    const store = mem();
    store.saveSettings({ ...store.settings(), instructions: 'Ask before any deploy' });
    const e = new Engine(loadConfig(), store, {} as any);
    const t = store.addTask({ title: 'Fix it' });
    expect(e.briefFor(t.id)).toContain('Ask before any deploy');
  });
  test('a thread the intake flags shows until dismissed', () => {
    const s = mem();
    s.addIntake({ src: '#team', who: 'two sessions', text: 'they contradict each other', verdict: 'check thread', taskId: null, url: 'https://example.slack.com/x' } as any);
    s.addIntake({ src: '#team', who: 'x', text: 'fyi', verdict: 'dropped', taskId: null, url: null } as any);
    const open = s.openThreadChecks();
    expect(open.length).toBe(1);
    s.resolveIntake(open[0].id);
    expect(s.openThreadChecks()).toEqual([]);
    expect(() => s.resolveIntake(99999)).toThrow();
  });
});

describe('instructions from the CLI', () => {
  test('add, set and undo through the API; every change keeps the previous version', async () => {
    const store = mem();
    const e = new Engine(loadConfig(), store, {} as any);
    const api = makeApi(e);
    const call = (b: any) => api(new Request('http://127.0.0.1:4400/api/owner-instructions', { method: 'POST', headers: { 'x-shiftboss': '1', 'content-type': 'application/json' }, body: JSON.stringify(b) }), new URL('http://127.0.0.1:4400/api/owner-instructions'));
    await call({ add: 'Review PRs before merge' });
    await call({ add: '- Ask before deploys' });
    expect(store.settings().instructions).toBe('- Review PRs before merge\n- Ask before deploys');
    await call({ set: 'Only this' });
    expect(store.settings().instructions).toBe('Only this');
    await call({ undo: true });
    expect(store.settings().instructions).toBe('- Review PRs before merge\n- Ask before deploys');
  });
});
