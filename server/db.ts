import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checksLeft, effectiveState, nextDueAfter } from './monitors';
import type { ActionItem, ChatMsg, Direction, Dismissal, Monitor, MonitorCheck, MonitorLinks, MonitorNote, MonitorVerdict, Onboarding, Replacement, ReplacementState,
  AuditEntry, Decision, IntakeItem, IntakeState, Need, PromiseItem, Settings, SlackMsg, Stage, Task, TaskEvent,
} from '../shared/types';
import { DEFAULT_NOTIFY, DEFAULT_SLACK } from '../shared/types';

export const DEFAULT_SETTINGS: Settings = {
  thresholds: { warn: 70, replace: 85, needsCap: 3, staleMin: 30, stuckMin: 20, loopRepeats: 3, cacheWarnM: 500, cacheReplaceM: 1000, leadReplace: 40 },
  switches: { autoDispatch: false, quietHours: true },
  budgets: { fiveHourTokens: 0, weeklyTokens: 0 },
  herdrWorkspace: '',
  handoffsDir: '',
  leadSession: '',
  watchedChannels: [],
  autoUpdate: true,
  mode: 'dry', // a new install watches first; installs from before modes keep Autopilot (see migrate)
  delegate: false, // a new install: only ShiftBoss's own screens make the owner's decisions
  notify: { ...DEFAULT_NOTIFY },
  closeOldAfterMin: 30, // a replaced session closes 30 min after its successor took over; 0 = never
  sessionsPerTab: 2, // two sessions side by side per herdr tab; 4 is tight on a laptop
  autoReplace: true, // worn-out sessions (cache read past the line) are replaced through a handoff
};

