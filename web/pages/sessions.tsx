import { useEffect, useState } from 'react';
import type { Session } from '../../shared/types';
import { act, ago, api, Arrow, Bar, C, Card, ctxColor, Dot, Empty, fmtTok, Hero, hhmm, href, Seg, toneColor, useSnap } from '../lib';

const statusColor = (s: Session['status']) => (s === 'blocked' ? C.amber : s === 'working' ? C.green : s === 'lost' ? C.red : C.faint);
const lineColor = (k: string) => (k === 'tool' ? C.fg : k === 'out' ? C.faint : k === 'you' ? C.amber : k === 'sys' ? C.red : C.dim);
/** The session's own last sentence, used when ShiftBoss has not given it a task. */
const lastSay = (s: Session) => { const t = s.lines.filter((l) => l.kind === 'say').at(-1)?.text; return t ? t.split(/(?<=[.!?])\s/)[0].slice(0, 120) : null; };
const prefix = (k: string) => (k === 'tool' ? '⏺ ' : k === 'out' ? '  ⎿ ' : k === 'you' ? 'you › ' : '· ');

function Lines({ s, n, height, stamps }: { s: Session; n: number; height: number; stamps?: boolean }) {
  return (
    <div className="term" style={{ height }}>
      <div className="scroll" style={{ height: '100%', padding: stamps ? '16px 18px' : '10px 12px' }} role="log" aria-live="polite" tabIndex={0}>
        <div className="col" style={{ gap: 2 }}>
          {s.lines.slice(-n).map((l, i) => (
            <div key={i + l.at} className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
              {stamps && <span style={{ width: 52, flex: 'none', color: 'rgba(255,255,255,0.22)' }}>{hhmm(l.at)}</span>}
              <span style={{ color: lineColor(l.kind), wordBreak: 'break-word', minWidth: 0 }} className={stamps ? '' : 'ellipsis'}>{prefix(l.kind) + l.text}</span>
            </div>
          ))}
          {!s.lines.length && <span className="faint">No transcript lines yet.</span>}
          <div>› <span className="caret" aria-hidden="true" /></div>
        </div>
      </div>
    </div>
  );
}

