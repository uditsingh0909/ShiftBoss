// Shapes shared by the server and the web UI.

export type AgentStatus = 'working' | 'idle' | 'done' | 'blocked' | 'unknown' | 'lost';

export interface OutputLine {
  at: string; // ISO timestamp
  kind: 'tool' | 'out' | 'say' | 'you' | 'sys';
  text: string;
}

export interface Session {
  name: string;
  paneId: string;
  sessionId: string | null;
  status: AgentStatus;
  cwd: string;
  model: string | null;
  contextTokens: number;
  contextWindow: number;
  contextPct: number;
  tokensToday: number;
  tokens5h: number;
  lastActivity: string | null;
  lastTool: string | null;
  lines: OutputLine[];
  heat: number[]; // 30 buckets x 2 minutes, oldest first; -1 = repeating
  filesTouched: string[]; // last 3 hours
  lane: string;
  slots: number;
  handoffPath: string | null;
  handoffAgeMin: number | null;
  prUrls: string[];
  usesShiftbossTools: boolean; // called a shiftboss MCP tool in the last 3 hours
  exactUsage: boolean; // the status line tap is reporting for this session
  /** Cache over the session's whole life: unlike context, it never drops after a compact. The real wear. */
  cache: SessionCache;
}

export interface SessionCache {
  read: number; // cache tokens read, all turns since the session started
  written: number; // cache tokens written
  compactions: number;
  lastCompactAt: string | null;
  /** From the status line tap, when on: is the prompt cache warm now, until when, and how often it hits. */
  warm: boolean | null;
  expiresAt: string | null;
  hitRatio: number | null;
}
/** "1.4B", "640M", "12K". */
export const fmtCache = (n: number) => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? Math.round(n / 1e6) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n));
/** Where a session's wear stands, by lifetime cache read only (context is shown, but never decides a replace). */
export function wear(s: { contextPct: number; cache?: { read: number } }, t: { cacheWarnM?: number; cacheReplaceM?: number }): 'ok' | 'warn' | 'replace' {
  const read = (s.cache?.read ?? 0) / 1e6;
  if (read >= (t.cacheReplaceM ?? 500)) return 'replace';
  if (read >= (t.cacheWarnM ?? 300)) return 'warn';
  return 'ok';
}

export const STAGES = ['Inbox', 'Queued', 'In progress', 'PR open', 'On dev', 'Live', 'Requester told'] as const;
export type Stage = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface Task {
  id: string;
  title: string;
  ask: string;
  requester: string;
  source: string;
  sourceUrl: string | null;
  session: string | null;
  stage: Stage;
  prio: 'P1' | 'P2' | 'P3';
  /** When it first reached Live (or later). */
  liveAt?: string | null;
  held: boolean;
  /** The owner queued or assigned it in the UI; only these are sent automatically. */
  vetted?: boolean;
  createdAt: string;
  updatedAt: string;
  /** Always set by the store; optional so hand-built tasks (tests, imports) need not name it. */
  direction?: Direction;
}

/**
 * Which way something went. inbound: someone asked us or wrote to the owner. outbound: the owner or a session
 * said or sent it. null: not recorded (older rows, or the sender did not say).
 */
export type Direction = 'inbound' | 'outbound' | null;

export interface TaskEvent { id: number; taskId: string; at: string; src: 'Slack' | 'GitHub' | 'Session' | 'ShiftBoss'; who: string; text: string }
export interface SlackMsg { id: number; taskId: string; at: string; who: string; text: string; kind: 'ask' | 'promise' | 'sent' | 'draft' }

export interface PromiseItem {
  id: number;
  to: string;
  where: string;
  said: string;
  keptWhen: string;
  taskId: string | null;
  state: 'open' | 'ready' | 'waiting' | 'due' | 'kept';
  dueAt: string | null;
  createdAt: string;
  keptAt: string | null;
  /** The promise's own link (Slack permalink, Gmail link), if one was recorded. */
  url: string | null;
  direction: Direction;
  /** Where "Open" goes: its own url, else its task's source link (via = that task id). Worked out when read. */
  link: { url: string; via: string | null } | null;
}

