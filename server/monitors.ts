// Pure rules for monitors: the schedule, when one is alerting, which checks are due, and the prompt the
// monitor session gets. The store keeps the rows; the engine sends one check at a time (sendMonitorCheck).
import type { Monitor, MonitorLinks, MonitorState, MonitorVerdict } from '../shared/types';

/** A check sent to the monitor session with no report after this long is recorded as an error. */
export const MONITOR_REPORT_TIMEOUT_MS = 30 * 60e3;
/** After a failed send (herdr hiccup), wait this long before trying that monitor again. */
export const MONITOR_RETRY_MS = 60e3;

const H = 3600e3;

/** How many checks a monitor runs in all: the first at the start, then one every interval until it ends. */
export function checksTotal(durationDays: number, intervalHours: number): number {
  return Math.max(1, Math.ceil((durationDays * 24) / intervalHours));
}

/** Checks still to run, counting the one due next (0 when nothing more falls before the end). */
export function checksLeft(nextDueMs: number | null, endsMs: number, intervalHours: number): number {
  if (nextDueMs === null || nextDueMs >= endsMs) return 0;
  return Math.ceil((endsMs - nextDueMs) / (intervalHours * H));
}

/**
 * When the check after one due at `dueMs` falls. Keeps to the schedule; if that time has already passed
 * (paused, ShiftBoss was off, a report came late), the next check is due now: one catch-up, not a burst.
 */
export function nextDueAfter(dueMs: number, intervalHours: number, nowMs: number): number {
  return Math.max(dueMs + intervalHours * H, nowMs);
}

/** Alerting: the last check was bad, or the last two were errors. Verdicts newest first. */
export function isAlerting(verdicts: MonitorVerdict[]): boolean {
  return verdicts[0] === 'bad' || (verdicts[0] === 'error' && verdicts[1] === 'error');
}

/** What the screen shows. Finished and paused win; an active monitor with a bad last check is alerting. */
export function effectiveState(stored: 'active' | 'paused' | 'finished', verdicts: MonitorVerdict[]): MonitorState {
  if (stored !== 'active') return stored;
  return isAlerting(verdicts) ? 'alerting' : 'active';
}

/**
 * Which monitors may be sent a check now, oldest due first: watched (active or alerting), due, nothing in
 * flight for it, and not waiting out a failed send.
 */
export function pickDue<M extends Pick<Monitor, 'id' | 'state' | 'nextDueAt' | 'inFlight'>>(monitors: M[], nowMs: number, retryAt: Map<number, number> = new Map()): M[] {
  return monitors
    .filter((m) => (m.state === 'active' || m.state === 'alerting') && m.nextDueAt !== null && Date.parse(m.nextDueAt) <= nowMs && !m.inFlight && (retryAt.get(m.id) ?? 0) <= nowMs)
    .sort((a, b) => Date.parse(a.nextDueAt!) - Date.parse(b.nextDueAt!) || a.id - b.id);
}

const LINK_LABELS: [keyof MonitorLinks, string][] = [['pr', 'Pull request'], ['ticket', 'Ticket'], ['dashboard', 'Dashboard']];
export const linkList = (l: MonitorLinks) => LINK_LABELS.filter(([k]) => l[k]).map(([k, label]) => ({ label, url: l[k]! }));

/** The one prompt the monitor session gets per check. */
export function monitorPrompt(m: Monitor, prev: { at: string; verdict: MonitorVerdict | null; summary: string } | null, repoPath: string): string {
  const total = m.checksDone + m.checksLeft;
  const after = Math.max(0, m.checksLeft - 1);
  const links = linkList(m.links);
  return [
    `ShiftBoss monitor check for monitor ${m.id}: ${m.title}`,
    'What to check, and what "bad" looks like (from the owner):',
    '> ' + m.prompt.replace(/\n/g, '\n> '),
    links.length ? 'Links:\n' + links.map((l) => `- ${l.label}: ${l.url}`).join('\n') : '',
    m.taskId ? `ShiftBoss task: ${m.taskId}` : '',
    `This is check ${m.checksDone + 1} of ${total}; ${after === 0 ? 'it is the last one' : `${after} more after this one, every ${m.intervalHours} h`}.`,
    prev ? `Last check (${prev.at}, ${prev.verdict ?? 'no verdict'}): ${prev.summary}` : 'This is the first check: note the numbers you see, so later checks can compare.',
    'Check it now with read-only tools only. Never change production, data or settings, and never post or message anyone.',
    `Then report once with the shiftboss monitor_report tool: monitor_id ${m.id}, verdict ok | warn | bad | error (error = you could not check), a one-line summary in plain words, and details (the numbers you saw, where you looked).`,
    `Without the tool: bun ${repoPath}/cli/shiftboss.ts monitor report ${m.id} <verdict> "<summary>" --details "<details>"`,
    `How to run a check: ${repoPath}/docs/MONITOR.md`,
  ].filter(Boolean).join('\n');
}

/** The note the lead session gets about a monitor set to tell the lead: it came back bad, or it is fine again. */
export function leadAlertPrompt(m: Pick<Monitor, 'id' | 'title' | 'prompt' | 'links' | 'taskId'>, summary: string, port: number, recovered = false): string {
  const links = linkList(m.links);
  if (recovered) return [
    `ShiftBoss monitor update: "${m.title}" is fine again.`,
    `Latest check: ${summary}`,
    'Nothing more to do for it unless you were still working on it.',
  ].join('\n');
  return [
    `ShiftBoss monitor alert: "${m.title}" came back bad.`,
    `What the monitor session found: ${summary}`,
    'What was being watched:',
    '> ' + m.prompt.replace(/\n/g, '\n> '),
    links.length ? 'Links:\n' + links.map((l) => `- ${l.label}: ${l.url}`).join('\n') : '',
    m.taskId ? `ShiftBoss task: ${m.taskId}` : '',
    `Full check history: http://127.0.0.1:${port}/#/monitors (monitor ${m.id}).`,
    'Look into it and route it to the session that owns this area, or fix it if it is yours. Ask the owner (ask_owner) before anything that touches production.',
    `Once it is fixed, ask for a fresh check: monitor_update with id ${m.id} and action check_now (or: shiftboss monitor check ${m.id}). If it was a false alarm, action resolve marks it fixed without a check.`,
  ].filter(Boolean).join('\n');
}

/** The first prompt of the monitor session itself. */
export function monitorSessionPrompt(ownerName: string, repoPath: string): string {
  return [
    `You are the monitor session for ShiftBoss. ${ownerName} ships things and wants them watched for a few days afterwards.`,
    `Read ${repoPath}/docs/MONITOR.md now; it is your job description.`,
    'ShiftBoss sends you one check at a time: what was shipped, what to look at, and what "bad" looks like.',
    'For each one, look with read-only tools only, never change production or anything else, never post or message anyone,',
    'and report with the shiftboss monitor_report tool in plain words. Between checks, wait: do nothing until the next prompt.',
  ].join(' ');
}
