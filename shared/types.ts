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
  thresholds: { warn: number; replace: number; needsCap: number; staleMin: number; stuckMin: number; loopRepeats: number };
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
}

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
export const DEFAULT_NOTIFY: NotifySettings = {
  needs: true, blocked: true, stuck: true, overlap: true, promiseDue: true, monitor: true, updated: true,
  finished: true, trouble: true, tasks: true, releases: true, monitorReport: true, replaced: true, actions: true, limits: true, system: true,
};

/** The running session that is the lead: the base name itself, or its newest replacement (name-v2, name-v3 …). */
export function resolveLead<T extends { name: string }>(sessions: T[], base: string): T | null {
  const b = base.trim().toLowerCase();
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
}

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
}
