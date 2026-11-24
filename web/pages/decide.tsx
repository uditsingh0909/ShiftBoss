import { useEffect, useState } from 'react';
import type { AuditEntry, Need, PromiseItem } from '../../shared/types';
import { act, ago, api, Bar, C, Card, Dot, Empty, Hero, hhmm, href, Seg, toast, useSnap } from '../lib';

const undoNeed = (id: number) => act(() => api('POST', `/api/needs/${id}/undo`, {}), 'Taken back · it is open again');
const isToday = (iso: string | null) => !!iso && new Date(iso).toDateString() === new Date().toDateString();
const kindColor = (k: Need['kind']) => (k === 'Production write' || k === 'Live customers' || k === 'Money' ? C.red : C.amber);

// ---------------------------------------------------------------- Needs you

function NeedBody({ n, onAnswered }: { n: Need; onAnswered?: () => void }) {
  const [busy, setBusy] = useState(false);
  const answer = async (a: string) => {
    setBusy(true);
    if (n.auto) await act(() => api('POST', `/api/needs/${n.id}/answer`, { answer: a }), 'Opened in herdr');
    else {
      try {
        await api('POST', `/api/needs/${n.id}/answer`, { answer: a });
        toast(`Answered: ${a} · sends in 10 s`, { label: 'Undo', run: () => void undoNeed(n.id) });
      } catch (e) { toast((e as Error).message); }
    }
    setBusy(false);
    if (!n.auto) onAnswered?.();
  };
  const kc = kindColor(n.kind);
  return (
    <>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <span className="eyebrow" style={{ borderColor: kc, color: kc }}>{n.kind}</span>
        <span className="mono dim" style={{ fontSize: 12 }}>{n.source || n.session || 'Foreman'}</span>
        <span className="mono faint" style={{ fontSize: 12, marginLeft: 'auto' }}>waiting {ago(n.createdAt)}</span>
      </div>
      <h2 style={{ fontSize: 28, lineHeight: 1.2 }}>{n.title}</h2>
      {n.body && <p className="dim" style={{ margin: 0, fontSize: 15, lineHeight: 1.6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{n.body}</p>}
      {n.code && <pre className="mono well" style={{ margin: 0, padding: '14px 16px', fontSize: 13, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{n.code}</pre>}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {n.answers.map((a, i) => (
          <button key={a} type="button" className={'pill' + (i === 0 ? ' w' : '')} disabled={busy} onClick={() => void answer(a)}>{a}</button>
        ))}
        {n.taskId && <a className="pill sm" href={href('task', n.taskId)} style={{ marginLeft: 'auto' }}>Task {n.taskId}</a>}
      </div>
      {n.auto && <span className="faint" style={{ fontSize: 12 }}>This is a permission prompt in {n.session ?? 'a session'}. Foreman never approves for you: it only brings the pane forward so you can answer it in herdr.</span>}
    </>
  );
}

export function NeedsYou() {
  const snap = useSnap()!;
  const [view, setView] = useState<'Focus' | 'List'>('Focus');
  const open = snap.needs.filter((n) => !n.answer);
  const [curId, setCurId] = useState<number | null>(null);
  const [slide, setSlide] = useState(0);
  // the step bar keeps items answered in this visit, so progress is visible
  const [seen, setSeen] = useState<number[]>([]);
  useEffect(() => {
    setSeen((s) => { const add = open.map((n) => n.id).filter((id) => !s.includes(id)); return add.length ? [...s, ...add] : s; });
  }, [open.map((n) => n.id).join(',')]);
  const steps = seen.map((id) => snap.needs.find((n) => n.id === id)).filter((n): n is Need => !!n);
  const idx = Math.max(0, open.findIndex((n) => n.id === curId));
  const cur = open[idx] ?? null;
  const go = (id: number | undefined) => { if (id === undefined) return; setCurId(id); setSlide((x) => x + 1); };
  const prev = () => go(open[(idx - 1 + open.length) % open.length]?.id);
  const next = () => go(open[(idx + 1) % open.length]?.id);
  const afterAnswer = () => { const rest = open.filter((n) => n.id !== cur?.id); go(rest[idx % Math.max(1, rest.length)]?.id ?? undefined); };
  const cap = snap.settings.thresholds.needsCap;
  const answered = snap.needs.filter((n) => n.answer && isToday(n.answeredAt)).sort((a, b) => Date.parse(b.answeredAt!) - Date.parse(a.answeredAt!));

  return (
    <div className="page">
      <Hero eyebrow="Needs you" live title={open.length ? `${open.length} thing${open.length === 1 ? '' : 's'} waiting on you.` : 'Nothing waiting on you.'}
        sub={open.length ? `Oldest waiting ${ago([...open].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0].createdAt)}.` : 'Sessions will ask here when they need a decision.'}>
        <Seg label="View" value={view} options={['Focus', 'List'] as const} onChange={setView} />
      </Hero>
      {open.length > cap && <span className="amber" style={{ fontSize: 13, marginTop: -24 }}>{open.length} open, more than your cap of {cap}. Sessions are piling up behind you; clear a few or raise the cap in Settings.</span>}

      <section className="grid12">
        <div className="col" style={{ gridColumn: 'span 8', gap: 16 }}>
          {!open.length ? (
            <Card span={8} pad={32}>
              <span className="eyebrow" style={{ borderColor: C.green, color: C.green }}><Dot color={C.green} />All clear</span>
              <h2 style={{ fontSize: 28 }}>Nothing needs you right now.</h2>
              <span className="dim">Answered {answered.length} today.</span>
            </Card>
          ) : view === 'Focus' && cur ? (
            <>
              <div className="row" style={{ gap: 10 }}>
                <button type="button" className="pill sm" aria-label="Previous item" onClick={prev} style={{ width: 32, padding: 0, justifyContent: 'center' }}>‹</button>
                <nav aria-label="Open items" style={{ flex: 1, display: 'grid', gridTemplateColumns: `repeat(${Math.min(steps.length, 3)}, minmax(0,1fr))`, gap: 6 }}>
                  {steps.map((n, i) => {
                    const done = !!n.answer;
                    const on = n.id === cur.id;
                    return (
                      <button key={n.id} type="button" disabled={done} aria-current={on ? 'step' : undefined} onClick={() => go(n.id)} className="col"
                        style={{ gap: 6, padding: '8px 10px', borderRadius: 12, border: '1px solid ' + (on ? 'rgba(255,255,255,.3)' : 'rgba(255,255,255,.06)'), background: on ? 'rgba(255,255,255,.05)' : 'transparent', cursor: done ? 'default' : 'pointer', textAlign: 'left', minWidth: 0 }}>
                        <span style={{ height: 3, borderRadius: 999, background: done ? C.green : on ? C.fg : 'rgba(255,255,255,.12)' }} />
                        <span className="ellipsis" style={{ fontSize: 12, color: done ? C.green : on ? C.fg : C.dim }}>{i + 1}. {n.title}</span>
                      </button>
                    );
                  })}
                </nav>
                <button type="button" className="pill sm" aria-label="Next item" onClick={next} style={{ width: 32, padding: 0, justifyContent: 'center' }}>›</button>
              </div>
              <article key={cur.id + ':' + slide} className="shell slide-in">
                <div className="core col" style={{ gap: 18, padding: 32 }}>
                  <span className="label">{idx + 1} of {open.length}</span>
                  <NeedBody n={cur} onAnswered={afterAnswer} />
                  <div className="row" style={{ gap: 8, borderTop: '1px solid rgba(255,255,255,.05)', paddingTop: 16 }}>
                    <button type="button" className="pill sm" onClick={prev} disabled={open.length < 2}>Back</button>
                    <button type="button" className="pill sm" onClick={next} disabled={open.length < 2}>Skip for now</button>
                    <button type="button" className="pill sm" onClick={next} disabled={open.length < 2} style={{ marginLeft: 'auto' }}>Next →</button>
                  </div>
                </div>
              </article>
            </>
          ) : (
            open.map((n, i) => <Card key={n.id} span={8} delay={i * 40} tone={kindColor(n.kind) === C.red ? 'red' : undefined} pad={26}><NeedBody n={n} /></Card>)
          )}
        </div>

        <div className="col" style={{ gridColumn: 'span 4', gap: 16 }}>
          <Card span={4} delay={80}>
            <span className="label">Your answers today</span>
            {answered.map((n) => (
              <div key={n.id} className="col" style={{ gap: 4 }}>
                <span className="ellipsis" style={{ fontSize: 13 }}>{n.title}</span>
                <span className="row mono" style={{ fontSize: 12, gap: 8 }}>
                  <span style={{ color: C.green }}>{n.answer}</span><span className="faint">· {hhmm(n.answeredAt)} · {n.auto ? 'in herdr' : n.sentAt ? 'sent' : 'sending…'}</span>
                  {!n.auto && <button type="button" className="pill sm" style={{ height: 26, marginLeft: 'auto', fontSize: 11 }} onClick={() => void undoNeed(n.id)}
                    title={n.sentAt ? 'Opens it again and tells the session to ignore your answer' : 'Not sent yet: takes it back quietly'}>{n.sentAt ? 'Reopen' : 'Undo'}</button>}
                </span>
              </div>
            ))}
            {!answered.length && <Empty text="None yet today." />}
          </Card>
          <Card span={4} delay={140}>
            <span className="label">Lead decided</span>
            {snap.decisions.slice(0, 8).map((d) => (
              <div key={d.id} className="row" style={{ gap: 10, alignItems: 'flex-start', fontSize: 13 }}>
                <span className="mono faint" style={{ fontSize: 11, flex: 'none', paddingTop: 2 }}>{hhmm(d.at)}</span>
                <span className="dim" style={{ lineHeight: 1.5 }}>{d.text}</span>
              </div>
            ))}
            {!snap.decisions.length && <Empty text="No decisions recorded." />}
          </Card>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- Promises

const promiseColor = (s: PromiseItem['state']) => (s === 'due' ? C.red : s === 'ready' ? C.amber : s === 'open' ? C.fg : s === 'kept' ? C.green : C.faint);

export function Promises() {
  const snap = useSnap()!;
  const [filter, setFilter] = useState<'Open' | 'Overdue' | 'Ready to send' | 'Kept'>('Open');
  const all = snap.promises;
  const pending = all.filter((p) => p.state !== 'kept');
  const people = new Set(pending.map((p) => p.to)).size;
  const due = all.filter((p) => p.state === 'due');
  const match: Record<typeof filter, (p: PromiseItem) => boolean> = {
    Open: (p) => p.state !== 'kept', Overdue: (p) => p.state === 'due', 'Ready to send': (p) => p.state === 'ready', Kept: (p) => p.state === 'kept',
  };
  const list = all.filter(match[filter]);
  const kept = all.filter((p) => p.state === 'kept');
  const onTime = kept.filter((p) => !p.dueAt || !p.keptAt || Date.parse(p.keptAt) <= Date.parse(p.dueAt)).length;
  const pct = all.length ? Math.round((onTime / all.length) * 100) : 0;
  const byPerson = Object.entries(pending.reduce<Record<string, PromiseItem[]>>((m, p) => { (m[p.to] ??= []).push(p); return m; }, {}))
    .map(([to, ps]) => ({ to, n: ps.length, oldest: ps.reduce((a, b) => (Date.parse(a.createdAt) < Date.parse(b.createdAt) ? a : b)).createdAt }))
    .sort((a, b) => Date.parse(a.oldest) - Date.parse(b.oldest));
  const setState = (p: PromiseItem, state: PromiseItem['state'], ok: string) => act(() => api('PATCH', `/api/promises/${p.id}`, { state }), ok);

  return (
    <div className="page">
      <Hero eyebrow="Promises" title={`${people} ${people === 1 ? 'person is' : 'people are'} waiting on you.`} sub={`${due.length} overdue.`}>
        <Seg label="Filter" value={filter} options={['Open', 'Overdue', 'Ready to send', 'Kept'] as const} onChange={setFilter} />
      </Hero>
      <section className="grid12">
        <div className="col" style={{ gridColumn: 'span 8', gap: 14 }}>
          {list.map((p, i) => (
            <Card key={p.id} span={8} delay={i * 40} tone={p.state === 'due' ? 'red' : undefined}>
              <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                <Dot color={promiseColor(p.state)} />
                <span style={{ fontWeight: 500 }}>{p.to}</span>
                {p.where && <span className="mono dim" style={{ fontSize: 12 }}>{p.where}</span>}
                <span className="mono" style={{ fontSize: 12, color: promiseColor(p.state) }}>{p.state === 'due' ? 'overdue' : p.state === 'ready' ? 'ready to send' : p.state}</span>
                <span className="mono faint" style={{ fontSize: 12, marginLeft: 'auto' }}>{ago(p.createdAt)} ago</span>
              </div>
              <blockquote style={{ margin: 0, fontSize: 18, lineHeight: 1.45 }}>“{p.said}”</blockquote>
              {p.keptWhen && <span className="dim" style={{ fontSize: 13 }}>Kept when: {p.keptWhen}</span>}
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {p.taskId && <a className="pill sm" href={href('task', p.taskId)}>Task {p.taskId}</a>}
                <span style={{ flex: 1 }} />
                {p.state === 'open' && <button type="button" className="pill sm" onClick={() => setState(p, 'due', 'Marked overdue')}>Mark overdue</button>}
                {p.state !== 'kept' && <button type="button" className="pill sm w" onClick={() => setState(p, 'kept', 'Marked kept')}>Mark kept</button>}
                {p.state === 'kept' && <span className="mono" style={{ fontSize: 12, color: C.green }}>kept {hhmm(p.keptAt)}</span>}
              </div>
            </Card>
          ))}
          {!list.length && <Card span={8}><Empty text="Nothing in this list." /></Card>}
        </div>
        <div className="col" style={{ gridColumn: 'span 4', gap: 16 }}>
          <Card span={4} delay={80}>
            <span className="label">Kept on time</span>
            <span style={{ fontSize: 48, fontWeight: 500, letterSpacing: '-0.04em', lineHeight: 1 }}>{pct}%</span>
            <Bar pct={pct} color={C.fg} />
            <span className="faint" style={{ fontSize: 12 }}>{onTime} of {all.length} promises kept by their due time</span>
          </Card>
          <Card span={4} delay={140}>
            <span className="label">Who's waiting longest</span>
            {byPerson.map((x) => (
              <div key={x.to} className="row" style={{ gap: 10, fontSize: 13 }}>
                <span className="ellipsis" style={{ flex: 1 }}>{x.to}</span>
                <span className="mono faint" style={{ fontSize: 12 }}>{x.n} · {ago(x.oldest)}</span>
              </div>
            ))}
            {!byPerson.length && <Empty text="Nobody is waiting." />}
          </Card>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- Audit

export function Audit() {
  const snap = useSnap()!;
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [filter, setFilter] = useState<'All' | 'Slack' | 'Jira' | 'Corrected'>('All');
  const [openId, setOpenId] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    api<AuditEntry[]>('GET', '/api/audit').then((r) => { if (live) setRows(r); }).catch(() => {});
    return () => { live = false; };
  }, [snap.now, tick]);
  const today = rows.filter((r) => isToday(r.at));
  const list = rows.filter((r) => (filter === 'All' ? true : filter === 'Corrected' ? r.corrected : r.where === filter));
  const grid = { display: 'grid', gridTemplateColumns: '60px 70px minmax(0,1fr) minmax(0,3fr) minmax(0,1fr) 140px', gap: 16, alignItems: 'center' } as const;
  const correct = async (id: number) => {
    const t = note.trim(); if (!t) return;
    await act(() => api('POST', `/api/audit/${id}/correct`, { note: t }), 'Marked corrected');
    setNote(''); setTick((x) => x + 1);
  };
  return (
    <div className="page">
      <Hero eyebrow="Sent as you" title={`${today.length} thing${today.length === 1 ? '' : 's'} went out in your name today.`} sub={`${today.filter((r) => r.corrected).length} needed a correction.`}>
        <Seg label="Filter" value={filter} options={['All', 'Slack', 'Jira', 'Corrected'] as const} onChange={setFilter} />
      </Hero>
      <section className="shell rise"><div className="core" style={{ padding: 12, overflowX: 'auto' }}>
        <div className="label" style={{ ...grid, padding: '14px 16px 10px', minWidth: 900 }}><span>Time</span><span>Where</span><span>Channel</span><span>Text</span><span>By</span><span>Approval</span></div>
        {list.map((r) => {
          const expanded = openId === r.id;
          return (
            <div key={r.id} style={{ minWidth: 900 }}>
              <button type="button" className="trow" aria-expanded={expanded} onClick={() => { setOpenId(expanded ? null : r.id); setNote(''); }}
                style={{ ...grid, width: '100%', border: 'none', background: expanded ? 'rgba(255,255,255,.03)' : 'transparent', cursor: 'pointer', textAlign: 'left', fontSize: 13 }}>
                <span className="mono faint" style={{ fontSize: 12 }}>{hhmm(r.at)}</span>
                <span className="dim">{r.where}</span>
                <span className="mono dim ellipsis" style={{ fontSize: 12 }}>{r.channel || '—'}</span>
                <span className="ellipsis">{r.text}</span>
                <span className="mono dim ellipsis" style={{ fontSize: 12 }}>{r.by || '—'}</span>
                <span className="mono ellipsis" style={{ fontSize: 12, color: r.corrected ? C.red : r.approval.includes('you') ? C.green : C.dim }}>{r.corrected ? 'corrected' : r.approval || '—'}</span>
              </button>
              {expanded && (
                <div className="col fresh" style={{ gap: 12, padding: '4px 16px 18px 92px' }}>
                  <div className="well" style={{ padding: '14px 16px', fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{r.text}</div>
                  {r.note && <span className="dim" style={{ fontSize: 13 }}>Note: {r.note}</span>}
                  {!r.corrected && (
                    <form className="row" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); void correct(r.id); }}>
                      <label htmlFor={'note-' + r.id} className="label" style={{ flex: 'none' }}>What was wrong</label>
                      <input id={'note-' + r.id} className="field" style={{ height: 36, flex: 1 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="A short note for the record" />
                      <button type="submit" className="pill sm" disabled={!note.trim()}>Mark corrected</button>
                    </form>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {!list.length && <Empty text="Nothing recorded here." />}
      </div></section>
    </div>
  );
}
