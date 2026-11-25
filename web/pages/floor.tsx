// The Floor: a full-screen 3D office for a second monitor. Every session sits at a desk; the panels on top show
// what needs you and what is happening, and follow what you click (a session, a team area or the lounge).
import { LeadChat } from '../chat';
import { MODE_LABEL } from '../../server/gate';
import { useEffect, useMemo, useRef, useState } from 'react';
import { clockTime, fmtCache, type Snapshot } from '../../shared/types';
import { DESK_COLOR, DESK_WORD, FLOOR_NAME, floorModel, type Desk } from '../../shared/floor';
import { api, href, navigate, toast, useSnap } from '../lib';
import type { FloorScene } from '../floor/scene';

type Scope = { kind: 'session'; name: string } | { kind: 'area'; lane: string } | null;

function inScopeFn(scope: Scope, all: Desk[]) {
  if (!scope) return () => true;
  if (scope.kind === 'session') return (name: string | null) => name === scope.name;
  const names = new Set(all.filter((d) => (scope.lane === '__idle' ? d.state === 'idle' : d.lane === scope.lane)).map((d) => d.name));
  return (name: string | null) => !!name && names.has(name);
}

export function FloorPage() {
  const snap = useSnap()!;
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const scene = useRef<FloorScene | null>(null);
  const [scope, setScope] = useState<Scope>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [ready, setReady] = useState(false); // re-render once the scene exists, so it draws right away
  const model = useMemo(() => floorModel(snap), [snap]);

  // the scene loads on its own (three.js is large), so the rest of ShiftBoss stays quick
  useEffect(() => {
    let live = true;
    import('../floor/scene').then(({ FloorScene }) => {
      if (!live || !canvas.current || !overlay.current) return;
      try {
        scene.current = new FloorScene(canvas.current, overlay.current, {
          onSelect: (name) => { setScope(name ? { kind: 'session', name } : null); scene.current?.select(name); },
          onArea: (lane) => { setScope({ kind: 'area', lane }); },
        });
        setReady(true);
      } catch (e) { setFailed((e as Error).message); }
    }).catch((e) => setFailed((e as Error).message));
    return () => { live = false; scene.current?.dispose(); scene.current = null; };
  }, []);
  useEffect(() => {
    const monitorAlert = snap.monitors.find((m) => m.state === 'alerting');
    scene.current?.setModel(model, {
      owner: snap.owner,
      usage5h: snap.limits ? snap.limits.fiveHourPct : null, usageWeek: snap.limits ? snap.limits.weeklyPct : null,
      envs: snap.releases.envs.map((e) => ({ env: e.name, version: e.version ?? '—' })),
      feed: snap.feed.slice(0, 6).map((f) => `${f.who} ${f.text}`), alert: monitorAlert ? monitorAlert.title : null,
    });
  });
  // keys: Esc back to the whole floor, / to search
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setScope(null); scene.current?.goHome(); }
      if (e.key === '/' && !(document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement)) { e.preventDefault(); document.getElementById('fl-q')?.focus(); }
    };
    addEventListener('keydown', on); return () => removeEventListener('keydown', on);
  }, []);
  useEffect(() => { document.title = `${FLOOR_NAME} · ShiftBoss`; }, []);

  const inScope = inScopeFn(scope, model.all);
  const selected = scope?.kind === 'session' ? model.all.find((d) => d.name === scope.name) ?? null : null;
  const pick = (name: string | null) => { setScope(name ? { kind: 'session', name } : null); if (name) scene.current?.select(name); else scene.current?.goHome(); };

  return (
    <div className="fl">
      <canvas ref={canvas} className="fl-gl" aria-label={`${FLOOR_NAME}: every session at its desk, lit in its state`} />
      <div ref={overlay} className="fl-overlay" aria-hidden="true" />
      {failed && <div className="fl-failed glass-solid">The 3D view could not start here ({failed}). Everything else in ShiftBoss still works.</div>}
      <div className="fl-ui">
        <TopBar snap={snap} model={model} onFind={pick} />
        <Kpis snap={snap} model={model} scope={scope} selected={selected} />
        <aside className="fl-right">
          <Detail snap={snap} model={model} scope={scope} selected={selected} onBack={() => pick(null)} onPick={pick} />
          <Needs snap={snap} inScope={inScope} scoped={!!scope} />
        </aside>
        <div className="fl-bottom">
          <Activity snap={snap} model={model} inScope={inScope} label={scope ? (scope.kind === 'session' ? scope.name : scope.lane === '__idle' ? 'lounge' : scope.lane) : 'all sessions'} />
        </div>
      </div>
      <div className="fl-tools">
      <nav className="fl-ctrls fl-card" aria-label="Camera">
        <button type="button" aria-label="Zoom in" onClick={() => scene.current?.zoom(.8)}>+</button>
        <button type="button" aria-label="Zoom out" onClick={() => scene.current?.zoom(1.25)}>−</button>
        <button type="button" aria-label="Turn left" onClick={() => scene.current?.turn(Math.PI / 6)}>⟲</button>
        <button type="button" aria-label="Turn right" onClick={() => scene.current?.turn(-Math.PI / 6)}>⟳</button>
        <button type="button" aria-label="Back to the whole floor" onClick={() => pick(null)}>⌂</button>
      </nav>
      <div className="fl-legend fl-card" aria-label="Colours">{(['working', 'needs', 'stuck', 'finished', 'idle'] as const).map((k) => <span key={k}><i className="dot" style={{ background: DESK_COLOR[k] }} />{DESK_WORD[k]}</span>)}</div>
      </div>
      <LeadChat />
    </div>
  );
}