export interface Need {
  id: number;
  kind: 'Permission' | 'Production write' | 'Live customers' | 'Money' | 'Access' | 'Decision';
  source: string;
  title: string;
  body: string;
  code: string;
  answers: string[];
  answer: string | null;
  session: string | null;
  taskId: string | null;
  createdAt: string;
  answeredAt: string | null;
  sentAt: string | null; // when the answer reached the session; null while it can still be undone
  auto: boolean; // created from a blocked herdr pane
}

export interface AuditEntry { id: number; at: string; where: 'Slack' | 'Jira' | 'GitHub' | 'Email'; channel: string; text: string; by: string; approval: string; corrected: boolean; note: string }
export interface IntakeItem { id: number; at: string; src: string; who: string; text: string; verdict: string; taskId: string | null; url: string | null; direction: Direction }
export interface Decision { id: number; at: string; text: string }

export interface HealthCard {
  session: string;
  verdict: 'healthy' | 'waiting' | 'heavy' | 'stuck' | 'looping' | 'burning' | 'lost';
  title: string;
  signals: { k: string; v: string; tone: 'red' | 'amber' | 'green' | 'dim' }[];
  loop: string[];
  suggest: string;
}

export interface Overlap {
  id: string;
  kind: 'Same file' | 'Same migration number' | 'Same task';
  severity: 'red' | 'amber';
  where: string;
  title: string;
  a: { session: string; what: string };
  b: { session: string; what: string };
  fix: string;
}

export interface EnvVersion { name: string; url: string; version: string | null; ok: boolean; checkedAt: string | null }
export interface MergedPr { number: number; title: string; author: string; mergedAt: string; url: string }

export interface Limits { fiveHourPct: number; weeklyPct: number; fiveHourTokens: number; weeklyTokens: number; estimate: boolean }

/** Where the intake session is: it reads messages newer than `since`, and does nothing while paused. */
export interface IntakeState {
  paused: boolean;
  pausedAt: string | null;
  resumeAt: string | null; // auto-resume (with catch-up) at this time
  since: string | null; // the intake has read everything up to here
  catchUpFrom: string | null; // set on resume-with-catch-up until the intake has read past the gap
  lastBeginAt: string | null; // the intake's last check-in, to spot a dead intake session
  lastCheckpointAt: string | null;
}

export interface Settings {
  /** cacheWarnM / cacheReplaceM: lifetime cache read, in millions of tokens. */
  thresholds: { warn: number; replace: number; needsCap: number; staleMin: number; stuckMin: number; loopRepeats: number; cacheWarnM?: number; cacheReplaceM?: number };
  switches: { autoDispatch: boolean; quietHours: boolean };
  budgets: { fiveHourTokens: number; weeklyTokens: number };
  herdrWorkspace: string;
  handoffsDir: string;
  /** Name of the lead session, e.g. 'lead'. Also matches its replacements: lead-v2, lead-v3, … */
  leadSession: string;
  /** Slack channels intake reads for new top-level messages, e.g. "#team-billing". */
  watchedChannels: string[];
  /** Install new versions of ShiftBoss by itself (a git checkout with no local edits). */
  autoUpdate?: boolean;
  /** What ShiftBoss may do on its own: dry (Dry run), ask (Ask first), safe (Safe auto), auto (Autopilot). */
  mode?: 'dry' | 'ask' | 'safe' | 'auto';
  /** Claude can make the owner's decisions (approve, mode, settings, answers) when the owner asks it to. Off: only ShiftBoss's own screens can. */
  delegate?: boolean;
  /** The owner's way of working, in their words. Added to everything ShiftBoss tells sessions. */
  instructions?: string;
  /** The text before the last change, so a change can be undone. */
  instructionsPrev?: string;
  /** Which browser notifications to show (one open tab shows them). Stored here so every tab agrees. */
  notify?: NotifySettings;
  /** Close a replaced session this many minutes after its successor has its first prompt. 0: never (you close it). */
  closeOldAfterMin?: number;
  /** How many sessions share one herdr tab as split panes: 1, 2 or 4 (2x2). New sessions fill the newest tab with room. */
  sessionsPerTab?: 1 | 2 | 3 | 4;
  /** Replace a worn-out session by itself (handoff first), by lifetime cache read with context as a backstop. Default on. */
  autoReplace?: boolean;
  /** The ShiftBoss Slack bot: where its alerts go and which. The token is kept apart and never in the snapshot. */
  slack?: SlackSettings;
}

