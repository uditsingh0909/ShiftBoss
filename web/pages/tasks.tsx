import { IntakeControl } from '../intake-control';
import { useEffect, useState } from 'react';
import { STAGES, type PromiseItem, type SlackMsg, type Stage, type Task, type TaskEvent } from '../../shared/types';
import { act, ago, api, Arrow, Bar, C, Card, Dot, Empty, Hero, hhmm, href, More, Pick, safeHref, Seg, usePage, useSnap } from '../lib';

const prioColor = (p: string) => (p === 'P1' ? C.red : p === 'P2' ? C.fg : C.faint);
const stageColor = (i: number) => (i === 0 ? C.amber : i === 1 ? C.faint : i >= 5 ? C.green : C.fg);

function StagePips({ stage }: { stage: number }) {
  return <span className="row" style={{ gap: 3 }} aria-label={'Stage: ' + STAGES[stage]}>{STAGES.map((_, i) => <span key={i} style={{ width: 12, height: 4, borderRadius: 999, background: i <= stage ? (stage >= 5 ? C.green : C.fg) : C.ghost }} />)}</span>;
}

function NewTask({ onDone }: { onDone: () => void }) {
  const snap = useSnap()!;
  const [f, setF] = useState({ title: '', ask: '', requester: '', source: '', session: '', prio: 'P2' as Task['prio'] });
  const submit = () => act(async () => { await api('POST', '/api/tasks', { ...f, session: f.session || null, who: 'you' }); onDone(); }, 'Added to the inbox');
  return (
    <section className="shell rise" aria-label="New task">
      <form className="core" style={{ display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0,1fr))', gap: 16, alignItems: 'end' }} onSubmit={(e) => { e.preventDefault(); if (f.title.trim()) void submit(); }}>
        <div className="col" style={{ gap: 8, gridColumn: 'span 6' }}><label htmlFor="nt-title" className="label">What needs doing</label><input id="nt-title" className="field" required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Move Hugh White texting to the approved campaign" /></div>
        <div className="col" style={{ gap: 8, gridColumn: 'span 3' }}><label htmlFor="nt-req" className="label">Asked by</label><input id="nt-req" className="field" value={f.requester} onChange={(e) => setF({ ...f, requester: e.target.value })} /></div>
        <div className="col" style={{ gap: 8, gridColumn: 'span 3' }}><label htmlFor="nt-src" className="label">Where</label><input id="nt-src" className="field" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} placeholder="#channel or meeting" /></div>
        <div className="col" style={{ gap: 8, gridColumn: 'span 6' }}><label htmlFor="nt-ask" className="label">The ask, in their words</label><textarea id="nt-ask" className="field" rows={2} value={f.ask} onChange={(e) => setF({ ...f, ask: e.target.value })} /></div>
        <div className="col" style={{ gap: 8, gridColumn: 'span 2' }}><span className="label">Priority</span><Seg label="Priority" value={f.prio} options={['P1', 'P2', 'P3'] as const} onChange={(p) => setF({ ...f, prio: p })} /></div>
        <div className="col" style={{ gap: 8, gridColumn: 'span 2' }}><label htmlFor="nt-s" className="label">Session</label>
          <Pick id="nt-s" value={f.session} onChange={(v) => setF({ ...f, session: v })} options={[{ value: '', label: 'Inbox (triage later)' }, ...snap.sessions.map((s) => ({ value: s.name, hint: s.lane || undefined }))]} /></div>
        <div style={{ gridColumn: 'span 2' }}><button type="submit" className="pill w" disabled={!f.title.trim()}>Add<Arrow dark /></button></div>
      </form>
    </section>
  );
}

