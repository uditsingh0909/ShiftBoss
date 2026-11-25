import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, C, toast, useSnap } from './lib';

export type Mode = 'dry' | 'ask' | 'safe' | 'auto';
export const MODES: { id: Mode; name: string; text: string }[] = [
  { id: 'dry', name: 'Dry run', text: 'Nothing happens. ShiftBoss records what it would do (start sessions, send briefs, run checks) so you can see it is safe first.' },
  { id: 'ask', name: 'Ask first', text: 'Every action waits for your approval in Needs you.' },
  { id: 'safe', name: 'Safe auto', text: 'Routine actions run (sending a brief, an intake pass, a monitor check). Risky ones wait for you: new sessions, replacing, prompting or stopping another session.' },
  { id: 'auto', name: 'Autopilot', text: 'Everything runs on its own.' },
];
export const modeName = (m?: string) => MODES.find((x) => x.id === m)?.name ?? 'Autopilot';

/** Settings → Mode: what ShiftBoss may do on its own. Saves at once (no Save button needed). */
export function ModePicker() {
  const snap = useSnap()!;
  const cur = (snap.settings.mode ?? 'auto') as Mode;
  const dry = snap.actions.filter((a) => a.state === 'dry').length;
  const [leaving, setLeaving] = useState<Mode | null>(null);
  const set = async (mode: Mode, dryRun?: 'review' | 'discard') => {
    try {
      const r = await api<{ settled: number }>('POST', '/api/mode', { mode, dryRun });
      toast(`${modeName(mode)} is on` + (r.settled ? (dryRun === 'review' ? ` · ${r.settled} recorded action${r.settled === 1 ? '' : 's'} moved to Needs you` : ' · recorded actions dropped') : ''));
      setLeaving(null);
    } catch (e) { toast((e as Error).message); }
  };
  const pick = (m: Mode) => { if (m === cur) return; if (cur === 'dry' && dry) setLeaving(m); else void set(m); };
  return (
    <div className="col" style={{ gridColumn: '1 / -1', gap: 10 }}>
      <div className="mode-grid" role="radiogroup" aria-label="Mode">
        {MODES.map((m) => (
          <button key={m.id} type="button" role="radio" aria-checked={cur === m.id} onClick={() => pick(m.id)} className={'mode-card' + (cur === m.id ? ' on' : '')}>
            <span className="row" style={{ gap: 8 }}>
              <span className="mode-dot" aria-hidden="true" />
              <span style={{ fontSize: 14, fontWeight: 500 }}>{m.name}</span>
            </span>
            <span className="dim" style={{ fontSize: 12, lineHeight: 1.5, textAlign: 'left' }}>{m.text}</span>
          </button>
        ))}
      </div>
      {leaving && (
        <div className="row well" style={{ gap: 10, padding: '12px 14px', flexWrap: 'wrap', borderColor: 'rgba(245,165,36,0.35)' }}>
          <span style={{ fontSize: 13, flex: '1 1 260px' }}>Dry run recorded {dry} action{dry === 1 ? '' : 's'}. Review them in Needs you before anything runs, or drop them?</span>
          <button type="button" className="pill sm w" onClick={() => void set(leaving, 'review')}>Review them</button>
          <button type="button" className="pill sm" onClick={() => void set(leaving, 'discard')}>Drop them</button>
          <button type="button" className="pill sm" onClick={() => setLeaving(null)}>Cancel</button>
        </div>
      )}
      <DelegateSwitch />
      <span className="faint" style={{ fontSize: 12 }}>
        Your own clicks in ShiftBoss always run. The mode covers what ShiftBoss does on its own (automatic sending, monitor checks) and what a session asks it to do. <span style={{ color: C.dim }}>Saved as soon as you pick one.</span>
      </span>
    </div>
  );
}

/**
 * The sidebar's mode switch: shows the mode, click to pick another. Opens above the button (on body, so the
 * sidebar never clips it). Leaving Dry run with recorded actions asks to review or drop them first.
 */