export function CommandCenter() {
  const snap = useSnap()!;
  const [filter, setFilter] = useState<'All' | 'Working' | 'Needs you' | 'Near limit' | 'Idle'>('All');
  const th = snap.settings.thresholds;
  const blocked = snap.sessions.filter((s) => s.status === 'blocked');
  const near = snap.sessions.filter((s) => s.contextPct >= th.replace);
  const hero = blocked[0] ?? [...snap.sessions].sort((a, b) => b.contextPct - a.contextPct)[0];
  const need = hero ? snap.needs.find((n) => !n.answer && n.session === hero.name) : null;
  const match = { All: () => true, Working: (s: Session) => s.status === 'working', 'Needs you': (s: Session) => s.status === 'blocked', 'Near limit': (s: Session) => s.contextPct >= 80, Idle: (s: Session) => s.status === 'idle' || s.status === 'done' };
  const tiles = snap.sessions.filter((s) => s !== hero).filter(match[filter]);
  const L = snap.limits;
  return (
    <div className="page">
      <section className="rise row" style={{ flexWrap: 'wrap', alignItems: 'stretch', justifyContent: 'space-between', gap: 32 }}>
        <div className="col" style={{ gap: 22, maxWidth: 900 }}>
          <span className="eyebrow"><Dot color={C.green} blink />Fleet · live · {snap.feed.length} recent events</span>
          <h1 className="hero">{snap.sessions.length} sessions running.<br /><span className="faint">{blocked.length} need{blocked.length === 1 ? 's' : ''} you, {near.length} near the limit.</span></h1>
        </div>
        <div className="col" style={{ justifyContent: 'space-between', alignItems: 'flex-end', gap: 24 }}>
          <nav aria-label="Shortcuts" className="row mono" style={{ gap: '8px 20px', fontSize: 12, flexWrap: 'wrap' }}>
            <a className="dim" href={href('roster')}>All sessions ↗</a><a className="dim" href={href('health')}>Health ↗</a><a className="dim" href={href('overlap')}>Overlaps ↗</a>
            <a className="dim" href={href('report')}>Daily report ↗</a><a className="dim" href={href('audit')}>Sent as you ↗</a>
          </nav>
          <Seg label="Filter" value={filter} options={['All', 'Working', 'Needs you', 'Near limit', 'Idle'] as const} onChange={setFilter} />
        </div>
      </section>

      <section className="grid12">
        {hero ? (
          <Card span={8} tone={hero.status === 'blocked' ? 'amber' : undefined} pad={28}>
            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              <span className="eyebrow" style={{ borderColor: statusColor(hero.status), color: statusColor(hero.status) }}>{hero.status === 'blocked' ? 'Needs you' : 'Fullest context'}</span>
              <span className="mono dim" style={{ fontSize: 12 }}>{hero.name} · {hero.model ?? 'model unknown'}</span>
              <span style={{ flex: 1 }} />
              <a className="pill sm" href={href('session', hero.name)}>Open session<Arrow /></a>
            </div>
            <h2 style={{ fontSize: 30, lineHeight: 1.15 }}>{snap.tasks.find((t) => t.session === hero.name && t.stage >= 2 && t.stage <= 4)?.title ?? lastSay(hero) ?? hero.name}</h2>
            {need && (
              <div className="col" style={{ gap: 12, padding: '16px 18px', borderRadius: 16, border: '1px solid rgba(245,165,36,0.22)', background: 'rgba(245,165,36,0.04)' }}>
                <span className="mono" style={{ fontSize: 13, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{need.code || need.title}</span>
                <div className="row" style={{ gap: 10 }}>
                  <button type="button" className="pill w sm" onClick={() => act(() => api('POST', `/api/sessions/${encodeURIComponent(hero.name)}/focus`), 'Opened in herdr')}>Answer in herdr</button>
                  <span className="faint" style={{ fontSize: 12 }}>waiting {ago(need.createdAt)} · ShiftBoss never approves for you</span>
                </div>
              </div>
            )}
            <Lines s={hero} n={10} height={230} />
            <div className="row" style={{ gap: 28, flexWrap: 'wrap' }}>
              {[['Context', Math.round(hero.contextPct) + '%'], ['Tokens today', fmtTok(hero.tokensToday)], ['Last tool', hero.lastTool ?? '—'], ['Active', ago(hero.lastActivity)]].map(([k, v]) => (
                <div key={k} className="col" style={{ gap: 4 }}><span className="label">{k}</span><span className="mono" style={{ fontSize: 15 }}>{v}</span></div>
              ))}
            </div>
          </Card>
        ) : <Card span={8}><Empty text="No Claude sessions found in herdr." /></Card>}

        <div className="col" style={{ gridColumn: 'span 4', gap: 16 }}>
          <Card span={4} delay={80}>
            <div className="row" style={{ justifyContent: 'space-between' }}><span className="eyebrow">Context pressure</span><span className="faint" style={{ fontSize: 12 }}>replace at {th.replace}%</span></div>
            {[...snap.sessions].sort((a, b) => b.contextPct - a.contextPct).slice(0, 5).map((s) => (
              <a key={s.name} href={href('session', s.name)} className="col" style={{ gap: 8 }}>
                <span className="row" style={{ justifyContent: 'space-between' }}><span className="mono ellipsis" style={{ fontSize: 13 }}>{s.name}</span><span className="mono" style={{ fontSize: 13, color: ctxColor(s.contextPct, th.warn, th.replace) }}>{Math.round(s.contextPct)}%</span></span>
                <Bar pct={s.contextPct} color={ctxColor(s.contextPct, th.warn, th.replace)} />
              </a>
            ))}
          </Card>
          <Card span={4} delay={140}>
            <div className="row" style={{ justifyContent: 'space-between' }}><span className="eyebrow">Usage limits</span><span className="faint" style={{ fontSize: 12 }}>{L.estimate ? 'estimate' : 'from Claude Code'}</span></div>
            {[['5-hour window', L.fiveHourPct], ['Weekly', L.weeklyPct]].map(([k, v]) => (
              <div key={k as string} className="col" style={{ gap: 8 }}>
                <span className="row" style={{ justifyContent: 'space-between' }}><span style={{ fontSize: 13 }}>{k}</span><span className="mono" style={{ fontSize: 15, color: ctxColor(v as number) }}>{Math.round(v as number)}%</span></span>
                <Bar pct={v as number} color={ctxColor(v as number)} />
              </div>
            ))}
            <span className="faint" style={{ fontSize: 12 }}>{fmtTok(L.fiveHourTokens)} tokens in the last 5 hours</span>
          </Card>
        </div>

        {tiles.map((s, i) => (
          <article key={s.name} className="shell rise" style={{ gridColumn: 'span 3', animationDelay: 200 + i * 50 + 'ms' }}>
            <div className="core col" style={{ gap: 14, padding: 20 }}>
              <div className="row" style={{ gap: 10 }}><Dot color={statusColor(s.status)} blink={s.status === 'working'} /><span className="mono ellipsis" style={{ fontSize: 13 }}>{s.name}</span><span className="mono faint" style={{ fontSize: 11, marginLeft: 'auto' }}>{s.status}</span></div>
              <span className="ellipsis" style={{ fontSize: 14 }}>{snap.tasks.find((t) => t.session === s.name && t.stage >= 2 && t.stage <= 4)?.title ?? lastSay(s) ?? (s.lane || 'No task from ShiftBoss')}</span>
              <Lines s={s} n={4} height={84} />
              <div className="col" style={{ gap: 6 }}>
                <span className="row mono" style={{ justifyContent: 'space-between', fontSize: 11 }}><span className="faint">context</span><span style={{ color: ctxColor(s.contextPct, th.warn, th.replace) }}>{Math.round(s.contextPct)}%</span></span>
                <Bar pct={s.contextPct} color={ctxColor(s.contextPct, th.warn, th.replace)} />
              </div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="mono faint" style={{ fontSize: 11 }}>{fmtTok(s.tokensToday)} · {ago(s.lastActivity)}</span>
                <a className="pill sm" href={href('session', s.name)}>Open</a>
              </div>
            </div>
          </article>
        ))}

        <Card span={tiles.length % 4 === 0 ? 12 : 3} delay={300}>
          <div className="row" style={{ gap: 8 }}><Dot color={C.green} blink /><span style={{ fontSize: 13 }}>Event stream</span><a className="mono faint" style={{ marginLeft: 'auto', fontSize: 11 }} href={href('intake')}>intake →</a></div>
          <div className="mono col" style={{ fontSize: 11, maxHeight: 260, overflow: 'hidden' }}>
            {snap.feed.slice(0, 12).map((f, i) => (
              <div key={i + f.at} className="row" style={{ gap: 10, padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <span className="faint">{hhmm(f.at)}</span><span style={{ color: f.who === 'you' ? C.amber : C.fg }}>{f.who}</span><span className="dim ellipsis" style={{ flex: 1 }}>{f.text}</span>
              </div>
            ))}
            {!snap.feed.length && <span className="faint">Quiet so far.</span>}
          </div>
        </Card>
      </section>
    </div>
  );
}

export function SessionPage({ name }: { name: string }) {
  const snap = useSnap()!;
  const s = snap.sessions.find((x) => x.name === name);
  const [draft, setDraft] = useState('');
  const [hideAlert, setHideAlert] = useState(false);
  const [screen, setScreen] = useState<string | null>(null);
  const th = snap.settings.thresholds;
  useEffect(() => { setScreen(null); }, [name]);
  // The raw terminal is read from herdr on demand; while it is open, refresh it every 3 s.
  const showingScreen = screen !== null;
  useEffect(() => {
    if (!showingScreen) return;
    const id = setInterval(() => { api('GET', `/api/sessions/${encodeURIComponent(name)}/screen`).then((r) => setScreen(r.text)).catch(() => {}); }, 3000);
    return () => clearInterval(id);
  }, [showingScreen, name]);
  if (!s) return <div className="page"><Hero eyebrow="Session" title={name} sub="Not running in herdr right now." /><a className="pill" href={href('roster')}>Back to roster</a></div>;
  const tasks = snap.tasks.filter((t) => t.session === s.name && t.stage >= 1 && t.stage <= 4);
  const current = tasks.find((t) => t.stage >= 2);
  const c = ctxColor(s.contextPct, th.warn, th.replace);
  const post = (path: string, body: unknown, ok: string) => act(() => api('POST', `/api/sessions/${encodeURIComponent(s.name)}/${path}`, body), ok);
  const send = async () => { const t = draft.trim(); if (!t) return; await post('prompt', { text: t }, 'Sent to ' + s.name); setDraft(''); };
  const replaceText = `Write your handoff now (open work, PRs, promises owed, scheduled jobs, worktrees) to ${s.handoffPath ?? 'your handoff file'}, then stop. A fresh session will continue from it.`;
  return (
    <div className="page" style={{ gap: 40 }}>
      <section className="rise row" style={{ flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 32 }}>
        <div className="col" style={{ gap: 20, minWidth: 0 }}>
          <div className="row" style={{ gap: 10 }}>
            <a className="eyebrow" href={href('roster')}>‹ Sessions</a>
            <span className="eyebrow" style={{ color: statusColor(s.status), borderColor: statusColor(s.status) }}><Dot color={statusColor(s.status)} blink={s.status === 'working'} />{s.status}</span>
          </div>
          <h1 className="hero mono" style={{ letterSpacing: '-0.045em' }}>{s.name}</h1>
          <div className="row mono faint" style={{ gap: 20, fontSize: 12, flexWrap: 'wrap' }}>
            <span>{s.model ?? 'model unknown'}</span><span>herdr {s.paneId}</span><span>{s.cwd}</span>{s.lane && <span>lane · {s.lane}</span>}
          </div>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="pill" onClick={() => post('interrupt', {}, 'Interrupted ' + s.name)}>Interrupt</button>
          <button type="button" className="pill" onClick={() => post('focus', {}, 'Opened in herdr')}>Open in herdr</button>
          <button type="button" className="pill" onClick={() => act(async () => setScreen((await api('GET', `/api/sessions/${encodeURIComponent(s.name)}/screen`)).text), 'Screen loaded')}>Raw screen</button>
          <button type="button" className={'pill' + (s.contextPct >= th.replace ? ' r' : '')} onClick={() => post('prompt', { text: replaceText }, 'Asked ' + s.name + ' to write its handoff')}>Prepare replace</button>
        </div>
      </section>

      {s.contextPct >= th.replace && !hideAlert && (
        <section role="alert" className="shell rise alert-red">
          <div className="core row" style={{ gap: 24, padding: '22px 26px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 40, fontWeight: 500, letterSpacing: '-0.04em', color: C.red }}>{Math.round(s.contextPct)}%</span>
            <span style={{ flex: '1 1 480px', lineHeight: 1.55, fontSize: 15 }}>Context is nearly full and the session will start losing track. <span className="dim">Prepare replace asks it to write its handoff; then start a fresh session from that file.</span></span>
            <button type="button" className="pill" onClick={() => setHideAlert(true)}>Later</button>
            <button type="button" className="pill w" onClick={() => post('prompt', { text: replaceText }, 'Asked for a handoff')}>Prepare replace<Arrow dark /></button>
          </div>
        </section>
      )}

      <section className="grid12" style={{ alignItems: 'stretch' }}>
        <article className="shell rise" style={{ gridColumn: 'span 8', gridRow: 'span 2' }}>
          <div className="core col" style={{ gap: 16, padding: 22 }}>
            <div className="row" style={{ gap: 10 }}><Dot color={C.green} blink={s.status === 'working'} /><span style={{ fontWeight: 500 }}>{screen ? 'Raw screen · refreshes every 3 s' : 'Live output'}</span>
              <span className="mono faint" style={{ marginLeft: 'auto', fontSize: 12 }}>{screen ? <button type="button" className="pill sm" onClick={() => setScreen(null)}>Back to live</button> : 'from the transcript · ' + s.lines.length + ' lines'}</span></div>
            {screen ? <pre className="term" style={{ height: 460, margin: 0, padding: 18, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{screen}</pre> : <Lines s={s} n={60} height={460} stamps />}
            <form className="row" style={{ gap: 10, padding: 6, borderRadius: 999, border: '1px solid rgba(255,255,255,0.08)', background: '#070707' }} onSubmit={(e) => { e.preventDefault(); void send(); }}>
              <label htmlFor="prompt" className="faint" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden' }}>Prompt</label>
              <input id="prompt" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`Message ${s.name} · arrives in its herdr pane as your next prompt`}
                style={{ flex: 1, height: 40, padding: '0 16px', border: 'none', background: 'transparent', fontSize: 14, outline: 'none' }} />
              <button type="submit" className="pill w" disabled={!draft.trim()}>Send<Arrow dark /></button>
            </form>
          </div>
        </article>
        <Card span={4}>
          <div className="row" style={{ justifyContent: 'space-between' }}><span className="label">Context window</span><span className="mono faint" style={{ fontSize: 12 }}>{fmtTok(s.contextTokens)} / {fmtTok(s.contextWindow)}</span></div>
          <span style={{ fontSize: 56, fontWeight: 500, letterSpacing: '-0.045em', lineHeight: 1, color: c }}>{Math.round(s.contextPct)}%</span>
          <Bar pct={s.contextPct} color={c} />
          <span className="faint" style={{ fontSize: 12 }}>{fmtTok(s.tokensToday)} tokens today · {fmtTok(s.tokens5h)} in 5 h</span>
        </Card>
        <Card span={4} delay={60}>
          <span className="label">Working on</span>
          {current ? <a href={href('task', current.id)} style={{ fontSize: 18, fontWeight: 500, lineHeight: 1.35 }}>{current.id} · {current.title}</a> : <span className="dim">Nothing from ShiftBoss right now.</span>}
          {tasks.filter((t) => t !== current).slice(0, 3).map((t) => <a key={t.id} href={href('task', t.id)} className="row dim ellipsis" style={{ gap: 12, fontSize: 13 }}><span className="mono faint">{t.id}</span>{t.title}</a>)}
        </Card>
      </section>
      <section className="grid12">
        <Card span={6}>
          <div className="row" style={{ justifyContent: 'space-between' }}><span className="label">Handoff</span>
            <span className="mono" style={{ fontSize: 12, color: s.handoffAgeMin == null ? C.amber : s.handoffAgeMin > th.staleMin ? C.amber : C.green }}>{s.handoffAgeMin == null ? 'no file found' : 'updated ' + s.handoffAgeMin + ' min ago'}</span></div>
          <span className="mono" style={{ fontSize: 13, wordBreak: 'break-all' }}>{s.handoffPath ?? 'Set a handoffs folder in Settings'}</span>
        </Card>
        <Card span={6} delay={60}>
          <span className="label">Pull requests seen</span>
          {s.prUrls.length ? s.prUrls.slice(-5).map((u) => <a key={u} href={u} target="_blank" rel="noreferrer" className="mono dim ellipsis" style={{ fontSize: 13 }}>{u.replace('https://github.com/', '')} ↗</a>) : <Empty text="None in this transcript." />}
        </Card>
      </section>
    </div>
  );
}

export function Roster() {
  const snap = useSnap()!;
  const [sort, setSort] = useState<'Context' | 'Name' | 'Status'>('Context');
  const th = snap.settings.thresholds;
  const rows = [...snap.sessions].sort(sort === 'Context' ? (a, b) => b.contextPct - a.contextPct : sort === 'Name' ? (a, b) => a.name.localeCompare(b.name) : (a, b) => a.status.localeCompare(b.status));
  const grid = { display: 'grid', gridTemplateColumns: 'minmax(0,1.3fr) minmax(0,1.4fr) minmax(0,1.5fr) 130px 90px 110px 80px', gap: 16, alignItems: 'center' } as const;
  return (
    <div className="page">
      <Hero eyebrow="Roster" title="Every session." sub={`${snap.sessions.length} in herdr right now.`}>
        <Seg label="Sort" value={sort} options={['Context', 'Name', 'Status'] as const} onChange={setSort} />
        <a className="pill" href={href('health')}>Health</a><a className="pill" href={href('overlap')}>Overlaps</a>
      </Hero>
      <section className="shell rise"><div className="core" style={{ padding: 12, overflowX: 'auto' }}>
        <div className="label" style={{ ...grid, padding: '14px 16px 10px', minWidth: 980 }}><span>Session</span><span>Lane</span><span>Working on</span><span>Context</span><span>Tokens today</span><span>Handoff</span><span style={{ textAlign: 'right' }}>Active</span></div>
        {rows.map((s) => (
          <a key={s.name} href={href('session', s.name)} className="trow" style={{ ...grid, minWidth: 980 }}>
            <span className="row" style={{ gap: 10, minWidth: 0 }}><Dot color={statusColor(s.status)} blink={s.status === 'working'} /><span className="col" style={{ gap: 3, minWidth: 0 }}><span className="mono ellipsis">{s.name}</span><span className="mono faint" style={{ fontSize: 11 }}>{(s.model ?? '?') + ' · ' + s.status}</span></span></span>
            <span className="dim ellipsis" style={{ fontSize: 13 }}>{s.lane || '—'}</span>
            <span className="ellipsis" style={{ fontSize: 13 }}>{snap.tasks.find((t) => t.session === s.name && t.stage >= 2 && t.stage <= 4)?.title ?? '—'}</span>
            <span className="col" style={{ gap: 6 }}><span className="mono" style={{ fontSize: 13, color: ctxColor(s.contextPct, th.warn, th.replace) }}>{Math.round(s.contextPct)}%</span><Bar pct={s.contextPct} color={ctxColor(s.contextPct, th.warn, th.replace)} /></span>
            <span className="mono dim" style={{ fontSize: 13 }}>{fmtTok(s.tokensToday)}</span>
            <span className="mono" style={{ fontSize: 12, color: s.handoffAgeMin == null || s.handoffAgeMin > th.staleMin ? C.amber : C.dim }}>{s.handoffAgeMin == null ? 'none' : s.handoffAgeMin + 'm ago'}</span>
            <span className="mono faint" style={{ fontSize: 12, textAlign: 'right' }}>{ago(s.lastActivity)}</span>
          </a>
        ))}
        {!rows.length && <Empty text="No sessions found. Is herdr running?" />}
      </div></section>
    </div>
  );
}

export function Health() {
  const snap = useSnap()!;
  const [filter, setFilter] = useState<'Needs action' | 'Watch' | 'All'>('Needs action');
  const act2 = (v: string) => ['looping', 'stuck', 'lost'].includes(v);
  const watch = (v: string) => ['heavy', 'waiting', 'burning'].includes(v);
  const cards = snap.health.filter((h) => filter === 'All' ? h.verdict !== 'healthy' || true : filter === 'Needs action' ? act2(h.verdict) : watch(h.verdict));
  const VC: Record<string, string> = { looping: C.red, stuck: C.red, lost: C.red, heavy: C.amber, waiting: C.amber, burning: C.amber, healthy: C.green };
  const nAct = snap.health.filter((h) => act2(h.verdict)).length;
  const shade = (v: number) => (v < 0 ? C.amber : v === 0 ? 'rgba(255,255,255,0.06)' : v < 3 ? 'rgba(255,255,255,0.25)' : v < 8 ? 'rgba(255,255,255,0.55)' : C.fg);
  return (
    <div className="page">
      <Hero eyebrow="Session health" live title={nAct ? `${nAct} session${nAct === 1 ? '' : 's'} need${nAct === 1 ? 's' : ''} a nudge.` : 'Every session is moving.'}
        sub={`${snap.health.filter((h) => watch(h.verdict)).length} to watch, ${snap.health.filter((h) => h.verdict === 'healthy').length} healthy.`}>
        <Seg label="Filter" value={filter} options={['Needs action', 'Watch', 'All'] as const} onChange={setFilter} />
      </Hero>
      <Card>
        <div className="row" style={{ justifyContent: 'space-between' }}><span className="label">Transcript activity, last 60 min · one cell per 2 min</span><span className="mono faint" style={{ fontSize: 11 }}>amber = the same command repeating</span></div>
        {snap.sessions.map((s) => {
          const h = snap.health.find((x) => x.session === s.name);
          return (
            <a key={s.name} href={href('session', s.name)} className="row" style={{ gap: 16 }}>
              <span className="mono ellipsis" style={{ width: 'min(200px, 28%)', fontSize: 12, flex: 'none' }}>{s.name}</span>
              <span style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(30, minmax(0,1fr))', gap: 3 }}>{s.heat.map((v, i) => <span key={i} style={{ height: 18, borderRadius: 3, background: shade(v) }} />)}</span>
              <span className="mono" style={{ width: 70, textAlign: 'right', fontSize: 12, color: VC[h?.verdict ?? 'healthy'] }}>{h?.verdict}</span>
            </a>
          );
        })}
      </Card>
      <section className="grid12">
        {cards.map((h, i) => (
          <Card key={h.session} span={6} delay={i * 50} tone={VC[h.verdict] === C.red ? 'red' : undefined} pad={26}>
            <div className="row" style={{ gap: 12 }}><Dot color={VC[h.verdict]} /><a className="mono" style={{ fontSize: 18 }} href={href('session', h.session)}>{h.session}</a><span className="eyebrow" style={{ borderColor: VC[h.verdict], color: VC[h.verdict] }}>{h.verdict}</span></div>
            <h2 style={{ fontSize: 22, lineHeight: 1.3 }}>{h.title}</h2>
            {h.signals.map((sg) => <div key={sg.k} className="row well" style={{ gap: 12, padding: '10px 14px', fontSize: 13 }}><span className="mono" style={{ width: 70, fontSize: 11, color: toneColor(sg.tone) }}>{sg.k}</span><span className="dim" style={{ flex: 1, wordBreak: 'break-word' }}>{sg.v}</span></div>)}
            {h.loop.length > 0 && <pre className="mono" style={{ margin: 0, padding: '12px 14px', borderRadius: 12, border: '1px dashed rgba(245,165,36,0.35)', fontSize: 12, color: C.dim, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{h.loop.join('\n')}</pre>}
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <span className="faint" style={{ fontSize: 12, marginRight: 'auto' }}>Suggested: {h.suggest}</span>
              {h.verdict !== 'healthy' && h.verdict !== 'waiting' && <button type="button" className="pill sm w" onClick={() => act(() => api('POST', `/api/sessions/${encodeURIComponent(h.session)}/prompt`, { text: h.verdict === 'looping' ? 'You have run the same command several times with the same result. Stop, explain what you think is wrong, and try a different approach.' : h.verdict === 'stuck' ? 'ShiftBoss: you have queued work waiting. Pick up the next task now, or say what is blocking you.' : 'ShiftBoss check-in: please give a one-line status.' }), 'Nudge sent')}>Send nudge</button>}
              {h.verdict === 'looping' && <button type="button" className="pill sm" onClick={() => act(() => api('POST', `/api/sessions/${encodeURIComponent(h.session)}/interrupt`, {}), 'Interrupted')}>Interrupt</button>}
              {h.verdict === 'waiting' && <a className="pill sm w" href={href('needs')}>Go to Needs you</a>}
              <a className="pill sm" href={href('session', h.session)}>Open</a>
            </div>
          </Card>
        ))}
        {!cards.length && <Card><Empty text="Nothing here." /></Card>}
      </section>
    </div>
  );
}

export function Overlap() {
  const snap = useSnap()!;
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});
  const list = snap.overlaps.filter((o) => !dismissed[o.id]);
  return (
    <div className="page">
      <Hero eyebrow="Overlap check · before two sessions collide" title={list.length ? `${list.length} overlap${list.length === 1 ? '' : 's'} right now.` : 'No overlaps.'} sub="From the files each session edited in the last 3 hours." />
      <section className="grid12">
        <div className="col" style={{ gridColumn: 'span 7', gap: 14 }}>
          {list.map((o, i) => (
            <Card key={o.id} delay={i * 50} tone={o.severity}>
              <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}><span className="eyebrow" style={{ borderColor: o.severity === 'red' ? C.red : C.amber, color: o.severity === 'red' ? C.red : C.amber }}>{o.kind}</span><span className="mono dim" style={{ fontSize: 12 }}>{o.where}</span></div>
              <h2 style={{ fontSize: 22, lineHeight: 1.3 }}>{o.title}</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 40px minmax(0,1fr)', gap: 10 }}>
                {[o.a, null, o.b].map((x, k) => x ? <a key={k} href={href('session', x.session)} className="col well" style={{ gap: 6, padding: 14 }}><span className="mono">{x.session}</span><span className="faint" style={{ fontSize: 12, wordBreak: 'break-all' }}>{x.what}</span></a> : <span key={k} className="row faint" style={{ justifyContent: 'center' }} aria-hidden="true">⇄</span>)}
              </div>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <span className="dim" style={{ fontSize: 13, marginRight: 'auto' }}>{o.fix}</span>
                <button type="button" className="pill sm w" onClick={() => act(() => api('POST', `/api/sessions/${encodeURIComponent(o.b.session)}/prompt`, { text: `ShiftBoss overlap check: ${o.title} ${o.fix} Coordinate before you push.` }), 'Told ' + o.b.session)}>Tell {o.b.session}</button>
                <button type="button" className="pill sm" onClick={() => setDismissed({ ...dismissed, [o.id]: true })}>Dismiss</button>
              </div>
            </Card>
          ))}
          {!list.length && <Card><Empty text="No two sessions touched the same file, migration number or task." /></Card>}
        </div>
        <Card span={5}>
          <span className="label">Files edited, last 3 hours</span>
          {snap.sessions.filter((s) => s.filesTouched.length).map((s) => (
            <div key={s.name} className="col" style={{ gap: 4 }}>
              <span className="mono" style={{ fontSize: 13 }}>{s.name} <span className="faint">· {s.filesTouched.length}</span></span>
              {s.filesTouched.slice(-4).map((f) => <span key={f} className="mono faint ellipsis" style={{ fontSize: 11 }}>{f}</span>)}
            </div>
          ))}
          {!snap.sessions.some((s) => s.filesTouched.length) && <Empty text="No edits recorded yet." />}
        </Card>
      </section>
    </div>
  );
}