function TopBar({ snap, model, onFind }: { snap: Snapshot; model: ReturnType<typeof floorModel>; onFind: (n: string) => void }) {
  const [q, setQ] = useState('');
  const [bell, setBell] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(t); }, []);
  const find = () => { const v = q.trim().toLowerCase(); const hit = model.all.find((d) => d.name.toLowerCase().includes(v) || (d.task ?? '').toLowerCase().includes(v) || d.lane.toLowerCase().includes(v)); if (hit) onFind(hit.name); else toast('No session matches'); };
  const notes = [
    ...snap.needs.filter((n) => !n.answer).map((n) => ({ tone: n.kind === 'Permission' ? 'var(--red)' : 'var(--amber)', title: `${n.session ?? 'A session'} needs you`, body: n.title, at: n.createdAt })),
    ...snap.actions.filter((a) => a.state === 'waiting').map((a) => ({ tone: 'var(--amber)', title: 'Waiting for your approval', body: a.summary, at: a.at })),
    ...snap.feed.slice(0, 6).map((f) => ({ tone: 'rgba(255,255,255,.35)', title: f.who, body: f.text, at: f.at })),
  ];
  const unread = model.kpis.needs;
  return (
    <header className="fl-top fl-card">
      <span className="fl-brand"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#F4F4F5" strokeWidth="1.25" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="4" /><path d="M8 9h8M8 12h5M8 15h7" /></svg>ShiftBoss <span className="faint">{FLOOR_NAME}</span></span>
      <label className="fl-search"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4-4" /></svg>
        <input id="fl-q" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') find(); }} placeholder="Find a session, task or team" aria-label="Find a session, task or team" /><span className="kbd">/</span></label>
      <span style={{ flex: 1 }} />
      <span className="eyebrow">{MODE_LABEL[snap.settings.mode ?? 'auto']}</span>
      {snap.limits && <span className="fl-meter">5h<i><em style={{ width: `${Math.min(100, snap.limits.fiveHourPct)}%` }} /></i><span className="mono">{Math.round(snap.limits.fiveHourPct)}%</span></span>}
      <button type="button" className="fl-ibtn" aria-label={`Notifications, ${unread} waiting`} aria-expanded={bell} onClick={() => setBell(!bell)}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20a2 2 0 0 0 4 0" /></svg>
        {unread > 0 && <span className="fl-badge">{unread}</span>}
      </button>
      <span className="fl-clock mono">{clockTime(Date.now())}</span>
      <a className="fl-exit" href={href()} onClick={(e) => { e.preventDefault(); navigate(href()); }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 4H5v16h4M14 8l4 4-4 4M18 12H9" /></svg>Leave the {FLOOR_NAME.toLowerCase()}</a>
      {bell && (
        <section className="fl-notes fl-card" aria-label="Notifications">
          <div className="fl-ph">Notifications<small><a href={href('settings', 'notifications')}>Settings</a></small></div>
          {notes.length ? notes.slice(0, 9).map((n, i) => <div key={i} className="fl-note"><i className="dot" style={{ background: n.tone }} /><div><b>{n.title}</b><span>{n.body}</span></div><time className="mono">{clockTime(n.at)}</time></div>) : <div className="faint" style={{ padding: 16 }}>Nothing new.</div>}
        </section>
      )}
    </header>
  );
}

