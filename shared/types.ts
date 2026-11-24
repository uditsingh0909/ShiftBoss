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
  held: boolean;
  createdAt: string;
  updatedAt: string;
}

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
export interface IntakeItem { id: number; at: string; src: string; who: string; text: string; verdict: string; taskId: string | null; url: string | null }
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
  /** Name of the lead session, e.g. 'lead-manager'. Also matches its replacements: lead-manager-v2, -v3, … */
  leadSession: string;
  /** Slack channels intake reads for new top-level messages, e.g. "#proj-vdp-plus". */
  watchedChannels: string[];
}

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
  owner: string;
  feed: { at: string; who: string; text: string }[];
}
