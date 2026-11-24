import { useEffect, useState, type ReactNode } from 'react';
import type { Settings } from '../../shared/types';
import { act, ago, api, C, Card, Dot, Empty, Hero, hhmm, Seg, toast, useSnap } from '../lib';
import { IntakeControl } from '../intake-control';

const isToday = (iso: string | null) => !!iso && new Date(iso).toDateString() === new Date().toDateString();
const host = (u: string) => { try { return new URL(u).host; } catch { return u; } };

// ---------------------------------------------------------------- Report

type Report = { sections: { title: string; tone: 'green' | 'amber' | 'dim'; lines: string[] }[]; text: string };
const AUD = { 'Plain words': 'plain', 'For the team': 'team', 'For me': 'me' } as const;
type AudLabel = keyof typeof AUD;

export function Report() {
  const snap = useSnap()!;
  const [aud, setAud] = useState<AudLabel>('Plain words');
  const [rep, setRep] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<Report>('GET', '/api/report?aud=' + AUD[aud]).then((r) => { if (live) { setRep(r); setErr(null); } }).catch((e) => { if (live) setErr((e as Error).message); });
    return () => { live = false; };
  }, [aud, snap.now]);
  const tone = (t: string) => (t === 'green' ? C.green : t === 'amber' ? C.amber : C.faint);
  const copy = async () => {
    if (!rep) return;
    try { await navigator.clipboard.writeText(rep.text); toast('Copied — ShiftBoss never posts it for you'); } catch { toast('Could not copy; select the text instead'); }
  };
  const liveToday = snap.tasks.filter((t) => t.stage >= 5 && isToday(t.updatedAt)).length;
  const inFlight = snap.tasks.filter((t) => t.stage >= 2 && t.stage <= 4).length;
  const waiting = snap.needs.filter((n) => !n.answer && !n.auto).length;
  return (
    <div className="page">
      <Hero eyebrow="Daily report" title="Today, in plain words." sub="Copy it and post it yourself.">
        <Seg label="Audience" value={aud} options={Object.keys(AUD) as AudLabel[]} onChange={setAud} />
        <button type="button" className="pill w" onClick={() => void copy()} disabled={!rep}>Copy</button>
      </Hero>
      <section className="grid12">
        <Card span={8} pad={32}>
          {err && <span className="red" style={{ fontSize: 13 }}>{err}</span>}
          {rep?.sections.map((s) => (
            <div key={s.title} className="col" style={{ gap: 10 }}>
              <span className="label">{s.title}</span>
              {s.lines.map((l, i) => (
                <div key={i} className="row" style={{ gap: 12, alignItems: 'baseline', fontSize: 16, lineHeight: 1.55 }}>
                  <Dot color={tone(s.tone)} /><span>{l}</span>
                </div>
              ))}
              {!s.lines.length && <span className="faint" style={{ fontSize: 14 }}>Nothing.</span>}
            </div>
          ))}
          {!rep && !err && <Empty text="Loading…" />}
          {rep && !rep.sections.length && <Empty text="Nothing to report yet." />}
        </Card>
        <Card span={4} delay={80}>
          {[['Live today', liveToday, C.green], ['In flight', inFlight, C.fg], ['Waiting on you', waiting, waiting ? C.amber : C.fg]].map(([k, v, c]) => (
            <div key={k as string} className="col" style={{ gap: 4 }}>
              <span className="label">{k}</span>
              <span style={{ fontSize: 40, fontWeight: 500, letterSpacing: '-0.04em', lineHeight: 1, color: c as string }}>{v}</span>
            </div>
          ))}
        </Card>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- Settings

function Range({ id, label, value, min, max, unit, onChange }: { id: string; label: string; value: number; min: number; max: number; unit?: string; onChange: (v: number) => void }) {
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <label htmlFor={id} style={{ fontSize: 13 }}>{label}</label>
        <span className="mono" style={{ fontSize: 13 }}>{value}{unit}</span>
      </div>
      <input id={id} type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ width: '100%', accentColor: C.fg }} />
    </div>
  );
}

function Switch({ label, hint, on, onChange, warn }: { label: string; hint?: string; on: boolean; onChange: (v: boolean) => void; warn?: string }) {
  return (
    <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
      <div className="col" style={{ gap: 4, flex: 1 }}>
        <span style={{ fontSize: 14 }}>{label}</span>
        {hint && <span className="faint" style={{ fontSize: 12 }}>{hint}</span>}
        {warn && on && <span className="amber" style={{ fontSize: 12 }}>{warn}</span>}
      </div>
      <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}
        style={{ width: 44, height: 24, flex: 'none', borderRadius: 999, border: '1px solid ' + (on ? C.fg : 'rgba(255,255,255,.2)'), background: on ? C.fg : 'transparent', position: 'relative', cursor: 'pointer', padding: 0 }}>
        <span style={{ position: 'absolute', top: 3, left: on ? 23 : 3, width: 16, height: 16, borderRadius: 999, background: on ? '#050505' : C.dim, transition: 'left .3s' }} />
      </button>
    </div>
  );
}