function Kpis({ snap, model, scope, selected }: { snap: Snapshot; model: ReturnType<typeof floorModel>; scope: Scope; selected: Desk | null }) {
  const k = model.kpis;
  let cards: [string, string, string, string?][];
  if (selected) {
    const nNeeds = snap.needs.filter((n) => !n.answer && n.session === selected.name).length;
    cards = [
      ['Context', `${selected.ctx}%`, selected.ctx >= 85 ? 'time to replace' : selected.ctx >= 70 ? 'getting full' : 'room left', selected.ctx >= 85 ? 'var(--red)' : selected.ctx >= 70 ? 'var(--amber)' : undefined],
      ['Cache read', fmtCache(selected.cacheRead), 'over its whole life', selected.cacheRead >= 1e9 ? 'var(--red)' : selected.cacheRead >= 5e8 ? 'var(--amber)' : undefined],
      ['Task', selected.task ?? '—', selected.task ? 'assigned' : 'no task assigned'],
      ['Needs you', String(nNeeds), nNeeds ? 'from this session' : 'nothing waiting', nNeeds ? 'var(--red)' : undefined],
    ];
  } else if (scope?.kind === 'area') {
    const list = model.all.filter((d) => (scope.lane === '__idle' ? d.state === 'idle' : d.lane === scope.lane));
    const busy = list.filter((d) => ['working', 'needs', 'stuck'].includes(d.state)).length;
    const top = list.slice().sort((a, b) => b.ctx - a.ctx)[0];
    const n = snap.needs.filter((x) => !x.answer && list.some((d) => d.name === x.session)).length;
    cards = [
      [`${scope.lane === '__idle' ? 'Lounge' : scope.lane} · busy`, list.length ? `${Math.round(busy / list.length * 100)}%` : '0%', `${busy} of ${list.length} sessions`],
      ['Sessions here', String(list.length), `${list.filter((d) => d.state === 'idle').length} idle`],
      ['Fullest context', top ? `${top.ctx}%` : '—', top?.name ?? '—'],
      ['Needs you', String(n), n ? 'in this area' : 'nothing waiting', n ? 'var(--red)' : undefined],
    ];
  } else {
    cards = [
      ['Busy', k.total ? `${Math.round(k.busy / k.total * 100)}%` : '0%', `${k.busy} of ${k.total} sessions`],
      ['In progress', String(k.inProgress), 'tasks being worked on'],
      ['Live today', String(k.shippedToday), 'tasks that reached Live'],
      ['Needs you', String(k.needs), k.oldestNeedMin !== null ? `oldest ${k.oldestNeedMin}m` : 'nothing waiting', k.needs ? 'var(--red)' : undefined],
    ];
  }
  return (
    <section className="fl-kpis" aria-label="Overview">
      {cards.map(([l, v, s, c]) => <div key={l} className="fl-kpi fl-card"><span className="label">{l}</span><b className="mono" style={{ color: c }}>{v}</b><span className="faint">{s}</span></div>)}
    </section>
  );
}

