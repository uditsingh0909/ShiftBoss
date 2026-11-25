// Which items in a snapshot deserve a browser notification, and which of them are new. Pure, so the
// rules are tested on their own; web/notify.tsx does the browser part.
import { DEFAULT_NOTIFY, STAGES, type NotifySettings, type Snapshot } from './types';

export type NotifyKind = keyof NotifySettings;
export interface NotifyEvent { kind: NotifyKind; key: string; title: string; body: string; route: string }

const route = (...parts: string[]) => '/' + parts.map(encodeURIComponent).join('/');
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
  // Actions held by the gate (Ask first / Safe auto), and threads where sessions look confused: both need the owner.
  for (const x of s.actions ?? []) if (x.state === 'waiting')
    out.push({ kind: 'needs', key: 'action:' + x.id, title: 'Approve? ' + cut(x.summary, 80), body: cut('Asked by ' + x.by + (x.detail ? ' — ' + x.detail : '')), route: route('needs') });
  for (const c of s.threadChecks ?? [])
    out.push({ kind: 'needs', key: 'thread:' + c.id, title: 'Sessions may be confused in ' + cut(c.src, 60), body: cut(c.text), route: route('') });
  // Monitors come from another part of ShiftBoss; read them loosely and skip them when absent.
  const monitors = (s as unknown as { monitors?: unknown }).monitors;
  if (Array.isArray(monitors)) {
    for (const m of monitors as Record<string, unknown>[]) {
      if (!m || typeof m !== 'object') continue;
      const state = String(m.state ?? m.status ?? m.verdict ?? '');
      const alerting = m.alert === true || m.alerting === true || /^(down|alert|alerting|failing|failed|red|error)$/i.test(state);
      const id = String(m.id ?? m.name ?? m.title ?? '');
      if (!alerting || !id) continue;
      out.push({ kind: 'monitor', key: 'monitor:' + id, title: 'Monitor alert: ' + cut(String(m.name ?? m.title ?? id), 80), body: cut(String(m.lastSummary ?? m.detail ?? m.message ?? state)), route: route('monitors') });
    }
  }
  // Everything else that happens, each under its own switch. Keys carry the state, so a change is a new key.
  for (const x of s.sessions ?? []) {
    // The intake and monitor sessions finish a turn every few minutes on a loop: not news.
    if (x.status === 'done' && x.lastActivity && !/^(intake|monitor)(-v\d+)?$/.test(x.name)) out.push({ kind: 'finished', key: `finished:${x.name}:${x.lastActivity}`, title: `${x.name} finished its turn`, body: cut(x.lines?.at(-1)?.text ?? 'It is waiting for its next prompt.'), route: route('session', x.name) });
  }
  for (const h of s.health) {
    if (h.verdict !== 'heavy' && h.verdict !== 'burning' && h.verdict !== 'lost') continue;
    const what = h.verdict === 'heavy' ? 'is nearly out of context' : h.verdict === 'burning' ? 'is using tokens fast' : 'was lost by herdr';
    out.push({ kind: 'trouble', key: `health:${h.session}:${h.verdict}`, title: `${h.session} ${what}`, body: cut(h.title + (h.suggest ? ' · ' + h.suggest : '')), route: route('session', h.session) });
  }
  for (const t of s.tasks) {
    const title = t.stage === 0 ? `New task ${t.id}: ${cut(t.title, 70)}` : `${t.id} is now ${STAGES[t.stage]}`;
    out.push({ kind: 'tasks', key: `task:${t.id}:${t.stage}`, title, body: cut(t.stage === 0 ? [t.requester, t.source].filter(Boolean).join(' · ') : t.title + (t.session ? ' · ' + t.session : '')), route: route('task', t.id) });
  }
  for (const p of s.promises) if (p.state === 'kept') out.push({ kind: 'tasks', key: 'kept:' + p.id, title: `Promise to ${p.to} kept`, body: cut('“' + p.said + '”'), route: route('promises') });
  for (const e of s.releases?.envs ?? []) if (e.version) out.push({ kind: 'releases', key: `env:${e.name}:${e.version}`, title: `${e.name} now runs ${cut(e.version, 40)}`, body: e.url, route: route('tasks') });
  for (const m of s.releases?.merged ?? []) out.push({ kind: 'releases', key: 'merged:' + m.number, title: `Merged #${m.number}: ${cut(m.title, 70)}`, body: 'by ' + m.author, route: route('tasks') });
  for (const m of s.monitors ?? []) {
    if (m.lastCheckAt && m.lastVerdict) out.push({ kind: 'monitorReport', key: `mcheck:${m.id}:${m.lastCheckAt}`, title: `${m.title}: ${m.lastVerdict}`, body: cut(m.lastSummary ?? ''), route: route('monitors') });
    if (m.finishedAt) out.push({ kind: 'monitorReport', key: 'mdone:' + m.id, title: `Monitor finished: ${cut(m.title, 70)}`, body: m.finishReason === 'stopped' ? 'Stopped.' : `Ran ${m.checksDone} check${m.checksDone === 1 ? '' : 's'}.`, route: route('monitors') });
  }
  for (const r of s.replacements ?? []) {
    if (r.state !== 'done' && r.state !== 'failed' && r.state !== 'stalled') continue;
    const what = r.state === 'done' ? `${r.newName} took over from ${r.oldName}` : r.state === 'failed' ? `Replacing ${r.oldName} failed` : `Replacing ${r.oldName} is stalled`;
    out.push({ kind: 'replaced', key: `repl:${r.id}:${r.state}`, title: what, body: cut(r.error ?? (r.missing.length ? 'Handoff still lacks: ' + r.missing.join(', ') : '')), route: route('session', r.state === 'done' ? r.newName : r.oldName) });
  }
  for (const x of s.actions ?? []) {
    if (x.state === 'done' || x.state === 'failed') out.push({ kind: 'actions', key: `action:${x.id}:${x.state}`, title: (x.state === 'done' ? 'Done: ' : 'Failed: ') + cut(x.summary, 80), body: cut(x.result ?? ''), route: route('needs') });
    if (x.state === 'dry') out.push({ kind: 'actions', key: `action:${x.id}:dry`, title: 'Dry run recorded: ' + cut(x.summary, 70), body: 'Nothing ran. ' + cut(x.detail), route: route('needs') });
  }
  const lim = s.limits;
  if (lim) for (const [name, pct] of [['5-hour', lim.fiveHourPct], ['weekly', lim.weeklyPct]] as const) {
    const level = pct >= 95 ? 95 : pct >= 80 ? 80 : 0;
    if (level) out.push({ kind: 'limits', key: `limit:${name}:${level}`, title: `${name} usage passed ${level}%`, body: `At ${Math.round(pct)}%${lim.estimate ? ' (estimate)' : ''}.`, route: route('') });
  }
  if (s.update?.latest && s.update.behind > 0) out.push({ kind: 'updated', key: 'available:' + s.update.latest.sha, title: 'A new ShiftBoss version is available', body: cut(s.update.latest.subject), route: route('settings') });
  if (s.herdrOk === false) out.push({ kind: 'system', key: 'herdr:down', title: 'herdr is not answering', body: cut(s.herdrError ?? 'ShiftBoss cannot see your sessions.'), route: route('') });
  const ist = s.intakeState;
  if (ist && !ist.paused && ist.lastBeginAt && Date.parse(s.now) - Date.parse(ist.lastBeginAt) > 15 * 60e3)
    out.push({ kind: 'system', key: 'intake:quiet:' + ist.lastBeginAt, title: 'The intake went quiet', body: 'No check-in for 15 minutes. Its session may have stopped.', route: route('intake') });
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
  const n = s ? s.needs.filter((x) => !x.answer).length + (s.actions ?? []).filter((x) => x.state === 'waiting').length : 0;
  return n ? `(${n}) ${base}` : base;
}