function LaneRow({ name, lane, slots }: { name: string; lane: string; slots: number }) {
  const [l, setL] = useState(lane);
  const [s, setS] = useState(slots);
  useEffect(() => { setL(lane); setS(slots); }, [lane, slots]);
  const dirty = l !== lane || s !== slots;
  const id = 'lane-' + name;
  return (
    <form className="row" style={{ gap: 12, flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); void act(() => api('POST', `/api/sessions/${encodeURIComponent(name)}/meta`, { lane: l, slots: s }), 'Saved ' + name); }}>
      <span className="mono ellipsis" style={{ width: 180, fontSize: 13 }}>{name}</span>
      <label htmlFor={id} className="label" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden' }}>Lane for {name}</label>
      <input id={id} className="field" style={{ height: 36, flex: '1 1 200px', width: 'auto' }} value={l} onChange={(e) => setL(e.target.value)} placeholder="What this session works on" />
      <div className="row" style={{ gap: 6 }} role="group" aria-label={'Slots for ' + name}>
        <button type="button" className="pill sm" aria-label="Fewer slots" disabled={s <= 0} onClick={() => setS(Math.max(0, s - 1))} style={{ width: 32, padding: 0, justifyContent: 'center' }}>−</button>
        <span className="mono" style={{ width: 52, textAlign: 'center', fontSize: 13 }}>{s} slot{s === 1 ? '' : 's'}</span>
        <button type="button" className="pill sm" aria-label="More slots" disabled={s >= 6} onClick={() => setS(Math.min(6, s + 1))} style={{ width: 32, padding: 0, justifyContent: 'center' }}>+</button>
      </div>
      <button type="submit" className={'pill sm' + (dirty ? ' w' : '')} disabled={!dirty}>Save</button>
    </form>
  );
}

/** One settings section: title and explanation on the left, controls in a two-column grid on the right. */
function SettingsSection({ title, text, children }: { title: string; text: string; children: ReactNode }) {
  return (
    <section className="shell rise" aria-label={title}>
      <div className="core settings-section">
        <div className="col" style={{ gap: 6 }}>
          <h2 style={{ fontSize: 18 }}>{title}</h2>
          <span className="dim" style={{ fontSize: 13, lineHeight: 1.55 }}>{text}</span>
        </div>
        <div className="settings-controls">{children}</div>
      </div>
    </section>
  );
}

function Field({ id, label, hint, wide, children }: { id: string; label: string; hint?: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className="col" style={{ gap: 6, gridColumn: wide ? '1 / -1' : undefined, minWidth: 0 }}>
      <label htmlFor={id} style={{ fontSize: 13 }}>{label}</label>
      {children}
      {hint && <span className="faint" style={{ fontSize: 12 }}>{hint}</span>}
    </div>
  );
}

