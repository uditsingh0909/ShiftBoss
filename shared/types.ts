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

export interface TaskEvent { id: number; taskId: string; at: string; src: 'Slack' | 'GitHub' | 'Session' | 'Shiftboss'; who: string; text: string }
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

export interface Settings {
  thresholds: { warn: number; replace: number; needsCap: number; staleMin: number; stuckMin: number; loopRepeats: number };
  switches: { autoDispatch: boolean; quietHours: boolean };
  budgets: { fiveHourTokens: number; weeklyTokens: number };
  herdrWorkspace: string;
  handoffsDir: string;
  /** Slack channels intake reads for new top-level messages, e.g. "#proj-vdp-plus". */
  watchedChannels: string[];
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
  owner: string;
  feed: { at: string; who: string; text: string }[];
}
