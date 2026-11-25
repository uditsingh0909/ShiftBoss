import { useState } from 'react';
import { ago, agoText, api, C, Empty, toast, useSnap } from './lib';
import { modeName } from './mode';

const by = (who: string) => (who === 'dispatcher' ? 'ShiftBoss (automatic sending)' : who === 'shiftboss' ? 'ShiftBoss' : who);

/** Needs you → actions held by the gate: approve or reject each, or all; and in Dry run, what it would have done. */
export function Approvals() {
  const snap = useSnap()!;
  const waiting = snap.actions.filter((a) => a.state === 'waiting');
  const dry = snap.actions.filter((a) => a.state === 'dry');
  const recent = snap.actions.filter((a) => ['done', 'failed', 'rejected'].includes(a.state)).slice(0, 6);
  const [busy, setBusy] = useState<number | 'all' | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const decide = async (id: number | 'all', approve: boolean) => {
    setBusy(id);
    try {
      if (id === 'all') { const r = await api<{ ok: number; failed: string[] }>('POST', '/api/actions/decide-all', { approve }); toast(`${approve ? 'Approved' : 'Rejected'} ${r.ok}` + (r.failed.length ? ` · ${r.failed.length} failed: ${r.failed[0]}` : '')); }
      else { await api('POST', `/api/actions/${id}/${approve ? 'approve' : 'reject'}`); toast(approve ? 'Approved: running it now' : 'Rejected'); }
    } catch (e) { toast((e as Error).message); }
    setBusy(null);
  };
  if (!waiting.length && !dry.length && !recent.length) return null;
  return (
    <section className="shell rise" aria-label="Waiting for your approval">
      <div className="core col" style={{ gap: 12 }}>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <span className="label">{waiting.length ? `Waiting for your approval · ${waiting.length}` : snap.settings.mode === 'dry' ? 'Dry run' : 'Approvals'}</span>
          <span className="faint" style={{ fontSize: 12 }}>Mode: {modeName(snap.settings.mode)} · <a href="/settings" style={{ textDecoration: 'underline' }}>change</a></span>
          {waiting.length > 1 && (
            <span className="row" style={{ gap: 8, marginLeft: 'auto' }}>
              <button type="button" className="pill sm w" disabled={busy !== null} onClick={() => void decide('all', true)}>Approve all</button>
              <button type="button" className="pill sm" disabled={busy !== null} onClick={() => void decide('all', false)}>Reject all</button>
            </span>
          )}
        </div>
        <div className="col divide">
          {waiting.map((a) => (
            <div key={a.id} className="col" style={{ gap: 6, padding: '10px 0' }}>
              <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                <span style={{ width: 8, height: 8, borderRadius: 999, background: C.amber, flex: 'none' }} aria-hidden="true" />
                <button type="button" className="col" onClick={() => setOpen(open === a.id ? null : a.id)} aria-expanded={open === a.id}
                  style={{ gap: 2, flex: '1 1 280px', minWidth: 0, textAlign: 'left', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0 }}>
                  <span style={{ fontSize: 14 }}>{a.summary}</span>
                  <span className="faint" style={{ fontSize: 12 }}>asked by {by(a.by)} · {agoText(a.at)}{a.detail ? ' · details' : ''}</span>
                </button>
                <button type="button" className="pill sm w" disabled={busy !== null} onClick={() => void decide(a.id, true)}>{busy === a.id ? 'Running…' : 'Approve'}</button>
                <button type="button" className="pill sm" disabled={busy !== null} onClick={() => void decide(a.id, false)}>Reject</button>
              </div>
              {open === a.id && a.detail && <pre className="mono well" style={{ margin: 0, padding: 10, fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{a.detail}</pre>}
            </div>
          ))}
          {!waiting.length && snap.settings.mode !== 'dry' && <Empty text="Nothing is waiting for your approval." />}
        </div>
        {dry.length > 0 && (
          <details>
            <summary className="dim" style={{ fontSize: 13, cursor: 'pointer' }}>Dry run log: {dry.length} thing{dry.length === 1 ? '' : 's'} ShiftBoss would have done (nothing ran)</summary>
            <div className="col divide scrollbox" style={{ marginTop: 8, maxHeight: 320 }}>
              {dry.map((a) => (
                <div key={a.id} className="row" style={{ gap: 10, padding: '8px 0', flexWrap: 'wrap' }}>
                  <span className="mono faint" style={{ fontSize: 11, width: 60 }}>{ago(a.at)}</span>
                  <span style={{ fontSize: 13, flex: '1 1 240px', minWidth: 0 }}>{a.summary}</span>
                  <span className="faint" style={{ fontSize: 12 }}>{by(a.by)}</span>
                </div>
              ))}
            </div>
            <span className="faint" style={{ fontSize: 12 }}>When you switch to a live mode in Settings, you choose whether to review these or drop them.</span>
          </details>
        )}
        {recent.length > 0 && (
          <details>
            <summary className="faint" style={{ fontSize: 12, cursor: 'pointer' }}>Recently decided</summary>
            <div className="col" style={{ gap: 6, marginTop: 8 }}>
              {recent.map((a) => (
                <span key={a.id} style={{ fontSize: 12 }}>
                  <span style={{ color: a.state === 'done' ? C.green : a.state === 'failed' ? C.red : C.faint }}>{a.state === 'done' ? 'approved' : a.state}</span>
                  <span className="dim"> · {a.summary}{a.result && a.state === 'failed' ? ` · ${a.result}` : ''}</span>
                </span>
              ))}
            </div>
          </details>
        )}
      </div>
    </section>
  );
}
