// The Floor: the 3D office view of every session. These pure rules turn a snapshot into who sits where and how
// they are doing, so the scene and the panels agree and the rules can be tested without a browser.
import { MONITOR_SESSION, resolveLead, type HealthCard, type OutputLine, type Session, type Snapshot } from './types';

/** The page's name, in one place: sidebar, title, button. */
export const FLOOR_NAME = 'Floor';

export type DeskState = 'working' | 'needs' | 'stuck' | 'finished' | 'idle';
export const DESK_WORD: Record<DeskState, string> = { working: 'working', needs: 'needs you', stuck: 'stuck', finished: 'just finished', idle: 'idle' };
export const DESK_COLOR: Record<DeskState, string> = { working: '#F4F4F5', needs: '#FF5A4F', stuck: '#F5A524', finished: '#4ADE80', idle: '#6B6B70' };

export interface Desk {
  name: string;
  lane: string;
  state: DeskState;
  /** The task it is on, if one is assigned and not done. */
  task: string | null;
  ctx: number;
  cacheRead: number;
  lastTool: string | null;
  /** What its terminal shows: the last few lines of its output. */
  lines: string[];
}
/** `label` is what the floor shows ("big 2" when a lane needs two pods); `lane` is the lane itself. */
export interface Pod { lane: string; label: string; desks: Desk[] }
export interface FloorModel {
  lead: Desk | null;
  ops: Desk | null;
  pods: Pod[];
  idle: Desk[];
  all: Desk[];
  /** Changes only when someone moves (joins, leaves, changes area): the scene rebuilds the layout then. */
  layoutKey: string;
  kpis: { busy: number; total: number; inProgress: number; shippedToday: number; needs: number; oldestNeedMin: number | null };
}

export const POD_SEATS = 6;
/** Where sessions without a lane sit. */
export const UNASSIGNED = 'Unassigned';
const FINISHED_FOR_MS = 10 * 60e3;
const STUCK: HealthCard['verdict'][] = ['stuck', 'looping', 'lost'];

/** How a session reads on the floor: waiting on a person beats stuck beats working; a turn that just ended shows as finished for a while. */
export function deskState(s: Pick<Session, 'status' | 'lastActivity'>, verdict: HealthCard['verdict'] | null, nowMs = Date.now()): DeskState {
  if (s.status === 'blocked') return 'needs';
  if (verdict && STUCK.includes(verdict)) return 'stuck';
  if (s.status === 'working') return 'working';
  if (s.status === 'done' && s.lastActivity && nowMs - Date.parse(s.lastActivity) < FINISHED_FOR_MS) return 'finished';
  return 'idle';
}

/** A terminal's lines from the session's output: tools as ⏺, their output as ⎿, what Claude said as plain text. */
export function terminalLines(lines: OutputLine[], max = 8): string[] {
  return lines.slice(-max).map((l) => {
    const t = l.text.replace(/\s+/g, ' ').trim();
    if (l.kind === 'tool') return '⏺ ' + t;
    if (l.kind === 'out') return '  ⎿ ' + t;
    if (l.kind === 'you') return '> ' + t;
    return t;
  });
}

const isToday = (iso: string | null | undefined, now: Date) => !!iso && new Date(iso).toDateString() === now.toDateString();

export function floorModel(snap: Pick<Snapshot, 'sessions' | 'health' | 'tasks' | 'needs' | 'actions' | 'settings'>, nowMs = Date.now()): FloorModel {
  const verdict = new Map(snap.health.map((h) => [h.session, h.verdict]));
  const taskOf = new Map<string, string>();
  for (const t of snap.tasks) if (t.session && t.stage >= 1 && t.stage <= 4 && !taskOf.has(t.session)) taskOf.set(t.session, t.id);
  const desk = (s: Session): Desk => ({
    name: s.name, lane: s.lane.trim() || UNASSIGNED, state: deskState(s, verdict.get(s.name) ?? null, nowMs),
    task: taskOf.get(s.name) ?? null, ctx: Math.round(s.contextPct), cacheRead: s.cache?.read ?? 0, lastTool: s.lastTool, lines: terminalLines(s.lines ?? []),
  });
  const all = snap.sessions.map(desk).sort((a, b) => a.name.localeCompare(b.name));
  const leadS = resolveLead(snap.sessions, snap.settings.leadSession ?? '');
  const opsS = resolveLead(snap.sessions, MONITOR_SESSION);
  const lead = leadS ? all.find((d) => d.name === leadS.name) ?? null : null;
  const ops = opsS && opsS.name !== leadS?.name ? all.find((d) => d.name === opsS.name) ?? null : null;
  const rest = all.filter((d) => d !== lead && d !== ops);
  const idle = rest.filter((d) => d.state === 'idle');
  const byLane = new Map<string, Desk[]>();
  // An idle session keeps its desk (empty while it rests in the lounge), so an area only changes when someone joins or leaves.
  for (const d of rest) byLane.set(d.lane, [...(byLane.get(d.lane) ?? []), d]);
  const pods: Pod[] = [];
  for (const lane of [...byLane.keys()].sort((a, b) => (a === UNASSIGNED ? 1 : b === UNASSIGNED ? -1 : a.localeCompare(b)))) {
    const ds = byLane.get(lane)!;
    for (let i = 0; i < ds.length; i += POD_SEATS) pods.push({ lane, label: ds.length > POD_SEATS ? `${lane} ${i / POD_SEATS + 1}` : lane, desks: ds.slice(i, i + POD_SEATS) });
  }
  const now = new Date(nowMs);
  const open = snap.needs.filter((n) => !n.answer);
  const waiting = snap.actions.filter((a) => a.state === 'waiting');
  const times = [...open.map((n) => n.createdAt), ...waiting.map((a) => a.at)].map((t) => Date.parse(t)).filter((t) => !Number.isNaN(t));
  return {
    lead, ops, pods, idle, all,
    layoutKey: JSON.stringify([lead?.name, ops?.name, pods.map((p) => [p.label, p.desks.map((d) => d.name)]), idle.map((d) => d.name)]),
    kpis: {
      busy: all.filter((d) => d.state === 'working' || d.state === 'needs' || d.state === 'stuck').length,
      total: all.length,
      inProgress: snap.tasks.filter((t) => t.stage === 2 || t.stage === 3).length,
      shippedToday: snap.tasks.filter((t) => isToday(t.liveAt, now)).length,
      needs: open.length + waiting.length,
      oldestNeedMin: times.length ? Math.round((nowMs - Math.min(...times)) / 60e3) : null,
    },
  };
}
