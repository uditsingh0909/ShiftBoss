import { LeadChat } from './chat';
import { useEffect, useState, type ReactNode } from 'react';
import type { Snapshot } from '../shared/types';
import { C, Dot, href, useSnap } from './lib';
import { ModeBanner, ModeSwitch } from './mode';

// The sidebar: every screen in one place, with a count of what waits on each. Collapses to an icon
// rail on desktop; on phones it is a drawer opened from the top bar.

type Tone = 'red' | 'amber' | 'dim';
type NavItem = { k: string; label: string; icon: ReactNode; badge?: { n: number; tone: Tone; title: string } };

const I = (d: string) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
const ICONS = {
  sessions: I('M4 5h16v11H4zM8 20h8M12 16v4'),
  tasks: I('M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v6h-4z'),
  needs: I('M12 4l9 16H3zM12 10v4M12 17v.5'),
  promises: I('M6 4h12v16H6zM9 10l2 2 4-4M9 16h6'),
  monitors: I('M3 12h4l2-6 4 12 2-6h6'),
  intake: I('M4 4h16v10h-5l-3 3-3-3H4zM8 9h8'),
  health: I('M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z'),
  overlap: I('M9 6a6 6 0 1 0 0 12A6 6 0 1 0 9 6zM15 6a6 6 0 1 0 0 12A6 6 0 1 0 15 6z'),
  audit: I('M4 6h16v12H4zM4 7l8 6 8-6'),
  report: I('M6 3h9l3 3v15H6zM9 11h6M9 15h6M9 7h3'),
  welcome: I('M5 12l5 5 9-10'),
  setup: I('M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5'),
  settings: I('M4 7h10M18 7h2M4 17h4M12 17h8M14 5v4M8 15v4'),
};

/** Active monitors, if this ShiftBoss sends them: an array (each with `active`, `state` or `status`) or `{ active: n }`. */
export function monitorCount(snap: Snapshot | null): number | null {
  const m = (snap as unknown as { monitors?: unknown } | null)?.monitors;
  if (m == null) return null;
  if (Array.isArray(m)) return m.filter((x) => { const o = (x ?? {}) as { active?: boolean; state?: string; status?: string }; return o.active ?? ['active', 'alerting'].includes(o.state ?? o.status ?? 'active'); }).length;
  const n = (m as { active?: unknown }).active;
  return typeof n === 'number' ? n : null;
}

function useGroups(): [string, NavItem[]][] {
  const snap = useSnap();
  // Questions and actions waiting for approval: both wait on the owner (the tab title counts the same).
  const needs = (snap?.needs.filter((n) => !n.answer).length ?? 0) + (snap?.actions?.filter((a) => a.state === 'waiting').length ?? 0);
  const alerting = (snap?.monitors ?? []).filter((m) => m.state === 'alerting').length;
  const due = snap?.promises.filter((p) => p.state === 'due').length ?? 0;
  const open = snap?.promises.filter((p) => p.state !== 'kept').length ?? 0;
  const inbox = snap?.tasks.filter((t) => t.stage === 0).length ?? 0;
  const unwell = snap?.health.filter((h) => h.verdict !== 'healthy' && h.verdict !== 'waiting') ?? [];
  const overlaps = snap?.overlaps.length ?? 0;
  const monitors = monitorCount(snap);
  const b = (n: number, tone: Tone, title: string) => (n > 0 ? { n, tone, title } : undefined);
  return [
    ['Work', [
      { k: '', label: 'Sessions', icon: ICONS.sessions },
      { k: 'tasks', label: 'Tasks', icon: ICONS.tasks, badge: b(inbox, 'dim', `${inbox} in the inbox`) },
      { k: 'needs', label: 'Needs you', icon: ICONS.needs, badge: b(needs, 'red', `${needs} waiting for your answer`) },
      { k: 'promises', label: 'Promises', icon: ICONS.promises, badge: due ? b(due, 'red', `${due} overdue`) : b(open, 'amber', `${open} open`) },
      { k: 'monitors', label: 'Monitors', icon: ICONS.monitors, badge: alerting ? b(alerting, 'red', `${alerting} alerting`) : monitors === null ? undefined : b(monitors, 'dim', `${monitors} watching`) },
    ]],
    ['Watch', [
      { k: 'intake', label: 'Intake', icon: ICONS.intake },
      { k: 'health', label: 'Health', icon: ICONS.health, badge: b(unwell.length, unwell.some((h) => ['lost', 'looping', 'burning'].includes(h.verdict)) ? 'red' : 'amber', `${unwell.length} need a look`) },
      { k: 'overlap', label: 'Overlaps', icon: ICONS.overlap, badge: b(overlaps, 'red', `${overlaps} right now`) },
      { k: 'audit', label: 'Sent as you', icon: ICONS.audit },
      { k: 'report', label: 'Daily report', icon: ICONS.report },
    ]],
    ['Setup', [
      { k: 'welcome', label: 'Get started', icon: ICONS.welcome },
      { k: 'setup', label: 'Connect', icon: ICONS.setup },
      { k: 'settings', label: 'Settings', icon: ICONS.settings },
    ]],
  ];
}

const sectionOf = (top: string) => (['', 'session', 'roster'].includes(top) ? '' : top === 'task' ? 'tasks' : top);
const badgeColor = (t: Tone) => (t === 'red' ? C.red : t === 'amber' ? C.amber : C.dim);

