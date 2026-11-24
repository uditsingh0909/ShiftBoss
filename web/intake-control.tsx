import { useState } from 'react';
import { act, ago, api, C, Dot, hhmm, href, useSnap } from './lib';

/** Next morning at 9:00 local time, as the default "pause until". */
function nextMorning(): string {
  const d = new Date();
  d.setDate(d.getDate() + (d.getHours() >= 9 ? 1 : 0));
  d.setHours(9, 0, 0, 0);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function span(fromIso: string | null): string {
  if (!fromIso) return '';
  const m = Math.max(0, Math.round((Date.now() - Date.parse(fromIso)) / 60e3));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Pause, pause until a time, resume with catch-up, or resume from now. Used on Sessions and Intake. */
export function IntakeControl({ compact }: { compact?: boolean }) {
  const snap = useSnap()!;
  const st = snap.intakeState;
  const [until, setUntil] = useState(nextMorning());
  const [picking, setPicking] = useState(false);
  const intakeSession = snap.sessions.find((s) => /intake/i.test(s.name));
  // The intake checks in at the start of each run (every ~2 min); silence for 10+ min means it is not running.
  const silent = !st.paused && (!st.lastBeginAt || Date.now() - Date.parse(st.lastBeginAt) > 10 * 60e3);
  const color = st.paused ? C.amber : silent ? C.red : C.green;
  const status = st.paused
    ? `Paused ${span(st.pausedAt)}${st.resumeAt ? ` · resumes ${new Date(st.resumeAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}`
    : silent
      ? intakeSession ? 'Running, but has not checked in for 10+ min' : 'No intake session running'
      : st.catchUpFrom ? `Catching up from ${hhmm(st.catchUpFrom)}` : `Reading · checked in ${ago(st.lastBeginAt)} ago`;
  const pause = (u: string | null) => act(() => api('POST', '/api/intake/pause', { until: u ? new Date(u).toISOString() : null }), u ? 'Intake paused until ' + new Date(u).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : 'Intake paused').then(() => setPicking(false));
  const resume = (catchUp: boolean) => act(() => api('POST', '/api/intake/resume', { catchUp }), catchUp ? 'Resumed · it will read what it missed' : 'Resumed from now · missed messages skipped');

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <Dot color={color} blink={!st.paused && !silent} />
        <span className="label">Intake</span>
        <span style={{ fontSize: 13, color: st.paused ? C.amber : silent ? C.red : C.dim }}>{status}</span>
        {!compact && st.since && <span className="mono faint" style={{ fontSize: 11, marginLeft: 'auto' }}>read up to {hhmm(st.since)}</span>}
      </div>
      {st.paused ? (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="pill sm w" onClick={() => resume(true)} title="Reads everything that came in while paused">Resume and catch up</button>
          <button type="button" className="pill sm" onClick={() => resume(false)} title="Skips what came in while paused">Resume from now</button>
        </div>
      ) : picking ? (
        <form className="row" style={{ gap: 8, flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); void pause(until); }}>
          <label className="row" style={{ gap: 6 }}><span className="faint" style={{ fontSize: 12 }}>Until</span>
            <input type="datetime-local" className="field" style={{ height: 32, width: 210, fontSize: 12 }} value={until} onChange={(e) => setUntil(e.target.value)} required />
          </label>
          <button type="submit" className="pill sm w">Pause</button>
          <button type="button" className="pill sm" onClick={() => setPicking(false)}>Cancel</button>
        </form>
      ) : (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="pill sm" onClick={() => setPicking(true)}>Pause until…</button>
          <button type="button" className="pill sm" onClick={() => void pause(null)}>Pause</button>
          {!compact && <a className="pill sm" href={href('intake')}>Open intake</a>}
        </div>
      )}
      {st.paused && <span className="faint" style={{ fontSize: 12 }}>While paused, the intake checks in and does nothing. Catching up reads the {span(st.since ?? st.pausedAt)} of messages it missed, oldest first.</span>}
    </div>
  );
}