export function SettingsPage() {
  const snap = useSnap()!;
  const [st, setSt] = useState<Settings>(snap.settings);
  const [base, setBase] = useState(JSON.stringify(snap.settings));
  // follow server changes while nothing is being edited
  useEffect(() => {
    const incoming = JSON.stringify(snap.settings);
    if (JSON.stringify(st) === base && incoming !== base) { setSt(snap.settings); setBase(incoming); }
  }, [snap.settings]);
  const dirty = JSON.stringify(st) !== base;
  const th = (k: keyof Settings['thresholds']) => (v: number) => setSt({ ...st, thresholds: { ...st.thresholds, [k]: v } });
  const sw = (k: keyof Settings['switches']) => (v: boolean) => setSt({ ...st, switches: { ...st.switches, [k]: v } });
  const bud = (k: keyof Settings['budgets']) => (v: number) => setSt({ ...st, budgets: { ...st.budgets, [k]: v } });
  const save = () => act(async () => { const next = await api<Settings>('PUT', '/api/settings', st); setSt(next); setBase(JSON.stringify(next)); }, 'Saved');
  const T = st.thresholds;
  const badOrder = T.warn >= T.replace;
  return (
    <div className="page">
      <Hero eyebrow="Settings" title="How ShiftBoss behaves." sub={badOrder ? <span style={{ color: C.red }}>The warning must be below the replace line.</span> : dirty ? <span style={{ color: C.amber }}>Unsaved changes.</span> : 'Everything is saved.'}>
        <button type="button" className="pill" disabled={!dirty} onClick={() => { setSt(JSON.parse(base)); }}>Discard</button>
        <button type="button" className="pill w" disabled={!dirty || badOrder} onClick={() => void save()}>Save</button>
      </Hero>
      <div className="col" style={{ gap: 16 }}>
        <SettingsSection title="General" text="Where ShiftBoss looks, and which session leads.">
          <Field id="lead-session" label="Lead session" hint="Always the big card on Sessions. Its replacements (name-v2, name-v3 …) take over automatically.">
            <input id="lead-session" className="field mono" value={st.leadSession ?? ''} placeholder="lead" onChange={(e) => setSt({ ...st, leadSession: e.target.value })} />
          </Field>
          <Field id="herdr-ws" label="herdr workspace" hint="Only show sessions in this workspace. Empty means every workspace.">
            <input id="herdr-ws" className="field mono" value={st.herdrWorkspace} placeholder="all workspaces" onChange={(e) => setSt({ ...st, herdrWorkspace: e.target.value })} />
          </Field>
          <Field id="handoffs-dir" label="Handoffs folder" hint="One file per session, named after it. Used for the handoff age." wide>
            <input id="handoffs-dir" className="field mono" value={st.handoffsDir} placeholder="C:/path/to/handoffs" onChange={(e) => setSt({ ...st, handoffsDir: e.target.value })} />
          </Field>
        </SettingsSection>

        <SettingsSection title="Warnings" text="When a session counts as heavy, stuck or looping, and how many decisions may wait on you.">
          <Range id="th-warn" label="Warn when context reaches" value={T.warn} min={50} max={90} unit="%" onChange={th('warn')} />
          <Range id="th-replace" label="Ask to replace the session at" value={T.replace} min={70} max={95} unit="%" onChange={th('replace')} />
          <Range id="th-stuck" label="Session counts as stuck after" value={T.stuckMin} min={5} max={60} unit=" min" onChange={th('stuckMin')} />
          <Range id="th-loop" label="Same command this many times is a loop" value={T.loopRepeats} min={2} max={6} onChange={th('loopRepeats')} />
          <Range id="th-stale" label="Handoff counts as stale after" value={T.staleMin} min={10} max={120} unit=" min" onChange={th('staleMin')} />
          <Range id="th-cap" label="Most open questions at once" value={T.needsCap} min={1} max={6} onChange={th('needsCap')} />
        </SettingsSection>

        <SettingsSection title="Automation" text="What ShiftBoss may do on its own.">
          <div style={{ gridColumn: '1 / -1', gap: 22 }} className="col">
            <Switch label="Send queued tasks automatically when a session frees a slot" on={st.switches.autoDispatch} onChange={sw('autoDispatch')}
              warn="When on, ShiftBoss prompts sessions on its own without asking you first." />
          </div>
        </SettingsSection>

        <SettingsSection title="Intake" text="The session that reads Slack and meeting notes, and the channels it watches.">
          <div style={{ gridColumn: '1 / -1' }}><IntakeControl compact /></div>
          <Field id="watched-channels" label="Watched Slack channels" hint="One per line. The intake reads new top-level messages here." wide>
            <textarea key={(st.watchedChannels ?? []).join('\n')} id="watched-channels" className="field mono" rows={5} defaultValue={(st.watchedChannels ?? []).join('\n')} onBlur={(e) => setSt({ ...st, watchedChannels: e.target.value.split('\n').map((l) => l.trim()).filter(Boolean) })} />
          </Field>
        </SettingsSection>

        <SettingsSection title="Usage budgets" text="Only used when Claude Code's own usage numbers are not available (no status line tap).">
          {([['fiveHourTokens', 'Tokens per 5-hour window']] as const).map(([k, lbl]) => (
            <Field key={k} id={'bud-' + k} label={lbl}>
              <input id={'bud-' + k} className="field mono" type="number" min={0} step={1000} value={st.budgets[k]} onChange={(e) => bud(k)(Math.max(0, Number(e.target.value) || 0))} />
            </Field>
          ))}
        </SettingsSection>

        <SettingsSection title="Lanes and slots" text="What each session works on, and how many tasks it may hold at once. Each row saves on its own.">
          <div style={{ gridColumn: '1 / -1' }} className="col divide">
            {snap.sessions.map((s) => <div key={s.name} style={{ padding: '10px 0' }}><LaneRow name={s.name} lane={s.lane} slots={s.slots} /></div>)}
            {!snap.sessions.length && <Empty text="No sessions running in herdr." />}
          </div>
        </SettingsSection>
      </div>
    </div>
  );
}