const COLLAPSE_KEY = 'shiftboss-nav-collapsed';
function readCollapsed() { try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; } }
function writeCollapsed(v: boolean) { try { localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0'); } catch { /* private window */ } }

const SearchIcon = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true" style={{ flex: 'none' }}><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4-4" /></svg>;

/** The sidebar on desktop, the top bar + drawer on phones. Wraps the page so content sits right of it. */
export function AppFrame({ top, connected, onSearch, children }: { top: string; connected: boolean; onSearch: () => void; children: ReactNode }) {
  const snap = useSnap();
  const groups = useGroups();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [open, setOpen] = useState(false);
  const section = sectionOf(top);
  useEffect(() => setOpen(false), [top]);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [open]);
  const toggle = () => setCollapsed((c) => { writeCollapsed(!c); return !c; });
  const close = () => setOpen(false);
  const urgent = !!snap && (snap.needs.some((n) => !n.answer) || snap.overlaps.length > 0);
  return (
    <div className={'app' + (collapsed ? ' collapsed' : '')}>
      <header className="topbar row">
        <button type="button" className="icon-btn" aria-label={'Open menu' + (urgent ? ' (something needs you)' : '')} aria-expanded={open} onClick={() => setOpen(true)}>
          {I('M4 7h16M4 12h16M4 17h16')}
          {urgent && <span className="side-pip" style={{ background: C.red }} aria-hidden="true" />}
        </button>
        <a href={href()} className="row" style={{ gap: 8 }} aria-label="ShiftBoss home">
          <span style={{ fontWeight: 500 }}>ShiftBoss</span>
          <span className={'dot' + (connected ? ' blink' : '')} style={{ background: connected ? C.green : C.red }} />
        </a>
        <span style={{ flex: 1 }} />
        <button type="button" className="icon-btn" aria-label="Search or run a command" onClick={onSearch}><SearchIcon /></button>
      </header>
      {open && <div className="side-scrim" onClick={close} aria-hidden="true" />}
      <aside className={'side' + (open ? ' open' : '')} aria-label="Main">
        <div className="side-head row">
          <a href={href()} className="row side-brand" aria-label="ShiftBoss home" onClick={close}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#F4F4F5" strokeWidth="1.25" aria-hidden="true" style={{ flex: 'none' }}><rect x="3.5" y="3.5" width="17" height="17" rx="4" /><path d="M8 9h8M8 12h5M8 15h7" /></svg>
            <span className="side-text" style={{ fontWeight: 500 }}>ShiftBoss</span>
            <span className={'dot' + (connected ? ' blink' : '')} title={connected ? 'Live' : 'Reconnecting'} aria-label={connected ? 'Live' : 'Reconnecting'} style={{ background: connected ? C.green : C.red }} />
          </a>
          <button type="button" className="side-toggle" onClick={toggle} aria-pressed={collapsed} aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'} title={collapsed ? 'Expand' : 'Collapse'}>
            <span className="st-logo"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#F4F4F5" strokeWidth="1.25" aria-hidden="true" style={{ flex: 'none' }}><rect x="3.5" y="3.5" width="17" height="17" rx="4" /><path d="M8 9h8M8 12h5M8 15h7" /></svg></span>
            <span className="st-drawer">{I('M4 5h16v14H4zM9.5 5v14')}</span>
            <span className="st-live" title={connected ? 'Live' : 'Reconnecting'} style={{ background: connected ? C.green : C.red }} aria-hidden="true" />
          </button>
          <button type="button" className="icon-btn side-close" aria-label="Close menu" onClick={close}>{I('M6 6l12 12M18 6L6 18')}</button>
        </div>
        <button type="button" className="side-search row" onClick={() => { close(); onSearch(); }} aria-label="Search or run a command (Ctrl K)" title="Search (Ctrl K)">
          <SearchIcon />
          <span className="side-text" style={{ flex: 1, textAlign: 'left' }}>Search…</span>
          <span className="side-text mono kbd">Ctrl K</span>
        </button>
        <nav className="side-nav col" aria-label="Screens">
          {groups.map(([g, items]) => (
            <div key={g} className="col" style={{ gap: 2 }}>
              <span className="label side-group">{g}</span>
              {items.map((it) => (
                <a key={it.k} href={href(...(it.k ? [it.k] : []))} className="side-item row" aria-current={section === it.k ? 'page' : undefined}
                  title={collapsed ? it.label + (it.badge ? ' · ' + it.badge.title : '') : it.badge?.title} onClick={close}>
                  <span className="side-ico">{it.icon}{it.badge && <span className="side-pip rail-only" style={{ background: badgeColor(it.badge.tone) }} aria-hidden="true" />}</span>
                  <span className="side-text ellipsis" style={{ flex: 1 }}>{it.label}</span>
                  {it.badge && <span className="side-text mono side-count" style={{ color: badgeColor(it.badge.tone) }}><span className="sr-only">, </span>{it.badge.n}<span className="sr-only"> {it.badge.title}</span></span>}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div className="side-foot col">
          <ModeSwitch collapsed={collapsed} onDone={close} />
        </div>
      </aside>
      <div className="app-main"><ModeBanner />{children}</div>
      <LeadChat />
    </div>
  );
}
