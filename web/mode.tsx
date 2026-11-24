import { useState } from 'react';
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
