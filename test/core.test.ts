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
import { checksLeft, checksTotal, effectiveState, isAlerting, monitorPrompt, nextDueAfter, pickDue } from '../server/monitors';
import { DEFAULT_NOTIFY, type Session } from '../shared/types';
import { newNotifications, notifyItems, tabTitle } from '../shared/notify';
import { inRange, rangeBounds } from '../web/filters';
import { inQuiet, SlackNotifier } from '../server/slack';
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
    const undoing = handle(new Request(`http://x/api/needs/${n.id}/undo`, { method: 'POST', headers: { 'x-shiftboss': '1', 'x-shiftboss-actor': 'owner' } }), new URL(`http://x/api/needs/${n.id}/undo`));
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

describe('source links and direction', () => {
  test('the migration adds url and direction to an old database, keeps its rows, and is safe to run again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-mig-'));
    try {
      // A database from before this change: promises without url/direction, intake without direction.
      const { Database } = require('bun:sqlite');
      const old = new Database(join(dir, 'shiftboss.db'), { create: true });
      old.exec(`CREATE TABLE promises (id INTEGER PRIMARY KEY AUTOINCREMENT, to_person TEXT NOT NULL, where_text TEXT NOT NULL DEFAULT '',
        said TEXT NOT NULL, kept_when TEXT NOT NULL DEFAULT '', task_id TEXT, state TEXT NOT NULL DEFAULT 'open', due_at TEXT, created_at TEXT NOT NULL, kept_at TEXT);
        CREATE TABLE intake (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, src TEXT NOT NULL, who TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, verdict TEXT NOT NULL, task_id TEXT);
        INSERT INTO promises (to_person, said, created_at) VALUES ('Sam', 'will send it', '2026-01-01T00:00:00Z');
        INSERT INTO intake (at, src, text, verdict) VALUES ('2026-01-01T00:00:00Z', '#team', 'hi', 'dropped');`);
      old.close();
      const a = new Store(dir);
      const cols = (t: string) => (a.db.query(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
      expect(cols('promises')).toContain('url');
      expect(cols('promises')).toContain('direction');
      expect(cols('tasks')).toContain('direction');
      expect(cols('intake')).toContain('direction');
      expect(a.listPromises()[0]).toMatchObject({ said: 'will send it', url: null, direction: null, link: null });
      expect(a.listIntake()[0]).toMatchObject({ text: 'hi', url: null, direction: null });
      a.db.close();
      const b = new Store(dir); // second run: no "duplicate column" error
      expect((b.db.query('PRAGMA table_info(promises)').all() as { name: string }[]).filter((c) => c.name === 'url').length).toBe(1);
      expect(b.listPromises().length).toBe(1);
      b.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('direction must be inbound, outbound or unknown', () => {
    const s = mem();
    expect(s.addTask({ title: 'a', direction: 'inbound' }).direction).toBe('inbound');
    expect(s.addTask({ title: 'b' }).direction).toBeNull();
    expect(() => s.addTask({ title: 'c', direction: 'sideways' as any })).toThrow('direction must be inbound or outbound');
    expect(() => s.addPromise({ to: 'Sam', said: 'x', direction: 'up' as any })).toThrow();
    expect(() => s.addIntake({ src: '#x', who: '', text: 't', verdict: 'dropped', taskId: null, url: null, direction: 'in' as any })).toThrow();
    const t = s.updateTask('T-1', { direction: 'outbound' });
    expect(t.direction).toBe('outbound');
    expect(s.events('T-1')[0].text).toContain('Marked outbound');
  });

  test('a promise without its own link shows its task link via T-n, worked out when read', () => {
    const s = mem();
    const t = s.addTask({ title: 'From Slack', sourceUrl: 'https://acme.slack.com/archives/C1/p1' });
    const p = s.addPromise({ to: 'Sam', said: 'will do', taskId: t.id });
    expect(p.url).toBeNull();
    expect(p.link).toEqual({ url: 'https://acme.slack.com/archives/C1/p1', via: t.id });
    // Fixing the task's link fixes the promise's too (nothing was copied).
    s.updateTask(t.id, { sourceUrl: 'https://acme.slack.com/archives/C1/p2' });
    expect(s.getPromise(p.id)!.link).toEqual({ url: 'https://acme.slack.com/archives/C1/p2', via: t.id });
    // Its own link wins.
    s.updatePromiseSource(p.id, { url: 'https://mail.google.com/mail/u/0/#inbox/abc', direction: 'outbound' });
    expect(s.getPromise(p.id)).toMatchObject({ url: 'https://mail.google.com/mail/u/0/#inbox/abc', direction: 'outbound', link: { via: null } });
    // A promise filed without a task gives its new task its link and direction.
    const q = s.addPromise({ to: 'Ann', said: 'by Friday', url: 'https://acme.slack.com/archives/C2/p3', direction: 'outbound' });
    expect(s.getTask(q.taskId!)).toMatchObject({ sourceUrl: 'https://acme.slack.com/archives/C2/p3', direction: 'outbound' });
    // No link anywhere: null, so the UI shows "No source link".
    const bare = s.addPromise({ to: 'Bo', said: 'soon', taskId: s.addTask({ title: 'no link' }).id });
    expect(bare.link).toBeNull();
  });

  test('the API checks links and direction on tasks, promises, intake and Slack', async () => {
    const store = mem();
    const e = new Engine(loadConfig(), store, { prompt: async () => {} } as any);
    const handle = makeApi(e);
    const call = async (method: string, path: string, body?: unknown) => {
      const res = (await handle(new Request('http://x' + path, { method, headers: { 'x-shiftboss': '1', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), new URL('http://x' + path)))!;
      return { status: res.status, body: await res.json() as any };
    };
    let r = await call('POST', '/api/tasks', { title: 'x', sourceUrl: 'javascript:alert(1)' });
    expect(r.status).toBe(400);
    r = await call('POST', '/api/tasks', { title: 'x', direction: 'both' });
    expect(r.body.error).toContain('direction');
    r = await call('POST', '/api/tasks', { title: 'Asked in Slack', sourceUrl: 'https://acme.slack.com/archives/C1/p1', direction: 'inbound' });
    expect(r.body).toMatchObject({ id: 'T-1', direction: 'inbound', sourceUrl: 'https://acme.slack.com/archives/C1/p1' });
    const bare = (await call('POST', '/api/tasks', { title: 'No link yet' })).body.id;
    // "Add link" on the task page.
    expect((await call('PATCH', `/api/tasks/${bare}`, { sourceUrl: 'ftp://x/y' })).status).toBe(400);
    r = await call('PATCH', `/api/tasks/${bare}`, { sourceUrl: 'https://mail.google.com/mail/u/0/#inbox/1', direction: 'inbound', who: 'you' });
    expect(r.body).toMatchObject({ sourceUrl: 'https://mail.google.com/mail/u/0/#inbox/1', direction: 'inbound' });
    // Promises.
    expect((await call('POST', '/api/promises', { to: 'Sam', said: 'x', url: 'data:text/html,hi' })).status).toBe(400);
    r = await call('POST', '/api/promises', { to: 'Sam', said: 'will send', taskId: 'T-1', direction: 'outbound' });
    expect(r.body).toMatchObject({ url: null, direction: 'outbound', link: { url: 'https://acme.slack.com/archives/C1/p1', via: 'T-1' } });
    const pid = r.body.id;
    expect((await call('PATCH', `/api/promises/${pid}`, { url: 'not a url' })).status).toBe(400);
    expect((await call('PATCH', `/api/promises/${pid}`, { direction: 'down' })).status).toBe(400);
    expect((await call('PATCH', `/api/promises/${pid}`, { url: 'https://acme.slack.com/archives/C1/p9' })).status).toBe(200);
    expect(store.getPromise(pid)).toMatchObject({ url: 'https://acme.slack.com/archives/C1/p9', link: { via: null } });
    expect((await call('PATCH', '/api/promises/999', { url: 'https://acme.slack.com/x' })).status).toBe(404);
    // Intake.
    expect((await call('POST', '/api/intake', { src: '#t', text: 'hi', verdict: 'dropped', direction: 'out' })).status).toBe(400);
    expect((await call('POST', '/api/intake', { src: '#t', text: 'hi', verdict: 'dropped', url: 'https://acme.slack.com/archives/C1/p5', direction: 'inbound' })).status).toBe(201);
    expect(store.listIntake()[0]).toMatchObject({ url: 'https://acme.slack.com/archives/C1/p5', direction: 'inbound' });
    // A Slack message with a permalink fills a task that has none, and never replaces one.
    const third = (await call('POST', '/api/tasks', { title: 'third' })).body.id;
    await call('POST', `/api/tasks/${third}/slack`, { who: 'Sam', text: 'can you?', kind: 'ask', url: 'https://acme.slack.com/archives/C3/p1' });
    expect(store.getTask(third)!.sourceUrl).toBe('https://acme.slack.com/archives/C3/p1');
    await call('POST', `/api/tasks/${third}/slack`, { who: 'Sam', text: 'again', kind: 'ask', url: 'https://acme.slack.com/archives/C3/p2' });
    expect(store.getTask(third)!.sourceUrl).toBe('https://acme.slack.com/archives/C3/p1');
  });

  test('notification switches default to on, merge partially and reject non-booleans', () => {
    const s = mem();
    expect(s.settings().notify).toEqual(DEFAULT_NOTIFY);
    expect(Object.values(DEFAULT_NOTIFY).every(Boolean)).toBe(true);
    const next = mergeSettings(s.settings(), { notify: { overlap: false } });
    expect(next.notify).toMatchObject({ overlap: false, needs: true });
    s.saveSettings(next);
    expect(s.settings().notify!.overlap).toBe(false);
    expect(() => mergeSettings(s.settings(), { notify: { needs: 'yes' } })).toThrow();
  });
});

describe('browser notifications', () => {
  const snapOf = (store: Store, over: Record<string, unknown> = {}) => {
    const e = new Engine(loadConfig(), store, { prompt: async () => {} } as any);
    return { ...e.snapshot(), ...over } as any;
  };
  test('only items that appear after the page loaded notify, and only enabled kinds', () => {
    const s = mem();
    s.addNeed({ kind: 'Decision', title: 'Old question', answers: ['Yes'] });
    const first = snapOf(s);
    expect(newNotifications(null, first, undefined)).toEqual([]); // page load: nothing is new
    s.addNeed({ kind: 'Decision', title: 'Ship it?', answers: ['Yes', 'No'], session: 'w1' });
    s.addNeed({ kind: 'Permission', title: 'Bash: rm', answers: ['Focus'], session: 'w2', auto: true });
    s.addPromise({ to: 'Sam', said: 'by Monday', dueAt: new Date(Date.now() - 6e4).toISOString() });
    const second = snapOf(s);
    const got = newNotifications(first, second, undefined);
    expect(got.map((x) => x.kind).sort()).toEqual(['blocked', 'needs', 'promiseDue', 'tasks']); // the promise filed its task
    expect(got.find((x) => x.kind === 'needs')).toMatchObject({ title: 'Needs you: Ship it?', route: '/needs' });
    expect(newNotifications(first, second, { ...DEFAULT_NOTIFY, blocked: false, promiseDue: false, tasks: false }).map((x) => x.kind)).toEqual(['needs']);
    expect(newNotifications(second, second, undefined)).toEqual([]); // nothing new the second time
  });
  test('stuck sessions, overlaps and monitor alerts (when present) notify; answered items do not', () => {
    const s = mem();
    const a = snapOf(s, { monitors: [{ id: 'm1', name: 'API', state: 'up' }] });
    const b = snapOf(s, {
      health: [{ session: 'w1', verdict: 'looping', title: 'Same command 4 times', signals: [], loop: [], suggest: 'Interrupt it' }],
      overlaps: [{ id: 'o1', kind: 'Same file', severity: 'red', where: 'x.ts', title: '', a: { session: 'w1', what: '' }, b: { session: 'w2', what: '' }, fix: '' }],
      monitors: [{ id: 'm1', name: 'API', state: 'down' }],
    });
    const got = newNotifications(a, b, undefined);
    expect(got.map((x) => x.kind).sort()).toEqual(['monitor', 'overlap', 'stuck']);
    expect(got.find((x) => x.kind === 'stuck')!.route).toBe('/session/w1');
    expect(notifyItems(snapOf(s, { herdrOk: true })).length).toBe(0); // no monitors field: skipped
    const n = s.addNeed({ kind: 'Decision', title: 'Q', answers: ['Yes'] });
    s.answerNeed(n.id, 'Yes');
    expect(notifyItems(snapOf(s, { herdrOk: true }))).toEqual([]);
  });
  test('everything else notifies once, when it changes: finished turns, tasks, releases, monitors, limits, herdr', () => {
    const s = mem();
    const sess = (status: string, at: string) => ({ name: 'w1', status, lastActivity: at, lines: [{ at, kind: 'say', text: 'All done' }] });
    const mon = (over: Record<string, unknown>) => ({ id: 7, title: 'Texting', lastCheckAt: null, lastVerdict: null, lastSummary: null, finishedAt: null, finishReason: null, checksDone: 0, ...over });
    const a = snapOf(s, {
      sessions: [sess('working', '2026-01-01T10:00:00Z')],
      tasks: [{ id: 'T-1', title: 'Fix', stage: 2, requester: 'Sam', source: 'Slack', session: 'w1' }],
      releases: { envs: [{ name: 'dev', url: 'u', version: 'v1', ok: true, checkedAt: null }], merged: [], freeze: null },
      monitors: [mon({})], limits: { fiveHourPct: 50, weeklyPct: 10, fiveHourTokens: 0, weeklyTokens: 0, estimate: false }, herdrOk: true,
    });
    const b = snapOf(s, {
      sessions: [sess('done', '2026-01-01T10:05:00Z')],
      tasks: [{ id: 'T-1', title: 'Fix', stage: 3, requester: 'Sam', source: 'Slack', session: 'w1' }, { id: 'T-2', title: 'New ask', stage: 0, requester: 'Sam', source: 'Slack', session: null }],
      releases: { envs: [{ name: 'dev', url: 'u', version: 'v2', ok: true, checkedAt: null }], merged: [{ number: 5, title: 'Fix', author: 'Sam', mergedAt: '', url: '' }], freeze: null },
      monitors: [mon({ lastCheckAt: '2026-01-01T10:04:00Z', lastVerdict: 'ok', lastSummary: 'Fine' })],
      limits: { fiveHourPct: 82, weeklyPct: 10, fiveHourTokens: 0, weeklyTokens: 0, estimate: false }, herdrOk: false, herdrError: 'not running',
    });
    const got = newNotifications(a, b, undefined);
    expect(got.map((x) => x.kind).sort()).toEqual(['finished', 'limits', 'monitorReport', 'releases', 'releases', 'system', 'tasks', 'tasks']);
    expect(got.find((x) => x.kind === 'finished')).toMatchObject({ title: 'w1 finished its turn', body: 'All done', route: '/session/w1' });
    expect(got.filter((x) => x.kind === 'tasks').map((x) => x.title).sort()).toEqual(['New task T-2: New ask', 'T-1 is now PR open']);
    expect(notifyItems({ ...b, sessions: [{ ...sess('done', 'x'), name: 'intake' }] }).some((x) => x.kind === 'finished')).toBe(false);
    expect(newNotifications(b, b, undefined)).toEqual([]);
    expect(newNotifications(a, b, { ...DEFAULT_NOTIFY, tasks: false, releases: false, finished: false, limits: false, system: false, monitorReport: false })).toEqual([]);
  });
  test('the tab title counts unanswered Needs you items', () => {
    const s = mem();
    expect(tabTitle(snapOf(s))).toBe('ShiftBoss');
    s.addNeed({ kind: 'Decision', title: 'A', answers: ['Yes'] });
    s.addNeed({ kind: 'Decision', title: 'B', answers: ['Yes'] });
    expect(tabTitle(snapOf(s))).toBe('(2) ShiftBoss');
    expect(tabTitle(null)).toBe('ShiftBoss');
  });
});

describe('slack bot', () => {
  const fakeSlack = (fail?: string) => {
    const calls: { method: string; args: Record<string, string> }[] = [];
    let n = 0;
    const f = async (url: string, init: RequestInit) => {
      const method = url.split('/').pop()!;
      const args = Object.fromEntries(new URLSearchParams(String(init.body)));
      calls.push({ method, args });
      if (fail) return Response.json({ ok: false, error: fail });
      if (method === 'auth.test') return Response.json({ ok: true, team: 'Acme', user: 'shiftboss', user_id: 'U1', team_id: 'T1' });
      if (method === 'conversations.open') return Response.json({ ok: true, channel: { id: 'D42' } });
      if (method === 'users.lookupByEmail') return Response.json({ ok: true, user: { id: 'U9', name: 'sam', real_name: 'Sam' } });
      if (method === 'chat.postMessage') return Response.json({ ok: true, ts: '1.' + ++n, channel: args.channel });
      return Response.json({ ok: false, error: 'unknown_method' });
    };
    return { f, calls };
  };
  const setup = async (over: Record<string, unknown> = {}, fail?: string) => {
    const s = mem();
    const { f, calls } = fakeSlack(fail);
    const logs: string[] = [];
    const n = new SlackNotifier(s, 'http://127.0.0.1:4400', (t) => logs.push(t), f as any, () => new Date(), 0);
    await n.connect('xoxb-1234567890-abcdef');
    s.saveSettings(mergeSettings(s.settings(), { slack: { dm: { on: true, userId: 'U9', label: 'Sam' }, channel: { on: true, id: 'C1', name: 'alerts' }, ...over } }));
    const e = new Engine(loadConfig(), s, { prompt: async () => {} } as any);
    const snap = (x: Record<string, unknown> = {}) => ({ ...e.snapshot(), herdrOk: true, ...x }) as any;
    return { s, n, calls, logs, snap };
  };
  const posts = (calls: { method: string; args: Record<string, string> }[]) => calls.filter((c) => c.method === 'chat.postMessage').map((c) => c.args);
  const flush = (n: SlackNotifier) => n.drain();

  test('connect checks the token and keeps it out of settings', async () => {
    const s = mem();
    const n = new SlackNotifier(s, 'http://x', () => {}, fakeSlack().f as any);
    await expect(n.connect('not-a-token')).rejects.toThrow('starts with xoxb-');
    expect(await n.connect('xoxb-1234567890-abcdef')).toEqual({ team: 'Acme', bot: 'shiftboss' });
    expect(JSON.stringify(s.settings())).not.toContain('xoxb');
    expect(n.status()).toMatchObject({ connected: true, team: 'Acme' });
    const bad = new SlackNotifier(mem(), 'http://x', () => {}, fakeSlack('invalid_auth').f as any);
    await expect(bad.connect('xoxb-1234567890-abcdef')).rejects.toThrow('does not accept this token');
  });

  test('only new events post, to the places switched on for their kind, threaded, with a link and no session output', async () => {
    const { s, n, calls, snap } = await setup();
    n.tick(snap()); // what was there at start never posts
    s.addNeed({ kind: 'Decision', title: 'Ship it?', answers: ['Yes'], session: 'w1' });
    const mon = { id: 3, title: 'Texting', lastCheckAt: '2026-01-01T10:00:00Z', lastVerdict: 'ok', lastSummary: 'fine', finishedAt: null, finishReason: null, checksDone: 1, notes: [] };
    n.tick(snap({ monitors: [mon], sessions: [session({ name: 'w2', status: 'done', lastActivity: '2026-01-01T10:00:00Z', lines: [{ at: '', kind: 'say', text: 'SECRET OUTPUT' }] })] }));
    await flush(n);
    const p = posts(calls);
    expect(p.find((x) => x.channel === 'D42' && x.text.includes('Needs you: Ship it?'))!.text).toContain('<http://127.0.0.1:4400/needs|Open in ShiftBoss>');
    expect(p.some((x) => x.channel === 'C1' && x.text.includes('Ship it?'))).toBe(false); // needs: DM only by default
    expect(p.find((x) => x.channel === 'C1' && x.text.includes('Texting: ok'))).toBeTruthy(); // monitor checks: channel
    expect(p.some((x) => x.text.includes('SECRET OUTPUT'))).toBe(false); // finished is off by default, and never carries output
    // The next check of the same monitor replies in its thread.
    const first = p.find((x) => x.text.includes('Texting: ok'))!;
    n.tick(snap({ monitors: [{ ...mon, lastCheckAt: '2026-01-01T16:00:00Z', lastVerdict: 'warn', lastSummary: 'slow' }] }));
    await flush(n);
    const reply = posts(calls).find((x) => x.text.includes('Texting: warn'))!;
    expect(reply.thread_ts).toBe(s.slackThread('channel', 'monitor:3')!.ts);
    expect(first.thread_ts).toBeUndefined();
  });

  test('a need answered says Cleared in its thread; quiet hours hold the DM and send one digest', async () => {
    const { s, n, calls, snap } = await setup({ quiet: { on: true, from: '00:00', to: '23:59' } });
    n.tick(snap());
    const need = s.addNeed({ kind: 'Decision', title: 'Q1', answers: ['Yes'] });
    n.tick(snap());
    await flush(n);
    expect(posts(calls).some((x) => x.text.includes('Q1'))).toBe(false); // held
    expect(s.heldSlack().map((h) => h.title)).toEqual(['Needs you: Q1']);
    s.saveSettings(mergeSettings(s.settings(), { slack: { quiet: { on: false } } }));
    s.answerNeed(need.id, 'Yes');
    n.tick(snap());
    await flush(n);
    expect(posts(calls).find((x) => x.text.startsWith('*While you were away: 1 thing*'))!.text).toContain('Needs you: Q1');
    expect(s.heldSlack()).toEqual([]);
  });

  test('a burst becomes one message; a revoked token stops sending and says why once', async () => {
    const { s, n, calls, snap, logs } = await setup();
    n.tick(snap());
    for (let i = 0; i < 20; i++) s.addNeed({ kind: 'Decision', title: 'Q' + i, answers: ['Yes'] });
    n.tick(snap());
    await flush(n);
    expect(posts(calls).filter((x) => x.channel === 'D42').map((x) => x.text.split('\n')[0])).toEqual(['*20 things happened at once in ShiftBoss*']);
    (n as any).f = fakeSlack('token_revoked').f;
    s.addNeed({ kind: 'Decision', title: 'After', answers: ['Yes'] });
    n.tick(snap());
    await flush(n);
    expect(n.status().error).toContain('revoked');
    expect(logs.filter((l) => l.includes('revoked')).length).toBe(1);
  });

  test('alerts held in quiet hours still go out as a digest after a restart', async () => {
    const { s, n, calls, snap } = await setup();
    s.holdSlack('Needs you: held before the restart', '/needs');
    n.tick(snap()); // first tick after start: not quiet, something held
    await flush(n);
    expect(posts(calls).find((x) => x.text.startsWith('*While you were away: 1 thing*'))!.text).toContain('held before the restart');
    expect(s.heldSlack()).toEqual([]);
  });

  test('quiet hours cross midnight', () => {
    const q = { on: true, from: '22:00', to: '08:00' };
    expect(inQuiet(q, new Date(2026, 0, 1, 23, 0))).toBe(true);
    expect(inQuiet(q, new Date(2026, 0, 1, 7, 59))).toBe(true);
    expect(inQuiet(q, new Date(2026, 0, 1, 8, 0))).toBe(false);
    expect(inQuiet({ ...q, on: false }, new Date(2026, 0, 1, 23, 0))).toBe(false);
  });
});

describe('list paging and date ranges', () => {
  test('the intake log pages on the server with kind, direction, search and dates', () => {
    const s = mem();
    for (let i = 0; i < 7; i++) s.addIntake({ src: i % 2 ? '#team' : 'DM', who: 'Sam', text: 'ask ' + i, verdict: i % 3 === 0 ? 'filed T-' + i : 'dropped', taskId: null, url: null, direction: i % 2 ? 'inbound' : 'outbound' });
    expect(s.pageIntake({ limit: 3 })).toMatchObject({ total: 7 });
    expect(s.pageIntake({ limit: 3 }).items.map((x) => x.text)).toEqual(['ask 6', 'ask 5', 'ask 4']);
    expect(s.pageIntake({ limit: 3, offset: 6 }).items.map((x) => x.text)).toEqual(['ask 0']);
    expect(s.pageIntake({ kind: 'filed' }).total).toBe(3);
    expect(s.pageIntake({ direction: 'inbound' }).total).toBe(3);
    expect(s.pageIntake({ q: 'team' }).total).toBe(3);
    expect(s.pageIntake({ from: new Date(Date.now() + 60e3).toISOString() }).total).toBe(0);
    expect(s.pageIntake({ limit: 5000 }).items.length).toBe(7); // capped at 200, fine here
  });
  test('date ranges: today, yesterday, rolling days, custom (inclusive), all', () => {
    const now = new Date(2026, 10, 25, 15, 30);
    const day = (d: number) => new Date(2026, 10, d).toISOString();
    expect(rangeBounds({ id: 'Today' }, now)).toEqual({ from: day(25) });
    expect(rangeBounds({ id: 'Yesterday' }, now)).toEqual({ from: day(24), to: day(25) });
    expect(rangeBounds({ id: '7 days' }, now)).toEqual({ from: day(19) });
    expect(rangeBounds({ id: 'Custom', from: '2026-11-01', to: '2026-11-03' }, now)).toEqual({ from: day(1), to: day(4) });
    expect(rangeBounds({ id: 'All' }, now)).toEqual({});
    expect(inRange(new Date(2026, 10, 24, 23).toISOString(), { id: 'Yesterday' }, now)).toBe(true);
    expect(inRange(new Date(2026, 10, 25, 1).toISOString(), { id: 'Yesterday' }, now)).toBe(false);
    expect(inRange(null, { id: 'All' }, now)).toBe(true);
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
    const call = (b: any) => api(new Request('http://127.0.0.1:4400/api/owner-instructions', { method: 'POST', headers: { 'x-shiftboss': '1', 'content-type': 'application/json', 'x-shiftboss-actor': 'owner' }, body: JSON.stringify(b) }), new URL('http://127.0.0.1:4400/api/owner-instructions'));
    await call({ add: 'Review PRs before merge' });
    await call({ add: '- Ask before deploys' });
    expect(store.settings().instructions).toBe('- Review PRs before merge\n- Ask before deploys');
    await call({ set: 'Only this' });
    expect(store.settings().instructions).toBe('Only this');
    await call({ undo: true });
    expect(store.settings().instructions).toBe('- Review PRs before merge\n- Ask before deploys');
  });
});

describe('monitors', () => {
  const H = 3600e3;
  const T0 = Date.parse('2026-11-20T10:00:00Z');
  const add = (s: Store, over: Partial<{ durationDays: number; intervalHours: number }> = {}) =>
    s.addMonitor({ title: 'New store', prompt: 'Texts send; bad = any failed', durationDays: 1, intervalHours: 6, ...over }, T0);

  test('schedule maths: totals, checks left, next due keeps to the schedule but never bursts', () => {
    expect(checksTotal(1, 6)).toBe(4);
    expect(checksTotal(3, 24)).toBe(3);
    expect(checksTotal(14, 1)).toBe(336);
    expect(checksTotal(1, 24)).toBe(1);
    expect(checksLeft(T0, T0 + 24 * H, 6)).toBe(4);
    expect(checksLeft(T0 + 18 * H, T0 + 24 * H, 6)).toBe(1);
    expect(checksLeft(T0 + 24 * H, T0 + 24 * H, 6)).toBe(0);
    expect(checksLeft(null, T0 + 24 * H, 6)).toBe(0);
    expect(nextDueAfter(T0, 6, T0 + H)).toBe(T0 + 6 * H); // on time: keep the schedule
    expect(nextDueAfter(T0, 6, T0 + 20 * H)).toBe(T0 + 20 * H); // came back late: one check now, not three
  });

  test('alerting: a bad check, or two errors in a row; a good check clears it', () => {
    expect(isAlerting(['bad'])).toBe(true);
    expect(isAlerting(['error'])).toBe(false);
    expect(isAlerting(['error', 'error'])).toBe(true);
    expect(isAlerting(['error', 'ok', 'error'])).toBe(false);
    expect(isAlerting(['ok', 'bad'])).toBe(false);
    expect(effectiveState('paused', ['bad'])).toBe('paused');
    expect(effectiveState('finished', ['bad'])).toBe('finished');
    expect(effectiveState('active', ['warn'])).toBe('active');
    const s = mem();
    const m = add(s, { durationDays: 3 });
    s.reportMonitor(m.id, { verdict: 'bad', summary: '3 texts failed' }, T0 + H);
    expect(s.getMonitor(m.id).state).toBe('alerting');
    s.reportMonitor(m.id, { verdict: 'ok', summary: 'all sent' }, T0 + 2 * H);
    expect(s.getMonitor(m.id).state).toBe('active');
  });

  test('a monitor runs its checks on schedule and finishes after its duration', () => {
    const s = mem();
    const m = add(s);
    expect(m).toMatchObject({ state: 'active', nextDueAt: new Date(T0).toISOString(), checksLeft: 4, checksDone: 0 });
    for (let i = 0; i < 4; i++) {
      const at = T0 + i * 6 * H + 60e3;
      expect(s.getMonitor(m.id).nextDueAt).toBe(new Date(T0 + i * 6 * H).toISOString());
      s.startMonitorCheck(m.id, at);
      const r = s.reportMonitor(m.id, { verdict: 'ok', summary: 'fine ' + i }, at + 60e3);
      expect(r.check.sentAt).not.toBeNull();
    }
    const done = s.getMonitor(m.id);
    expect(done).toMatchObject({ state: 'finished', finishReason: 'ended', checksDone: 4, checksLeft: 0, nextDueAt: null, lastSummary: 'fine 3' });
    expect(() => s.checkMonitorNow(m.id)).toThrow(/finished/);
    // Lengthening a monitor that ran out reopens it.
    expect(s.updateMonitor(m.id, { durationDays: 3 }, T0 + 25 * H).state).toBe('active');
  });

  test('days up with nothing in flight finishes; a check in flight may still report first', () => {
    const s = mem();
    const a = add(s), b = add(s);
    s.startMonitorCheck(b.id, T0 + 23 * H);
    expect(s.finishMonitors(T0 + 24 * H).map((x) => x.id)).toEqual([a.id]);
    expect(s.getMonitor(b.id).state).toBe('active');
    s.reportMonitor(b.id, { verdict: 'ok', summary: 'fine' }, T0 + 24.5 * H);
    expect(s.getMonitor(b.id).state).toBe('finished');
  });

  test('one check in flight at a time; no report in 30 min is an error, two in a row alert', () => {
    const s = mem();
    const a = add(s), b = add(s);
    const c = s.startMonitorCheck(a.id, T0);
    expect(() => s.startMonitorCheck(b.id, T0)).toThrow(/in flight/);
    expect(s.monitorInFlight()!.id).toBe(c.id);
    expect(s.timeoutMonitorChecks(30 * 60e3, T0 + 29 * 60e3)).toEqual([]);
    const [t] = s.timeoutMonitorChecks(30 * 60e3, T0 + 31 * 60e3);
    expect(t.monitor.lastVerdict).toBe('error');
    expect(t.monitor.lastSummary).toContain('no report');
    expect(t.becameAlerting).toBe(false);
    expect(s.monitorInFlight()).toBeNull();
    expect(s.getMonitor(a.id).nextDueAt).toBe(new Date(T0 + 6 * H).toISOString());
    s.startMonitorCheck(a.id, T0 + 6 * H);
    const [t2] = s.timeoutMonitorChecks(30 * 60e3, T0 + 7 * H);
    expect(t2.becameAlerting).toBe(true);
    expect(s.getMonitor(a.id).state).toBe('alerting');
    // A failed send drops the claim, so the check is still due.
    const c3 = s.startMonitorCheck(b.id, T0 + 7 * H);
    s.abandonMonitorCheck(c3.id);
    expect(s.monitorInFlight()).toBeNull();
    expect(s.getMonitor(b.id).inFlight).toBeNull();
  });

  test('pause, resume, stop and check now', () => {
    const s = mem();
    const m = add(s, { durationDays: 3 });
    s.startMonitorCheck(m.id, T0);
    s.reportMonitor(m.id, { verdict: 'ok', summary: 'fine' }, T0 + 60e3);
    expect(s.setMonitorState(m.id, 'pause', T0 + H).state).toBe('paused');
    expect(() => s.checkMonitorNow(m.id)).toThrow(/paused/);
    expect(s.setMonitorState(m.id, 'resume', T0 + 10 * H).nextDueAt).toBe(new Date(T0 + 10 * H).toISOString()); // missed while paused: due now
    expect(s.checkMonitorNow(m.id, T0 + 10.5 * H).nextDueAt).toBe(new Date(T0 + 10.5 * H).toISOString());
    expect(s.setMonitorState(m.id, 'stop', T0 + 11 * H)).toMatchObject({ state: 'finished', finishReason: 'stopped' });
    expect(() => s.setMonitorState(m.id, 'resume')).toThrow();
    expect(s.updateMonitor(m.id, { durationDays: 14 }, T0 + 12 * H).state).toBe('finished'); // stopped stays stopped
  });

  test('due-check selection: watched, due, oldest first, nothing in flight, not backing off', () => {
    const list = [
      { id: 1, state: 'active' as const, nextDueAt: new Date(T0 + H).toISOString(), inFlight: null },
      { id: 2, state: 'alerting' as const, nextDueAt: new Date(T0 - H).toISOString(), inFlight: null },
      { id: 3, state: 'paused' as const, nextDueAt: new Date(T0 - H).toISOString(), inFlight: null },
      { id: 4, state: 'finished' as const, nextDueAt: null, inFlight: null },
      { id: 5, state: 'active' as const, nextDueAt: new Date(T0 - 2 * H).toISOString(), inFlight: { checkId: 1, sentAt: '' } },
      { id: 6, state: 'active' as const, nextDueAt: new Date(T0).toISOString(), inFlight: null },
      { id: 7, state: 'active' as const, nextDueAt: new Date(T0 - 3 * H).toISOString(), inFlight: null },
    ];
    expect(pickDue(list, T0).map((m) => m.id)).toEqual([7, 2, 6]);
    expect(pickDue(list, T0, new Map([[7, T0 + 60e3]])).map((m) => m.id)).toEqual([2, 6]);
  });

  test('the engine sends one check to an idle monitor session, never to a blocked or busy one', async () => {
    const store = mem();
    store.saveSettings({ ...store.settings(), mode: 'auto' }); // sending is what this test is about
    const sent: string[] = [];
    let fail = false;
    const herdr = { prompt: async (_p: string, t: string) => { if (fail) throw new Error('herdr hiccup'); sent.push(t); } };
    const e = new Engine(loadConfig(), store, herdr as any);
    e.herdrOk = true;
    const a = store.addMonitor({ title: 'Store A', prompt: 'look', durationDays: 1, intervalHours: 6, links: { pr: 'https://github.com/acme/api/pull/1' } });
    store.addMonitor({ title: 'Store B', prompt: 'look', durationDays: 1, intervalHours: 6 });
    e.sessions = [session({ name: 'monitor', status: 'blocked' })];
    await e.runMonitors();
    expect(sent.length).toBe(0); // waiting on a prompt: never type into it
    e.sessions = [session({ name: 'monitor', status: 'working' })];
    await e.runMonitors();
    expect(sent.length).toBe(0);
    e.sessions = [session({ name: 'monitor', status: 'idle' })];
    await e.runMonitors();
    await e.runMonitors();
    expect(sent.length).toBe(1); // one in flight: the second waits
    expect(sent[0]).toContain('monitor ' + a.id);
    expect(sent[0]).toContain('monitor_report');
    expect(sent[0]).toContain('https://github.com/acme/api/pull/1');
    expect(sent[0]).toContain('check 1 of 4');
    store.reportMonitor(a.id, { verdict: 'ok', summary: 'fine' });
    fail = true;
    await e.runMonitors(); // B fails to send: claim dropped, retried later, engine fine
    expect(store.monitorInFlight()).toBeNull();
    fail = false;
    await e.runMonitors();
    expect(sent.length).toBe(1); // backing off for a minute
    await e.runMonitors(Date.now() + 61e3);
    expect(sent.length).toBe(2);
    expect(sent[1]).toContain('Store B');
    expect(e.snapshot().monitors.length).toBe(2);
  });

  test('tell the lead: a bad check prompts the lead (never a blocked one), recovery sends a second note; Mark fixed clears the alert', async () => {
    const store = mem();
    store.saveSettings({ ...store.settings(), mode: 'auto', leadSession: 'lead' });
    const sent: { pane: string; text: string }[] = [];
    const e = new Engine(loadConfig(), store, { prompt: async (pane: string, text: string) => { sent.push({ pane, text }); } } as any);
    e.herdrOk = true;
    const m = store.addMonitor({ title: 'Store A', prompt: 'texts send', durationDays: 3, intervalHours: 6, informLead: true, links: { pr: 'https://github.com/acme/api/pull/1' } });
    const quiet = store.addMonitor({ title: 'Store B', prompt: 'look', durationDays: 3, intervalHours: 6 });
    expect(store.getMonitor(quiet.id).informLead).toBe(false); // the store default; the API defaults new ones to true
    e.sessions = [session({ name: 'lead-v2', paneId: 'p-lead', status: 'blocked' }), session({ name: 'monitor', paneId: 'p-mon', status: 'idle' })];
    await e.tellLeadAboutMonitor(store.getMonitor(m.id), '3 texts failed', false);
    expect(sent.length).toBe(0); // a lead waiting on a permission prompt is never typed into
    e.sessions[0] = session({ name: 'lead-v2', paneId: 'p-lead', status: 'working' });
    await e.tellLeadAboutMonitor(store.getMonitor(quiet.id), 'x', false);
    expect(sent.length).toBe(0); // monitor not set to tell the lead
    await e.tellLeadAboutMonitor(store.getMonitor(m.id), '3 texts failed', false);
    expect(sent.length).toBe(1);
    expect(sent[0].pane).toBe('p-lead');
    expect(sent[0].text).toContain('"Store A" came back bad');
    expect(sent[0].text).toContain('3 texts failed');
    expect(sent[0].text).toContain('https://github.com/acme/api/pull/1');
    expect(sent[0].text).toContain('check_now');
    await e.tellLeadAboutMonitor(store.getMonitor(m.id), 'all sent', true);
    expect(sent[1].text).toContain('is fine again');
    // Mark fixed: the bad check no longer counts; a later bad one alerts again.
    const T = Date.now();
    expect(store.reportMonitor(m.id, { verdict: 'bad', summary: 'failed' }, T).monitor.state).toBe('alerting');
    expect(() => store.setMonitorState(quiet.id, 'resolve', T)).toThrow('not alerting');
    expect(store.setMonitorState(m.id, 'resolve', T + 1000).state).toBe('active');
    expect(store.getMonitor(m.id).resolvedAt).not.toBeNull();
    const again = store.reportMonitor(m.id, { verdict: 'bad', summary: 'failed again' }, T + 2000);
    expect(again.becameAlerting).toBe(true);
    expect(store.reportMonitor(m.id, { verdict: 'ok', summary: 'fine' }, T + 3000).recovered).toBe(true);
  });

  test('a replaced session closes after the set time: never while busy or blocked, never without its successor, not after a no', async () => {
    const store = mem();
    store.saveSettings({ ...store.settings(), mode: 'auto', closeOldAfterMin: 30 });
    const closed: string[] = [];
    const e = new Engine(loadConfig(), store, { close: async (pane: string) => { closed.push(pane); } } as any);
    e.herdrOk = true;
    const r = store.addReplacement({ oldName: 'intake', newName: 'intake-v2', cwd: '/x', model: null, handoffPath: '/x/h.md', sessionId: null, transcriptPath: null });
    const T = Date.now();
    store.updateReplacement(r.id, { state: 'done', promptedAt: new Date(T).toISOString() });
    e.sessions = [session({ name: 'intake', paneId: 'p-old', status: 'idle' }), session({ name: 'intake-v2', paneId: 'p-new', status: 'working' })];
    await e.closeReplaced(T + 10 * 60e3);
    expect(closed).toEqual([]); // too early
    e.sessions[0] = session({ name: 'intake', paneId: 'p-old', status: 'working' });
    await e.closeReplaced(T + 31 * 60e3);
    expect(closed).toEqual([]); // busy: next tick
    e.sessions[0] = session({ name: 'intake', paneId: 'p-old', status: 'blocked' });
    await e.closeReplaced(T + 31 * 60e3);
    expect(closed).toEqual([]); // waits on a permission prompt
    e.sessions = [session({ name: 'intake', paneId: 'p-old', status: 'idle' })];
    await e.closeReplaced(T + 31 * 60e3);
    expect(closed).toEqual([]); // the successor is not running
    e.sessions = [session({ name: 'intake', paneId: 'p-old', status: 'idle' }), session({ name: 'intake-v2', paneId: 'p-new', status: 'idle' })];
    store.saveSettings({ ...store.settings(), closeOldAfterMin: 0 });
    await e.closeReplaced(T + 31 * 60e3);
    expect(closed).toEqual([]); // switched off
    store.saveSettings({ ...store.settings(), closeOldAfterMin: 30 });
    await e.closeReplaced(T + 31 * 60e3);
    expect(closed).toEqual(['p-old']);
    expect(store.getReplacement(r.id)!.closedAt).not.toBeNull();
    await e.closeReplaced(T + 32 * 60e3);
    expect(closed).toEqual(['p-old']); // once
    // Ask first: it waits for approval; a rejection is final.
    const r2 = store.addReplacement({ oldName: 'w1', newName: 'w1-v2', cwd: '/x', model: null, handoffPath: '/x/h2.md', sessionId: null, transcriptPath: null });
    store.updateReplacement(r2.id, { state: 'done', promptedAt: new Date(T).toISOString() });
    store.saveSettings({ ...store.settings(), mode: 'ask' });
    e.sessions = [session({ name: 'w1', paneId: 'p-w1', status: 'idle' }), session({ name: 'w1-v2', paneId: 'p-w2', status: 'idle' })];
    await e.closeReplaced(T + 31 * 60e3);
    const held = store.listActions().filter((a: any) => a.kind === 'close-old' && a.state === 'waiting');
    expect(held.length).toBe(1);
    e.rejectAction(held[0].id);
    await e.closeReplaced(T + 32 * 60e3);
    expect(store.listActions().filter((a: any) => a.kind === 'close-old' && a.state === 'waiting').length).toBe(0);
    expect(closed).toEqual(['p-old']);
  });

  test('dismissing with notes: monitor notes reach every check, Needs attention items hide until undone, finished replacements leave the list', () => {
    const s = mem();
    const m = s.addMonitor({ title: 'Texting', prompt: 'texts send', durationDays: 1, intervalHours: 6 });
    s.reportMonitor(m.id, { verdict: 'bad', summary: 'test numbers rejected' });
    s.setMonitorState(m.id, 'resolve');
    s.addMonitorNote(m.id, 'Rejected texts to test numbers are intentional', 'you');
    const got = s.getMonitor(m.id);
    expect(got.state).toBe('active');
    expect(got.notes.map((n) => n.text)).toEqual(['Rejected texts to test numbers are intentional']);
    const prompt = monitorPrompt(got, null, '/repo');
    expect(prompt).toContain('do not report these as bad');
    expect(prompt).toContain('- Rejected texts to test numbers are intentional');
    s.deleteMonitorNote(m.id, got.notes[0].id);
    expect(monitorPrompt(s.getMonitor(m.id), null, '/repo')).not.toContain('Notes from the owner');
    s.dismiss({ key: 'h:w1:stuck', what: 'w1 is stuck', note: 'waiting on CI', by: 'you' });
    expect(s.listDismissed()).toMatchObject([{ key: 'h:w1:stuck', note: 'waiting on CI', by: 'you' }]);
    s.undismiss('h:w1:stuck');
    expect(s.listDismissed()).toEqual([]);
    const r = s.addReplacement({ oldName: 'a', newName: 'a-v2', cwd: '/x', model: null, handoffPath: '/x/h.md', sessionId: null, transcriptPath: null });
    expect(() => s.dismissReplacement(r.id)).toThrow('still under way');
    s.updateReplacement(r.id, { state: 'done' });
    s.dismissReplacement(r.id);
    expect(s.listReplacements().some((x) => x.id === r.id)).toBe(false);
  });

  test('telling the lead is routine: it runs in Safe auto, waits in Ask first', () => {
    expect(decide('safe', 'auto', 'monitor-lead')).toBe('run');
    expect(decide('ask', 'auto', 'monitor-lead')).toBe('ask');
    expect(decide('dry', 'auto', 'monitor-lead')).toBe('record');
  });
});

describe('monitor checks go through the gate', () => {
  test('Dry run records a due check once and sends nothing; Ask first waits; approving sends it', async () => {
    const store = mem();
    const sent: string[] = [];
    const e = new Engine(loadConfig(), store, { prompt: async (_p: string, t: string) => { sent.push(t); } } as any);
    e.herdrOk = true;
    e.sessions = [session({ name: 'monitor', status: 'idle' })];
    store.addMonitor({ title: 'Store A', prompt: 'look', durationDays: 1, intervalHours: 6 });
    await e.runMonitors();
    await e.runMonitors();
    expect(sent).toEqual([]);
    expect(store.listActions().filter((a) => a.kind === 'monitor-check' && a.state === 'dry').length).toBe(1);
    store.saveSettings({ ...store.settings(), mode: 'ask' });
    store.settleDryActions(true);
    const waiting = store.listActions().find((a) => a.kind === 'monitor-check' && a.state === 'waiting')!;
    await e.approveAction(waiting.id);
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain('Store A');
  });
});

describe('review fixes', () => {
  const req = (path: string, method: string, headers: Record<string, string>, b?: unknown) =>
    [new Request('http://127.0.0.1:4400' + path, { method, headers: { 'x-shiftboss': '1', 'content-type': 'application/json', ...headers }, body: b === undefined ? undefined : JSON.stringify(b) }), new URL('http://127.0.0.1:4400' + path)] as const;
  test('a session acting for the owner needs the switch; setup only until setup is done; the UI always', async () => {
    const store = mem();
    const e = new Engine(loadConfig(), store, {} as any);
    const api = makeApi(e);
    const asSession = { 'x-shiftboss-actor': 'owner', 'x-shiftboss-by': 'lead' };
    expect((await api(...req('/api/mode', 'POST', asSession, { mode: 'auto' })))!.status).toBe(403);
    expect((await api(...req('/api/owner-instructions', 'POST', asSession, { add: 'x' })))!.status).toBe(403);
    expect((await api(...req('/api/owner-instructions', 'POST', {}, { add: 'x' })))!.status).toBe(403);
    expect((await api(...req('/api/mode', 'POST', { 'x-shiftboss-actor': 'owner', 'x-shiftboss-by': 'setup' }, { mode: 'ask' })))!.status).toBe(200);
    store.saveOnboarding({ doneAt: new Date().toISOString() });
    expect((await api(...req('/api/mode', 'POST', { 'x-shiftboss-actor': 'owner', 'x-shiftboss-by': 'setup' }, { mode: 'auto' })))!.status).toBe(403);
    // a session cannot turn the switch on for itself
    await api(...req('/api/settings', 'PUT', asSession, { delegate: true }));
    expect(store.settings().delegate).toBe(false);
    expect((await api(...req('/api/settings', 'PUT', { 'x-shiftboss-actor': 'owner' }, { delegate: true })))!.status).toBe(200);
    expect((await api(...req('/api/mode', 'POST', asSession, { mode: 'safe' })))!.status).toBe(200);
    expect(store.settings().mode).toBe('safe');
  });
  test('settings never change the mode (only /api/mode, which settles the dry-run log)', async () => {
    const store = mem();
    const api = makeApi(new Engine(loadConfig(), store, {} as any));
    await api(...req('/api/settings', 'PUT', { 'x-shiftboss-actor': 'owner' }, { mode: 'auto', thresholds: { warn: 60 } }));
    expect(store.settings().mode).toBe('dry');
    expect(store.settings().thresholds.warn).toBe(60);
  });
  test('a dry-run record is not reused in a live mode; the owner doing it settles the held one', async () => {
    const store = mem();
    const sent: string[] = [];
    const e = new Engine(loadConfig(), store, { prompt: async (_p: string, t: string) => { sent.push(t); } } as any);
    e.sessions = [session({ name: 'worker', status: 'idle' })];
    const meta = { actor: 'session' as const, by: 'lead', summary: 'prompt worker' };
    expect((await e.act('prompt', { session: 'worker', text: 'hi' }, meta)).status).toBe('dry');
    store.saveSettings({ ...store.settings(), mode: 'ask' });
    const held = await e.act('prompt', { session: 'worker', text: 'hi' }, meta);
    expect(held.status).toBe('waiting');
    await e.act('prompt', { session: 'worker', text: 'hi' }, { ...meta, actor: 'owner' });
    expect(sent).toEqual(['hi']);
    await expect(e.approveAction((held as any).id)).rejects.toThrow();
    expect(sent).toEqual(['hi']);
  });
  test('an approved brief is not sent once the task moved on; one held brief per session', async () => {
    const store = mem();
    store.saveSettings({ ...store.settings(), mode: 'ask' });
    const e = new Engine(loadConfig(), store, { prompt: async () => {} } as any);
    e.sessions = [session({ name: 'worker', status: 'idle', slots: 3 })];
    const a = store.addTask({ title: 'A', session: 'worker' }); store.vetTask(a.id);
    const b = store.addTask({ title: 'B', session: 'worker' }); store.vetTask(b.id);
    expect(e.readyToDispatch().length).toBe(1);
    const held = await e.act('dispatch', { taskId: e.readyToDispatch()[0] }, { actor: 'auto', by: 'dispatcher', summary: 'send' });
    expect(e.readyToDispatch()).toEqual([]); // the session already has one waiting
    const id = (held as any).id;
    const t = store.action(id)!.params.taskId;
    store.updateTask(t, { stage: 3 });
    await expect(e.approveAction(id)).rejects.toThrow(/past Queued/);
  });
  test('an approval cut off by a restart fails instead of blocking; an old install with no settings row keeps Autopilot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-fix-'));
    try {
      const s1 = new Store(dir);
      s1.db.exec('DROP TABLE actions');
      s1.db.exec("DELETE FROM settings");
      s1.addTask({ title: 'old work' });
      s1.db.close();
      const s2 = new Store(dir);
      expect(s2.settings().mode).toBe('auto');
      expect(s2.settings().delegate).toBe(true);
      const h = s2.holdAction({ kind: 'prompt', key: 'k', params: {}, summary: 'x', actor: 'session', by: 's', state: 'waiting' });
      s2.setActionState(h.item.id, ['waiting'], 'approved');
      s2.db.close();
      const s3 = new Store(dir);
      expect(s3.action(h.item.id)!.state).toBe('failed');
      expect(s3.hasOpenAction('k')).toBe(false);
      s3.db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});


describe('report: live today', () => {
  test('a task counts as live today when it went live today, not when an old live task is edited', () => {
    const s = mem();
    const t = s.addTask({ title: 'Ship it' });
    s.updateTask(t.id, { stage: 5 });
    expect(s.getTask(t.id)!.liveAt).toBeTruthy();
    const first = s.getTask(t.id)!.liveAt;
    s.db.query("UPDATE tasks SET live_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(t.id);
    s.updateTask(t.id, { title: 'Ship it (renamed)' });
    expect(s.getTask(t.id)!.liveAt).toBe('2020-01-01T00:00:00.000Z');
    expect(first).not.toBeNull();
  });
});
