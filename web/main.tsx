import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { C, Dot, href, SnapshotCtx, Toaster, useLiveSnapshot, useRoute, useSnap } from './lib';
import { Audit, NeedsYou, Promises } from './pages/decide';
import { Releases, Report, SettingsPage } from './pages/ops';
import { CommandCenter, Health, Overlap, Roster, SessionPage } from './pages/sessions';
import { Intake, TaskPage, Tasks } from './pages/tasks';

const NAV = [
  ['', 'Sessions'], ['tasks', 'Tasks'], ['intake', 'Intake'], ['promises', 'Promises'], ['releases', 'Releases'], ['needs', 'Needs you'],
] as const;

function Nav({ route, onSearch, connected }: { route: string[]; onSearch: () => void; connected: boolean }) {
  const snap = useSnap();
  const counts: Record<string, number> = {
    needs: snap?.needs.filter((n) => !n.answer).length ?? 0,
    promises: snap?.promises.filter((p) => p.state !== 'kept').length ?? 0,
  };
  const top = route[0] ?? '';
  const section = ['session', 'roster', 'health', 'overlap', 'report', 'audit'].includes(top) ? '' : top === 'task' ? 'tasks' : top;
  return (
    <div className="navwrap">
      <nav aria-label="Main" className="nav row">
        <a href={href()} className="row" style={{ gap: 8, padding: '0 12px 0 10px' }} aria-label="ShiftBoss home">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#F4F4F5" strokeWidth="1.25" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="4" /><path d="M8 9h8M8 12h5M8 15h7" /></svg>
          <span style={{ fontWeight: 500 }}>ShiftBoss</span>
          <span className={'dot' + (connected ? ' blink' : '')} title={connected ? 'Live' : 'Reconnecting'} aria-label={connected ? 'Live' : 'Reconnecting'} style={{ background: connected ? C.green : C.red }} />
        </a>
        {NAV.map(([k, label]) => (
          <a key={k} className="item" href={href(...(k ? [k] : []))} aria-current={section === k ? 'page' : undefined}>
            {label}
            {counts[k] ? <span className="mono" style={{ fontSize: 11, color: k === 'needs' ? C.red : C.amber }}>{counts[k]}</span> : null}
          </a>
        ))}
        <span style={{ width: 1, height: 20, background: 'rgba(255,255,255,0.08)', margin: '0 6px' }} />
        <button type="button" className="srch row mono" onClick={onSearch} aria-label="Search or run a command (Ctrl K)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true" style={{ flex: 'none' }}><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4-4" /></svg>
          <span className="x">Search or run a command</span><span className="x" style={{ border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, padding: '1px 6px' }}>⌘K</span>
        </button>
        <a href={href('settings')} aria-label="Settings" aria-current={top === 'settings' ? 'page' : undefined} className="row" style={{ justifyContent: 'center', width: 34, height: 34, borderRadius: 999, border: '1px solid rgba(255,255,255,0.08)', background: top === 'settings' ? 'rgba(255,255,255,0.08)' : 'transparent' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#F4F4F5" strokeWidth="1.25" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" /></svg>
        </a>
      </nav>
    </div>
  );
}

const SHORTCUTS = [['roster', 'All sessions'], ['health', 'Health'], ['overlap', 'Overlaps'], ['report', 'Daily report'], ['audit', 'Sent as you']] as const;

function Shortcuts({ top }: { top: string }) {
  return (
    <div className="shortcuts-wrap">
      <nav aria-label="Shortcuts" className="shortcuts row mono">
        {SHORTCUTS.map(([k, label]) => (
          <a key={k} href={href(k)} aria-current={top === k ? 'page' : undefined}>{label} ↗</a>
        ))}
      </nav>
    </div>
  );
}

function Palette({ onClose }: { onClose: () => void }) {
  const snap = useSnap();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const items = useMemo(() => {
    const all: { group: string; label: string; meta: string; to: string }[] = [
      { group: 'Go to', label: 'Tasks board', meta: 'board and list', to: href('tasks') },
      { group: 'Go to', label: 'Needs you', meta: 'decisions', to: href('needs') },
      { group: 'Go to', label: 'Roster', meta: 'every session', to: href('roster') },
      { group: 'Go to', label: 'Session health', meta: 'stuck, looping, heavy', to: href('health') },
      { group: 'Go to', label: 'Overlap check', meta: 'same files, same migration', to: href('overlap') },
      { group: 'Go to', label: 'Daily report', meta: 'copy and send', to: href('report') },
      { group: 'Go to', label: 'Sent as you', meta: 'audit log', to: href('audit') },
      { group: 'Go to', label: 'Settings', meta: 'lanes, slots, thresholds', to: href('settings') },
      { group: 'Do', label: 'New task', meta: 'into the inbox', to: href('tasks', 'new') },
    ];
    for (const s of snap?.sessions ?? []) all.push({ group: 'Sessions', label: s.name, meta: `${s.status} · ctx ${Math.round(s.contextPct)}%`, to: href('session', s.name) });
    for (const t of snap?.tasks ?? []) all.push({ group: 'Tasks', label: `${t.id} · ${t.title}`, meta: t.session ?? 'unassigned', to: href('task', t.id) });
    const ql = q.toLowerCase();
    return all.filter((i) => !ql || (i.label + ' ' + i.meta).toLowerCase().includes(ql)).slice(0, 14);
  }, [q, snap]);
  const go = (to: string) => { location.hash = to.slice(1); onClose(); };
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="shell rise" role="dialog" aria-modal="true" aria-label="Command palette" style={{ width: 'min(760px, 100%)' }}>
        <div className="core col" style={{ padding: 8 }}>
          <div className="row" style={{ gap: 14, padding: '12px 16px' }}>
            <label htmlFor="pq" className="faint" style={{ fontSize: 12 }}>Search</label>
            <input id="pq" ref={input} value={q} onChange={(e) => { setQ(e.target.value); setSel(0); }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
                if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
                if (e.key === 'Enter' && items[sel]) go(items[sel].to);
                if (e.key === 'Escape') onClose();
              }}
              placeholder="Sessions, tasks, screens" style={{ flex: 1, height: 36, border: 'none', background: 'transparent', fontSize: 20, outline: 'none' }} />
            <span className="mono faint" style={{ fontSize: 11, border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, padding: '2px 7px' }}>esc</span>
          </div>
          <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '0 10px' }} />
          <div className="col" style={{ padding: 6, gap: 2, maxHeight: '56vh', overflowY: 'auto' }} role="listbox">
            {items.map((i, k) => (
              <a key={i.group + i.label} href={i.to} onClick={onClose} role="option" aria-selected={k === sel} onMouseEnter={() => setSel(k)}
                className="row" style={{ gap: 14, height: 46, padding: '0 14px', borderRadius: 14, background: k === sel ? 'rgba(255,255,255,0.06)' : 'transparent' }}>
                <span className="label" style={{ width: 70 }}>{i.group}</span>
                <span className="ellipsis" style={{ flex: 1, fontSize: 14 }}>{i.label}</span>
                <span className="mono faint" style={{ fontSize: 12 }}>{i.meta}</span>
              </a>
            ))}
            {!items.length && <div className="faint" style={{ padding: 16 }}>Nothing matches.</div>}
          </div>
        </div>
      </section>
    </div>
  );
}

