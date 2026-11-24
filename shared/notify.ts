// Which items in a snapshot deserve a browser notification, and which of them are new. Pure, so the
// rules are tested on their own; web/notify.tsx does the browser part.
import { DEFAULT_NOTIFY, type NotifySettings, type Snapshot } from './types';

export type NotifyKind = keyof NotifySettings;
export interface NotifyEvent { kind: NotifyKind; key: string; title: string; body: string; route: string }

const route = (...parts: string[]) => '#/' + parts.map(encodeURIComponent).join('/');
const cut = (s: string, n = 140) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Every item in this snapshot that would notify, enabled or not. Keys are stable across snapshots. */
export function notifyItems(s: Snapshot): NotifyEvent[] {
  const out: NotifyEvent[] = [];
  for (const n of s.needs) {
    if (n.answer) continue;
    if (n.auto) out.push({ kind: 'blocked', key: 'need:' + n.id, title: `${n.session ?? 'A session'} needs a permission answer`, body: cut(n.title + ' · answer it in herdr'), route: route('needs') });
    else out.push({ kind: 'needs', key: 'need:' + n.id, title: 'Needs you: ' + cut(n.title, 80), body: cut([n.kind, n.session].filter(Boolean).join(' · ') + (n.body ? ' — ' + n.body : '')), route: route('needs') });
  }
  for (const h of s.health) {
    if (h.verdict !== 'stuck' && h.verdict !== 'looping') continue;
    out.push({ kind: 'stuck', key: `health:${h.session}:${h.verdict}`, title: `${h.session} is ${h.verdict}`, body: cut(h.title + (h.suggest ? ' · ' + h.suggest : '')), route: route('session', h.session) });
  }
  for (const o of s.overlaps) out.push({ kind: 'overlap', key: 'overlap:' + o.id, title: `Overlap: ${o.a.session} and ${o.b.session}`, body: cut(`${o.kind} · ${o.where}`), route: route('overlap') });
  for (const p of s.promises) {
    if (p.state === 'due') out.push({ kind: 'promiseDue', key: 'promise:' + p.id, title: `Promise to ${p.to} is overdue`, body: cut('“' + p.said + '”'), route: route('promises') });
  }
  // Monitors come from another part of ShiftBoss; read them loosely and skip them when absent.
  const monitors = (s as unknown as { monitors?: unknown }).monitors;
  if (Array.isArray(monitors)) {
    for (const m of monitors as Record<string, unknown>[]) {
      if (!m || typeof m !== 'object') continue;
      const state = String(m.state ?? m.status ?? m.verdict ?? '');
      const alerting = m.alert === true || m.alerting === true || /^(down|alert|alerting|failing|failed|red|error)$/i.test(state);
      const id = String(m.id ?? m.name ?? m.title ?? '');
      if (!alerting || !id) continue;
      out.push({ kind: 'monitor', key: 'monitor:' + id, title: 'Monitor alert: ' + cut(String(m.name ?? m.title ?? id), 80), body: cut(String(m.detail ?? m.message ?? m.note ?? state)), route: route('monitors') });
    }
  }
  return out;
}

/**
 * Items in `next` that were not in `prev`, for the kinds switched on. With no `prev` (the page just loaded)
 * nothing is new: what was already there when the page opened never notifies.
 */
export function newNotifications(prev: Snapshot | null, next: Snapshot, on: NotifySettings | undefined): NotifyEvent[] {
  if (!prev) return [];
  const enabled = { ...DEFAULT_NOTIFY, ...on };
  const seen = new Set(notifyItems(prev).map((e) => e.kind + '|' + e.key));
  return notifyItems(next).filter((e) => enabled[e.kind] && !seen.has(e.kind + '|' + e.key));
}

/** Unanswered Needs you items, for the tab title: "(2) ShiftBoss". */
export function tabTitle(s: Snapshot | null, base = 'ShiftBoss'): string {
  const n = s ? s.needs.filter((x) => !x.answer).length : 0;
  return n ? `(${n}) ${base}` : base;
}