function Detail({ snap, model, scope, selected, onBack, onPick }: { snap: Snapshot; model: ReturnType<typeof floorModel>; scope: Scope; selected: Desk | null; onBack: () => void; onPick: (n: string) => void }) {
  if (selected) {
    const d = selected;
    return (
      <section className="fl-card fl-panel fl-detail" aria-label={d.name}>
        <div className="fl-ph"><i className="dot" style={{ background: DESK_COLOR[d.state] }} /><span className="mono">{d.name}</span><small><button type="button" className="fl-x" onClick={onBack} aria-label="Back to the whole floor">✕</button></small></div>
        <span className="faint" style={{ fontSize: 12 }}>{d.lane} · {DESK_WORD[d.state]}{d.task ? ` · ${d.task}` : ''}</span>
        {d.lastTool && <div className="fl-cell"><span>Doing now</span><div className="mono ellipsis">{d.lastTool}</div></div>}
        <div className="fl-term mono">{(d.lines.length ? d.lines.slice(-5) : ['no output yet']).map((l, i) => <div key={i} className="ellipsis">{l}</div>)}</div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="pill sm w" onClick={() => void api('POST', `/api/sessions/${encodeURIComponent(d.name)}/focus`).then(() => toast('Opened in herdr'), (e) => toast((e as Error).message))}>Open in herdr</button>
          <a className="pill sm" href={href('session', d.name)}>Session page</a>
        </div>
      </section>
    );
  }
  const order: Record<string, number> = { needs: 0, stuck: 1, working: 2, finished: 3, idle: 4 };
  const scopeList = scope?.kind === 'area' ? model.all.filter((d) => (scope.lane === '__idle' ? d.state === 'idle' : d.lane === scope.lane)) : model.all;
  const list = scopeList.slice().sort((x, y) => order[x.state] - order[y.state] || y.ctx - x.ctx);
  const t = snap.settings.thresholds;
  const worn = list.filter((d) => d.cacheRead >= (t.cacheWarnM ?? 500) * 1e6).sort((x, y) => y.cacheRead - x.cacheRead).slice(0, 3);
  const counts = (['needs', 'stuck', 'working', 'finished', 'idle'] as const).map((k) => [k, list.filter((d) => d.state === k).length] as const);
  const run = (path: string, body: unknown, ok: string) => void api('POST', path, body).then(() => toast(ok), (e) => toast((e as Error).message));
  return (
    <section className="fl-card fl-panel fl-detail fl-overview" aria-label="The floor">
      <div className="fl-ph">{scope?.kind === 'area' ? (scope.lane === '__idle' ? 'Lounge' : scope.lane) : 'The floor'}<small>{list.length} session{list.length === 1 ? '' : 's'}</small></div>
      <div className="fl-chips">{counts.map(([k, n]) => <span key={k} className={'fl-chip' + (n ? '' : ' zero')}><i className="dot" style={{ background: DESK_COLOR[k] }} />{n} {DESK_WORD[k]}</span>)}</div>
      <div className="fl-slist">
        {list.map((d) => (
          <button key={d.name} type="button" className="fl-srow" onClick={() => onPick(d.name)}>
            <i className="dot" style={{ background: DESK_COLOR[d.state] }} />
            <span className="fl-sname"><b className="mono ellipsis">{d.name}</b><span className="ellipsis">{d.task ?? d.lane}</span></span>
            <span className="fl-sbar" title={`context ${d.ctx}%`}><i style={{ width: `${Math.min(100, d.ctx)}%`, background: d.ctx >= t.replace ? 'var(--red)' : d.ctx >= t.warn ? 'var(--amber)' : 'rgba(255,255,255,.6)' }} /></span>
            <em className="mono" style={{ color: d.cacheRead >= (t.cacheReplaceM ?? 1000) * 1e6 ? 'var(--red)' : d.cacheRead >= (t.cacheWarnM ?? 500) * 1e6 ? 'var(--amber)' : undefined }}>{fmtCache(d.cacheRead)}</em>
          </button>
        ))}
        {!list.length && <span className="faint" style={{ fontSize: 13 }}>No sessions running in herdr.</span>}
      </div>
      {worn.length > 0 && (
        <div className="fl-worn">
          <span className="label">Due for a fresh start</span>
          {worn.map((d) => (
            <div key={d.name} className="fl-wrow"><b className="mono ellipsis">{d.name}</b><span className="faint mono">{fmtCache(d.cacheRead)} · {d.ctx}%</span>
              <button type="button" className="pill xs" onClick={() => run('/api/sessions/replace', { sessions: [d.name] }, `Replacing ${d.name}: handoff first`)}>Replace</button></div>
          ))}
        </div>
      )}
      <div className="fl-actions">
        <button type="button" className="pill xs" onClick={() => run('/api/herdr/tidy', {}, 'Tidied herdr tabs')}>Tidy herdr tabs</button>
        <button type="button" className="pill xs" onClick={() => run('/api/intake/run', {}, 'Intake is checking now')}>Run intake check</button>
        <a className="pill xs" href={href()}>Open Sessions</a>
      </div>
    </section>
  );
}