/** Where the ShiftBoss bot posts, and which kinds of event go to each place. */
export interface SlackSettings {
  dm: { on: boolean; userId: string | null; label: string | null };
  channel: { on: boolean; id: string | null; name: string | null };
  kinds: { dm: NotifySettings; channel: NotifySettings };
  /** Quiet hours for the DM (local time, HH:MM): held, then one digest when they end. */
  quiet: { on: boolean; from: string; to: string };
}
export type SlackDest = 'dm' | 'channel';
/** The bot's state, for the screens. Never holds the token. */
export interface SlackStatus { connected: boolean; team: string | null; bot: string | null; error: string | null; sentToday: number; held: number; queued: number }

/** Browser notification switches, one per kind of event. */
export interface NotifySettings {
  needs: boolean; // a new Needs you item (a decision a session asked for, an approval, a confused thread)
  blocked: boolean; // a session waits on a permission answer in herdr
  stuck: boolean; // a session is stuck or looping
  overlap: boolean; // two sessions touch the same thing
  promiseDue: boolean; // a promise became overdue
  monitor: boolean; // a monitor raised an alert
  updated: boolean; // ShiftBoss installed a new version, or a new one is available
  finished: boolean; // a session finished its turn and waits for its next prompt
  trouble: boolean; // a session's context is nearly full, it burns tokens fast, or herdr lost it
  tasks: boolean; // a new task, or a task moved to another stage
  releases: boolean; // a PR merged, or an environment runs a new version
  monitorReport: boolean; // every monitor check result, and a monitor finishing
  replaced: boolean; // a session replacement finished, stalled or failed
  actions: boolean; // a held action ran, failed, or Dry run recorded one
  limits: boolean; // the 5-hour or weekly usage passed 80% or 95%
  system: boolean; // herdr stopped answering, or the intake went quiet
}
/** Slack defaults: the DM gets what needs you and what went wrong; the channel only what the team cares about. */
const OFF: NotifySettings = { needs: false, blocked: false, stuck: false, overlap: false, promiseDue: false, monitor: false, updated: false,
  finished: false, trouble: false, tasks: false, releases: false, monitorReport: false, replaced: false, actions: false, limits: false, system: false };
export const DEFAULT_SLACK: SlackSettings = {
  dm: { on: false, userId: null, label: null },
  channel: { on: false, id: null, name: null },
  kinds: {
    dm: { ...OFF, needs: true, blocked: true, stuck: true, trouble: true, overlap: true, promiseDue: true, monitor: true, replaced: true, limits: true, system: true },
    channel: { ...OFF, monitor: true, monitorReport: true, releases: true },
  },
  quiet: { on: false, from: '22:00', to: '08:00' },
};
export const DEFAULT_NOTIFY: NotifySettings = {
  needs: true, blocked: true, stuck: true, overlap: true, promiseDue: true, monitor: true, updated: true,
  finished: true, trouble: true, tasks: true, releases: true, monitorReport: true, replaced: true, actions: true, limits: true, system: true,
};

