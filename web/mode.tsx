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
