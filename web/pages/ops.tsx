import { useEffect, useState, type ReactNode } from 'react';
import type { Settings } from '../../shared/types';
import { act, ago, agoText, api, C, Card, Dot, Empty, Hero, hhmm, href, Pick, Seg, toast, useSnap } from '../lib';
import { IntakeControl } from '../intake-control';
import { resetTours } from '../tour';
import { ModePicker } from '../mode';
import { NotificationSettings } from '../notify';
import { SlackSettingsSection } from '../slack';

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
        <button type="button" className="pill sm icon" aria-label="Fewer slots" disabled={s <= 0} onClick={() => setS(Math.max(0, s - 1))}>−</button>
        <span className="mono" style={{ width: 64, textAlign: 'center', fontSize: 13, whiteSpace: 'nowrap' }}>{s} slot{s === 1 ? '' : 's'}</span>
        <button type="button" className="pill sm icon" aria-label="More slots" disabled={s >= 6} onClick={() => setS(Math.min(6, s + 1))}>+</button>
      </div>
      <button type="submit" className={'pill sm' + (dirty ? ' w' : '')} disabled={!dirty}>Save</button>
    </form>
  );
}

/** One settings section: title and explanation on the left, controls in a two-column grid on the right. */
function SettingsSection({ id, title, text, children }: { id: string; title: string; text: string; children: ReactNode }) {
  return (
    <section className="shell rise settings-anchor" id={'set-' + id} aria-label={title}>
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

/** The running version, a newer one if there is, and a button to check now. */
function UpdateRow() {
  const snap = useSnap()!;
  const u = snap.update;
  const [busy, setBusy] = useState(false);
  if (!u) return <span className="faint" style={{ fontSize: 13 }}>This copy is not a git checkout, so it cannot update itself.</span>;
  const tone = u.state === 'failed' ? C.red : u.state === 'available' || u.state === 'blocked' ? C.amber : u.state === 'updated' || u.state === 'up-to-date' ? C.green : C.faint;
  const check = async () => {
    setBusy(true);
    try { const r = await api<{ note: string }>('POST', '/api/update/check', { apply: true }); toast(r.note); } catch (e) { toast((e as Error).message); }
    setBusy(false);
  };
  return (
    <div className="row well" style={{ gap: 14, padding: '12px 16px', flexWrap: 'wrap' }}>
      <div className="col" style={{ gap: 4, flex: '1 1 280px', minWidth: 0 }}>
        <span style={{ fontSize: 14 }}>Running <span className="mono">{u.current?.sha ?? '?'}</span>{u.current ? <span className="faint"> · {u.current.date.slice(0, 10)} · {u.current.subject}</span> : null}</span>
        <span style={{ fontSize: 12, color: tone }}>{u.checking ? 'Checking…' : u.note}{u.checkedAt && !u.checking ? <span className="faint"> · checked {agoText(u.checkedAt)}</span> : null}</span>
        {u.latest && u.behind > 0 && <span className="faint ellipsis" style={{ fontSize: 12 }}>Newest: <span className="mono">{u.latest.sha}</span> {u.latest.subject}</span>}
      </div>
      <button type="button" className="pill sm" disabled={busy || u.checking} onClick={() => void check()}>{busy || u.checking ? 'Checking…' : 'Check now'}</button>
    </div>
  );
}

export function SettingsPage({ section }: { section?: string }) {
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
  // Notification switches save on their own (NotificationSettings), so Save never sends a stale copy of them.
  // Only what changed on this page: the mode, notifications and the delegation switch save on their own, and a
  // session may have changed other fields meanwhile, so sending the whole copy would undo those.
  const save = () => act(async () => {
    const was = JSON.parse(base) as Record<string, unknown>;
    const now = st as unknown as Record<string, unknown>;
    const changed = Object.fromEntries(Object.keys(now).filter((k) => !['mode', 'notify', 'delegate', 'slack'].includes(k) && JSON.stringify(now[k]) !== JSON.stringify(was[k])).map((k) => [k, now[k]]));
    const next = await api<Settings>('PUT', '/api/settings', changed);
    setSt(next); setBase(JSON.stringify(next));
  }, 'Saved');
  const T = st.thresholds;
  const badOrder = T.warn >= T.replace;
  // Most-used first. The menu jumps to a section without leaving the page, so unsaved edits survive;
  // #/settings/<id> opens the page at that section.
  const SECTIONS = [
    ['mode', 'Mode'], ['instructions', 'Your way of working'], ['notifications', 'Notifications'], ['slack', 'Slack'], ['automation', 'Automation'], ['intake', 'Intake'], ['lanes', 'Lanes and slots'], ['warnings', 'Warnings'],
    ['general', 'General'], ['updates', 'Updates'], ['budgets', 'Usage budgets'], ['help', 'Help'],
  ] as const;
  const jump = (id: string) => document.getElementById('set-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  useEffect(() => { if (!section) return; const t = setTimeout(() => jump(section), 300); return () => clearTimeout(t); }, [section]);
  const status = badOrder ? <span className="red">The warning must be below the replace line.</span> : dirty ? <span className="amber">Unsaved changes.</span> : <span className="faint">Everything is saved.</span>;
  return (
    <div className="page">
      <Hero eyebrow="Settings" title="How ShiftBoss behaves." sub="Pick a section, change it, then Save." />
      <div className="col" style={{ gap: 16 }}>
        <div className="set-bar shell">
          <div className="core row" style={{ padding: '8px 8px 8px 14px', gap: 12 }}>
            <nav aria-label="Sections" className="set-menu row">
              {SECTIONS.map(([id, label]) => (
                <a key={id} href={href('settings', id)} onClick={(e) => { e.preventDefault(); jump(id); }}>{label}</a>
              ))}
            </nav>
            <span className="set-status" style={{ fontSize: 12 }} role="status">{status}</span>
            <div className="row" style={{ gap: 8, flex: 'none' }}>
              <button type="button" className="pill sm" disabled={!dirty} onClick={() => { setSt(JSON.parse(base)); }}>Discard</button>
              <button type="button" className="pill sm w" disabled={!dirty || badOrder} onClick={() => void save()}>Save</button>
            </div>
          </div>
        </div>

        <SettingsSection id="mode" title="Mode" text="How much ShiftBoss may do on its own. Start with Dry run to watch it safely; switch any time.">
          <ModePicker />
        </SettingsSection>

        <SettingsSection id="instructions" title="Your way of working" text="How you like work done, in your own words. ShiftBoss adds it to every brief, handoff and prompt it sends, and sessions can read it with the owner_instructions tool.">
          <div style={{ gridColumn: '1 / -1' }} className="col">
            <textarea id="owner-instructions" aria-label="Your way of working" className="field" rows={6} maxLength={4000}
              placeholder={'For example:\n- Always let me review a PR before it is merged, and ask before any deploy.\n- Keep Slack replies to a few lines.\n- Test on dev with real requests before opening a PR.'}
              value={st.instructions ?? ''} onChange={(e) => setSt({ ...st, instructions: e.target.value })} style={{ height: 'auto', padding: 12, lineHeight: 1.55 }} />
            <span className="row faint" style={{ fontSize: 12, marginTop: 6, gap: 10, flexWrap: 'wrap' }}>
              <span>{(st.instructions ?? '').length}/4000 · Save to apply. Sessions can change it with <code className="mono">shiftboss instructions add "…"</code> when you ask them.</span>
              {base && JSON.parse(base).instructionsPrev !== undefined && JSON.parse(base).instructionsPrev !== (JSON.parse(base).instructions ?? '') && (
                <button type="button" className="pill sm" onClick={() => setSt({ ...st, instructions: JSON.parse(base).instructionsPrev })}>Bring back the previous version</button>
              )}
            </span>
          </div>
        </SettingsSection>

        <NotificationSettings Section={SettingsSection} Switch={Switch} />
        <SlackSettingsSection Section={SettingsSection} Switch={Switch} />

        <SettingsSection id="automation" title="Automation" text="What ShiftBoss may do without asking you.">
          <div style={{ gridColumn: '1 / -1', gap: 22 }} className="col">
            <Switch label="Send queued tasks by itself when a session has room" on={st.switches.autoDispatch} onChange={sw('autoDispatch')}
              hint="Off: queued tasks wait for you to press Send on the card."
              warn="On: ShiftBoss prompts sessions without asking you first." />
          </div>
          <Field id="close-old" label="Close a replaced session" hint="After a replacement, the old session closes this long after the new one took over. Never while it is working or waiting on a permission prompt. Its transcript stays, so it can be resumed.">
            <Pick id="close-old" label="Close a replaced session" value={String(st.closeOldAfterMin ?? 30)} onChange={(v) => setSt({ ...st, closeOldAfterMin: Number(v) })}
              options={[['0', 'Never: I close it'], ['10', 'After 10 minutes'], ['30', 'After 30 minutes'], ['60', 'After 1 hour'], ['120', 'After 2 hours']].map(([value, label]) => ({ value, label }))} />
          </Field>
        </SettingsSection>

        <SettingsSection id="intake" title="Intake" text="The session that reads Slack and meeting notes for new asks, and the channels it reads.">
          <div style={{ gridColumn: '1 / -1' }}><IntakeControl compact /></div>
          <Field id="watched-channels" label="Slack channels to read" hint="One per line." wide>
            <textarea key={(st.watchedChannels ?? []).join('\n')} id="watched-channels" className="field mono" rows={5} defaultValue={(st.watchedChannels ?? []).join('\n')} onBlur={(e) => setSt({ ...st, watchedChannels: e.target.value.split('\n').map((l) => l.trim()).filter(Boolean) })} />
          </Field>
        </SettingsSection>

        <SettingsSection id="lanes" title="Lanes and slots" text="What each session works on, and how many tasks it holds at once. Each row saves by itself.">
          <div style={{ gridColumn: '1 / -1' }} className="col divide">
            {snap.sessions.map((s) => <div key={s.name} style={{ padding: '10px 0' }}><LaneRow name={s.name} lane={s.lane} slots={s.slots} /></div>)}
            {!snap.sessions.length && <Empty text="No sessions running in herdr." />}
          </div>
        </SettingsSection>

        <SettingsSection id="warnings" title="Warnings" text="When a session counts as full, stuck or looping, and how many questions may wait on you.">
          <Range id="th-warn" label="Warn when context reaches" value={T.warn} min={50} max={90} unit="%" onChange={th('warn')} />
          <Range id="th-replace" label="Ask to replace the session at" value={T.replace} min={70} max={95} unit="%" onChange={th('replace')} />
          <Range id="th-stuck" label="Stuck after no progress for" value={T.stuckMin} min={5} max={60} unit=" min" onChange={th('stuckMin')} />
          <Range id="th-loop" label="Same command this many times is a loop" value={T.loopRepeats} min={2} max={6} onChange={th('loopRepeats')} />
          <Range id="th-stale" label="Handoff is stale after" value={T.staleMin} min={10} max={120} unit=" min" onChange={th('staleMin')} />
          <Range id="th-cap" label="Most open questions at once" value={T.needsCap} min={1} max={6} onChange={th('needsCap')} />
        </SettingsSection>

        <SettingsSection id="general" title="General" text="Which session leads, and where ShiftBoss looks.">
          <Field id="lead-session" label="Lead session" hint="Shown in the big card on Sessions. Its replacements (name-v2, name-v3 …) take over by themselves.">
            <input id="lead-session" className="field mono" value={st.leadSession ?? ''} placeholder="lead" onChange={(e) => setSt({ ...st, leadSession: e.target.value })} />
          </Field>
          <Field id="herdr-ws" label="herdr workspace" hint="Only show sessions in this workspace. Empty: all of them.">
            <input id="herdr-ws" className="field mono" value={st.herdrWorkspace} placeholder="all workspaces" onChange={(e) => setSt({ ...st, herdrWorkspace: e.target.value })} />
          </Field>
          <Field id="handoffs-dir" label="Handoffs folder" hint="One file per session, named after it." wide>
            <input id="handoffs-dir" className="field mono" value={st.handoffsDir} placeholder="C:/path/to/handoffs" onChange={(e) => setSt({ ...st, handoffsDir: e.target.value })} />
          </Field>
        </SettingsSection>

        <SettingsSection id="updates" title="Updates" text="New versions install by themselves and ShiftBoss restarts quietly. A copy with local edits is never touched.">
          <div style={{ gridColumn: '1 / -1', gap: 14 }} className="col">
            <Switch label="Install new versions automatically" on={st.autoUpdate !== false} onChange={(v) => setSt({ ...st, autoUpdate: v })}
              hint="Waits until nothing is being sent to a session." />
            <UpdateRow />
          </div>
        </SettingsSection>

        <SettingsSection id="budgets" title="Usage budgets" text="Only used when Claude Code's own usage numbers are missing (no status line tap).">
          {([['fiveHourTokens', 'Tokens per 5-hour window']] as const).map(([k, lbl]) => (
            <Field key={k} id={'bud-' + k} label={lbl}>
              <input id={'bud-' + k} className="field mono" type="number" min={0} step={1000} value={st.budgets[k]} onChange={(e) => bud(k)(Math.max(0, Number(e.target.value) || 0))} />
            </Field>
          ))}
        </SettingsSection>

        <SettingsSection id="help" title="Help" text="Each page shows a short tour the first time you open it.">
          <div style={{ gridColumn: '1 / -1', gap: 12, flexWrap: 'wrap' }} className="row">
            <button type="button" className="pill sm" onClick={() => { resetTours(); toast('Each page shows its tour again on your next visit'); }}>Show the tours again</button>
            <span className="faint" style={{ fontSize: 12 }}>Or press Ctrl+K and pick "Show this page's tour".</span>
          </div>
        </SettingsSection>
      </div>
    </div>
  );
}