export function ModeSwitch({ collapsed, onDone }: { collapsed?: boolean; onDone?: () => void }) {
  const snap = useSnap();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const [leaving, setLeaving] = useState<Mode | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const r = btn.current?.getBoundingClientRect();
    if (r) setPos({ left: Math.min(r.left, innerWidth - 300), bottom: innerHeight - r.top + 8 });
    const off = (e: MouseEvent) => { const t = e.target as Node; if (!btn.current?.contains(t) && !pop.current?.contains(t)) { setOpen(false); setLeaving(null); } };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); setLeaving(null); } };
    addEventListener('mousedown', off); addEventListener('keydown', esc);
    return () => { removeEventListener('mousedown', off); removeEventListener('keydown', esc); };
  }, [open]);
  if (!snap) return null;
  const cur = (snap.settings.mode ?? 'auto') as Mode;
  const dry = snap.actions.filter((a) => a.state === 'dry').length;
  const tone = cur === 'auto' ? C.amber : cur === 'dry' ? C.faint : C.green;
  const set = async (mode: Mode, dryRun?: 'review' | 'discard') => {
    try {
      const r = await api<{ settled: number }>('POST', '/api/mode', { mode, dryRun });
      toast(`${modeName(mode)} is on` + (r.settled ? (dryRun === 'review' ? ` · ${r.settled} recorded action${r.settled === 1 ? '' : 's'} moved to Needs you` : ' · recorded actions dropped') : ''));
      setOpen(false); setLeaving(null); onDone?.();
    } catch (e) { toast((e as Error).message); }
  };
  const pick = (m: Mode) => { if (m === cur) { setOpen(false); return; } if (cur === 'dry' && dry) setLeaving(m); else void set(m); };
  return (
    <>
      <button ref={btn} type="button" className="side-item row" aria-haspopup="menu" aria-expanded={open} title={'Mode: ' + modeName(cur) + ' (click to change)'} onClick={() => setOpen(!open)}>
        <span className="side-ico"><span style={{ width: 8, height: 8, borderRadius: 999, background: tone, display: 'inline-block' }} /></span>
        {!collapsed && <span className="side-text ellipsis" style={{ flex: 1, textAlign: 'left' }}><span className="faint">Mode · </span>{modeName(cur)}</span>}
        {!collapsed && <span className="faint" aria-hidden="true" style={{ fontSize: 11 }}>▴</span>}
      </button>
      {open && pos && createPortal(
        <div ref={pop} role="menu" aria-label="Mode" className="mode-pop" style={{ position: 'fixed', left: Math.max(8, pos.left), bottom: pos.bottom }}>
          {leaving ? (
            <div className="col" style={{ gap: 10, padding: 6 }}>
              <span style={{ fontSize: 13 }}>Dry run recorded {dry} action{dry === 1 ? '' : 's'}. Review them in Needs you, or drop them?</span>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <button type="button" className="pill sm w" onClick={() => void set(leaving, 'review')}>Review them</button>
                <button type="button" className="pill sm" onClick={() => void set(leaving, 'discard')}>Drop them</button>
                <button type="button" className="pill sm" onClick={() => setLeaving(null)}>Back</button>
              </div>
            </div>
          ) : MODES.map((m) => (
            <button key={m.id} type="button" role="menuitemradio" aria-checked={cur === m.id} className={'mode-opt' + (cur === m.id ? ' on' : '')} onClick={() => pick(m.id)}>
              <span className="row" style={{ gap: 8 }}><span className="mode-dot" aria-hidden="true" /><span style={{ fontSize: 13, fontWeight: 500 }}>{m.name}</span></span>
              <span className="faint" style={{ fontSize: 11, lineHeight: 1.45, textAlign: 'left' }}>{m.text}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

/** Whether a Claude session may make the owner's decisions when asked (approvals, mode, settings, answers). Saves at once. */
function DelegateSwitch() {
  const snap = useSnap()!;
  const on = !!snap.settings.delegate;
  const flip = async () => {
    try { await api('PUT', '/api/settings', { delegate: !on }); toast(!on ? 'Claude can now make your decisions when you ask it to' : 'Only ShiftBoss itself can make your decisions now'); }
    catch (e) { toast((e as Error).message); }
  };
  return (
    <div className="row well" style={{ gap: 12, padding: '12px 14px', flexWrap: 'wrap' }}>
      <div className="col" style={{ gap: 3, flex: '1 1 300px', minWidth: 0 }}>
        <span style={{ fontSize: 14 }}>Claude can make my decisions</span>
        <span className="faint" style={{ fontSize: 12, lineHeight: 1.5 }}>
          {on ? 'On: when you ask a Claude session to approve something, change the mode or settings, or answer for you, it can. The feed shows which session did it.'
            : 'Off: only ShiftBoss itself can approve, change the mode or settings, or answer for you. Claude sessions can still read everything and do their own work.'}
        </span>
      </div>
      <button type="button" role="switch" aria-checked={on} aria-label="Claude can make my decisions" className="switch" onClick={() => void flip()}
        style={{ width: 44, height: 24, borderRadius: 999, border: '1px solid rgba(255,255,255,.2)', background: on ? 'var(--fg)' : 'transparent', position: 'relative', cursor: 'pointer', flex: 'none' }}>
        <span style={{ position: 'absolute', top: 3, left: on ? 23 : 3, width: 16, height: 16, borderRadius: 999, background: on ? '#050505' : 'var(--fg)', transition: 'left .3s var(--ease)' }} />
      </button>
    </div>
  );
}

/** A thin line on every page while ShiftBoss is not on Autopilot, so nobody wonders why nothing happened. */
export function ModeBanner() {
  const snap = useSnap();
  if (!snap) return null;
  const mode = (snap.settings.mode ?? 'auto') as Mode;
  if (mode === 'auto') return null;
  const dry = snap.actions.filter((a) => a.state === 'dry').length;
  const waiting = snap.actions.filter((a) => a.state === 'waiting').length;
  const text = mode === 'dry'
    ? `Dry run: ShiftBoss only records what it would do.${dry ? ` ${dry} recorded so far.` : ''}`
    : mode === 'ask' ? `Ask first: every action waits for your approval.${waiting ? ` ${waiting} waiting.` : ''}`
    : `Safe auto: risky actions wait for your approval.${waiting ? ` ${waiting} waiting.` : ''}`;
  return (
    <div className="mode-banner row" role="status">
      <span style={{ width: 8, height: 8, borderRadius: 999, background: mode === 'dry' ? C.faint : C.green, flex: 'none' }} aria-hidden="true" />
      <span style={{ flex: '1 1 auto', minWidth: 0 }}>{text}</span>
      {(dry > 0 || waiting > 0) && <a href="/needs" className="pill xs">{mode === 'dry' ? 'See them' : 'Review'}</a>}
      <a href="/settings/mode" className="pill xs">Change</a>
    </div>
  );
}