export function Tasks({ openNew, inbox }: { openNew: boolean; inbox?: boolean }) {
  const snap = useSnap()!;
  const [view, setView] = useState<'Board' | 'List'>(inbox ? 'List' : 'Board');
  const [filter, setFilter] = useState<'All' | 'Inbox' | 'P1' | 'Unassigned' | 'Mine to ship'>(inbox ? 'Inbox' : 'All');
  const [adding, setAdding] = useState(openNew);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [ready, setReady] = useState<string[]>([]);
  useEffect(() => { api<string[]>('GET', '/api/ready').then(setReady).catch(() => setReady([])); }, [snap.now]);
  const match = { All: () => true, Inbox: (t: Task) => t.stage === 0, P1: (t: Task) => t.prio === 'P1', Unassigned: (t: Task) => !t.session, 'Mine to ship': (t: Task) => t.stage >= 3 && t.stage <= 5 };
  const list = snap.tasks.filter(match[filter]);
  const page = usePage(list, 50, filter);
  const move = (id: string, stage: number) => act(() => api('PATCH', `/api/tasks/${id}`, { stage, who: 'you' }), `${id} → ${STAGES[stage]}`);
  const inFlight = snap.tasks.filter((t) => t.stage >= 2 && t.stage <= 4).length;

  const card = (t: Task) => (
    <div key={t.id} className="kcard" draggable onDragStart={() => setDragId(t.id)} onDragEnd={() => { setDragId(null); setOver(null); }}>
      <a href={href('task', t.id)} className="col" style={{ gap: 8 }}>
        <span className="row" style={{ justifyContent: 'space-between' }}><span className="mono faint" style={{ fontSize: 11 }}>{t.id}</span><span className="mono" style={{ fontSize: 11, color: prioColor(t.prio) }}>{t.held ? 'held · ' : ''}{t.prio}</span></span>
        <span style={{ fontSize: 13, lineHeight: 1.4 }}>{t.title}</span>
      </a>
      <span className="row" style={{ gap: 8 }}>
        <Dot color={t.session ? C.fg : C.amber} /><span className="mono ellipsis dim" style={{ fontSize: 11, flex: 1 }}>{t.session ?? 'unassigned'}</span>
        <span className="mono faint" style={{ fontSize: 11 }}>{ago(t.updatedAt)}</span>
        {t.sourceUrl && <a href={safeHref(t.sourceUrl)} target="_blank" rel="noreferrer" className="mono dim" style={{ fontSize: 11 }} aria-label={`Open ${t.id} in ${/slack\.com/.test(t.sourceUrl) ? 'Slack' : 'its source'}`}>{/slack\.com/.test(t.sourceUrl) ? 'Slack' : 'Link'} ↗</a>}
        {ready.includes(t.id) && <button type="button" className="pill sm w" style={{ height: 24, padding: '0 10px', fontSize: 11 }} onClick={() => act(() => api('POST', `/api/tasks/${t.id}/dispatch`, {}), 'Sent to ' + t.session)}>Send</button>}
        {t.stage < 6 && <button type="button" aria-label={`Move ${t.id} to ${STAGES[t.stage + 1]}`} onClick={() => move(t.id, t.stage + 1)} style={{ width: 24, height: 24, borderRadius: 999, border: '1px solid rgba(255,255,255,0.12)', background: 'transparent', cursor: 'pointer', fontSize: 12 }}>→</button>}
      </span>
    </div>
  );

  return (
    <div className="page">
      <Hero eyebrow="Dispatcher" live title={`${inFlight} in flight.`} sub={`${snap.tasks.filter((t) => t.stage === 1).length} queued, ${snap.tasks.filter((t) => t.stage === 0).length} waiting for triage.`}>
        <Seg label="View" value={view} options={['Board', 'List'] as const} onChange={setView} />
        <Seg label="Filter" value={filter} options={['All', 'Inbox', 'P1', 'Unassigned', 'Mine to ship'] as const} onChange={setFilter} />
        <button type="button" className="pill w tour-newtask" onClick={() => setAdding(!adding)}>New task<Arrow dark /></button>
      </Hero>
      {adding && <NewTask onDone={() => setAdding(false)} />}
      {ready.length > 0 && !snap.settings.switches.autoDispatch && (
        <div className="shell rise alert-amber"><div className="core row" style={{ gap: 14, padding: '14px 20px', flexWrap: 'wrap' }}>
          <Dot color={C.amber} /><span style={{ flex: 1 }}>{ready.length} queued task{ready.length === 1 ? '' : 's'} can go now: {ready.join(', ')}. Automatic sending is off, so press Send on the card.</span>
          <a className="pill sm" href={href('settings')}>Settings</a>
        </div></div>
      )}

      {view === 'Board' ? (
        <section className="rise" aria-label="Board" style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(180px, 1fr))', gap: 12, alignItems: 'start', overflowX: 'auto', paddingBottom: 8 }}>
          {STAGES.map((label, i) => {
            const cards = list.filter((t) => t.stage === i);
            return (
              <div key={label} className="col stage-col" style={{ gap: 8, minWidth: 0, minHeight: 200, maxHeight: 'max(420px, calc(100vh - 300px))', overflowY: 'auto', borderRadius: 18, padding: 4, outline: over === i ? '1px dashed rgba(255,255,255,0.3)' : 'none' }}
                onDragOver={(e) => { e.preventDefault(); setOver(i); }} onDragLeave={() => setOver(null)}
                onDrop={(e) => { e.preventDefault(); if (dragId) void move(dragId, i); setOver(null); }}>
                <div className="row" style={{ gap: 10, padding: '6px 4px 10px', borderBottom: '1px solid rgba(255,255,255,0.06)', position: 'sticky', top: -4, zIndex: 1, background: '#050505' }}>
                  <Dot color={stageColor(i)} /><span style={{ fontSize: 13, fontWeight: 500 }}>{label}</span><span className="mono faint" style={{ marginLeft: 'auto', fontSize: 12 }}>{cards.length}</span>
                </div>
                {cards.map(card)}
                {!cards.length && <span className="faint" style={{ fontSize: 12, padding: '14px 4px' }}>Nothing here</span>}
              </div>
            );
          })}
        </section>
      ) : (
        <section className="shell rise"><div className="core col" style={{ padding: 12, gap: 0 }}>
          {page.shown.map((t) => (
            <a key={t.id} href={href('task', t.id)} className="trow" style={{ display: 'grid', gridTemplateColumns: '64px minmax(0,1fr) 170px 110px 90px 70px', gap: 16, alignItems: 'center' }}>
              <span className="mono faint" style={{ fontSize: 12 }}>{t.id}</span>
              <span className="col" style={{ gap: 4, minWidth: 0 }}><span className="ellipsis">{t.title}</span><span className="ellipsis faint" style={{ fontSize: 12 }}>{[t.requester, t.source].filter(Boolean).join(' · ') || '—'}</span></span>
              <span className="mono ellipsis dim" style={{ fontSize: 12 }}>{t.session ?? 'unassigned'}</span>
              <StagePips stage={t.stage} />
              <span className="mono" style={{ fontSize: 12, color: prioColor(t.prio) }}>{t.prio}</span>
              <span className="mono faint" style={{ fontSize: 12, textAlign: 'right' }}>{ago(t.updatedAt)}</span>
            </a>
          ))}
          <More page={page} />
          {!list.length && <Empty text="No tasks yet. Add one, or let the intake session file them with: shiftboss task add" />}
        </div></section>
      )}
    </div>
  );
}

