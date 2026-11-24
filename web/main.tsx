import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { C, Dot, href, SnapshotCtx, Toaster, useLiveSnapshot, useRoute, useSnap } from './lib';
import { AppFrame } from './nav';
import { Audit, NeedsYou, Promises } from './pages/decide';
import { Report, SettingsPage } from './pages/ops';
import { Welcome } from './pages/welcome';
import { replayTour, Tour } from './tour';
import { SetupPage } from './pages/setup';
import { CommandCenter, Health, Overlap, Roster, SessionPage } from './pages/sessions';
import { Intake, TaskPage, Tasks } from './pages/tasks';

function Palette({ onClose }: { onClose: () => void }) {
  const snap = useSnap();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const items = useMemo(() => {
    const all: { group: string; label: string; meta: string; to: string; run?: () => void }[] = [
      { group: 'Help', label: "Show this page's tour", meta: 'a short walk through this screen', to: '#', run: replayTour },
      { group: 'Go to', label: 'Tasks board', meta: 'board and list', to: href('tasks') },
      { group: 'Go to', label: 'Needs you', meta: 'decisions', to: href('needs') },
      { group: 'Go to', label: 'Promises', meta: 'what you said you would do', to: href('promises') },
      { group: 'Go to', label: 'Monitors', meta: 'what is being watched', to: href('monitors') },
      { group: 'Go to', label: 'Intake', meta: 'every message it read', to: href('intake') },
      { group: 'Go to', label: 'Roster', meta: 'every session', to: href('roster') },
      { group: 'Go to', label: 'Session health', meta: 'stuck, looping, heavy', to: href('health') },
      { group: 'Go to', label: 'Overlap check', meta: 'same files, same migration', to: href('overlap') },
      { group: 'Go to', label: 'Daily report', meta: 'copy and send', to: href('report') },
      { group: 'Go to', label: 'Sent as you', meta: 'audit log', to: href('audit') },
      { group: 'Go to', label: 'Settings', meta: 'lanes, slots, thresholds', to: href('settings') },
      { group: 'Go to', label: 'Connect', meta: 'MCP tools, status line, intake setup', to: href('setup') },
      { group: 'Do', label: 'Get started', meta: 'set up, bring in current work', to: href('welcome') },
      { group: 'Do', label: 'Bring sessions into herdr', meta: 'from the CLI, TUI or desktop app', to: href('welcome') },
      { group: 'Do', label: 'New task', meta: 'into the inbox', to: href('tasks', 'new') },
      { group: 'Do', label: 'New session', meta: 'Claude Code in a new herdr tab', to: href('sessions') },
    ];
    for (const s of snap?.sessions ?? []) all.push({ group: 'Sessions', label: s.name, meta: `${s.status} · ctx ${Math.round(s.contextPct)}%`, to: href('session', s.name) });
    for (const t of snap?.tasks ?? []) all.push({ group: 'Tasks', label: `${t.id} · ${t.title}`, meta: t.session ?? 'unassigned', to: href('task', t.id) });
    const ql = q.toLowerCase();
    return all.filter((i) => !ql || (i.label + ' ' + i.meta).toLowerCase().includes(ql)).slice(0, 14);
  }, [q, snap]);
  const go = (i: { to: string; run?: () => void }) => { onClose(); if (i.run) setTimeout(i.run, 60); else location.hash = i.to.slice(1); };
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
                if (e.key === 'Enter' && items[sel]) go(items[sel]);
                if (e.key === 'Escape') onClose();
              }}
              placeholder="Sessions, tasks, screens" style={{ flex: 1, height: 36, border: 'none', background: 'transparent', fontSize: 20, outline: 'none' }} />
            <span className="mono faint" style={{ fontSize: 11, border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, padding: '2px 7px' }}>esc</span>
          </div>
          <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '0 10px' }} />
          <div className="col" style={{ padding: 6, gap: 2, maxHeight: '56vh', overflowY: 'auto' }} role="listbox">
            {items.map((i, k) => (
              <a key={i.group + i.label} href={i.to} onClick={(e) => { if (i.run) { e.preventDefault(); go(i); } else onClose(); }} role="option" aria-selected={k === sel} onMouseEnter={() => setSel(k)}
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

/** One screen failing to render must not black out the app: show what broke and a way back. */
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page">
        <section className="shell alert-red"><div className="core col" style={{ gap: 12 }}>
          <span className="label">This screen hit an error</span>
          <span className="mono" style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{this.state.error.message}</span>
          <span className="dim" style={{ fontSize: 13 }}>The rest of ShiftBoss still works. Reload the page, or go back to Sessions.</span>
          <div className="row" style={{ gap: 8 }}><a className="pill sm w" href="#/">Back to Sessions</a><button type="button" className="pill sm" onClick={() => location.reload()}>Reload</button></div>
        </div></section>
      </div>
    );
  }
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
  else if (top === 'report') page = <Report />;
  else if (top === 'settings') page = <SettingsPage />;
  else if (top === 'welcome') page = <Welcome />;
  else if (top === 'setup') page = <SetupPage />;
  // A fresh install (nothing on the board, setup never finished) opens on Get started.
  else if (!snap.onboarding.doneAt && !snap.tasks.length && !top) page = <Welcome />;
  else page = <CommandCenter />;
  return (
    <SnapshotCtx.Provider value={snap}>
      <AppFrame top={top ?? ''} connected={connected} onSearch={() => setPalette(true)}>
        {snap && !snap.herdrOk && (
          <div role="alert" className="row" style={{ gap: 10, justifyContent: 'center', padding: '10px 16px', borderBottom: '1px solid rgba(255,90,79,0.3)', fontSize: 13 }}>
            <Dot color={C.red} /> herdr is not answering: {snap.herdrError ?? 'unknown error'}
          </div>
        )}
        {!connected && snap && <div role="status" className="mono faint" style={{ textAlign: 'center', padding: 8, fontSize: 12 }}>Reconnecting…</div>}
        <main key={route.join('/')}><Boundary>{page}</Boundary></main>
      </AppFrame>
      {palette && <Palette onClose={() => setPalette(false)} />}
      {snap && <Tour page={top === '' && !(!snap.onboarding.doneAt && !snap.tasks.length) ? 'home' : top || 'welcome'} />}
      <Toaster />
    </SnapshotCtx.Provider>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