const now = () => new Date().toISOString();
/** 'inbound' | 'outbound' | null (unknown). undefined passes through as "not given". Anything else is an error. */
export function checkDirection(v: unknown): Direction | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (v === 'inbound' || v === 'outbound') return v;
  throw new Error('direction must be inbound or outbound');
}
/** Thrown for an id that does not exist; the API answers 404. */
export class NotFound extends Error {}

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
    // vetted: the owner queued or assigned this task in the UI. Only vetted tasks are sent automatically,
    // so text from Slack (filed by the intake) never reaches a session as a prompt without a person.
    const pcols = this.db.query('PRAGMA table_info(promises)').all() as { name: string }[];
    if (!pcols.some((c) => c.name === 'kept_by_task')) this.db.exec('ALTER TABLE promises ADD COLUMN kept_by_task INTEGER NOT NULL DEFAULT 0');
    // Held-back actions (gate.ts): waiting for approval, or recorded in Dry run. params is the JSON the executor needs.
    const hadActions = !!this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'actions'").get();
    this.db.exec(`CREATE TABLE IF NOT EXISTS actions (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL,
      params TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', actor TEXT NOT NULL, by_who TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL, decided_at TEXT, result TEXT)`);
    // Installs from before modes existed ran everything; keep that (Autopilot) instead of the new-install default.
    // That covers installs that never saved settings too: an existing database with any work in it.
    const srow: any = this.db.query("SELECT value FROM settings WHERE key = 'settings'").get();
    if (srow) { const v = JSON.parse(srow.value); if (!('mode' in v)) this.db.query("UPDATE settings SET value = ? WHERE key = 'settings'").run(JSON.stringify({ ...v, mode: 'auto', delegate: true })); }
    else if (!hadActions && (this.db.query('SELECT 1 FROM tasks LIMIT 1').get() || this.db.query('SELECT 1 FROM intake LIMIT 1').get()))
      this.db.query("INSERT INTO settings (key, value) VALUES ('settings', ?)").run(JSON.stringify({ mode: 'auto', delegate: true }));
    // An approval that was running when ShiftBoss stopped (crash, self-update) did not finish: say so, unblock its key.
    this.db.exec("UPDATE actions SET state = 'failed', result = 'interrupted by a restart' WHERE state = 'approved'");
    const icols2 = this.db.query('PRAGMA table_info(intake)').all() as { name: string }[];
    if (!icols2.some((c) => c.name === 'resolved')) this.db.exec('ALTER TABLE intake ADD COLUMN resolved INTEGER NOT NULL DEFAULT 0');
    // When a task first went live: the report's "Live today" must not count an old task that was just edited.
    if (!cols.some((c) => c.name === 'live_at')) this.db.exec("ALTER TABLE tasks ADD COLUMN live_at TEXT; UPDATE tasks SET live_at = updated_at WHERE stage >= 5");
    if (!cols.some((c) => c.name === 'vetted')) this.db.exec('ALTER TABLE tasks ADD COLUMN vetted INTEGER NOT NULL DEFAULT 0');
    const scols = this.db.query('PRAGMA table_info(slack_msgs)').all() as { name: string }[];
    if (!scols.some((c) => c.name === 'approved_at')) this.db.exec('ALTER TABLE slack_msgs ADD COLUMN approved_at TEXT');
    if (!cols.some((c) => c.name === 'ext_id')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN ext_id TEXT; CREATE UNIQUE INDEX IF NOT EXISTS tasks_ext_id ON tasks(ext_id);');
    }
    // Where an item came from and which way it went: url (promises only; tasks and intake already have one)
    // and direction ('inbound' | 'outbound' | NULL when unknown). Old rows stay NULL; nothing is guessed.
    const addCol = (table: string, col: string, type: string) => {
      const have = this.db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!have.some((c) => c.name === col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    };
    addCol('promises', 'url', 'TEXT');
    addCol('promises', 'direction', 'TEXT');
    addCol('tasks', 'direction', 'TEXT');
    addCol('intake', 'direction', 'TEXT');
    this.db.exec(`CREATE TABLE IF NOT EXISTS replacements (id INTEGER PRIMARY KEY AUTOINCREMENT, old_name TEXT NOT NULL, new_name TEXT NOT NULL,
      cwd TEXT NOT NULL, model TEXT, handoff_path TEXT NOT NULL, session_id TEXT, transcript_path TEXT, state TEXT NOT NULL,
      started_at TEXT NOT NULL, updated_at TEXT NOT NULL, requested_at TEXT, prompted_at TEXT, error TEXT, missing TEXT NOT NULL DEFAULT '[]')`);
    // Monitors: watch something for a few days after it shipped. state is what was stored (active | paused |
    // finished); "alerting" is worked out from the checks, so it clears itself when a good check comes in.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS monitors (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, prompt TEXT NOT NULL,
        links TEXT NOT NULL DEFAULT '{}', task_id TEXT, duration_days INTEGER NOT NULL, interval_hours INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'active', started_at TEXT NOT NULL, ends_at TEXT NOT NULL, next_due_at TEXT,
        paused_at TEXT, finished_at TEXT, finish_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS monitor_checks (id INTEGER PRIMARY KEY AUTOINCREMENT, monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        due_at TEXT NOT NULL, sent_at TEXT, reported_at TEXT, verdict TEXT, summary TEXT NOT NULL DEFAULT '', details TEXT NOT NULL DEFAULT '',
        links TEXT NOT NULL DEFAULT '[]');
      CREATE INDEX IF NOT EXISTS monitor_checks_monitor ON monitor_checks(monitor_id, id);
    `);
    this.db.exec(`CREATE TABLE IF NOT EXISTS monitor_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        at TEXT NOT NULL, by_who TEXT NOT NULL, text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dismissals (key TEXT PRIMARY KEY, at TEXT NOT NULL, what TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', by_who TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS slack_threads (dest TEXT NOT NULL, thread TEXT NOT NULL, channel TEXT NOT NULL, ts TEXT NOT NULL, title TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (dest, thread));
      CREATE TABLE IF NOT EXISTS slack_held (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, route TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
        session TEXT NOT NULL, state TEXT NOT NULL, key TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS chat_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    const rcols = this.db.query('PRAGMA table_info(replacements)').all() as { name: string }[];
    if (!rcols.some((c) => c.name === 'dismissed_at')) this.db.exec('ALTER TABLE replacements ADD COLUMN dismissed_at TEXT');
    if (!rcols.some((c) => c.name === 'hold_until')) this.db.exec('ALTER TABLE replacements ADD COLUMN hold_until TEXT');
    if (!rcols.some((c) => c.name === 'closed_at')) {
      this.db.exec('ALTER TABLE replacements ADD COLUMN closed_at TEXT');
      // Replacements finished before auto-close existed stay the owner's to close: only recent ones (2 h) are closed for them.
      this.db.query("UPDATE replacements SET closed_at = prompted_at WHERE state = 'done' AND prompted_at < ?").run(new Date(Date.now() - 2 * 3600e3).toISOString());
    }
    const mcols = this.db.query('PRAGMA table_info(monitors)').all() as { name: string }[];
    if (!mcols.some((c) => c.name === 'inform_lead')) this.db.exec('ALTER TABLE monitors ADD COLUMN inform_lead INTEGER NOT NULL DEFAULT 0');
    if (!mcols.some((c) => c.name === 'resolved_at')) this.db.exec('ALTER TABLE monitors ADD COLUMN resolved_at TEXT');
  }

  /**
   * Create or update a task that lives in another tracker, keyed by its id there.
   * Safe to run again: a known ext_id updates the task instead of adding a second one.
   */
  importTask(t: { extId: string; title: string; ask?: string; requester?: string; source?: string; sourceUrl?: string | null; session?: string | null; stage: Stage; prio?: Task['prio']; held?: boolean; links?: { label: string; url: string }[] }): { id: string; created: boolean } {
    const row: any = this.db.query('SELECT id, stage FROM tasks WHERE ext_id = ?').get(t.extId);
    if (row) {
      // A re-import only moves a task forward: work ShiftBoss has seen ship must not be undone by an older export.
      const stage = Math.max(row.stage, t.stage);
      this.db.query(`UPDATE tasks SET title=?, ask=?, stage=?, held=?, source_url=COALESCE(?, source_url), prio=COALESCE(?, prio),
        session=COALESCE(?, session), requester=COALESCE(?, requester), updated_at=? WHERE id=?`)
        .run(t.title, t.ask ?? '', stage, t.held ? 1 : 0, t.sourceUrl ?? null, t.prio ?? null, t.session ?? null, t.requester ?? null, now(), row.id);
      if (row.stage !== stage) this.addEvent(row.id, 'ShiftBoss', 'import', 'Tracker moved it to ' + ['Inbox', 'Queued', 'In progress', 'PR open', 'On dev', 'Live', 'Requester told'][stage]);
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
    session: r.session, stage: r.stage as Stage, prio: r.prio, held: !!r.held, vetted: !!r.vetted, createdAt: r.created_at, updatedAt: r.updated_at,
    direction: r.direction ?? null, liveAt: r.live_at ?? null,
  });

  vetTask(id: string) { this.db.query('UPDATE tasks SET vetted = 1 WHERE id = ?').run(id); }
  approveSlack(id: number) { this.db.query('UPDATE slack_msgs SET approved_at = ? WHERE id = ? AND approved_at IS NULL').run(now(), id); }
  listTasks(): Task[] {
    return this.db.query('SELECT * FROM tasks ORDER BY seq DESC').all().map(this.rowTask);
  }
  getTask(id: string): Task | null {
    const r = this.db.query('SELECT * FROM tasks WHERE id = ?').get(id);
    return r ? this.rowTask(r) : null;
  }
  addTask(t: { title: string; ask?: string; requester?: string; source?: string; sourceUrl?: string | null; session?: string | null; prio?: Task['prio']; stage?: Stage; direction?: Direction }): Task {
    const at = now();
    const direction = checkDirection(t.direction) ?? null;
    const tx = this.db.transaction(() => {
      const res = this.db.query(`INSERT INTO tasks (id, title, ask, requester, source, source_url, session, stage, prio, created_at, updated_at, direction)
        VALUES ('pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        t.title, t.ask ?? '', t.requester ?? '', t.source ?? '', t.sourceUrl ?? null, t.session ?? null,
        t.stage ?? (t.session ? 1 : 0), t.prio ?? 'P2', at, at, direction);
      const id = 'T-' + res.lastInsertRowid;
      this.db.query('UPDATE tasks SET id = ? WHERE seq = ?').run(id, res.lastInsertRowid);
      return id;
    });
    const id = tx();
    this.addEvent(id, 'ShiftBoss', 'shiftboss', 'Filed' + (t.requester ? ' for ' + t.requester : '') + (t.source ? ' from ' + t.source : ''));
    return this.getTask(id)!;
  }
  updateTask(id: string, patch: Partial<Pick<Task, 'title' | 'ask' | 'session' | 'stage' | 'prio' | 'held' | 'sourceUrl' | 'direction'>>, who = 'you'): Task {
    const cur = this.getTask(id);
    if (!cur) throw new NotFound('No task ' + id);
    if (patch.prio !== undefined && !['P1', 'P2', 'P3'].includes(patch.prio)) throw new Error('prio must be P1, P2 or P3');
    const next = { ...cur, ...patch };
    if (next.stage < 0 || next.stage > 6) throw new Error('Stage must be 0-6');
    checkDirection(next.direction);
    this.db.query('UPDATE tasks SET title=?, ask=?, session=?, stage=?, prio=?, held=?, source_url=?, direction=?, updated_at=? WHERE id=?')
      .run(next.title, next.ask, next.session, next.stage, next.prio, next.held ? 1 : 0, next.sourceUrl ?? null, next.direction ?? null, now(), id);
    if (next.stage >= 5 && cur.stage < 5) this.db.query('UPDATE tasks SET live_at = COALESCE(live_at, ?) WHERE id = ?').run(now(), id);
    const notes: string[] = [];
    if (patch.sourceUrl !== undefined && patch.sourceUrl !== cur.sourceUrl) notes.push(patch.sourceUrl ? 'Source link set: ' + patch.sourceUrl : 'Source link removed');
    if (patch.direction !== undefined && patch.direction !== cur.direction) notes.push(patch.direction ? 'Marked ' + patch.direction : 'Direction cleared');
    if (patch.stage !== undefined && patch.stage !== cur.stage) notes.push('Moved to ' + ['Inbox', 'Queued', 'In progress', 'PR open', 'On dev', 'Live', 'Requester told'][patch.stage]);
    if (patch.session !== undefined && patch.session !== cur.session) notes.push('Assigned to ' + (patch.session ?? 'nobody'));
    if (patch.held !== undefined && patch.held !== cur.held) notes.push(patch.held ? 'Put on hold' : 'Resumed');
    if (notes.length) this.addEvent(id, 'ShiftBoss', who, notes.join(' · '));
    // Telling the requester keeps every open promise tied to this task.
    if (patch.stage === 6 && cur.stage !== 6) {
      const kept = this.db.query("UPDATE promises SET state = 'kept', kept_at = ?, kept_by_task = 1 WHERE task_id = ? AND state != 'kept'").run(now(), id).changes;
      if (kept) this.addEvent(id, 'ShiftBoss', who, `${kept} promise${kept === 1 ? '' : 's'} marked kept`);
    }
    // Moving back from "Requester told" reopens exactly the promises that move closed.
    if (cur.stage === 6 && patch.stage !== undefined && patch.stage < 6) {
      const reopened = this.db.query("UPDATE promises SET state = 'open', kept_at = NULL, kept_by_task = 0 WHERE task_id = ? AND kept_by_task = 1").run(id).changes;
      if (reopened) this.addEvent(id, 'ShiftBoss', who, `${reopened} promise${reopened === 1 ? '' : 's'} reopened`);
    }
    return this.getTask(id)!;
  }
  addEvent(taskId: string, src: TaskEvent['src'], who: string, text: string) {
    if (!this.db.query('SELECT 1 FROM tasks WHERE id = ?').get(taskId)) throw new NotFound('No task ' + taskId);
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
  /** PRs still being followed (not closed, not live): re-checked even when no running transcript names them. */
  openPrUrls(): string[] {
    return (this.db.query('SELECT url FROM pr_links WHERE done = 0').all() as { url: string }[]).map((r) => r.url);
  }
  savePrLink(l: { url: string; taskIds: string[]; state: string; mergeSha: string | null; repo: string; number: number; done: boolean }) {
    this.db.query(`INSERT INTO pr_links (url, task_ids, state, merge_sha, repo, number, done, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET task_ids=excluded.task_ids, state=excluded.state, merge_sha=excluded.merge_sha, done=excluded.done, checked_at=excluded.checked_at`)
      .run(l.url, JSON.stringify(l.taskIds), l.state, l.mergeSha, l.repo, l.number, l.done ? 1 : 0, now());
  }

  // ---------- promises ----------
  private rowPromise = (r: any): PromiseItem => ({ id: r.id, to: r.to_person, where: r.where_text, said: r.said, keptWhen: r.kept_when, taskId: r.task_id,
    // Overdue is worked out from the due time when read, so it is never stale.
    state: r.state === 'open' && r.due_at && Date.parse(r.due_at) < Date.now() ? 'due' : r.state,
    dueAt: r.due_at, createdAt: r.created_at, keptAt: r.kept_at, url: r.url ?? null, direction: r.direction ?? null,
    // Its own link, else its task's source link ("via T-n"). Worked out when read, never stored: fixing the task's
    // link fixes the promise too, and an old promise with no link of its own still points somewhere.
    link: r.url ? { url: r.url, via: null } : r.task_url ? { url: r.task_url, via: r.task_id } : null });
  private static PROMISE_SELECT = 'SELECT p.*, t.source_url AS task_url FROM promises p LEFT JOIN tasks t ON t.id = p.task_id';
  listPromises(): PromiseItem[] { return this.db.query(Store.PROMISE_SELECT + ' ORDER BY p.id DESC').all().map(this.rowPromise); }
  getPromise(id: number): PromiseItem | null {
    const r = this.db.query(Store.PROMISE_SELECT + ' WHERE p.id = ?').get(id);
    return r ? this.rowPromise(r) : null;
  }
  /** Fix a promise's own link or direction (a person on the promise page, or a session). null clears it. */
  updatePromiseSource(id: number, patch: { url?: string | null; direction?: Direction }, who = 'you'): PromiseItem {
    const cur = this.getPromise(id);
    if (!cur) throw new NotFound('No promise ' + id);
    const url = patch.url !== undefined ? patch.url : cur.url;
    const d = checkDirection(patch.direction);
    const direction = d !== undefined ? d : cur.direction;
    this.db.query('UPDATE promises SET url = ?, direction = ? WHERE id = ?').run(url, direction, id);
    if (cur.taskId && patch.url !== undefined && patch.url !== cur.url) {
      this.addEvent(cur.taskId, 'ShiftBoss', who, patch.url ? `Link for the promise to ${cur.to}: ${patch.url}` : `Removed the link of the promise to ${cur.to}`);
    }
    return this.getPromise(id)!;
  }
  /** Every promise belongs to a task. Without a (known) task id, one is filed in the Inbox for it. */
  addPromise(p: { to: string; where?: string; said: string; keptWhen?: string; taskId?: string | null; dueAt?: string | null; url?: string | null; direction?: Direction }): PromiseItem {
    const direction = checkDirection(p.direction) ?? null;
    const taskId = p.taskId && this.getTask(p.taskId) ? p.taskId : this.taskForPromise(p.to, p.said, p.where ?? '', p.keptWhen ?? '', p.url ?? null, direction).id;
    const r = this.db.query('INSERT INTO promises (to_person, where_text, said, kept_when, task_id, due_at, created_at, url, direction) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p.to, p.where ?? '', p.said, p.keptWhen ?? '', taskId, p.dueAt ?? null, now(), p.url ?? null, direction);
    this.addEvent(taskId, 'Slack', p.to, `Promised to ${p.to}${p.where ? ' in ' + p.where : ''}: "${p.said}"`);
    return this.getPromise(Number(r.lastInsertRowid))!;
  }
  private taskForPromise(to: string, said: string, where: string, keptWhen: string, url: string | null = null, direction: Direction = null): Task {
    const short = said.length > 90 ? said.slice(0, 87).trimEnd() + '…' : said;
    return this.addTask({ title: `${to}: ${short}`, ask: said + (keptWhen ? `\n\nKept when: ${keptWhen}` : ''), requester: to, source: where || 'promise', sourceUrl: url, direction });
  }
  /** Gives each promise that has no task (made before promises required one) a task of its own. */
  linkOrphanPromises(): number {
    const rows = this.db.query("SELECT *, NULL AS task_url FROM promises WHERE task_id IS NULL OR task_id = '' OR task_id NOT IN (SELECT id FROM tasks)").all().map(this.rowPromise);
    for (const p of rows) {
      const t = this.taskForPromise(p.to, p.said, p.where, p.keptWhen, p.url, p.direction);
      this.db.query('UPDATE promises SET task_id = ? WHERE id = ?').run(t.id, p.id);
      if (p.state === 'kept') this.updateTask(t.id, { stage: 6 }, 'shiftboss');
    }
    return rows.length;
  }
  linkPromise(id: number, taskId: string) {
    if (!this.getTask(taskId)) throw new Error('No task ' + taskId);
    const p = this.listPromises().find((x) => x.id === id);
    if (!p) throw new NotFound('No promise ' + id);
    this.db.query('UPDATE promises SET task_id = ? WHERE id = ?').run(taskId, id);
    this.addEvent(taskId, 'ShiftBoss', 'you', `Linked the promise to ${p.to}: "${p.said}"`);
  }
  setPromiseState(id: number, state: PromiseItem['state']) {
    if (!this.listPromises().some((x) => x.id === id)) throw new NotFound('No promise ' + id);
    if (!['open', 'ready', 'waiting', 'due', 'kept'].includes(state)) throw new Error('state must be open, due or kept');
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
  /**
   * Claim an answer for sending: stamps `sent_at` only if this exact answer is still there and unsent.
   * Returns the stamp, or null when it was undone, re-answered or already claimed. Claiming before the
   * send means an undo that lands mid-send sees `sentAt` and takes the reopen path (tells the session).
   */
  claimSend(n: Pick<Need, 'id' | 'answer' | 'answeredAt'>): string | null {
    if (!n.answer || !n.answeredAt) return null;
    const at = now();
    const r = this.db.query('UPDATE needs SET sent_at = ? WHERE id = ? AND sent_at IS NULL AND answer = ? AND answered_at = ?').run(at, n.id, n.answer, n.answeredAt);
    return r.changes === 1 ? at : null;
  }
  /** The send failed: put the claim back so the next tick retries, unless the answer changed meanwhile. */
  releaseSend(id: number, claimedAt: string) {
    this.db.query('UPDATE needs SET sent_at = NULL WHERE id = ? AND sent_at = ?').run(id, claimedAt);
  }
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
  openAutoNeeds(): Need[] {
    return (this.db.query('SELECT * FROM needs WHERE auto = 1 AND answer IS NULL').all() as any[]).map((r) => this.rowNeed(r));
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
  markCorrected(id: number, note: string) {
    if (!this.db.query('UPDATE audit SET corrected = 1, note = ? WHERE id = ?').run(note, id).changes) throw new NotFound('No audit entry ' + id);
  }
  listAudit(): AuditEntry[] {
    return this.db.query('SELECT id, at, where_kind as "where", channel, text, by_who as "by", approval, corrected, note FROM audit ORDER BY id DESC LIMIT 500').all()
      .map((r: any) => ({ ...r, corrected: !!r.corrected }));
  }
  addIntake(i: Omit<IntakeItem, 'id' | 'at' | 'direction'> & { direction?: Direction }) {
    this.db.query('INSERT INTO intake (at, src, who, text, verdict, task_id, url, direction) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(now(), i.src, i.who, i.text, i.verdict, i.taskId, i.url, checkDirection(i.direction) ?? null);
  }
  listIntake(limit = 200): IntakeItem[] {
    return (this.db.query('SELECT id, at, src, who, text, verdict, task_id as taskId, url, direction FROM intake ORDER BY id DESC LIMIT ?').all(limit) as any[])
      .map((r) => ({ ...r, direction: r.direction ?? null })) as IntakeItem[];
  }
  /**
   * One page of the intake log, newest first, with the total for the pager. kind: filed (became or joined a task),
   * lead (sent to the lead), dropped, check (a confused thread); q matches text, source or sender.
   */
  pageIntake(f: { from?: string; to?: string; kind?: string; q?: string; direction?: string; offset?: number; limit?: number }): { items: IntakeItem[]; total: number } {
    const where: string[] = [], args: (string | number)[] = [];
    if (f.from) { where.push('at >= ?'); args.push(f.from); }
    if (f.to) { where.push('at < ?'); args.push(f.to); }
    if (f.kind === 'filed') where.push("(verdict LIKE 'filed%' OR verdict LIKE 'linked%')");
    else if (f.kind === 'lead') where.push("verdict = 'to lead'");
    else if (f.kind === 'dropped') where.push("verdict = 'dropped'");
    else if (f.kind === 'check') where.push("verdict LIKE 'check%'");
    if (f.direction === 'inbound' || f.direction === 'outbound') { where.push('direction = ?'); args.push(f.direction); }
    if (f.q?.trim()) { where.push('(text LIKE ? OR src LIKE ? OR who LIKE ?)'); const q = '%' + f.q.trim() + '%'; args.push(q, q, q); }
    const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const total = (this.db.query('SELECT COUNT(*) AS n FROM intake' + w).get(...args) as { n: number }).n;
    const limit = Math.min(200, Math.max(1, f.limit ?? 50)), offset = Math.max(0, f.offset ?? 0);
    const items = (this.db.query('SELECT id, at, src, who, text, verdict, task_id as taskId, url, direction FROM intake' + w + ' ORDER BY id DESC LIMIT ? OFFSET ?').all(...args, limit, offset) as any[])
      .map((r) => ({ ...r, direction: r.direction ?? null })) as IntakeItem[];
    return { items, total };
  }
  /** Messages read and turned into tasks per day, in the viewer's time zone (offset in minutes east of UTC). */
  intakeCountsByDay(days = 14, tzMin = 0): { day: string; read: number; filed: number }[] {
    const off = `${tzMin >= 0 ? '+' : '-'}${Math.abs(Math.trunc(tzMin))} minutes`;
    return this.db.query(`SELECT date(at, ?) as day, count(*) as read, sum(CASE WHEN verdict LIKE 'filed%' OR verdict LIKE 'linked%' THEN 1 ELSE 0 END) as filed
      FROM intake WHERE at >= ? GROUP BY day ORDER BY day`).all(off, new Date(Date.now() - (days + 1) * 864e5).toISOString()) as any;
  }
  /** Threads the intake flagged as Claude sessions being confused, not yet dismissed (last 3 days). */
  openThreadChecks(): { id: number; at: string; src: string; who: string; text: string; url: string | null }[] {
    return this.db.query("SELECT id, at, src, who, text, url FROM intake WHERE verdict LIKE 'check%' AND resolved = 0 AND at >= ? ORDER BY id DESC LIMIT 20")
      .all(new Date(Date.now() - 3 * 864e5).toISOString()) as any;
  }
  resolveIntake(id: number) {
    if (!this.db.query('UPDATE intake SET resolved = 1 WHERE id = ?').run(id).changes) throw new NotFound('No intake item ' + id);
  }
  addDecision(text: string) { this.db.query('INSERT INTO decisions (at, text) VALUES (?, ?)').run(now(), text); }
  listDecisions(limit = 50): Decision[] { return this.db.query('SELECT * FROM decisions ORDER BY id DESC LIMIT ?').all(limit) as Decision[]; }

  // ---------- replacements ----------
  private rowRepl = (r: any): Replacement => ({
    id: r.id, oldName: r.old_name, newName: r.new_name, cwd: r.cwd, model: r.model, handoffPath: r.handoff_path, sessionId: r.session_id,
    transcriptPath: r.transcript_path, state: r.state, startedAt: r.started_at, updatedAt: r.updated_at, requestedAt: r.requested_at,
    promptedAt: r.prompted_at, error: r.error, missing: JSON.parse(r.missing || '[]'), closedAt: r.closed_at ?? null, dismissedAt: r.dismissed_at ?? null, holdUntil: r.hold_until ?? null,
  });
  /** Keep the old session open until this time (null: the normal rule again). */
  holdReplacement(id: number, until: string | null) {
    if (!this.getReplacement(id)) throw new NotFound('No replacement ' + id);
    this.db.query('UPDATE replacements SET hold_until = ? WHERE id = ?').run(until, id);
  }
  /** Hide a finished replacement from the list. One still under way must be cancelled instead. */
  dismissReplacement(id: number) {
    const r = this.getReplacement(id);
    if (!r) throw new NotFound('No replacement ' + id);
    if (!['done', 'failed', 'cancelled'].includes(r.state)) throw new Error('This replacement is still under way: cancel it instead.');
    this.db.query('UPDATE replacements SET dismissed_at = ? WHERE id = ?').run(now(), id);
  }
  // ---------- dismissed Needs attention items ----------
  dismiss(d: { key: string; what: string; note?: string; by: string }) {
    this.db.query('INSERT OR REPLACE INTO dismissals (key, at, what, note, by_who) VALUES (?, ?, ?, ?, ?)').run(d.key, now(), d.what, d.note ?? '', d.by);
  }
  undismiss(key: string) { if (!this.db.query('DELETE FROM dismissals WHERE key = ?').run(key).changes) throw new NotFound('Not dismissed'); }
  listDismissed(): Dismissal[] {
    this.db.query('DELETE FROM dismissals WHERE at < ?').run(new Date(Date.now() - 14 * 864e5).toISOString());
    return this.db.query('SELECT key, at, what, note, by_who AS by FROM dismissals ORDER BY at DESC LIMIT 200').all() as Dismissal[];
  }
  /** Done replacements whose old session ShiftBoss has not closed yet, oldest first. */
  replacementsToClose(): Replacement[] {
    return this.db.query("SELECT * FROM replacements WHERE state = 'done' AND closed_at IS NULL AND prompted_at IS NOT NULL ORDER BY id").all().map(this.rowRepl);
  }
  markReplacementClosed(id: number) { this.db.query('UPDATE replacements SET closed_at = ? WHERE id = ? AND closed_at IS NULL').run(now(), id); }
  addReplacement(r: { oldName: string; newName: string; cwd: string; model: string | null; handoffPath: string; sessionId: string | null; transcriptPath: string | null }): Replacement {
    const at = now();
    const res = this.db.query(`INSERT INTO replacements (old_name, new_name, cwd, model, handoff_path, session_id, transcript_path, state, started_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(r.oldName, r.newName, r.cwd, r.model, r.handoffPath, r.sessionId, r.transcriptPath, at, at);
    return this.getReplacement(Number(res.lastInsertRowid))!;
  }
  getReplacement(id: number): Replacement | null {
    const r = this.db.query('SELECT * FROM replacements WHERE id = ?').get(id);
    return r ? this.rowRepl(r) : null;
  }
  /** Still running, finished or failed in the last day, newest first. */
  listReplacements(): Replacement[] {
    const since = new Date(Date.now() - 864e5).toISOString();
    return this.db.query(`SELECT * FROM replacements WHERE dismissed_at IS NULL AND (state NOT IN ('done', 'failed', 'cancelled') OR updated_at >= ?) ORDER BY id DESC LIMIT 100`).all(since).map(this.rowRepl);
  }
  /** The replacement still under way for this session, if any. */
  // ----- lead chat -----
  /** A message you sent from the chat panel; `seen` once the lead's transcript shows it. */
  addChatOut(session: string, text: string, at = new Date().toISOString()): number {
    return Number(this.db.query('INSERT INTO chat (at, role, text, session, state) VALUES (?, ?, ?, ?, ?)').run(at, 'you', text, session, 'sent').lastInsertRowid);
  }
  /** Bring in what the lead's transcript shows: your messages it picked up, and its replies (which grow while it types). */
  syncChat(session: string, turns: { key: string; at: number; role: 'you' | 'lead'; text: string }[]) {
    const cleared = Number((this.db.query("SELECT value FROM chat_meta WHERE key = 'cleared_at'").get() as { value: string } | null)?.value ?? 0);
    for (const t of turns) {
      if (t.at <= cleared) continue; // cleared: the transcript still holds it, the chat does not
      const key = session + ':' + t.key;
      if (t.role === 'you') {
        if (this.db.query('SELECT 1 FROM chat WHERE key = ?').get(key)) continue;
        const out = this.db.query("SELECT id FROM chat WHERE role = 'you' AND state = 'sent' AND key IS NULL AND text = ? ORDER BY id LIMIT 1").get(t.text) as { id: number } | null;
        if (out) this.db.query("UPDATE chat SET state = 'seen', key = ? WHERE id = ?").run(key, out.id);
        else this.db.query('INSERT OR IGNORE INTO chat (at, role, text, session, state, key) VALUES (?, ?, ?, ?, ?, ?)').run(new Date(t.at).toISOString(), 'you', t.text, session, 'seen', key);
      } else {
        // only a reply that grew is written, so an unchanged snapshot stays unchanged (frames are skipped on no writes)
        this.db.query("INSERT INTO chat (at, role, text, session, state, key) VALUES (?, 'lead', ?, ?, 'reply', ?) ON CONFLICT(key) DO UPDATE SET text = excluded.text WHERE chat.text <> excluded.text")
          .run(new Date(t.at).toISOString(), t.text, session, key);
      }
    }
  }
  listChat(limit = 80): ChatMsg[] {
    const rows = this.db.query('SELECT id, at, role, text, session, state FROM chat ORDER BY at DESC, id DESC LIMIT ?').all(limit) as ChatMsg[];
    return rows.reverse();
  }
  clearChat(nowMs = Date.now()) {
    this.db.exec('DELETE FROM chat');
    this.db.query("INSERT INTO chat_meta (key, value) VALUES ('cleared_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(nowMs));
  }
  dropChat(id: number) { this.db.query('DELETE FROM chat WHERE id = ?').run(id); }

  activeReplacementFor(oldName: string): Replacement | null {
    const r = this.db.query(`SELECT * FROM replacements WHERE old_name = ? AND state NOT IN ('done', 'failed', 'cancelled') ORDER BY id DESC LIMIT 1`).get(oldName);
    return r ? this.rowRepl(r) : null;
  }
  updateReplacement(id: number, patch: Partial<Pick<Replacement, 'state' | 'newName' | 'requestedAt' | 'promptedAt' | 'error' | 'missing'>>): Replacement {
    const cur = this.getReplacement(id);
    if (!cur) throw new Error('No replacement ' + id);
    const n = { ...cur, ...patch };
    this.db.query('UPDATE replacements SET state=?, new_name=?, requested_at=?, prompted_at=?, error=?, missing=?, updated_at=? WHERE id=?')
      .run(n.state, n.newName, n.requestedAt, n.promptedAt, n.error, JSON.stringify(n.missing), now(), id);
    return this.getReplacement(id)!;
  }
  /** Compare-and-set on state, so the engine tick and an API call cannot both advance one row. */
  claimReplacement(id: number, from: ReplacementState[], to: ReplacementState): boolean {
    return this.db.query(`UPDATE replacements SET state = ?, updated_at = ? WHERE id = ? AND state IN (${from.map(() => '?').join(',')})`).run(to, now(), id, ...from).changes === 1;
  }
  /**
   * A replaced session's ShiftBoss state goes to its successor: tasks not yet told, questions (and answers not yet delivered) it
   * was waiting for, and its lane and slots. Each moved task logs the move. Safe to run twice.
   */
  moveSessionState(from: string, to: string, who = 'shiftboss'): { tasks: string[]; needs: number } {
    const tx = this.db.transaction(() => {
      const ids = (this.db.query('SELECT id FROM tasks WHERE session = ? AND stage < 6').all(from) as { id: string }[]).map((r) => r.id);
      for (const id of ids) {
        this.db.query('UPDATE tasks SET session = ?, updated_at = ? WHERE id = ?').run(to, now(), id);
        this.addEvent(id, 'ShiftBoss', who, `Moved from ${from} to ${to}: ${from} was replaced`);
      }
      const needs = this.db.query('UPDATE needs SET session = ? WHERE session = ? AND sent_at IS NULL AND auto = 0').run(to, from).changes;
      const m = this.meta(from);
      if (m) this.setMeta(to, { lane: m.lane, slots: m.slots });
      return { tasks: ids, needs };
    });
    return tx();
  }

  // ---------- sessions meta + settings ----------
  meta(name: string): { lane: string; slots: number; handoffPath: string | null } | null {
    const r: any = this.db.query('SELECT * FROM session_meta WHERE name = ?').get(name);
    return r ? { lane: r.lane, slots: r.slots, handoffPath: r.handoff_path } : null;
  }
  setMeta(name: string, m: { lane?: string; slots?: number; handoffPath?: string | null }) {
    const cur = this.meta(name) ?? { lane: '', slots: 2, handoffPath: null };
    // Only the fields given change: an undefined key must not overwrite the stored value with NULL.
    const given = Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined));
    const n = { ...cur, ...given, lane: (given.lane as string | undefined) ?? cur.lane ?? '' };
    if (!Number.isInteger(n.slots) || n.slots < 0 || n.slots > 6) throw new Error('Slots must be a whole number from 0 to 6');
    this.db.query('INSERT INTO session_meta (name, lane, slots, handoff_path) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET lane=excluded.lane, slots=excluded.slots, handoff_path=excluded.handoff_path')
      .run(name, n.lane, n.slots, n.handoffPath);
  }
  /**
   * Rows written through this connection so far. Moves on every write, including ones the snapshot does
   * not show (task events, Slack text), so the live stream still pushes and pages that fetch them refresh.
   */
  writeCount(): number {
    return (this.db.query('SELECT total_changes() AS n').get() as { n: number }).n;
  }
  settings(): Settings {
    const r: any = this.db.query("SELECT value FROM settings WHERE key = 'settings'").get();
    if (!r) return DEFAULT_SETTINGS;
    const s = JSON.parse(r.value);
    return { ...DEFAULT_SETTINGS, ...s, thresholds: { ...DEFAULT_SETTINGS.thresholds, ...s.thresholds }, switches: { ...DEFAULT_SETTINGS.switches, ...s.switches }, budgets: { ...DEFAULT_SETTINGS.budgets, ...s.budgets },
      notify: { ...DEFAULT_NOTIFY, ...s.notify },
      slack: { ...DEFAULT_SLACK, ...s.slack, kinds: { dm: { ...DEFAULT_SLACK.kinds.dm, ...s.slack?.kinds?.dm }, channel: { ...DEFAULT_SLACK.kinds.channel, ...s.slack?.kinds?.channel } } } };
  }
  // ---------- held-back actions (gate.ts) ----------
  private rowAction = (r: any): ActionItem => ({ id: r.id, at: r.at, kind: r.kind, summary: r.summary, detail: r.detail, actor: r.actor, by: r.by_who,
    state: r.state, decidedAt: r.decided_at, result: r.result });
  /** Record an action as waiting or dry. The same action already open is returned instead of a second copy. */
  holdAction(a: { kind: string; key: string; params: unknown; summary: string; detail?: string; actor: 'session' | 'auto'; by: string; state: 'waiting' | 'dry' }): { item: ActionItem; fresh: boolean } {
    const open: any = this.db.query('SELECT * FROM actions WHERE key = ? AND state = ? ORDER BY id DESC LIMIT 1').get(a.key, a.state);
    if (open) return { item: this.rowAction(open), fresh: false };
    const r = this.db.query('INSERT INTO actions (at, kind, key, params, summary, detail, actor, by_who, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(now(), a.kind, a.key, JSON.stringify(a.params ?? null), a.summary, a.detail ?? '', a.actor, a.by, a.state);
    return { item: this.rowAction(this.db.query('SELECT * FROM actions WHERE id = ?').get(Number(r.lastInsertRowid))), fresh: true };
  }
  action(id: number): (ActionItem & { params: any }) | null {
    const r: any = this.db.query('SELECT * FROM actions WHERE id = ?').get(id);
    return r ? { ...this.rowAction(r), params: JSON.parse(r.params) } : null;
  }
  /** Move an action on, only from the state the caller saw (so two clicks can't run it twice). */
  setActionState(id: number, from: ActionItem['state'][], to: ActionItem['state'], result: string | null = null): boolean {
    const marks = from.map(() => '?').join(', ');
    return this.db.query(`UPDATE actions SET state = ?, decided_at = COALESCE(decided_at, ?), result = COALESCE(?, result) WHERE id = ? AND state IN (${marks})`)
      .run(to, now(), result, id, ...from).changes > 0;
  }
  // ---------- secrets (the Slack bot token): never in settings or the snapshot ----------
  getSecret(key: string): string | null { return (this.db.query('SELECT value FROM secrets WHERE key = ?').get(key) as { value: string } | null)?.value ?? null; }
  setSecret(key: string, value: string | null) {
    if (value === null) this.db.query('DELETE FROM secrets WHERE key = ?').run(key);
    else this.db.query('INSERT OR REPLACE INTO secrets (key, value, at) VALUES (?, ?, ?)').run(key, value, now());
  }
  // ---------- Slack threads and the quiet-hours digest ----------
  slackThread(dest: string, thread: string): { channel: string; ts: string; title: string } | null {
    return (this.db.query('SELECT channel, ts, title FROM slack_threads WHERE dest = ? AND thread = ?').get(dest, thread) as any) ?? null;
  }
  setSlackThread(dest: string, thread: string, channel: string, ts: string, title: string) {
    this.db.query('INSERT OR REPLACE INTO slack_threads (dest, thread, channel, ts, title, at) VALUES (?, ?, ?, ?, ?, ?)').run(dest, thread, channel, ts, title, now());
    this.db.query('DELETE FROM slack_threads WHERE at < ?').run(new Date(Date.now() - 7 * 864e5).toISOString());
  }
  holdSlack(title: string, route: string) { this.db.query('INSERT INTO slack_held (title, route, at) VALUES (?, ?, ?)').run(title, route, now()); }
  heldSlack(): { id: number; title: string; route: string; at: string }[] { return this.db.query('SELECT * FROM slack_held ORDER BY id').all() as any; }
  clearHeldSlack(upTo: number) { this.db.query('DELETE FROM slack_held WHERE id <= ?').run(upTo); }
  /** The owner said no to this exact action before: do not ask again. */
  wasRejected(key: string): boolean { return !!this.db.query("SELECT 1 FROM actions WHERE key = ? AND state = 'rejected'").get(key); }
  hasOpenAction(key: string): boolean { return !!this.db.query("SELECT 1 FROM actions WHERE key = ? AND state IN ('waiting', 'dry')").get(key); }
  /** The owner did it directly: the same action held earlier is settled, so approving it later cannot run it twice. */
  supersedeActions(key: string): number {
    return this.db.query("UPDATE actions SET state = 'done', result = 'done directly by the owner', decided_at = ? WHERE key = ? AND state IN ('waiting', 'dry')").run(now(), key).changes;
  }
  /** Sessions that already have a brief waiting for approval (or recorded in Dry run): one at a time per session. */
  sessionsWithHeldDispatch(): Set<string> {
    const out = new Set<string>();
    for (const r of this.db.query("SELECT params FROM actions WHERE kind IN ('dispatch', 'dispatch-unvetted') AND state IN ('waiting', 'dry')").all() as any[]) {
      try { const t = this.getTask(JSON.parse(r.params).taskId); if (t?.session) out.add(t.session); } catch { /* bad row */ }
    }
    return out;
  }
  listActions(): ActionItem[] {
    const since = new Date(Date.now() - 864e5).toISOString();
    return (this.db.query("SELECT * FROM actions WHERE state = 'waiting' OR at >= ? ORDER BY id DESC LIMIT 200").all(since) as any[]).map(this.rowAction);
  }
  /** Leaving Dry run: what it recorded becomes approvals to review, or is dropped. */
  settleDryActions(review: boolean): number {
    return this.db.query(`UPDATE actions SET state = ?, decided_at = ? WHERE state = 'dry'`).run(review ? 'waiting' : 'discarded', review ? null : now()).changes;
  }

  // ---------- first-run onboarding ----------
  onboarding(): Onboarding {
    const r: any = this.db.query("SELECT value FROM settings WHERE key = 'onboarding'").get();
    const empty: Onboarding = { doneAt: null, asked: {}, backfillFrom: null };
    return r ? { ...empty, ...JSON.parse(r.value) } : empty;
  }
  saveOnboarding(patch: Partial<Onboarding>): Onboarding {
    const next = { ...this.onboarding(), ...patch };
    this.db.query("INSERT INTO settings (key, value) VALUES ('onboarding', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
    return next;
  }
  /** Send the intake back to `from`: its next run reads everything since then, oldest first. Unpauses it. */
  backfillIntake(from: string): IntakeState {
    const t = Date.parse(from);
    if (!Number.isFinite(t) || t > Date.now()) throw new Error('Backfill must start in the past');
    if (Date.now() - t > 31 * 864e5) throw new Error('Backfill at most 31 days');
    const iso = new Date(t).toISOString();
    this.saveOnboarding({ backfillFrom: iso });
    return this.saveIntake({ ...this.intakeState(), paused: false, pausedAt: null, resumeAt: null, since: iso, catchUpFrom: iso });
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
  // ---------- monitors ----------
  private rowCheck = (r: any): MonitorCheck => ({ id: r.id, monitorId: r.monitor_id, dueAt: r.due_at, sentAt: r.sent_at, reportedAt: r.reported_at,
    verdict: r.verdict, summary: r.summary, details: r.details, links: JSON.parse(r.links) });
  private rowMonitor(r: any): Monitor {
    const done = this.db.query('SELECT * FROM monitor_checks WHERE monitor_id = ? AND reported_at IS NOT NULL ORDER BY id DESC LIMIT 2').all(r.id).map(this.rowCheck);
    const count = (this.db.query('SELECT COUNT(*) AS n FROM monitor_checks WHERE monitor_id = ? AND reported_at IS NOT NULL').get(r.id) as { n: number }).n;
    const fl: any = this.db.query('SELECT id, sent_at FROM monitor_checks WHERE monitor_id = ? AND reported_at IS NULL AND sent_at IS NOT NULL ORDER BY id DESC LIMIT 1').get(r.id);
    // A check from before the last 'Mark fixed' no longer makes it alert.
    const verdicts = done.filter((c) => !r.resolved_at || (c.reportedAt ?? '') > r.resolved_at).map((c) => c.verdict).filter((v): v is MonitorVerdict => !!v);
    const finished = r.state === 'finished';
    return {
      id: r.id, title: r.title, prompt: r.prompt, links: { pr: null, ticket: null, dashboard: null, ...JSON.parse(r.links) }, taskId: r.task_id,
      durationDays: r.duration_days, intervalHours: r.interval_hours, state: effectiveState(r.state, verdicts),
      createdAt: r.created_at, updatedAt: r.updated_at, startedAt: r.started_at, endsAt: r.ends_at, nextDueAt: finished ? null : r.next_due_at,
      finishedAt: r.finished_at, finishReason: r.finish_reason,
      lastVerdict: done[0]?.verdict ?? null, lastSummary: done[0]?.summary ?? null, lastCheckAt: done[0]?.reportedAt ?? null,
      checksDone: count, checksLeft: finished ? 0 : checksLeft(r.next_due_at ? Date.parse(r.next_due_at) : null, Date.parse(r.ends_at), r.interval_hours),
      inFlight: fl ? { checkId: fl.id, sentAt: fl.sent_at } : null,
      informLead: !!r.inform_lead, resolvedAt: r.resolved_at ?? null,
      notes: this.db.query('SELECT id, at, by_who AS by, text FROM monitor_notes WHERE monitor_id = ? ORDER BY id').all(r.id) as MonitorNote[],
    };
  }
  getMonitor(id: number): Monitor {
    const r = this.db.query('SELECT * FROM monitors WHERE id = ?').get(id);
    if (!r) throw new NotFound('No monitor ' + id);
    return this.rowMonitor(r);
  }
  /** Every monitor, newest first. With `finishedWithinMs`, finished ones only if they finished that recently. */
  listMonitors(finishedWithinMs?: number, nowMs = Date.now()): Monitor[] {
    const rows = finishedWithinMs === undefined
      ? this.db.query('SELECT * FROM monitors ORDER BY id DESC').all()
      : this.db.query("SELECT * FROM monitors WHERE state != 'finished' OR finished_at >= ? ORDER BY id DESC").all(new Date(nowMs - finishedWithinMs).toISOString());
    return rows.map((r) => this.rowMonitor(r));
  }
  addMonitorNote(id: number, text: string, by: string): MonitorNote {
    this.getMonitor(id);
    const res = this.db.query('INSERT INTO monitor_notes (monitor_id, at, by_who, text) VALUES (?, ?, ?, ?)').run(id, now(), by, text);
    return this.db.query('SELECT id, at, by_who AS by, text FROM monitor_notes WHERE id = ?').get(Number(res.lastInsertRowid)) as MonitorNote;
  }
  deleteMonitorNote(id: number, noteId: number) {
    if (!this.db.query('DELETE FROM monitor_notes WHERE id = ? AND monitor_id = ?').run(noteId, id).changes) throw new NotFound('No note ' + noteId);
  }
  monitorChecks(id: number, limit = 200): MonitorCheck[] {
    return this.db.query('SELECT * FROM monitor_checks WHERE monitor_id = ? ORDER BY id DESC LIMIT ?').all(id, limit).map(this.rowCheck);
  }
  /** The first check is due straight away, so the session notes a baseline while the change is fresh. */
  addMonitor(m: { title: string; prompt: string; links?: Partial<MonitorLinks>; taskId?: string | null; durationDays: number; intervalHours: number; informLead?: boolean }, nowMs = Date.now()): Monitor {
    const at = new Date(nowMs).toISOString();
    const res = this.db.query(`INSERT INTO monitors (title, prompt, links, task_id, duration_days, interval_hours, state, started_at, ends_at, next_due_at, created_at, updated_at, inform_lead)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`).run(m.title, m.prompt, JSON.stringify({ pr: null, ticket: null, dashboard: null, ...m.links }), m.taskId ?? null,
      m.durationDays, m.intervalHours, at, new Date(nowMs + m.durationDays * 864e5).toISOString(), at, at, at, m.informLead ? 1 : 0);
    return this.getMonitor(Number(res.lastInsertRowid));
  }
  /**
   * Edit what is watched. A new duration counts from the start; a new interval moves the next check.
   * A monitor that ran out (not one that was stopped) reopens if its new end is later.
   */
  updateMonitor(id: number, patch: { title?: string; prompt?: string; links?: Partial<MonitorLinks>; taskId?: string | null; durationDays?: number; intervalHours?: number; informLead?: boolean }, nowMs = Date.now()): Monitor {
    const r: any = this.db.query('SELECT * FROM monitors WHERE id = ?').get(id);
    if (!r) throw new NotFound('No monitor ' + id);
    const links = { pr: null, ticket: null, dashboard: null, ...JSON.parse(r.links), ...(patch.links ?? {}) };
    const days = patch.durationDays ?? r.duration_days, hours = patch.intervalHours ?? r.interval_hours;
    const endsMs = Date.parse(r.started_at) + days * 864e5;
    let state = r.state, nextDue = r.next_due_at, finishedAt = r.finished_at, reason = r.finish_reason;
    const lastDue = (this.db.query('SELECT due_at FROM monitor_checks WHERE monitor_id = ? AND sent_at IS NOT NULL ORDER BY id DESC LIMIT 1').get(id) as any)?.due_at as string | undefined;
    if (hours !== r.interval_hours && state !== 'finished' && lastDue) nextDue = new Date(nextDueAfter(Date.parse(lastDue), hours, nowMs)).toISOString();
    if (state === 'finished' && reason === 'ended' && endsMs > nowMs) {
      state = 'active'; finishedAt = null; reason = null;
      nextDue = new Date(lastDue ? nextDueAfter(Date.parse(lastDue), hours, nowMs) : nowMs).toISOString();
    }
    this.db.query(`UPDATE monitors SET title=?, prompt=?, links=?, task_id=?, duration_days=?, interval_hours=?, ends_at=?, state=?, next_due_at=?,
      finished_at=?, finish_reason=?, updated_at=?, inform_lead=? WHERE id=?`).run(patch.title ?? r.title, patch.prompt ?? r.prompt, JSON.stringify(links),
      patch.taskId !== undefined ? patch.taskId : r.task_id, days, hours, new Date(endsMs).toISOString(), state, nextDue, finishedAt, reason, new Date(nowMs).toISOString(),
      patch.informLead !== undefined ? (patch.informLead ? 1 : 0) : r.inform_lead, id);
    return this.getMonitor(id);
  }
  /** Pause, resume or stop. Resuming a monitor whose check fell due while paused runs that check now; stopping is final. */
  setMonitorState(id: number, action: 'pause' | 'resume' | 'stop' | 'resolve', nowMs = Date.now()): Monitor {
    const r: any = this.db.query('SELECT * FROM monitors WHERE id = ?').get(id);
    if (!r) throw new NotFound('No monitor ' + id);
    const at = new Date(nowMs).toISOString();
    if (r.state === 'finished') throw new Error(action === 'stop' ? 'This monitor has already finished.' : 'This monitor has finished. Edit its duration to watch it longer.');
    if (action === 'resolve') {
      if (this.getMonitor(id).state !== 'alerting') throw new Error('This monitor is not alerting.');
      this.db.query('UPDATE monitors SET resolved_at=?, updated_at=? WHERE id=?').run(at, at, id);
    } else if (action === 'pause') {
      if (r.state === 'paused') throw new Error('Already paused.');
      this.db.query("UPDATE monitors SET state='paused', paused_at=?, updated_at=? WHERE id=?").run(at, at, id);
    } else if (action === 'resume') {
      if (r.state !== 'paused') throw new Error('Not paused.');
      const next = r.next_due_at && Date.parse(r.next_due_at) > nowMs ? r.next_due_at : at;
      this.db.query("UPDATE monitors SET state='active', paused_at=NULL, next_due_at=?, updated_at=? WHERE id=?").run(next, at, id);
    } else {
      this.db.query("UPDATE monitors SET state='finished', finished_at=?, finish_reason='stopped', next_due_at=NULL, updated_at=? WHERE id=?").run(at, at, id);
    }
    return this.getMonitor(id);
  }
  /** Make a check due now; the engine sends it once the monitor session is free. */
  checkMonitorNow(id: number, nowMs = Date.now()): Monitor {
    const m = this.getMonitor(id);
    if (m.state === 'finished') throw new Error('This monitor has finished. Edit its duration to watch it longer.');
    if (m.state === 'paused') throw new Error('This monitor is paused. Resume it first.');
    if (m.inFlight) throw new Error('A check is already running for this monitor.');
    const at = new Date(nowMs).toISOString();
    this.db.query('UPDATE monitors SET next_due_at=?, updated_at=? WHERE id=?').run(at, at, id);
    return this.getMonitor(id);
  }
  /** The check in flight with the monitor session, across all monitors (there is at most one). */
  monitorInFlight(): MonitorCheck | null {
    const r = this.db.query('SELECT * FROM monitor_checks WHERE sent_at IS NOT NULL AND reported_at IS NULL ORDER BY id LIMIT 1').get();
    return r ? this.rowCheck(r) : null;
  }
  /** Claim a check before it is sent. Refuses while any check is in flight, so prompts never stack. */
  startMonitorCheck(id: number, nowMs = Date.now()): MonitorCheck {
    const claim = this.db.transaction(() => {
      if (this.monitorInFlight()) throw new Error('A monitor check is already in flight');
      const r: any = this.db.query('SELECT * FROM monitors WHERE id = ?').get(id);
      if (!r) throw new NotFound('No monitor ' + id);
      if (r.state !== 'active' || !r.next_due_at) throw new Error('Monitor ' + id + ' is not being watched');
      return Number(this.db.query('INSERT INTO monitor_checks (monitor_id, due_at, sent_at) VALUES (?, ?, ?)').run(id, r.next_due_at, new Date(nowMs).toISOString()).lastInsertRowid);
    });
    return this.rowCheck(this.db.query('SELECT * FROM monitor_checks WHERE id = ?').get(claim()));
  }
  /** The send failed: drop the claim, so the check is still due. */
  abandonMonitorCheck(checkId: number) {
    this.db.query('DELETE FROM monitor_checks WHERE id = ? AND reported_at IS NULL').run(checkId);
  }
  /** After a check completes: schedule the next one, or finish if none falls before the end. */
  private advanceMonitor(id: number, dueAt: string, nowMs: number) {
    const r: any = this.db.query('SELECT * FROM monitors WHERE id = ?').get(id);
    if (!r || r.state === 'finished') return;
    const next = nextDueAfter(Date.parse(dueAt), r.interval_hours, nowMs);
    const at = new Date(nowMs).toISOString();
    if (next >= Date.parse(r.ends_at)) this.db.query("UPDATE monitors SET state='finished', finished_at=?, finish_reason='ended', next_due_at=NULL, updated_at=? WHERE id=?").run(at, at, id);
    else this.db.query('UPDATE monitors SET next_due_at=?, updated_at=? WHERE id=?').run(new Date(next).toISOString(), at, id);
  }
  /**
   * The monitor session's answer. It completes this monitor's check in flight; with none in flight (a
   * report nobody asked for, e.g. from the CLI) it is recorded as an extra check and the schedule stays.
   */
  reportMonitor(id: number, rep: { verdict: MonitorVerdict; summary: string; details?: string; links?: string[] }, nowMs = Date.now()): { monitor: Monitor; check: MonitorCheck; becameAlerting: boolean; recovered: boolean } {
    const before = this.getMonitor(id);
    const at = new Date(nowMs).toISOString();
    const links = JSON.stringify((rep.links ?? []).slice(0, 5));
    let checkId: number;
    if (before.inFlight) {
      checkId = before.inFlight.checkId;
      const c: any = this.db.query('SELECT due_at FROM monitor_checks WHERE id = ?').get(checkId);
      this.db.query('UPDATE monitor_checks SET reported_at=?, verdict=?, summary=?, details=?, links=? WHERE id=?').run(at, rep.verdict, rep.summary, rep.details ?? '', links, checkId);
      this.advanceMonitor(id, c.due_at, nowMs);
    } else {
      checkId = Number(this.db.query('INSERT INTO monitor_checks (monitor_id, due_at, reported_at, verdict, summary, details, links) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, at, at, rep.verdict, rep.summary, rep.details ?? '', links).lastInsertRowid);
    }
    const monitor = this.getMonitor(id);
    return { monitor, check: this.rowCheck(this.db.query('SELECT * FROM monitor_checks WHERE id = ?').get(checkId)), becameAlerting: monitor.state === 'alerting' && before.state !== 'alerting',
      recovered: before.state === 'alerting' && rep.verdict === 'ok' };
  }
  /** Checks sent more than `timeoutMs` ago with no report become an error, and the schedule moves on. */
  timeoutMonitorChecks(timeoutMs: number, nowMs = Date.now()): { monitor: Monitor; becameAlerting: boolean }[] {
    const stale = this.db.query('SELECT * FROM monitor_checks WHERE sent_at IS NOT NULL AND reported_at IS NULL AND sent_at < ?').all(new Date(nowMs - timeoutMs).toISOString()) as any[];
    return stale.map((c) => {
      const before = this.getMonitor(c.monitor_id).state;
      this.db.query("UPDATE monitor_checks SET reported_at=?, verdict='error', summary=? WHERE id=?").run(new Date(nowMs).toISOString(), `error: no report within ${Math.round(timeoutMs / 60e3)} minutes`, c.id);
      this.advanceMonitor(c.monitor_id, c.due_at, nowMs);
      const monitor = this.getMonitor(c.monitor_id);
      return { monitor, becameAlerting: monitor.state === 'alerting' && before !== 'alerting' };
    });
  }
  /** Monitors whose days are up finish, unless a check is still in flight (it may report first). */
  finishMonitors(nowMs = Date.now()): Monitor[] {
    const at = new Date(nowMs).toISOString();
    const rows = this.db.query(`SELECT id FROM monitors WHERE state != 'finished' AND ends_at <= ? AND NOT EXISTS
      (SELECT 1 FROM monitor_checks c WHERE c.monitor_id = monitors.id AND c.sent_at IS NOT NULL AND c.reported_at IS NULL)`).all(at) as { id: number }[];
    for (const { id } of rows) this.db.query("UPDATE monitors SET state='finished', finished_at=?, finish_reason='ended', next_due_at=NULL, updated_at=? WHERE id=?").run(at, at, id);
    return rows.map(({ id }) => this.getMonitor(id));
  }
  saveSettings(s: Settings) {
    this.db.query("INSERT INTO settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(s));
  }
}
