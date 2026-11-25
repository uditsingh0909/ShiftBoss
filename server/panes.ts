// Pure rules for sharing herdr tabs: where a new session goes, what a tab is called, and how
// "Tidy into tabs" regroups running sessions. No herdr calls here; the engine runs them.
import { baseName } from './fleet';

export type PerTab = 1 | 2 | 4;
export const PER_TAB_CHOICES: PerTab[] = [1, 2, 4];
export const CLOSING_LABEL = 'old (closing)';

export interface PaneInfo { pane_id: string; tab_id: string; agent?: string | null; label?: string | null; workspace_id?: string }
export interface TabInfo { tab_id: string; number: number; label?: string; pane_count: number; workspace_id?: string; focused?: boolean }
export interface PaneRect { pane_id: string; rect: { width: number; height: number } }

/**
 * The one workspace placement and Tidy work in: the configured one, else the workspace of the focused tab,
 * else the one with the most tabs. Tab numbers are per workspace, so mixing workspaces makes "newest" meaningless.
 */
export function workspaceFor(tabs: TabInfo[], configured: string): string {
  if (configured) return configured;
  const f = tabs.find((t) => t.focused)?.workspace_id;
  if (f) return f;
  const n = new Map<string, number>();
  for (const t of tabs) if (t.workspace_id) n.set(t.workspace_id, (n.get(t.workspace_id) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}
/** The workspaces to tidy and label: the configured one, else every workspace that has tabs, each on its own. */
export function workspacesOf(tabs: TabInfo[], configured: string): string[] {
  if (configured) return [configured];
  const ws = [...new Set(tabs.map((t) => t.workspace_id ?? ''))];
  return ws.length ? ws : [''];
}
export function inWorkspace<T extends { workspace_id?: string }>(xs: T[], ws: string): T[] {
  return ws ? xs.filter((x) => !x.workspace_id || x.workspace_id === ws) : xs;
}

/** Tabs that hold only Claude panes: ShiftBoss never splits or empties a tab with someone's shell in it. */
export function claudeTabs(tabs: TabInfo[], panes: PaneInfo[]): Map<string, PaneInfo[]> {
  const by = new Map<string, PaneInfo[]>();
  for (const p of panes) by.set(p.tab_id, [...(by.get(p.tab_id) ?? []), p]);
  const out = new Map<string, PaneInfo[]>();
  for (const t of tabs) {
    const ps = by.get(t.tab_id) ?? [];
    if (ps.length && ps.every((p) => p.agent === 'claude')) out.set(t.tab_id, ps);
  }
  return out;
}

/**
 * The newest tab with room for one more session, or null (start a new tab). Pass tabs and panes of one
 * workspace. `avoid`: tabs not to fill, e.g. one that only holds sessions waiting to be closed.
 */
export function tabWithRoom(tabs: TabInfo[], panes: PaneInfo[], perTab: number, avoid: Set<string> = new Set()): { tab: string; panes: string[] } | null {
  if (perTab <= 1) return null;
  const ok = claudeTabs(tabs, panes);
  const open = tabs
    .filter((t) => ok.has(t.tab_id) && !avoid.has(t.tab_id) && ok.get(t.tab_id)!.length < perTab)
    .sort((a, b) => b.number - a.number);
  const t = open[0];
  return t ? { tab: t.tab_id, panes: ok.get(t.tab_id)!.map((p) => p.pane_id) } : null;
}

/**
 * Which pane to split, and which way: the biggest one, side by side while it is wide and stacked once
 * it is not (a terminal cell is about twice as tall as wide). One pane splits right, so 2 sit side
 * by side; the next two split down, so 4 make a 2x2.
 */
export function pickSplit(rects: PaneRect[]): { pane: string; direction: 'right' | 'down' } | null {
  if (!rects.length) return null;
  const big = [...rects].sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)[0];
  return { pane: big.pane_id, direction: big.rect.width >= 2.2 * big.rect.height ? 'right' : 'down' };
}

const short = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + '…');

/** A tab's label from its sessions: "lead + shiftboss" (base names, no -vN), or "old (closing)" when every one is waiting to close. */
export function tabLabel(names: string[], closing: Set<string> = new Set()): string {
  if (!names.length) return '';
  if (names.every((n) => closing.has(n))) return CLOSING_LABEL;
  const live = names.filter((n) => !closing.has(n));
  const bases = [...new Set(live.map((n) => baseName(n)))];
  const each = bases.length <= 1 ? 32 : bases.length === 2 ? 18 : 10;
  const parts = bases.map((b) => short(b, each));
  // Drop whole trailing names rather than cutting one in half, so the label still reads as session names.
  let out = parts.join(' + ');
  while (out.length > 40 && parts.length > 1) { parts.pop(); out = parts.join(' + ') + ' …'; }
  return out;
}

/**
 * Whether ShiftBoss may rename a tab: only labels it (or herdr) would have made: empty, a plain number,
 * "old (closing)", a session name or base name, or an earlier "a + b" label made of session names.
 * A name the owner typed stays.
 */
export function isGeneratedTabLabel(label: string, sessionNames: Iterable<string>): boolean {
  // herdr adds " 2", " 3" to a label another tab already has; " …" marks names dropped for length.
  const l = label.trim().replace(/ \d+$/, '').replace(/ …$/, '');
  if (!l || /^\d+$/.test(l) || l === CLOSING_LABEL) return true;
  const known = new Set<string>();
  for (const n of sessionNames) { known.add(n); known.add(baseName(n)); }
  const parts = l.split(' + ').map((p) => p.replace(/…$/, ''));
  return parts.every((p) => p && [...known].some((k) => k === p || (l.includes('…') && k.startsWith(p))));
}

/**
 * "Tidy into tabs": which sessions move to which tab. Fills under-full Claude-only tabs, oldest first, from
 * the newest under-full ones; a full tab is never broken up. Tabs holding a session that is waiting to close
 * stay as they are. The engine picks the split for each move from the tab's real layout.
 */
export function tidyPlan(tabs: TabInfo[], panes: PaneInfo[], perTab: number, names: Map<string, string>, closing: Set<string>): { pane: string; tab: string }[] {
  if (perTab <= 1) return [];
  const ok = claudeTabs(tabs, panes);
  const isLive = (p: PaneInfo) => !closing.has(names.get(p.pane_id) ?? '');
  const groups = tabs
    .filter((t) => ok.has(t.tab_id) && ok.get(t.tab_id)!.every(isLive) && ok.get(t.tab_id)!.length < perTab)
    .sort((a, b) => a.number - b.number)
    .map((t) => ({ tab: t.tab_id, panes: ok.get(t.tab_id)!.map((p) => p.pane_id) }));
  const moves: { pane: string; tab: string }[] = [];
  let lo = 0, hi = groups.length - 1;
  while (lo < hi) {
    const a = groups[lo], b = groups[hi];
    if (a.panes.length >= perTab) { lo++; continue; }
    if (!b.panes.length) { hi--; continue; }
    const pane = b.panes.pop()!;
    moves.push({ pane, tab: a.tab });
    a.panes.push(pane);
  }
  return moves;
}