function App() {
  const { snap, connected } = useLiveSnapshot();
  const route = useRoute();
  const [palette, setPalette] = useState(false);
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); } };
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, []);
  const [top, a1] = route;
  let page;
  if (!snap) page = <div className="page"><span className="faint">{connected ? 'Loading…' : 'Connecting to ShiftBoss…'}</span></div>;
  else if (top === 'session' && a1) page = <SessionPage name={a1} />;
  else if (top === 'roster') page = <Roster />;
  else if (top === 'health') page = <Health />;
  else if (top === 'overlap') page = <Overlap />;
  else if (top === 'tasks') page = <Tasks openNew={a1 === 'new'} inbox={a1 === 'inbox'} />;
  else if (top === 'task' && a1) page = <TaskPage id={a1} />;
  else if (top === 'intake') page = <Intake />;
  else if (top === 'needs') page = <NeedsYou />;
  else if (top === 'promises') page = <Promises />;
  else if (top === 'audit') page = <Audit />;
  else if (top === 'releases') page = <Releases />;
  else if (top === 'report') page = <Report />;
  else if (top === 'settings') page = <SettingsPage />;
  else page = <CommandCenter />;
  return (
    <SnapshotCtx.Provider value={snap}>
      {snap && !snap.herdrOk && (
        <div role="alert" className="row" style={{ gap: 10, justifyContent: 'center', padding: '10px 16px', borderBottom: '1px solid rgba(255,90,79,0.3)', fontSize: 13 }}>
          <Dot color={C.red} /> herdr is not answering: {snap.herdrError ?? 'unknown error'}
        </div>
      )}
      {!connected && snap && <div role="status" className="mono faint" style={{ textAlign: 'center', padding: 8, fontSize: 12 }}>Reconnecting…</div>}
      <Shortcuts top={top ?? ''} />
      <main key={route.join('/')}>{page}</main>
      <Nav route={route} onSearch={() => setPalette(true)} connected={connected} />
      {palette && <Palette onClose={() => setPalette(false)} />}
      <Toaster />
    </SnapshotCtx.Provider>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
