import { useEffect, useState } from 'react';
import { MONITOR_DAYS, MONITOR_HOURS, type Monitor, type MonitorCheck, type MonitorState, type MonitorVerdict } from '../../shared/types';
import { act, api, Arrow, C, Card, Dot, Empty, Hero, href, Pick, safeHref, Seg, toast, useSnap } from '../lib';

type Full = Monitor & { checks: MonitorCheck[] };
type List = { monitors: Full[]; session: { name: string; status: string; cwd: string } | null; sessionName: string; leadCwd: string | null; startPrompt: string };

export const verdictColor = (v: MonitorVerdict | null) => (v === 'bad' || v === 'error' ? C.red : v === 'warn' ? C.amber : v === 'ok' ? C.green : C.faint);
const stateColor = (s: MonitorState) => (s === 'alerting' ? C.red : s === 'paused' ? C.amber : s === 'active' ? C.green : C.faint);
const STATE_WORD: Record<MonitorState, string> = { active: 'Watching', alerting: 'Alerting', paused: 'Paused', finished: 'Finished' };
const VERDICT_WORD: Record<MonitorVerdict, string> = { ok: 'OK', warn: 'Worth a look', bad: 'Bad', error: 'Could not check' };

/** "Tue 14:00" for a time this week, else a date. */
function when(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const far = Math.abs(d.getTime() - Date.now()) > 6 * 864e5;
  return d.toLocaleString([], far ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

type Form = { title: string; prompt: string; pr: string; ticket: string; dashboard: string; taskId: string; durationDays: string; intervalHours: string };
const EMPTY: Form = { title: '', prompt: '', pr: '', ticket: '', dashboard: '', taskId: '', durationDays: '3', intervalHours: '6' };
const toForm = (m: Monitor): Form => ({ title: m.title, prompt: m.prompt, pr: m.links.pr ?? '', ticket: m.links.ticket ?? '', dashboard: m.links.dashboard ?? '', taskId: m.taskId ?? '', durationDays: String(m.durationDays), intervalHours: String(m.intervalHours) });

/** New monitor, or edit one. */
function MonitorForm({ initial, id, onDone }: { initial: Form; id?: number; onDone: () => void }) {
  const snap = useSnap()!;
  const [f, setF] = useState(initial);
  const set = (k: keyof Form) => (v: string) => setF({ ...f, [k]: v });
  const p = id ? 'em' + id : 'nm';
  const taskOptions = [{ value: '', label: 'No task' }, ...snap.tasks.filter((t) => t.stage < 6).map((t) => ({ value: t.id, label: `${t.id} · ${t.title}` }))];
  const checks = Math.ceil((Number(f.durationDays) * 24) / Number(f.intervalHours));
  const submit = () => act(async () => {
    const body = { title: f.title, prompt: f.prompt, links: { pr: f.pr, ticket: f.ticket, dashboard: f.dashboard }, taskId: f.taskId, durationDays: Number(f.durationDays), intervalHours: Number(f.intervalHours) };
    await api(id ? 'PATCH' : 'POST', id ? `/api/monitors/${id}` : '/api/monitors', body);
    onDone();
  }, id ? 'Saved' : 'Watching it · the first check goes to the monitor session now');
  return (
    <form className="grid12" style={{ alignItems: 'end' }} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="col" style={{ gap: 8, gridColumn: 'span 12' }}><label htmlFor={p + '-title'} className="label">What was shipped</label>
        <input id={p + '-title'} className="field" required maxLength={200} value={f.title} onChange={(e) => set('title')(e.target.value)} placeholder="New store: phone numbers and texting registration" /></div>
      <div className="col" style={{ gap: 8, gridColumn: 'span 12' }}><label htmlFor={p + '-prompt'} className="label">What to check, and what "bad" looks like</label>
        <textarea id={p + '-prompt'} className="field" required rows={4} maxLength={4000} value={f.prompt} onChange={(e) => set('prompt')(e.target.value)}
          placeholder="Texts from the new numbers go out and replies come back. Bad: any message failing, or no replies at all in a day." /></div>
      <div className="col" style={{ gap: 8, gridColumn: 'span 4' }}><label htmlFor={p + '-pr'} className="label">Pull request (optional)</label>
        <input id={p + '-pr'} className="field mono" type="url" value={f.pr} onChange={(e) => set('pr')(e.target.value)} placeholder="https://…" /></div>
      <div className="col" style={{ gap: 8, gridColumn: 'span 4' }}><label htmlFor={p + '-ticket'} className="label">Ticket (optional)</label>
        <input id={p + '-ticket'} className="field mono" type="url" value={f.ticket} onChange={(e) => set('ticket')(e.target.value)} placeholder="https://…" /></div>
      <div className="col" style={{ gap: 8, gridColumn: 'span 4' }}><label htmlFor={p + '-dash'} className="label">Dashboard (optional)</label>
        <input id={p + '-dash'} className="field mono" type="url" value={f.dashboard} onChange={(e) => set('dashboard')(e.target.value)} placeholder="https://…" /></div>
      <div className="col" style={{ gap: 8, gridColumn: 'span 4' }}><label htmlFor={p + '-task'} className="label">Task (optional)</label>
        <Pick id={p + '-task'} value={f.taskId} onChange={set('taskId')} options={taskOptions} label="Task" /></div>
      <div className="col" style={{ gap: 8, gridColumn: 'span 3' }}><label htmlFor={p + '-days'} className="label">Watch for</label>
        <Pick id={p + '-days'} value={f.durationDays} onChange={set('durationDays')} options={MONITOR_DAYS.map((d) => ({ value: String(d), label: `${d} day${d === 1 ? '' : 's'}` }))} label="Watch for" /></div>
      <div className="col" style={{ gap: 8, gridColumn: 'span 3' }}><label htmlFor={p + '-every'} className="label">Check every</label>
        <Pick id={p + '-every'} value={f.intervalHours} onChange={set('intervalHours')} options={MONITOR_HOURS.map((h) => ({ value: String(h), label: `${h} hour${h === 1 ? '' : 's'}` }))} label="Check every" /></div>
      <div className="row" style={{ gridColumn: 'span 2', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button type="button" className="pill sm" onClick={onDone}>Cancel</button>
        <button type="submit" className="pill w" disabled={!f.title.trim() || !f.prompt.trim()}>{id ? 'Save' : 'Watch'}<Arrow dark /></button>
      </div>
      <span className="faint" style={{ gridColumn: 'span 12', fontSize: 12 }}>
        {id ? 'A new duration counts from when it started.' : `${checks} check${checks === 1 ? '' : 's'} in all, the first one now.`} A bad check, or two checks in a row that could not be done, puts it on the Sessions page under Needs attention.
      </span>
    </form>
  );
}

/** The monitor session: running, or a button that starts it (Sonnet, in the lead's folder). */
function MonitorSession({ data }: { data: List }) {
  const snap = useSnap()!;
  const folders = [...new Set(snap.sessions.map((s) => s.cwd).filter(Boolean))];
  const [cwd, setCwd] = useState(data.leadCwd ?? '');
  const s = data.session;
  const start = () => act(() => api('POST', '/api/sessions/spawn', { name: data.sessionName, cwd: (data.leadCwd ?? cwd).trim(), model: 'sonnet', prompt: data.startPrompt }),
    `Starting ${data.sessionName} · it shows up on Sessions in a few seconds`);
  if (s) return (
    <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
      <Dot color={s.status === 'blocked' ? C.amber : C.green} blink={s.status === 'working'} />
      <span className="label">Monitor session</span>
      <a className="mono" href={href('session', s.name)}>{s.name}</a>
      <span className="faint" style={{ fontSize: 13 }}>{s.status === 'blocked' ? 'is waiting on a prompt in herdr: checks wait until you answer it there' : s.status === 'working' ? 'is checking' : 'is ready for the next check'}</span>
    </div>
  );
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <Dot color={C.red} /><span className="label">Monitor session</span>
        <span className="dim" style={{ fontSize: 13 }}>Not running, so no checks are being done. ShiftBoss starts a Sonnet session named <code className="mono">{data.sessionName}</code> and sends it one check at a time.</span>
      </div>
      {!data.leadCwd && (
        <div className="col" style={{ gap: 8, maxWidth: 560 }}>
          <label htmlFor="mon-cwd" className="label">Folder to start it in</label>
          <Pick id="mon-cwd" free value={cwd} onChange={setCwd} placeholder="C:/path/to/a/folder/Claude/trusts" options={folders.map((d) => ({ value: d }))} />
          <span className="faint" style={{ fontSize: 12 }}>Pick a folder Claude already trusts, such as one your sessions work in. A new folder asks "trust this folder?" in herdr; only you answer that.</span>
        </div>
      )}
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <button type="button" className="pill sm w" disabled={!(data.leadCwd ?? cwd).trim()} onClick={() => void start()}>Start the monitor session</button>
        {data.leadCwd && <span className="faint mono ellipsis" style={{ fontSize: 12, minWidth: 0 }}>in {data.leadCwd} (the lead's folder)</span>}
      </div>
    </div>
  );
}

function Timeline({ checks }: { checks: MonitorCheck[] }) {
  if (!checks.length) return <span className="faint" style={{ fontSize: 13 }}>No checks yet.</span>;
  return (
    <ol className="col divide" style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label="Checks">
      {checks.map((c) => (
        <li key={c.id} className="col" style={{ gap: 4, padding: '10px 0' }}>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <Dot color={c.reportedAt ? verdictColor(c.verdict) : C.dim} blink={!c.reportedAt} />
            <span style={{ fontSize: 13, color: c.reportedAt ? verdictColor(c.verdict) : C.dim }}>{c.reportedAt ? VERDICT_WORD[c.verdict!] : 'Checking now'}</span>
            <span className="mono faint" style={{ fontSize: 12 }}>{when(c.reportedAt ?? c.sentAt)}</span>
            {!c.sentAt && <span className="faint" style={{ fontSize: 12 }}>(reported without being asked)</span>}
          </div>
          {c.summary && <span style={{ fontSize: 14, paddingLeft: 16, overflowWrap: 'anywhere' }}>{c.summary}</span>}
          {(c.details || c.links.length > 0) && (
            <details style={{ paddingLeft: 16 }}>
              <summary className="faint" style={{ fontSize: 12, cursor: 'pointer' }}>Details</summary>
              {c.details && <p className="dim" style={{ fontSize: 13, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '6px 0' }}>{c.details}</p>}
              {c.links.map((u) => <a key={u} className="mono" style={{ display: 'block', fontSize: 12, overflowWrap: 'anywhere' }} href={safeHref(u)} target="_blank" rel="noreferrer">{u} ↗</a>)}
            </details>
          )}
        </li>
      ))}
    </ol>
  );
}

function MonitorCard({ m, onChanged }: { m: Full; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(m.state === 'alerting');
  const run = (fn: () => Promise<unknown>, ok: string) => act(async () => { await fn(); onChanged(); }, ok);
  const checkNow = async () => {
    try {
      const r = await api<{ waiting: string | null }>('POST', `/api/monitors/${m.id}/check-now`);
      toast(r.waiting ? 'Queued: ' + r.waiting : 'The monitor session is checking it now');
      onChanged();
    } catch (e) { toast((e as Error).message); }
  };
  const action = (a: 'pause' | 'resume' | 'stop') => run(() => api('PATCH', `/api/monitors/${m.id}`, { action: a }), a === 'pause' ? 'Paused' : a === 'resume' ? 'Resumed' : 'Stopped watching');
  const links = ([['pr', 'Pull request'], ['ticket', 'Ticket'], ['dashboard', 'Dashboard']] as const).filter(([k]) => m.links[k]);
  const watched = m.state === 'active' || m.state === 'alerting';
  return (
    <Card tone={m.state === 'alerting' ? 'red' : undefined} pad={20}>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <Dot color={stateColor(m.state)} blink={m.state === 'alerting'} />
        <span className="label" style={{ color: stateColor(m.state) }}>{STATE_WORD[m.state]}</span>
        <span style={{ fontSize: 17, flex: '1 1 240px', minWidth: 0, overflowWrap: 'anywhere' }}>{m.title}</span>
        {m.taskId && <a className="mono" style={{ fontSize: 12, color: C.amber }} href={href('task', m.taskId)}>{m.taskId}</a>}
      </div>
      <div className="row" style={{ gap: 18, flexWrap: 'wrap', fontSize: 13 }}>
        <span className="dim">{m.inFlight ? `Checking now (asked ${when(m.inFlight.sentAt)})` : watched ? (m.nextDueAt && Date.parse(m.nextDueAt) <= Date.now() ? 'Check due now · it goes when the monitor session is free' : `Next check ${when(m.nextDueAt)}`) : m.state === 'paused' ? 'Paused: no checks until you resume' : m.finishReason === 'stopped' ? `Stopped ${when(m.finishedAt)}` : `Finished ${when(m.finishedAt)}`}</span>
        <span className="faint">{m.checksDone} done{m.checksLeft ? `, ${m.checksLeft} left` : ''} · every {m.intervalHours} h for {m.durationDays} day{m.durationDays === 1 ? '' : 's'}, until {when(m.endsAt)}</span>
      </div>
      {m.lastVerdict && (
        <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
          <span className="mono" style={{ fontSize: 12, color: verdictColor(m.lastVerdict), flex: 'none', paddingTop: 2 }}>{VERDICT_WORD[m.lastVerdict]}</span>
          <span style={{ fontSize: 14, minWidth: 0, overflowWrap: 'anywhere' }}>{m.lastSummary}</span>
        </div>
      )}
      {links.length > 0 && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {links.map(([k, label]) => <a key={k} className="pill sm" href={safeHref(m.links[k])} target="_blank" rel="noreferrer">{label} ↗</a>)}
        </div>
      )}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {watched && <button type="button" className="pill sm w" disabled={!!m.inFlight} onClick={() => void checkNow()}>Check now</button>}
        {watched && <button type="button" className="pill sm" onClick={() => void action('pause')}>Pause</button>}
        {m.state === 'paused' && <button type="button" className="pill sm w" onClick={() => void action('resume')}>Resume</button>}
        {m.state !== 'finished' && <button type="button" className="pill sm" onClick={() => { if (confirm(`Stop watching "${m.title}"? No more checks will run.`)) void action('stop'); }}>Stop</button>}
        <button type="button" className="pill sm" aria-expanded={editing} onClick={() => setEditing(!editing)}>Edit</button>
        <button type="button" className="pill sm" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide checks' : `All checks (${m.checks.length})`}</button>
      </div>
      {editing && <MonitorForm id={m.id} initial={toForm(m)} onDone={() => { setEditing(false); onChanged(); }} />}
      {open && <Timeline checks={m.checks} />}
      {!editing && <details><summary className="faint" style={{ fontSize: 12, cursor: 'pointer' }}>What it checks</summary><p className="dim" style={{ fontSize: 13, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '6px 0 0' }}>{m.prompt}</p></details>}
    </Card>
  );
}

export function Monitors() {
  const snap = useSnap()!;
  const [data, setData] = useState<List | null>(null);
  const [adding, setAdding] = useState(false);
  const [show, setShow] = useState<'Watching' | 'Finished' | 'All'>('Watching');
  const load = () => api<List>('GET', '/api/monitors').then(setData).catch(() => setData(null));
  useEffect(() => { void load(); }, [snap.now]);
  const all = data?.monitors ?? [];
  const order: Record<MonitorState, number> = { alerting: 0, active: 1, paused: 2, finished: 3 };
  const list = all.filter((m) => show === 'All' || (show === 'Finished') === (m.state === 'finished')).sort((a, b) => order[a.state] - order[b.state] || b.id - a.id);
  const watching = all.filter((m) => m.state !== 'finished').length;
  const alerting = all.filter((m) => m.state === 'alerting').length;
  return (
    <div className="page">
      <Hero eyebrow={'Monitors · ' + (data?.session ? data.session.name : 'no monitor session running')} live={!!data?.session}
        title={`${watching} thing${watching === 1 ? '' : 's'} watched.`} sub={alerting ? `${alerting} need${alerting === 1 ? 's' : ''} a look.` : 'Checked on a schedule after they ship.'}>
        <Seg label="Show" value={show} options={['Watching', 'Finished', 'All'] as const} onChange={setShow} />
        <button type="button" className="pill w" onClick={() => setAdding(!adding)} aria-expanded={adding}>New monitor<Arrow dark /></button>
      </Hero>
      {data && <Card pad={20}><MonitorSession data={data} /></Card>}
      {adding && (
        <section className="shell rise" aria-label="New monitor">
          <div className="core col" style={{ gap: 18 }}><MonitorForm initial={EMPTY} onDone={() => { setAdding(false); void load(); }} /></div>
        </section>
      )}
      <section className="col" style={{ gap: 16 }} aria-label="Monitors">
        {list.map((m) => <MonitorCard key={m.id} m={m} onChanged={() => void load()} />)}
        {data && !list.length && <Empty text={show === 'Finished' ? 'Nothing has finished yet.' : 'Nothing is being watched. After you ship something, add a monitor and the monitor session checks on it for a few days.'} />}
        {!data && <Empty text="Loading monitors…" />}
      </section>
    </div>
  );
}