export function TaskPage({ id }: { id: string }) {
  const snap = useSnap()!;
  const [d, setD] = useState<{ task: Task; events: TaskEvent[]; slack: SlackMsg[]; promises: PromiseItem[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [src, setSrc] = useState<'All' | 'Slack' | 'GitHub' | 'Session' | 'ShiftBoss'>('All');
  const [note, setNote] = useState('');
  useEffect(() => { api('GET', `/api/tasks/${id}`).then(setD).catch((e) => setErr(e.message)); }, [id, snap.now]);
  if (err) return <div className="page"><Hero eyebrow="Task" title={id} sub={err} /></div>;
  if (!d) return <div className="page faint">Loading…</div>;
  const t = d.task;
  const s = t.session ? snap.sessions.find((x) => x.name === t.session) : null;
  const patch = (body: object, ok: string) => act(() => api('PATCH', `/api/tasks/${t.id}`, { ...body, who: 'you' }), ok);
  const events = d.events.filter((e) => src === 'All' || e.src === src);
  const sent = d.slack.filter((m) => m.kind === 'sent').length;
  const owed = d.promises.filter((p) => p.state !== 'kept').length;
  return (
    <div className="page" style={{ gap: 40 }}>
      <section className="rise row" style={{ flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 32 }}>
        <div className="col" style={{ gap: 20, maxWidth: 1040 }}>
          <div className="row" style={{ gap: 10 }}><a className="eyebrow" href={href('tasks')}>‹ Tasks</a><span className="eyebrow mono">{t.id}</span><span className="eyebrow" style={{ color: prioColor(t.prio), borderColor: prioColor(t.prio) }}>{t.prio}{t.held ? ' · held' : ''}</span></div>
          <h1 className="hero" style={{ fontSize: 52, lineHeight: 1.06 }}>{t.title}</h1>
          <span className="row dim" style={{ gap: 16, flexWrap: 'wrap' }}><span>{t.requester ? 'Asked by ' + t.requester : 'No requester'}{t.source ? ' in ' + t.source : ''}</span><span className="faint">·</span><span>filed {ago(t.createdAt)} ago</span><span className="faint">·</span><span>{STAGES[t.stage]}</span></span>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="pill" onClick={() => patch({ held: !t.held }, t.held ? 'Resumed' : 'On hold')}>{t.held ? 'Resume' : 'Hold'}</button>
          <Pick pill width={240} label="Session" value={t.session ?? ''} onChange={(v) => patch({ session: v || null }, v ? 'Assigned to ' + v : 'Unassigned')}
            prefix="Session"
            options={[{ value: '', label: 'Unassigned' }, ...snap.sessions.map((x) => ({ value: x.name, hint: x.status }))]} placeholder="Session" />
          {t.session && t.stage <= 1 && <button type="button" className="pill w" onClick={() => act(() => api('POST', `/api/tasks/${t.id}/dispatch`, {}), 'Brief sent')}>Send brief<Arrow dark /></button>}
        </div>
      </section>

      <section className="shell rise" aria-label="Stages"><div className="core" style={{ padding: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(112px, 1fr))', gap: 8 }}>
        {STAGES.map((label, i) => {
          const done = i < t.stage, cur = i === t.stage;
          return (
            <button key={label} type="button" onClick={() => patch({ stage: i as Stage }, 'Moved to ' + label)} aria-current={cur ? 'step' : undefined}
              className="col" style={{ gap: 14, padding: 16, borderRadius: 16, textAlign: 'left', cursor: 'pointer', border: '1px solid ' + (cur ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.04)'), background: cur ? 'rgba(255,255,255,0.04)' : '#070707' }}>
              <span className="mono" style={{ fontSize: 12, color: done ? C.green : cur ? C.fg : C.faint }}>{done ? '✓' : String(i + 1).padStart(2, '0')}</span>
              <span style={{ fontSize: 15, fontWeight: 500, color: done ? C.dim : cur ? C.fg : C.faint }}>{label}</span>
            </button>
          );
        })}
      </div></section>

      <section className="grid12" style={{ alignItems: 'stretch' }}>
        <Card span={7} pad={28}>
          <span className="label">The ask</span>
          {t.ask ? <blockquote style={{ margin: 0, paddingLeft: 20, borderLeft: '2px solid rgba(255,255,255,0.14)', fontSize: 20, lineHeight: 1.5 }}>{t.ask}</blockquote> : <Empty text="No ask recorded." />}
          {t.sourceUrl && <a className="mono faint" style={{ fontSize: 12 }} href={safeHref(t.sourceUrl)} target="_blank" rel="noreferrer">open the source ↗</a>}
          <span className="label" style={{ marginTop: 8 }}>What done means</span>
          {[['Merged, review bot approved', 3], ['Live on dev and checked', 4], ['Live on prod', 5], ['Requester told', 6]].map(([text, need]) => {
            const ok = t.stage >= (need as number);
            return <div key={text as string} className="row well" style={{ gap: 14, padding: '12px 16px' }}><span style={{ width: 20, height: 20, borderRadius: 999, border: '1px solid ' + (ok ? C.green : 'rgba(255,255,255,0.16)'), color: C.green, fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center' }} aria-hidden="true">{ok ? '✓' : ''}</span><span style={{ color: ok ? C.fg : C.dim }}>{text}</span></div>;
          })}
        </Card>
        <div className="col" style={{ gridColumn: 'span 5', gap: 16 }}>
          <Card span={5}>
            <div className="row" style={{ justifyContent: 'space-between' }}><span className="label">Session</span><span className="mono faint" style={{ fontSize: 12 }}>{s ? s.status : t.session ? 'not running' : ''}</span></div>
            {t.session ? <a href={href('session', t.session)} className="mono" style={{ fontSize: 22 }}>{t.session}</a> : <span className="dim">Nobody yet. Pick one above.</span>}
            {s && <><span className="mono dim ellipsis" style={{ fontSize: 12 }}>{s.lines.at(-1) ? '⏺ ' + s.lines.at(-1)!.text : ''}</span><Bar pct={s.contextPct} color={s.contextPct >= 85 ? C.red : C.fg} /></>}
          </Card>
          <Card span={5}>
            <div className="row" style={{ justifyContent: 'space-between' }}><span className="label">Promises</span><span className="mono" style={{ fontSize: 12, color: owed ? C.amber : C.green }}>{owed ? owed + ' open' : 'none open'}</span></div>
            {d.promises.map((p) => <span key={p.id} style={{ fontSize: 13 }}>“{p.said}” <span className="faint">to {p.to} · {p.state}</span></span>)}
            {!d.promises.length && <Empty text="No promises tied to this task." />}
          </Card>
        </div>

        <Card span={7} className="tour-activity">
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}><span className="label">Activity</span><span className="mono faint" style={{ fontSize: 12 }}>{d.events.length} events</span>
            <span style={{ marginLeft: 'auto' }}><Seg label="Source" value={src} options={['All', 'Slack', 'GitHub', 'Session', 'ShiftBoss'] as const} onChange={setSrc} /></span></div>
          <div className="col divide scrollbox" style={{ maxHeight: 520 }}>
            {events.map((e) => (
              <div key={e.id} className="row" style={{ gap: 16, padding: '10px 0' }}>
                <span className="mono faint" style={{ width: 48, fontSize: 12, flex: 'none' }}>{hhmm(e.at)}</span>
                <span className="mono" style={{ width: 64, fontSize: 11, flex: 'none', color: e.src === 'Slack' ? C.amber : e.src === 'GitHub' ? C.fg : C.faint }}>{e.src}</span>
                <span className="mono ellipsis" style={{ width: 120, fontSize: 12, flex: 'none' }}>{e.who}</span>
                <span className="dim" style={{ fontSize: 14, minWidth: 0 }}>{e.text}</span>
              </div>
            ))}
            {!events.length && <Empty text="Nothing yet." />}
          </div>
          <form className="row" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); if (note.trim()) void act(async () => { await api('POST', `/api/tasks/${t.id}/events`, { src: 'ShiftBoss', who: 'you', text: note }); setNote(''); }, 'Noted'); }}>
            <label htmlFor="tnote" className="faint" style={{ fontSize: 12 }}>Note</label>
            <input id="tnote" className="field" style={{ height: 38 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note to the log" />
            <button type="submit" className="pill sm" disabled={!note.trim()}>Add</button>
          </form>
        </Card>
        <Card span={5} className="tour-slack">
          <div className="row" style={{ justifyContent: 'space-between' }}><span className="label">Slack thread</span><span className="mono faint" style={{ fontSize: 12 }}>{sent} sent</span></div>
          <div className="col scrollbox" style={{ gap: 12, maxHeight: 560 }}>
          {d.slack.map((m) => {
            const us = m.who === 'you' || m.who.toLowerCase().startsWith(snap.owner.toLowerCase());
            const tc = m.kind === 'draft' || m.kind === 'promise' ? C.amber : m.kind === 'sent' ? C.green : C.faint;
            return (
              <div key={m.id} className="col well" style={{ gap: 8, padding: 14, borderStyle: m.kind === 'draft' ? 'dashed' : 'solid', borderColor: m.kind === 'draft' ? 'rgba(245,165,36,0.45)' : undefined }}>
                <span className="row" style={{ gap: 10 }}>
                  <span style={{ width: 24, height: 24, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, background: us ? C.fg : 'rgba(255,255,255,0.1)', color: us ? '#050505' : C.fg }} aria-hidden="true">{m.who[0]?.toUpperCase()}</span>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{m.who}</span><span className="mono faint" style={{ fontSize: 11 }}>{hhmm(m.at)}</span>
                  <span className="mono" style={{ marginLeft: 'auto', fontSize: 11, color: tc }}>{m.kind === 'draft' ? 'draft · needs your OK' : m.kind}</span>
                </span>
                <span style={{ fontSize: 14, lineHeight: 1.5, paddingLeft: 34 }}>{m.text}</span>
                {m.kind === 'draft' && <span className="row" style={{ gap: 8, paddingLeft: 34 }}><button type="button" className="pill sm w" onClick={() => act(() => api('POST', `/api/slack/${m.id}/approve`, {}), 'Approved; ' + (t.session ?? 'the session') + ' will post it')}>Approve and post</button></span>}
              </div>
            );
          })}
          </div>
          {!d.slack.length && <Empty text="No Slack messages recorded for this task. Sessions add them with: shiftboss slack T-n …" />}
        </Card>
      </section>
    </div>
  );
}

export function Intake() {
  const snap = useSnap()!;
  const [filter, setFilter] = useState<'All' | 'Filed' | 'To lead' | 'Dropped'>('All');
  const [days, setDays] = useState<{ day: string; read: number; filed: number }[]>([]);
  useEffect(() => { api('GET', '/api/intake/days').then(setDays).catch(() => setDays([])); }, [snap.intake[0]?.id]);
  const isTask = (v: string) => /^(filed|linked)/.test(v);
  const match = { All: () => true, Filed: (v: string) => isTask(v), 'To lead': (v: string) => v === 'to lead', Dropped: (v: string) => v === 'dropped' };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todays = snap.intake.filter((i) => Date.parse(i.at) >= today.getTime());
  const max = Math.max(1, ...days.map((d) => d.read));
  const intakeSession = snap.sessions.find((s) => /intake/i.test(s.name));
  const intakePage = usePage(snap.intake.filter((i) => match[filter](i.verdict)), 50, filter);
  return (
    <div className="page">
      <Hero eyebrow={'Intake · ' + (intakeSession ? intakeSession.name + ' · ' + (intakeSession.model ?? '') : 'no intake session running')} live={!!intakeSession}
        title={`${todays.length} messages read today.`} sub={`${todays.filter((i) => isTask(i.verdict)).length} became tasks.`}>
        <Seg label="Filter" value={filter} options={['All', 'Filed', 'To lead', 'Dropped'] as const} onChange={setFilter} />
        <a className="pill" href={href('tasks', 'inbox')}>Open inbox<Arrow /></a>
      </Hero>
      <section className="grid12">
        <Card span={8} pad={12}>
          {intakePage.shown.map((m) => (
            <div key={m.id} className="trow row" style={{ gap: 18 }}>
              <span className="mono faint" style={{ width: 48, fontSize: 12, flex: 'none' }}>{hhmm(m.at)}</span>
              <span className="mono dim ellipsis" style={{ width: 180, fontSize: 12, flex: 'none' }}>{m.src}</span>
              <span className="col" style={{ flex: 1, minWidth: 0, gap: 4 }}><span className="ellipsis">{m.text}</span><span className="faint" style={{ fontSize: 12 }}>{m.who}</span></span>
              {m.url ? <a href={safeHref(m.url)} target="_blank" rel="noreferrer" className="pill sm" style={{ height: 28, fontSize: 11 }} aria-label={'Open in ' + (/slack\.com/.test(m.url) ? 'Slack' : 'source') + ': ' + m.text}>{/slack\.com/.test(m.url) ? 'Slack' : /mail\.google/.test(m.url) ? 'Gmail' : 'Open'} ↗</a>
                : <span className="mono faint" style={{ fontSize: 11, width: 64, textAlign: 'center' }} title="The intake did not record a link for this one">no link</span>}
              {m.taskId ? <a href={href('task', m.taskId)} className="mono" style={{ fontSize: 12, color: C.amber, minWidth: 80, textAlign: 'right' }}>{m.verdict}</a> : <span className="mono" style={{ fontSize: 12, minWidth: 80, textAlign: 'right', color: m.verdict === 'to lead' ? C.fg : C.faint }}>{m.verdict}</span>}
            </div>
          ))}
          <div className="row" style={{ justifyContent: 'center' }}><More page={intakePage} /></div>
          {!snap.intake.length && <Empty text="Nothing logged yet. The intake session reports each message it reads with: shiftboss intake --src … --text … --verdict …" />}
        </Card>
        <div className="col" style={{ gridColumn: 'span 4', gap: 16 }}>
          <Card span={4} tone={snap.intakeState.paused ? 'amber' : undefined}>
            <IntakeControl />
          </Card>
          <Card span={4}>
            <span className="label">Read and filed · 14 days</span>
            <div className="row" style={{ gap: 4, alignItems: 'flex-end', height: 96 }} aria-label="Messages per day">
              {days.map((d) => <span key={d.day} title={`${d.day}: ${d.read} read, ${d.filed} filed`} style={{ flex: 1, height: Math.max(3, (d.read / max) * 96), borderRadius: 3, background: 'rgba(255,255,255,0.16)', position: 'relative' }}><span style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: d.read ? (d.filed / d.read) * 100 + '%' : 0, background: C.fg, borderRadius: 3 }} /></span>)}
              {!days.length && <span className="faint" style={{ fontSize: 12 }}>No history yet.</span>}
            </div>
            <span className="faint" style={{ fontSize: 12 }}>White = became a task.</span>
          </Card>
          <Card span={4}>
            <span className="label">Rules the intake session follows</span>
            {['Read the whole thread before calling anything open.', 'An ask that is ours becomes a task; an FYI is dropped.', 'Production, money, customers or access goes to the lead, never straight to a session.', 'A promise sent from your account is tracked until the person is told.'].map((r, i) => (
              <div key={i} className="row" style={{ gap: 12, fontSize: 13, alignItems: 'flex-start' }}><span className="mono faint" style={{ fontSize: 11 }}>{String(i + 1).padStart(2, '0')}</span><span className="dim">{r}</span></div>
            ))}
            <a className="mono faint" style={{ fontSize: 12 }} href={href('settings')}>settings →</a>
          </Card>
        </div>
      </section>
    </div>
  );
}