/** The running session that is the lead: the base name itself, or its newest replacement (name-v2, name-v3 …). */
/** A name for a new session that works one task: "t12-fix-texting-numbers", made unique against `taken`. */
export function taskSessionName(t: { id: string; title: string }, taken: Iterable<string>): string {
  const used = new Set(taken);
  const words = t.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter((w) => w && !['the', 'a', 'an', 'to', 'for', 'of', 'and', 'on', 'in'].includes(w));
  let base = (t.id.toLowerCase().replace('-', '') + '-' + words.join('-')).slice(0, 29).replace(/-+$/, ''); // room for -2…-99 within herdr's 32
  if (base.length < 2) base = 'task-' + base;
  let name = base, i = 2;
  while (used.has(name)) name = `${base}-${i++}`;
  return name;
}

export function resolveLead<T extends { name: string }>(sessions: T[], base: string): T | null {
  // A setting saved as a versioned name (lead-v2) still means the lead line: lead, lead-v2, lead-v3, ...
  const b = base.trim().toLowerCase().replace(/-v\d+$/, '');
  if (!b) return null;
  let best: T | null = null, bestV = -1;
  for (const s of sessions) {
    const n = s.name.toLowerCase();
    const m = n === b ? ['', '1'] : n.match(new RegExp('^' + b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-v(\\d+)$'));
    if (m && Number(m[1]) > bestV) { best = s; bestV = Number(m[1]); }
  }
  return best;
}

/** First-run setup: which sessions were asked to register their work, and how far back the intake was sent. */
export interface Onboarding {
  doneAt: string | null;
  asked: Record<string, string>; // session name -> when it was asked
  backfillFrom: string | null;
}

/**
 * Replacing a session through a handoff. pending: waiting to ask (the old session is at a prompt);
 * requested: asked for the handoff; stalled: no complete handoff after the timeout (still watched);
 * ready: handoff complete; starting / started: the new session is starting / up; moved: tasks and
 * lane moved to the new name, first prompt not delivered yet; done: the new session has its first
 * prompt. The old session is never closed by ShiftBoss.
 */
export type ReplacementState = 'pending' | 'requested' | 'stalled' | 'ready' | 'starting' | 'started' | 'moved' | 'done' | 'failed' | 'cancelled';
export interface Replacement {
  id: number;
  oldName: string;
  newName: string;
  cwd: string;
  model: string | null;
  handoffPath: string;
  sessionId: string | null;
  transcriptPath: string | null;
  state: ReplacementState;
  startedAt: string;
  updatedAt: string;
  requestedAt: string | null;
  promptedAt: string | null;
  error: string | null;
  /** Section headings (or the end marker) the handoff file still lacks; empty when unknown or complete. */
  missing: string[];
  /** When ShiftBoss closed the old session's pane (or found it already gone). Null while it is still open. */
  closedAt: string | null;
  /** Hidden from the Replacements list by the owner. */
  dismissedAt: string | null;
  /** Do not auto-close the old session before this time (e.g. it still holds a scheduled job). */
  holdUntil: string | null;
}

/** An action ShiftBoss held back: waiting for approval, or recorded in Dry run. */
export interface ActionItem {
  id: number;
  at: string;
  kind: string;
  summary: string;
  detail: string;
  actor: 'session' | 'auto';
  by: string; // the session that asked, or 'shiftboss'
  state: 'waiting' | 'dry' | 'approved' | 'done' | 'failed' | 'rejected' | 'discarded';
  decidedAt: string | null;
  result: string | null;
}

/** A Slack thread where Claude sessions seem confused (contradicting, repeating, unanswered), flagged by the intake. */
export interface ThreadCheck { id: number; at: string; src: string; who: string; text: string; url: string | null }

/** Watching something after it shipped: one dedicated session (`monitor`) runs a check every few hours for a few days. */
export const MONITOR_SESSION = 'monitor';
export const MONITOR_DAYS = [1, 3, 7, 14] as const;
export const MONITOR_HOURS = [1, 3, 6, 12, 24] as const;
export type MonitorVerdict = 'ok' | 'warn' | 'bad' | 'error';
/** finished: its days are up, or it was stopped. alerting: still watched, and the last check was bad (or two errors in a row). */
export type MonitorState = 'active' | 'paused' | 'finished' | 'alerting';
export interface MonitorLinks { pr: string | null; ticket: string | null; dashboard: string | null }
export interface MonitorCheck {
  id: number;
  monitorId: number;
  dueAt: string;
  sentAt: string | null; // when the prompt went to the monitor session; null for a report nobody asked for
  reportedAt: string | null; // null while the check is in flight
  verdict: MonitorVerdict | null;
  summary: string;
  details: string;
  links: string[];
}
export interface Monitor {
  id: number;
  title: string;
  prompt: string;
  links: MonitorLinks;
  taskId: string | null;
  durationDays: number;
  intervalHours: number;
  state: MonitorState;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  endsAt: string;
  nextDueAt: string | null; // null once finished
  finishedAt: string | null;
  finishReason: 'ended' | 'stopped' | null;
  lastVerdict: MonitorVerdict | null;
  lastSummary: string | null;
  lastCheckAt: string | null;
  checksDone: number;
  checksLeft: number; // still to run, counting the one due next
  inFlight: { checkId: number; sentAt: string } | null;
  /** Send the lead session a short note when a check comes back bad (or the monitor starts alerting). */
  informLead: boolean;
  /** When the owner (or a session) marked the last alert fixed; checks before it no longer count for alerting. */
  resolvedAt: string | null;
  /** The owner's notes, e.g. why an alert was dismissed ("that is intentional"). Every later check is told them. */
  notes: MonitorNote[];
}
export interface MonitorNote { id: number; at: string; by: string; text: string }
/** Something in Needs attention the owner dismissed, with an optional note. Hidden until it changes. */
export interface Dismissal { key: string; at: string; what: string; note: string; by: string }

/** The chat with the lead from the side panel. Your messages and the lead's replies to them, nothing else. */
export interface ChatMsg { id: number; at: string; role: 'you' | 'lead'; text: string; session: string; state: 'sent' | 'seen' | 'reply' }
/** Marks a prompt as a chat message, so its reply can be told apart from cron check-ins and peer messages. */
export const CHAT_MARK = '[ShiftBoss chat]';

export interface Snapshot {
  now: string;
  herdrOk: boolean;
  herdrError: string | null;
  sessions: Session[];
  tasks: Task[];
  needs: Need[];
  promises: PromiseItem[];
  intake: IntakeItem[];
  decisions: Decision[];
  health: HealthCard[];
  overlaps: Overlap[];
  limits: Limits;
  releases: { envs: EnvVersion[]; merged: MergedPr[]; freeze: boolean | null };
  settings: Settings;
  intakeState: IntakeState;
  onboarding: Onboarding;
  /** Held-back actions: every waiting one, plus recent dry-run and decided ones. */
  actions: ActionItem[];
  /** Threads to look at, from the intake (verdict 'check thread'), until dismissed. */
  threadChecks: ThreadCheck[];
  owner: string;
  /** The self-updater: running version, newer one if any, and what it last did. Null when not a git checkout. */
  update: { supported: boolean; current: { sha: string; date: string; subject: string } | null; latest: { sha: string; date: string; subject: string } | null; behind: number; checking: boolean; checkedAt: string | null; state: string; note: string } | null;
  feed: { at: string; who: string; text: string }[];
  replacements: Replacement[];
  /** Monitors being watched (active, paused, alerting) and those finished in the last day. */
  monitors: Monitor[];
  /** Needs attention items the owner dismissed (last 14 days). */
  dismissed: Dismissal[];
  /** The ShiftBoss Slack bot, if set up. */
  slack: SlackStatus;
  /** The lead chat: the last messages, newest last. */
  chat: ChatMsg[];
}

/** A time of day the way people read it here: 12-hour, in the local time zone ("5:42 PM"). One place, so every screen agrees. */
export function clockTime(at: string | number | Date): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
}