function Needs({ snap, inScope, scoped }: { snap: Snapshot; inScope: (n: string | null) => boolean; scoped: boolean }) {
  const [page, setPage] = useState(0);
  const needs = snap.needs.filter((n) => !n.answer && inScope(n.session));
  const held = scoped ? [] : snap.actions.filter((a) => a.state === 'waiting');
  const items = [...needs.map((n) => ({ kind: 'need' as const, n })), ...held.map((a) => ({ kind: 'action' as const, a }))];
  const pages = Math.max(1, Math.ceil(items.length / 3)), p = Math.min(page, pages - 1);
  const answer = (id: number, a: string) => api('POST', `/api/needs/${id}/answer`, { answer: a }).then(() => toast(`Answered: ${a}`), (e) => toast((e as Error).message));
  const decide = (id: number, ok: boolean) => api('POST', `/api/actions/${id}/${ok ? 'approve' : 'reject'}`).then(() => toast(ok ? 'Approved' : 'Rejected'), (e) => toast((e as Error).message));
  return (
    <section className={'fl-card fl-panel fl-needs' + (items.length ? '' : ' empty')} aria-label="Needs you">
      <div className="fl-ph">{scoped ? 'Needs you here' : 'Needs you'}{items.length > 0 && <span className="fl-cnt">{items.length}</span>}<small><a href={href('needs')}>All</a></small></div>
      <div className="fl-needlist">
        {items.slice(p * 3, p * 3 + 3).map((it) => it.kind === 'need' ? (
          <div key={'n' + it.n.id} className={'fl-need' + (it.n.auto ? ' red' : '')}>
            <div className="r"><i className={'dot' + (it.n.auto ? ' pulse' : '')} style={{ background: it.n.auto ? 'var(--red)' : 'var(--amber)' }} /><b className="ellipsis">{it.n.session ?? it.n.kind}</b><small>{it.n.kind} · {clockTime(it.n.createdAt)}</small></div>
            <p>{it.n.title}</p>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>{it.n.auto
              ? <button type="button" className="pill sm w" onClick={() => void answer(it.n.id, 'open')}>Open in herdr</button>
              : it.n.answers.slice(0, 3).map((a, i) => <button key={a} type="button" className={'pill sm' + (i === 0 ? ' w' : '')} onClick={() => void answer(it.n.id, a)}>{a}</button>)}</div>
          </div>
        ) : (
          <div key={'a' + it.a.id} className="fl-need">
            <div className="r"><i className="dot" style={{ background: 'var(--amber)' }} /><b>Approve?</b><small>{it.a.by} · {clockTime(it.a.at)}</small></div>
            <p>{it.a.summary}</p>
            <div className="row" style={{ gap: 8 }}><button type="button" className="pill sm w" onClick={() => void decide(it.a.id, true)}>Approve</button><button type="button" className="pill sm" onClick={() => void decide(it.a.id, false)}>Reject</button></div>
          </div>
        ))}
        {!items.length && <div className="fl-need"><p>Nothing {scoped ? 'here ' : ''}needs you right now.</p></div>}
      </div>
      {items.length > 3 && <div className="fl-pager mono"><span>{p * 3 + 1}–{Math.min(items.length, p * 3 + 3)} of {items.length}</span><button type="button" aria-label="Previous page" onClick={() => setPage(Math.max(0, p - 1))}>‹</button><button type="button" aria-label="Next page" onClick={() => setPage(Math.min(pages - 1, p + 1))}>›</button></div>}
    </section>
  );
}

function Activity({ snap, model, inScope, label }: { snap: Snapshot; model: ReturnType<typeof floorModel>; inScope: (n: string | null) => boolean; label: string }) {
  const [tab, setTab] = useState<'activity' | 'console'>('activity');
  const names = new Set(model.all.map((d) => d.name));
  const feed = snap.feed.filter((f) => !names.has(f.who) || inScope(f.who)).slice(0, 8);
  const lines = snap.sessions.filter((s) => inScope(s.name)).flatMap((s) => (s.lines ?? []).slice(-6).map((l) => ({ ...l, who: s.name }))).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 9);
  const stateOf = (n: string) => model.all.find((d) => d.name === n)?.state ?? 'idle';
  return (
    <section className="fl-card fl-act" aria-label="Activity">
      <div className="row" style={{ gap: 4 }}>
        <button type="button" className="fl-tab" aria-pressed={tab === 'activity'} onClick={() => setTab('activity')}>Live activity</button>
        <button type="button" className="fl-tab" aria-pressed={tab === 'console'} onClick={() => setTab('console')}>Console</button>
        <span style={{ flex: 1 }} /><span className="label">{label}</span>
      </div>
      <div className={'fl-feed' + (tab === 'console' ? ' console' : '')}>
        {tab === 'activity'
          ? (feed.length ? feed.map((f, i) => <div key={i} className="l"><i className="dot" style={{ background: DESK_COLOR[stateOf(f.who)] }} /><b>{f.who}</b><span>{f.text}</span></div>) : <div className="faint">Quiet.</div>)
          : (lines.length ? lines.map((l, i) => <div key={i} className="l"><i className="dot" style={{ background: DESK_COLOR[stateOf(l.who)] }} /><b>{l.who}</b><span>{l.kind === 'tool' ? '⏺ ' : l.kind === 'out' ? '⎿ ' : ''}{l.text}</span></div>) : <div className="faint">No output yet.</div>)}
      </div>
    </section>
  );
}
