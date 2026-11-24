import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AuditEntry, Decision, IntakeItem, IntakeState, Need, PromiseItem, Settings, SlackMsg, Stage, Task, TaskEvent,
} from '../shared/types';

export const DEFAULT_SETTINGS: Settings = {
  thresholds: { warn: 70, replace: 85, needsCap: 3, staleMin: 30, stuckMin: 20, loopRepeats: 3 },
  switches: { autoDispatch: false, quietHours: true },
  budgets: { fiveHourTokens: 0, weeklyTokens: 0 },
  herdrWorkspace: '',
  handoffsDir: '',
  leadSession: 'lead-manager',
  watchedChannels: [],
};

const now = () => new Date().toISOString();

export class Store {
  db: Database;
  constructor(dir: string, file = 'shiftboss.db') {
    if (file !== ':memory:') mkdirSync(dir, { recursive: true });
    this.db = new Database(file === ':memory:' ? ':memory:' : join(dir, file), { create: true });
    // busy_timeout: wait up to 5 s for another connection (CLI checks, sqlite tools) instead of failing.
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE NOT NULL, title TEXT NOT NULL, ask TEXT NOT NULL DEFAULT '',
        requester TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', source_url TEXT,
        session TEXT, stage INTEGER NOT NULL DEFAULT 0, prio TEXT NOT NULL DEFAULT 'P2',
        held INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        at TEXT NOT NULL, src TEXT NOT NULL, who TEXT NOT NULL, text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS slack_msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        at TEXT NOT NULL, who TEXT NOT NULL, text TEXT NOT NULL, kind TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS promises (id INTEGER PRIMARY KEY AUTOINCREMENT, to_person TEXT NOT NULL, where_text TEXT NOT NULL DEFAULT '',
        said TEXT NOT NULL, kept_when TEXT NOT NULL DEFAULT '', task_id TEXT, state TEXT NOT NULL DEFAULT 'open',
        due_at TEXT, created_at TEXT NOT NULL, kept_at TEXT);
      CREATE TABLE IF NOT EXISTS needs (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, source TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', code TEXT NOT NULL DEFAULT '', answers TEXT NOT NULL DEFAULT '[]',
        answer TEXT, session TEXT, task_id TEXT, created_at TEXT NOT NULL, answered_at TEXT, auto INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, where_kind TEXT NOT NULL, channel TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL, by_who TEXT NOT NULL DEFAULT '', approval TEXT NOT NULL DEFAULT '', corrected INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS intake (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, src TEXT NOT NULL, who TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL, verdict TEXT NOT NULL, task_id TEXT);
      CREATE TABLE IF NOT EXISTS decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_meta (name TEXT PRIMARY KEY, lane TEXT NOT NULL DEFAULT '', slots INTEGER NOT NULL DEFAULT 2, handoff_path TEXT);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const cols = this.db.query('PRAGMA table_info(tasks)').all() as { name: string }[];
    this.db.exec(`CREATE TABLE IF NOT EXISTS pr_links (url TEXT PRIMARY KEY, task_ids TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL DEFAULT 'OPEN',
      merge_sha TEXT, repo TEXT NOT NULL DEFAULT '', number INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, checked_at TEXT)`);
    const ncols = this.db.query('PRAGMA table_info(needs)').all() as { name: string }[];
    if (!ncols.some((c) => c.name === 'sent_at')) this.db.exec('ALTER TABLE needs ADD COLUMN sent_at TEXT');
    const icols = this.db.query('PRAGMA table_info(intake)').all() as { name: string }[];
    if (!icols.some((c) => c.name === 'url')) this.db.exec('ALTER TABLE intake ADD COLUMN url TEXT');
    if (!cols.some((c) => c.name === 'ext_id')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN ext_id TEXT; CREATE UNIQUE INDEX IF NOT EXISTS tasks_ext_id ON tasks(ext_id);');
    }
  }

  /**
   * Create or update a task that lives in another tracker, keyed by its id there.
   * Safe to run again: a known ext_id updates the task instead of adding a second one.
   */
  importTask(t: { extId: string; title: string; ask?: string; requester?: string; source?: string; sourceUrl?: string | null; session?: string | null; stage: Stage; prio?: Task['prio']; held?: boolean; links?: { label: string; url: string }[] }): { id: string; created: boolean } {
    const row: any = this.db.query('SELECT id, stage FROM tasks WHERE ext_id = ?').get(t.extId);
    if (row) {
      this.db.query('UPDATE tasks SET title=?, ask=?, stage=?, held=?, source_url=COALESCE(?, source_url), updated_at=? WHERE id=?')
        .run(t.title, t.ask ?? '', t.stage, t.held ? 1 : 0, t.sourceUrl ?? null, now(), row.id);
      if (row.stage !== t.stage) this.addEvent(row.id, 'ShiftBoss', 'import', 'Tracker moved it to ' + ['Inbox', 'Queued', 'In progress', 'PR open', 'On dev', 'Live', 'Requester told'][t.stage]);
      return { id: row.id, created: false };
    }
    const task = this.addTask({ title: t.title, ask: t.ask, requester: t.requester, source: t.source, sourceUrl: t.sourceUrl, session: t.session, prio: t.prio, stage: t.stage });
    this.db.query('UPDATE tasks SET ext_id = ?, held = ? WHERE id = ?').run(t.extId, t.held ? 1 : 0, task.id);
    for (const l of t.links ?? []) this.addEvent(task.id, /github/i.test(l.url) ? 'GitHub' : /slack/i.test(l.url) ? 'Slack' : 'ShiftBoss', 'import', `${l.label}: ${l.url}`);
    return { id: task.id, created: true };
  }

  // ---------- tasks ----------
  private rowTask = (r: any): Task => ({
    id: r.id, title: r.title, ask: r.ask, requester: r.requester, source: r.source, sourceUrl: r.source_url,
    session: r.session, stage: r.stage as Stage, prio: r.prio, held: !!r.held, createdAt: r.created_at, updatedAt: r.updated_at,
  });

  listTasks(): Task[] {
    return this.db.query('SELECT * FROM tasks ORDER BY seq DESC').all().map(this.rowTask);
  }
  getTask(id: string): Task | null {
    const r = this.db.query('SELECT * FROM tasks WHERE id = ?').get(id);
    return r ? this.rowTask(r) : null;
  }
  addTask(t: { title: string; ask?: string; requester?: string; source?: string; sourceUrl?: string | null; session?: string | null; prio?: Task['prio']; stage?: Stage }): Task {
    const at = now();
    const tx = this.db.transaction(() => {
      const res = this.db.query(`INSERT INTO tasks (id, title, ask, requester, source, source_url, session, stage, prio, created_at, updated_at)
        VALUES ('pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        t.title, t.ask ?? '', t.requester ?? '', t.source ?? '', t.sourceUrl ?? null, t.session ?? null,
        t.stage ?? (t.session ? 1 : 0), t.prio ?? 'P2', at, at);
      const id = 'T-' + res.lastInsertRowid;
      this.db.query('UPDATE tasks SET id = ? WHERE seq = ?').run(id, res.lastInsertRowid);
      return id;
    });
    const id = tx();
    this.addEvent(id, 'ShiftBoss', 'shiftboss', 'Filed' + (t.requester ? ' for ' + t.requester : '') + (t.source ? ' from ' + t.source : ''));
    return this.getTask(id)!;
  }
  updateTask(id: string, patch: Partial<Pick<Task, 'title' | 'ask' | 'session' | 'stage' | 'prio' | 'held'>>, who = 'you'): Task {
    const cur = this.getTask(id);
    if (!cur) throw new Error('No task ' + id);
    const next = { ...cur, ...patch };
    if (next.stage < 0 || next.stage > 6) throw new Error('Stage must be 0-6');
    this.db.query('UPDATE tasks SET title=?, ask=?, session=?, stage=?, prio=?, held=?, updated_at=? WHERE id=?')
      .run(next.title, next.ask, next.session, next.stage, next.prio, next.held ? 1 : 0, now(), id);
    const notes: string[] = [];
    if (patch.stage !== undefined && patch.stage !== cur.stage) notes.push('Moved to ' + ['Inbox', 'Queued', 'In progress', 'PR open', 'On dev', 'Live', 'Requester told'][patch.stage]);
    if (patch.session !== undefined && patch.session !== cur.session) notes.push('Assigned to ' + (patch.session ?? 'nobody'));
    if (patch.held !== undefined && patch.held !== cur.held) notes.push(patch.held ? 'Put on hold' : 'Resumed');
    if (notes.length) this.addEvent(id, 'ShiftBoss', who, notes.join(' · '));
    // Telling the requester keeps every open promise tied to this task.
    if (patch.stage === 6 && cur.stage !== 6) {
      const kept = this.db.query("UPDATE promises SET state = 'kept', kept_at = ? WHERE task_id = ? AND state != 'kept'").run(now(), id).changes;
      if (kept) this.addEvent(id, 'ShiftBoss', who, `${kept} promise${kept === 1 ? '' : 's'} marked kept`);
    }
    return this.getTask(id)!;
  }
  addEvent(taskId: string, src: TaskEvent['src'], who: string, text: string) {
    this.db.query('INSERT INTO task_events (task_id, at, src, who, text) VALUES (?, ?, ?, ?, ?)').run(taskId, now(), src, who, text);
  }
  events(taskId: string): TaskEvent[] {
    return this.db.query('SELECT id, task_id as taskId, at, src, who, text FROM task_events WHERE task_id = ? ORDER BY id DESC').all(taskId) as TaskEvent[];
  }
  addSlack(taskId: string, who: string, text: string, kind: SlackMsg['kind']) {
    this.db.query('INSERT INTO slack_msgs (task_id, at, who, text, kind) VALUES (?, ?, ?, ?, ?)').run(taskId, now(), who, text, kind);
    this.addEvent(taskId, 'Slack', who, (kind === 'ask' ? 'Asked: ' : kind === 'draft' ? 'Drafted: ' : kind === 'promise' ? 'Promised: ' : 'Posted: ') + text);
  }
  slack(taskId: string): SlackMsg[] {
    return this.db.query('SELECT id, task_id as taskId, at, who, text, kind FROM slack_msgs WHERE task_id = ? ORDER BY id').all(taskId) as SlackMsg[];
  }
  setSlackKind(id: number, kind: SlackMsg['kind']) {
    this.db.query('UPDATE slack_msgs SET kind = ? WHERE id = ?').run(kind, id);
  }

  // ---------- PR links (GitHub auto-advance) ----------
  prLink(url: string): { url: string; taskIds: string[]; state: string; mergeSha: string | null; repo: string; number: number; done: boolean } | null {
    const r: any = this.db.query('SELECT * FROM pr_links WHERE url = ?').get(url);
    return r ? { url: r.url, taskIds: JSON.parse(r.task_ids), state: r.state, mergeSha: r.merge_sha, repo: r.repo, number: r.number, done: !!r.done } : null;
  }
  savePrLink(l: { url: string; taskIds: string[]; state: string; mergeSha: string | null; repo: string; number: number; done: boolean }) {
    this.db.query(`INSERT INTO pr_links (url, task_ids, state, merge_sha, repo, number, done, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET task_ids=excluded.task_ids, state=excluded.state, merge_sha=excluded.merge_sha, done=excluded.done, checked_at=excluded.checked_at`)
      .run(l.url, JSON.stringify(l.taskIds), l.state, l.mergeSha, l.repo, l.number, l.done ? 1 : 0, now());
  }

  // ---------- promises ----------
  private rowPromise = (r: any): PromiseItem => ({ id: r.id, to: r.to_person, where: r.where_text, said: r.said, keptWhen: r.kept_when, taskId: r.task_id, state: r.state, dueAt: r.due_at, createdAt: r.created_at, keptAt: r.kept_at });
  listPromises(): PromiseItem[] { return this.db.query('SELECT * FROM promises ORDER BY id DESC').all().map(this.rowPromise); }
  /** Every promise belongs to a task. Without a (known) task id, one is filed in the Inbox for it. */
  addPromise(p: { to: string; where?: string; said: string; keptWhen?: string; taskId?: string | null; dueAt?: string | null }): PromiseItem {
    const taskId = p.taskId && this.getTask(p.taskId) ? p.taskId : this.taskForPromise(p.to, p.said, p.where ?? '', p.keptWhen ?? '').id;
    const r = this.db.query('INSERT INTO promises (to_person, where_text, said, kept_when, task_id, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(p.to, p.where ?? '', p.said, p.keptWhen ?? '', taskId, p.dueAt ?? null, now());
    this.addEvent(taskId, 'Slack', p.to, `Promised to ${p.to}${p.where ? ' in ' + p.where : ''}: "${p.said}"`);
    return this.rowPromise(this.db.query('SELECT * FROM promises WHERE id = ?').get(r.lastInsertRowid));
  }
  private taskForPromise(to: string, said: string, where: string, keptWhen: string): Task {
    const short = said.length > 90 ? said.slice(0, 87).trimEnd() + '…' : said;
    return this.addTask({ title: `${to}: ${short}`, ask: said + (keptWhen ? `\n\nKept when: ${keptWhen}` : ''), requester: to, source: where || 'promise' });
  }
  /** Gives each promise that has no task (made before promises required one) a task of its own. */
  linkOrphanPromises(): number {
    const rows = this.db.query("SELECT * FROM promises WHERE task_id IS NULL OR task_id = '' OR task_id NOT IN (SELECT id FROM tasks)").all().map(this.rowPromise);
    for (const p of rows) {
      const t = this.taskForPromise(p.to, p.said, p.where, p.keptWhen);
      this.db.query('UPDATE promises SET task_id = ? WHERE id = ?').run(t.id, p.id);
      if (p.state === 'kept') this.updateTask(t.id, { stage: 6 }, 'shiftboss');
    }
    return rows.length;
  }
  linkPromise(id: number, taskId: string) {
    if (!this.getTask(taskId)) throw new Error('No task ' + taskId);
    const p = this.listPromises().find((x) => x.id === id);
    if (!p) throw new Error('No promise ' + id);
    this.db.query('UPDATE promises SET task_id = ? WHERE id = ?').run(taskId, id);
    this.addEvent(taskId, 'ShiftBoss', 'you', `Linked the promise to ${p.to}: "${p.said}"`);
  }
  setPromiseState(id: number, state: PromiseItem['state']) {
    this.db.query('UPDATE promises SET state = ?, kept_at = ? WHERE id = ?').run(state, state === 'kept' ? now() : null, id);
    const p = this.listPromises().find((x) => x.id === id);
    if (p?.taskId && state === 'kept') this.addEvent(p.taskId, 'ShiftBoss', 'you', `Promise to ${p.to} kept`);
  }

  // ---------- needs ----------
  private rowNeed = (r: any): Need => ({ id: r.id, kind: r.kind, source: r.source, title: r.title, body: r.body, code: r.code, answers: JSON.parse(r.answers), answer: r.answer, session: r.session, taskId: r.task_id, createdAt: r.created_at, answeredAt: r.answered_at, sentAt: r.sent_at ?? null, auto: !!r.auto });
  listNeeds(includeAnswered = true): Need[] {
    return this.db.query(`SELECT * FROM needs ${includeAnswered ? '' : 'WHERE answer IS NULL'} ORDER BY id`).all().map(this.rowNeed);
  }
  addNeed(n: { kind: Need['kind']; source?: string; title: string; body?: string; code?: string; answers: string[]; session?: string | null; taskId?: string | null; auto?: boolean }): Need {
    const r = this.db.query('INSERT INTO needs (kind, source, title, body, code, answers, session, task_id, created_at, auto) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(n.kind, n.source ?? '', n.title, n.body ?? '', n.code ?? '', JSON.stringify(n.answers), n.session ?? null, n.taskId ?? null, now(), n.auto ? 1 : 0);
    return this.rowNeed(this.db.query('SELECT * FROM needs WHERE id = ?').get(r.lastInsertRowid));
  }
  answerNeed(id: number, answer: string): Need {
    this.db.query('UPDATE needs SET answer = ?, answered_at = ? WHERE id = ? AND answer IS NULL').run(answer, now(), id);
    return this.rowNeed(this.db.query('SELECT * FROM needs WHERE id = ?').get(id));
  }
  /** Answers older than `graceMs` that have not reached their session yet. */
  pendingAnswers(graceMs: number): Need[] {
    const cutoff = new Date(Date.now() - graceMs).toISOString();
    return this.db.query('SELECT * FROM needs WHERE answer IS NOT NULL AND sent_at IS NULL AND auto = 0 AND answered_at <= ?').all(cutoff).map(this.rowNeed);
  }
  markSent(id: number) { this.db.query('UPDATE needs SET sent_at = ? WHERE id = ?').run(now(), id); }
  /** Take an answer back: the item is open again. Returns what it was, so the caller can tell the session if it was already sent. */
  undoAnswer(id: number): { was: Need } {
    const r = this.db.query('SELECT * FROM needs WHERE id = ?').get(id);
    if (!r) throw new Error('No item ' + id);
    const was = this.rowNeed(r);
    if (!was.answer) throw new Error('Not answered yet');
    if (was.auto) throw new Error('Permission prompts are answered in herdr; there is nothing to undo here');
    this.db.query('UPDATE needs SET answer = NULL, answered_at = NULL, sent_at = NULL WHERE id = ?').run(id);
    return { was };
  }
  openAutoNeedFor(session: string): Need | null {
    const r = this.db.query('SELECT * FROM needs WHERE auto = 1 AND session = ? AND answer IS NULL ORDER BY id DESC LIMIT 1').get(session);
    return r ? this.rowNeed(r) : null;
  }

  // ---------- audit, intake, decisions ----------
  addAudit(a: Omit<AuditEntry, 'id' | 'at' | 'corrected' | 'note'> & { note?: string }) {
    this.db.query('INSERT INTO audit (at, where_kind, channel, text, by_who, approval, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(now(), a.where, a.channel, a.text, a.by, a.approval, a.note ?? '');
  }
  markCorrected(id: number, note: string) { this.db.query('UPDATE audit SET corrected = 1, note = ? WHERE id = ?').run(note, id); }
  listAudit(): AuditEntry[] {
    return this.db.query('SELECT id, at, where_kind as "where", channel, text, by_who as "by", approval, corrected, note FROM audit ORDER BY id DESC LIMIT 500').all()
      .map((r: any) => ({ ...r, corrected: !!r.corrected }));
  }
  addIntake(i: Omit<IntakeItem, 'id' | 'at'>) {
    this.db.query('INSERT INTO intake (at, src, who, text, verdict, task_id, url) VALUES (?, ?, ?, ?, ?, ?, ?)').run(now(), i.src, i.who, i.text, i.verdict, i.taskId, i.url);
  }
  listIntake(limit = 200): IntakeItem[] {
    return this.db.query('SELECT id, at, src, who, text, verdict, task_id as taskId, url FROM intake ORDER BY id DESC LIMIT ?').all(limit) as IntakeItem[];
  }
  intakeCountsByDay(days = 14): { day: string; read: number; filed: number }[] {
    return this.db.query(`SELECT substr(at, 1, 10) as day, count(*) as read, sum(CASE WHEN verdict LIKE 'filed%' THEN 1 ELSE 0 END) as filed
      FROM intake WHERE at >= ? GROUP BY day ORDER BY day`).all(new Date(Date.now() - days * 864e5).toISOString()) as any;
  }
  addDecision(text: string) { this.db.query('INSERT INTO decisions (at, text) VALUES (?, ?)').run(now(), text); }
  listDecisions(limit = 50): Decision[] { return this.db.query('SELECT * FROM decisions ORDER BY id DESC LIMIT ?').all(limit) as Decision[]; }

  // ---------- sessions meta + settings ----------
  meta(name: string): { lane: string; slots: number; handoffPath: string | null } | null {
    const r: any = this.db.query('SELECT * FROM session_meta WHERE name = ?').get(name);
    return r ? { lane: r.lane, slots: r.slots, handoffPath: r.handoff_path } : null;
  }
  setMeta(name: string, m: { lane?: string; slots?: number; handoffPath?: string | null }) {
    const cur = this.meta(name) ?? { lane: '', slots: 2, handoffPath: null };
    const n = { ...cur, ...m };
    if (n.slots < 0 || n.slots > 6) throw new Error('Slots must be 0-6');
    this.db.query('INSERT INTO session_meta (name, lane, slots, handoff_path) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET lane=excluded.lane, slots=excluded.slots, handoff_path=excluded.handoff_path')
      .run(name, n.lane, n.slots, n.handoffPath);
  }
  settings(): Settings {
    const r: any = this.db.query("SELECT value FROM settings WHERE key = 'settings'").get();
    if (!r) return DEFAULT_SETTINGS;
    const s = JSON.parse(r.value);
    return { ...DEFAULT_SETTINGS, ...s, thresholds: { ...DEFAULT_SETTINGS.thresholds, ...s.thresholds }, switches: { ...DEFAULT_SETTINGS.switches, ...s.switches }, budgets: { ...DEFAULT_SETTINGS.budgets, ...s.budgets } };
  }
  // ---------- intake pause / resume / catch-up ----------
  intakeState(): IntakeState {
    const r: any = this.db.query("SELECT value FROM settings WHERE key = 'intake'").get();
    const empty: IntakeState = { paused: false, pausedAt: null, resumeAt: null, since: null, catchUpFrom: null, lastBeginAt: null, lastCheckpointAt: null };
    return r ? { ...empty, ...JSON.parse(r.value) } : empty;
  }
  private saveIntake(s: IntakeState): IntakeState {
    this.db.query("INSERT INTO settings (key, value) VALUES ('intake', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(s));
    return s;
  }
  pauseIntake(until: string | null): IntakeState {
    const cur = this.intakeState();
    if (until !== null && !(Date.parse(until) > Date.now())) throw new Error('Pause until must be a time in the future');
    return this.saveIntake({ ...cur, paused: true, pausedAt: cur.paused ? cur.pausedAt : now(), resumeAt: until });
  }
  /** catchUp: read what came in while paused. Otherwise skip it and start from now. */
  resumeIntake(catchUp: boolean): IntakeState {
    const cur = this.intakeState();
    const from = cur.since ?? cur.pausedAt;
    return this.saveIntake({ ...cur, paused: false, pausedAt: null, resumeAt: null,
      since: catchUp ? cur.since : now(), catchUpFrom: catchUp && cur.paused ? from : null });
  }
  /** Called by the intake at the start of each run: says whether to run and from when. */
  intakeBegin(): IntakeState {
    return this.saveIntake({ ...this.intakeState(), lastBeginAt: now() });
  }
  /** Called by the intake at the end of a run: everything up to `readUntil` has been read. */
  intakeCheckpoint(readUntil: string): IntakeState {
    const t = Date.parse(readUntil);
    if (!Number.isFinite(t)) throw new Error('readUntil must be an ISO time');
    if (t > Date.now() + 60e3) throw new Error('readUntil is in the future');
    const cur = this.intakeState();
    const since = cur.since && Date.parse(cur.since) > t ? cur.since : new Date(t).toISOString();
    return this.saveIntake({ ...cur, since, catchUpFrom: null, lastCheckpointAt: now() });
  }
  saveSettings(s: Settings) {
    this.db.query("INSERT INTO settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(s));
  }
}
