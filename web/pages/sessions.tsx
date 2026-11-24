import { IntakeControl } from '../intake-control';
import { useEffect, useState } from 'react';
import { MONITOR_SESSION, resolveLead, type Replacement, type Session } from '../../shared/types';
import { act, ago, api, Arrow, Bar, C, Card, ctxColor, Dot, Empty, fmtTok, Hero, hhmm, href, Pick, safeHref, Seg, toneColor, useSnap } from '../lib';

const statusColor = (s: Session['status']) => (s === 'blocked' ? C.amber : s === 'working' ? C.green : s === 'lost' ? C.red : C.faint);
const lineColor = (k: string) => (k === 'tool' ? C.fg : k === 'out' ? C.faint : k === 'you' ? C.amber : k === 'sys' ? C.red : C.dim);
/** The session's own last sentence, used when ShiftBoss has not given it a task. */
const lastSay = (s: Session) => { const t = s.lines.filter((l) => l.kind === 'say').at(-1)?.text; return t ? t.split(/(?<=[.!?])\s/)[0].slice(0, 120) : null; };
const prefix = (k: string) => (k === 'tool' ? '⏺ ' : k === 'out' ? '  ⎿ ' : k === 'you' ? 'you › ' : '· ');

function Lines({ s, n, height, stamps, grow }: { s: Session; n: number; height: number; stamps?: boolean; grow?: boolean }) {
  return (
    <div className="term" style={grow ? { flex: '1 1 0', minHeight: height } : { height }}>
      <div className="scroll" style={{ height: '100%', padding: stamps ? '16px 18px' : '10px 12px' }} role="log" aria-live="polite" tabIndex={0}>
        <div className="col" style={{ gap: 2 }}>
          {s.lines.slice(-n).map((l, i) => (
            <div key={i + l.at} className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
              {stamps && <span style={{ width: 52, flex: 'none', color: 'rgba(255,255,255,0.22)' }}>{hhmm(l.at)}</span>}
              <span style={{ color: lineColor(l.kind), wordBreak: 'break-word', minWidth: 0 }} className={stamps ? '' : 'ellipsis'}>{prefix(l.kind) + l.text}</span>
            </div>
          ))}
          {!s.lines.length && <span className="faint">No transcript lines yet.</span>}
          <div>› <span className="caret" aria-hidden="true" /></div>
        </div>
      </div>
    </div>
  );
}



type Alert = { key: string; tone: 'red' | 'amber'; what: string; detail: string; to: string; action?: { label: string; run: () => void } };

/** Everything that needs attention right now, in one strip, worst first, each with its next step. */
function Alerts() {
  const snap = useSnap()!;
  const th = snap.settings.thresholds;
  const st = snap.intakeState;
  const out: Alert[] = [];
  if (!snap.herdrOk) out.push({ key: 'herdr', tone: 'red', what: 'herdr is not answering', detail: snap.herdrError ?? 'Sessions cannot be read', to: href('setup') });
  for (const n of snap.needs.filter((x) => !x.answer)) {
    const focus = n.session ? { label: 'Open in herdr', run: () => void act(() => api('POST', `/api/sessions/${encodeURIComponent(n.session!)}/focus`), 'Opened in herdr') } : undefined;
    out.push({ key: 'need' + n.id, tone: n.kind === 'Decision' ? 'amber' : 'red', what: `${n.session ?? 'A session'} needs you`, detail: n.title + ' · ' + ago(n.createdAt), to: href('needs'), action: n.auto ? focus : undefined });
  }
  for (const h of snap.health.filter((x) => !['healthy', 'waiting'].includes(x.verdict)))
    out.push({ key: 'h' + h.session, tone: ['lost', 'looping', 'burning'].includes(h.verdict) ? 'red' : 'amber', what: `${h.session} is ${h.verdict}`, detail: h.suggest || h.title, to: href('session', h.session) });
  for (const s of snap.sessions.filter((x) => x.contextPct >= th.replace && !snap.health.some((h) => h.session === x.name && h.verdict === 'heavy')))
    out.push({ key: 'ctx' + s.name, tone: 'red', what: `${s.name} is at ${Math.round(s.contextPct)}% context`, detail: 'Time to hand off and replace it', to: href('session', s.name) });
  for (const o of snap.overlaps) out.push({ key: 'o' + o.id, tone: o.severity, what: o.title, detail: `${o.a.session} and ${o.b.session} · ${o.fix}`, to: href('overlap') });
  const due = snap.promises.filter((p) => p.state === 'due');
  if (due.length) out.push({ key: 'due', tone: 'amber', what: `${due.length} promise${due.length === 1 ? '' : 's'} due`, detail: due.slice(0, 2).map((p) => `${p.to}: ${p.said}`).join(' · '), to: href('promises') });
  const silent = !st.paused && (!st.lastBeginAt || Date.now() - Date.parse(st.lastBeginAt) > 10 * 60e3);
  if (silent) out.push({ key: 'intake', tone: 'amber', what: 'Intake has not checked in for 10+ min', detail: 'New Slack and Gmail asks are not being filed', to: href('intake'),
    action: snap.sessions.some((x) => /intake/i.test(x.name)) ? { label: 'Check now', run: () => void act(() => api('POST', '/api/intake/run'), 'Intake is checking now') } : undefined });
  for (const m of (snap.monitors ?? []).filter((x) => x.state === 'alerting'))
    out.push({ key: 'mon' + m.id, tone: 'red', what: `Monitor: ${m.title} ${m.lastVerdict === 'error' ? 'could not be checked twice in a row' : 'looks bad'}`, detail: (m.lastSummary ?? '') + ' · ' + ago(m.lastCheckAt), to: href('monitors') });
  const watched = (snap.monitors ?? []).filter((x) => x.state === 'active' || x.state === 'alerting');
  if (watched.length && snap.herdrOk && !resolveLead(snap.sessions, MONITOR_SESSION))
    out.push({ key: 'mon-session', tone: 'amber', what: 'No monitor session running', detail: `${watched.length} monitor${watched.length === 1 ? '' : 's'} not being checked`, to: href('monitors') });
  out.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'red' ? -1 : 1));
  const [idx, setIdx] = useState(0);
  const [hold, setHold] = useState(false);
  const n = out.length;
  // Auto-advance every 6 s; hovering or focusing the strip holds it.
  useEffect(() => {
    if (n < 2 || hold) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % n), 6000);
    return () => clearInterval(t);
  }, [n, hold]);
  if (!n) return (
    <div className="rise row" aria-label="Needs attention" style={{ gap: 10, padding: '12px 18px', border: '1px solid var(--line)', borderRadius: 999, alignSelf: 'flex-start' }}>
      <Dot color={C.green} /><span style={{ fontSize: 13 }} className="dim">All clear: nothing needs you, no health issues, no overlaps.</span>
    </div>
  );
  const i = idx % n;
  const a = out[i];
  const reds = out.filter((x) => x.tone === 'red').length;
  const go = (d: number) => setIdx((x) => (x % n + d + n) % n);
  return (
    <section className={`shell rise alert-${a.tone}`} aria-label="Needs attention" aria-roledescription="carousel"
      onMouseEnter={() => setHold(true)} onMouseLeave={() => setHold(false)} onFocus={() => setHold(true)} onBlur={() => setHold(false)}>
      <div className="core row" style={{ gap: 14, padding: '12px 14px 12px 20px', flexWrap: 'wrap' }}>
        <span className="row" style={{ gap: 8, flex: 'none' }}>
          <Dot color={reds ? C.red : C.amber} blink />
          <span className="label">{n} need{n === 1 ? 's' : ''} attention</span>
        </span>
        <a key={a.key} href={a.to} className="col alert-slide" style={{ gap: 2, flex: '1 1 260px', minWidth: 0 }} aria-live="polite">
          <span className="row" style={{ gap: 8, fontSize: 14, minWidth: 0 }}><Dot color={a.tone === 'red' ? C.red : C.amber} /><span className="ellipsis">{a.what}</span></span>
          <span className="faint ellipsis" style={{ fontSize: 12, paddingLeft: 16 }}>{a.detail}</span>
        </a>
        <span className="row" style={{ gap: 8, flex: 'none', marginLeft: 'auto' }}>
          {a.action && <button type="button" className="pill sm w" onClick={a.action.run}>{a.action.label}</button>}
          <a className="pill sm" href={a.to}>Open<Arrow /></a>
          {n > 1 && <>
            <span className="row hide-sm" style={{ gap: 4, margin: '0 4px' }} aria-hidden="true">
              {out.slice(0, 12).map((x, k) => <span key={x.key} style={{ width: k === i ? 14 : 5, height: 5, borderRadius: 999, background: k === i ? C.fg : x.tone === 'red' ? 'rgba(255,90,79,.5)' : C.ghost, transition: 'width .5s var(--ease)' }} />)}
            </span>
            <span className="mono faint" style={{ fontSize: 11 }}>{i + 1}/{n}</span>
            <button type="button" className="pill sm" style={{ width: 32, padding: 0, justifyContent: 'center' }} aria-label="Previous alert" onClick={() => go(-1)}>‹</button>
            <button type="button" className="pill sm" style={{ width: 32, padding: 0, justifyContent: 'center' }} aria-label="Next alert" onClick={() => go(1)}>›</button>
          </>}
        </span>
      </div>
    </section>
  );
}

const MODEL_OPTIONS = [{ value: '', label: 'Claude Code default' }, { value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' }, { value: 'haiku', label: 'Haiku' }];
type Row = { name: string; cwd: string; model: string; prompt: string };

/** Quick action, several at once: rows of name, folder, model and first prompt; a prefix and count fills them in. */
function NewSessions({ onDone }: { onDone: () => void }) {
  const snap = useSnap()!;
  const folders = [...new Set(snap.sessions.map((s) => s.cwd).filter(Boolean))];
  const [fill, setFill] = useState({ prefix: '', count: '3', cwd: folders[0] ?? '', model: '' });
  const [rows, setRows] = useState<Row[]>([]);
  const make = () => {
    const n = Math.max(1, Math.min(20, Math.floor(Number(fill.count) || 0)));
    setRows(Array.from({ length: n }, (_, i) => ({ name: `${fill.prefix.trim()}-${i + 1}`, cwd: fill.cwd, model: fill.model, prompt: rows[i]?.prompt ?? '' })));
  };
  const set = (i: number, patch: Partial<Row>) => setRows(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const ready = rows.length > 0 && rows.every((r) => r.name.trim() && r.cwd.trim());
  const submit = () => act(async () => {
    await api('POST', '/api/sessions/spawn-many', { sessions: rows.map((r) => ({ name: r.name.trim(), cwd: r.cwd.trim(), model: r.model || null, prompt: r.prompt || null })) });
    onDone();
  }, `Starting ${rows.length} sessions one after another · watch the event stream`);
  return (
    <form className="col" style={{ gap: 18 }} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="grid12" style={{ alignItems: 'end' }}>
        <div className="col" style={{ gap: 8, gridColumn: 'span 3' }}><label htmlFor="nm-prefix" className="label">Name prefix</label>
          <input id="nm-prefix" className="field mono" value={fill.prefix} onChange={(e) => setFill({ ...fill, prefix: e.target.value })} placeholder="billing" /></div>
        <div className="col" style={{ gap: 8, gridColumn: 'span 1' }}><label htmlFor="nm-count" className="label">How many</label>
          <input id="nm-count" className="field mono" type="number" min={1} max={20} value={fill.count} onChange={(e) => setFill({ ...fill, count: e.target.value })} /></div>
        <div className="col" style={{ gap: 8, gridColumn: 'span 4' }}><label htmlFor="nm-cwd" className="label">Folder for all</label>
          <Pick id="nm-cwd" free value={fill.cwd} onChange={(v) => setFill({ ...fill, cwd: v })} placeholder="C:/path/to/repo" options={folders.map((d) => ({ value: d }))} /></div>
        <div className="col" style={{ gap: 8, gridColumn: 'span 2' }}><label htmlFor="nm-model" className="label">Model for all</label>
          <Pick id="nm-model" value={fill.model} onChange={(v) => setFill({ ...fill, model: v })} options={MODEL_OPTIONS} /></div>
        <div className="row" style={{ gridColumn: 'span 2', justifyContent: 'flex-end' }}>
          <button type="button" className="pill sm" disabled={!fill.prefix.trim() || !fill.cwd.trim()} onClick={make}>{rows.length ? 'Remake rows' : 'Make rows'}</button>
        </div>
      </div>
      {rows.map((r, i) => (
        <div key={i} className="grid12 well" style={{ alignItems: 'end', padding: 14 }} aria-label={`Session ${i + 1}`} role="group">
          <div className="col" style={{ gap: 6, gridColumn: 'span 3' }}><label htmlFor={`nm-name-${i}`} className="label">Name</label>
            <input id={`nm-name-${i}`} className="field mono" required pattern="[A-Za-z0-9][A-Za-z0-9_\-]{1,39}" value={r.name} onChange={(e) => set(i, { name: e.target.value })} /></div>
          <div className="col" style={{ gap: 6, gridColumn: 'span 4' }}><label htmlFor={`nm-cwd-${i}`} className="label">Folder</label>
            <Pick id={`nm-cwd-${i}`} free value={r.cwd} onChange={(v) => set(i, { cwd: v })} options={folders.map((d) => ({ value: d }))} /></div>
          <div className="col" style={{ gap: 6, gridColumn: 'span 2' }}><label htmlFor={`nm-model-${i}`} className="label">Model</label>
            <Pick id={`nm-model-${i}`} value={r.model} onChange={(v) => set(i, { model: v })} options={MODEL_OPTIONS} /></div>
          <div className="row" style={{ gridColumn: 'span 3', justifyContent: 'flex-end' }}>
            <button type="button" className="pill sm" aria-label={`Remove ${r.name || 'row ' + (i + 1)}`} onClick={() => setRows(rows.filter((_, k) => k !== i))}>Remove</button>
          </div>
          <div className="col" style={{ gap: 6, gridColumn: 'span 12' }}><label htmlFor={`nm-prompt-${i}`} className="label">First prompt (optional)</label>
            <textarea id={`nm-prompt-${i}`} className="field" rows={2} value={r.prompt} onChange={(e) => set(i, { prompt: e.target.value })} placeholder="What should it start on?" /></div>
        </div>
      ))}
      {!rows.length && <span className="faint" style={{ fontSize: 13 }}>Give a prefix and a count to make rows (billing-1, billing-2 …), then set each one's first prompt. Up to 20.</span>}
      <div className="row" style={{ gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        {rows.length > 0 && rows.length < 20 && <button type="button" className="pill sm" onClick={() => setRows([...rows, { name: '', cwd: fill.cwd, model: fill.model, prompt: '' }])}>+ Add row</button>}
        <button type="button" className="pill sm" onClick={onDone}>Cancel</button>
        <button type="submit" className="pill w" disabled={!ready}>Start {rows.length || ''} session{rows.length === 1 ? '' : 's'}<Arrow dark /></button>
      </div>
      <span className="faint" style={{ fontSize: 12 }}>They start one after another. A folder Claude has not opened before asks "trust this folder?" in herdr; only you answer that.</span>
    </form>
  );
}

/** Quick action: start a Claude Code session in a new herdr tab, with an optional first prompt. Or several. */
function NewSession({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'One' | 'Several'>('One');
  return (
    <section className="shell rise" aria-label="New session">
      <div className="core col" style={{ gap: 18 }}>
        <div className="row"><Seg label="How many sessions" value={mode} options={['One', 'Several'] as const} onChange={setMode} /></div>
        {mode === 'One' ? <NewOne onDone={onDone} /> : <NewSessions onDone={onDone} />}
      </div>
    </section>
  );
}

function NewOne({ onDone }: { onDone: () => void }) {
  const snap = useSnap()!;
  const folders = [...new Set(snap.sessions.map((s) => s.cwd).filter(Boolean))];
  const [f, setF] = useState({ name: '', cwd: folders[0] ?? '', model: '', prompt: '' });
  const submit = () => act(async () => { await api('POST', '/api/sessions/spawn', { ...f, model: f.model || null, prompt: f.prompt || null }); onDone(); }, `Starting ${f.name} · it shows up here in a few seconds`);
  return (
    <>
      <form className="grid12" style={{ alignItems: 'end' }} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="col" style={{ gap: 8, gridColumn: 'span 3' }}><label htmlFor="ns-name" className="label">Name</label>
          <input id="ns-name" className="field mono" required pattern="[A-Za-z0-9][A-Za-z0-9_\-]{1,39}" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="billing-fix" /></div>
        <div className="col" style={{ gap: 8, gridColumn: 'span 6' }}><label htmlFor="ns-cwd" className="label">Folder</label>
          <Pick id="ns-cwd" free value={f.cwd} onChange={(v) => setF({ ...f, cwd: v })} placeholder="C:/path/to/repo" options={folders.map((d) => ({ value: d }))} /></div>
        <div className="col" style={{ gap: 8, gridColumn: 'span 3' }}><label htmlFor="ns-model" className="label">Model</label>
          <Pick id="ns-model" value={f.model} onChange={(v) => setF({ ...f, model: v })} options={MODEL_OPTIONS} /></div>
        <div className="col" style={{ gap: 8, gridColumn: 'span 9' }}><label htmlFor="ns-prompt" className="label">First prompt (optional)</label>
          <textarea id="ns-prompt" className="field" rows={2} value={f.prompt} onChange={(e) => setF({ ...f, prompt: e.target.value })} placeholder="What should it start on?" /></div>
        <div className="row" style={{ gridColumn: 'span 3', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="pill sm" onClick={onDone}>Cancel</button>
          <button type="submit" className="pill w" disabled={!f.name.trim() || !f.cwd.trim()}>Start<Arrow dark /></button>
        </div>
      </form>
    </>
  );
}

// ---------- replacing sessions ----------
const REPL_STEPS = ['Handoff asked', 'Handoff ready', 'Replacement started', 'State moved'] as const;
/** How many of the four steps are done. */
const stepsDone = (st: Replacement['state']) => ({ pending: 0, requested: 1, stalled: 1, ready: 2, starting: 2, started: 3, moved: 4, done: 4, failed: -1, cancelled: -1 })[st];
const cancellable = (st: Replacement['state']) => ['pending', 'requested', 'stalled', 'ready', 'failed'].includes(st);
export const activeRepl = (st: Replacement['state']) => !['done', 'failed', 'cancelled'].includes(st);

function replNote(r: Replacement): { text: string; tone: string } {
  switch (r.state) {
    case 'pending': return { text: r.error ?? 'About to ask for the handoff.', tone: C.amber };
    case 'requested': return { text: r.missing.length ? 'Handoff still missing: ' + r.missing.join(', ') : `Waiting for ${r.oldName} to write its handoff.`, tone: C.dim };
    case 'stalled': return { text: `No complete handoff after 20 min${r.missing.length ? ' (missing: ' + r.missing.join(', ') + ')' : ''}. Open ${r.oldName} and check on it, or cancel.`, tone: C.red };
    case 'ready': case 'starting': return { text: `Starting ${r.newName}…`, tone: C.dim };
    case 'started': return { text: r.error ?? `${r.newName} is up; moving tasks…`, tone: r.error ? C.amber : C.dim };
    case 'moved': return { text: r.error ?? `Tasks moved. Waiting for ${r.newName} to be ready for its first prompt.`, tone: C.amber };
    case 'done': return { text: `${r.newName} took over. ${r.oldName} can be closed when you are ready; ShiftBoss leaves that to you.`, tone: C.green };
    case 'failed': return { text: r.error ?? 'Failed.', tone: C.red };
    case 'cancelled': return { text: 'Cancelled.', tone: C.faint };
  }
}

/** One replacement's progress: the four steps, what it waits on, and cancel while that is still possible. */
function ReplacementProgress({ r, compact }: { r: Replacement; compact?: boolean }) {
  const done = stepsDone(r.state);
  const note = replNote(r);
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <a className="mono" href={href('session', r.oldName)}>{r.oldName}</a><span className="faint">→</span>
        {r.state === 'done' || r.state === 'moved' || r.state === 'started' ? <a className="mono" href={href('session', r.newName)}>{r.newName}</a> : <span className="mono dim">{r.newName}</span>}
        <span className="mono faint" style={{ fontSize: 11, marginLeft: 'auto' }}>{r.state} · {ago(r.updatedAt)}</span>
      </div>
      <ol className="row" style={{ gap: 8, flexWrap: 'wrap', listStyle: 'none', margin: 0, padding: 0 }} aria-label="Replacement steps">
        {REPL_STEPS.map((label, i) => {
          const ok = done > i;
          const now = done === i && r.state !== 'failed' && r.state !== 'cancelled';
          const color = ok ? C.green : now ? (r.state === 'stalled' ? C.red : C.amber) : C.faint;
          return (
            <li key={label} className="row" style={{ gap: 6, fontSize: 12, padding: '4px 10px', borderRadius: 999, border: '1px solid ' + (ok || now ? color : 'var(--line)'), color }}>
              <Dot color={color} blink={now && r.state !== 'stalled'} /><span>{label}</span><span className="sr-only">{ok ? ' (done)' : now ? ' (in progress)' : ''}</span>
            </li>
          );
        })}
      </ol>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, color: note.tone, flex: '1 1 240px', overflowWrap: 'anywhere' }}>{note.text}</span>
        {cancellable(r.state) && <button type="button" className="pill sm" onClick={() => act(() => api('POST', `/api/replacements/${r.id}/cancel`), r.state === 'failed' ? 'Dismissed' : 'Cancelled')}>{r.state === 'failed' ? 'Dismiss' : 'Cancel'}</button>}
      </div>
      {!compact && <span className="mono faint" style={{ fontSize: 11, wordBreak: 'break-all' }}>handoff · {r.handoffPath}</span>}
    </div>
  );
}

/** Quick action: pick sessions to replace; those over the replace threshold come ticked. */
function ReplaceMany({ onDone }: { onDone: () => void }) {
  const snap = useSnap()!;
  const th = snap.settings.thresholds;
  const busy = new Set(snap.replacements.filter((r) => activeRepl(r.state)).map((r) => r.oldName));
  const list = [...snap.sessions].sort((a, b) => b.contextPct - a.contextPct);
  const [picked, setPicked] = useState<Record<string, boolean>>(() => Object.fromEntries(list.filter((s) => s.contextPct >= th.replace && !busy.has(s.name)).map((s) => [s.name, true])));
  const names = list.filter((s) => picked[s.name] && !busy.has(s.name)).map((s) => s.name);
  const submit = () => act(async () => {
    const r = await api<{ results: { name: string; error?: string }[] }>('POST', '/api/sessions/replace', { sessions: names });
    const bad = r.results.filter((x) => x.error);
    if (bad.length) throw new Error(`Started ${r.results.length - bad.length}; could not start ${bad.map((x) => `${x.name} (${x.error})`).join(', ')}`);
    onDone();
  }, `Asked ${names.length} session${names.length === 1 ? '' : 's'} for a handoff`);
  return (
    <section className="shell rise" aria-label="Replace sessions">
      <form className="core col" style={{ gap: 14 }} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <span className="label">Replace sessions</span>
        <span className="dim" style={{ fontSize: 13, lineHeight: 1.5 }}>Each one writes a handoff, then a fresh session (name-v2, -v3 …) starts in the same folder, reads it and takes over its tasks. The old sessions stay open for you to close. Ticked: over {th.replace}% context.</span>
        <fieldset className="col" style={{ gap: 4, border: 'none', margin: 0, padding: 0, minWidth: 0 }}>
          <legend className="sr-only">Sessions</legend>
          {list.map((s) => (
            <label key={s.name} className="row trow" style={{ gap: 12, padding: '8px 10px', cursor: busy.has(s.name) ? 'default' : 'pointer' }}>
              <input type="checkbox" checked={!!picked[s.name] && !busy.has(s.name)} disabled={busy.has(s.name)} onChange={(e) => setPicked({ ...picked, [s.name]: e.target.checked })} />
              <span className="mono ellipsis" style={{ flex: '1 1 auto', minWidth: 0, fontSize: 13 }}>{s.name}</span>
              <span className="mono faint" style={{ fontSize: 11 }}>{busy.has(s.name) ? 'being replaced' : s.status}</span>
              <span className="mono" style={{ width: 44, textAlign: 'right', fontSize: 13, color: ctxColor(s.contextPct, th.warn, th.replace) }}>{Math.round(s.contextPct)}%</span>
            </label>
          ))}
          {!list.length && <Empty text="No sessions running." />}
        </fieldset>
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button type="button" className="pill sm" onClick={onDone}>Cancel</button>
          <button type="submit" className="pill w" disabled={!names.length}>Replace {names.length || ''}<Arrow dark /></button>
        </div>
      </form>
    </section>
  );
}

export function CommandCenter() {
  const snap = useSnap()!;
  const [filter, setFilter] = useState<'All' | 'Working' | 'Needs you' | 'Near limit' | 'Idle'>('All');
  const th = snap.settings.thresholds;
  const blocked = snap.sessions.filter((s) => s.status === 'blocked');
  const near = snap.sessions.filter((s) => s.contextPct >= th.replace);
  // The lead session is always the big card; without one, whoever needs you, then the fullest context.
  const [spawning, setSpawning] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const lead = resolveLead(snap.sessions, snap.settings.leadSession ?? '');
  const hero = lead ?? blocked[0] ?? [...snap.sessions].sort((a, b) => b.contextPct - a.contextPct)[0];
  const need = hero ? snap.needs.find((n) => !n.answer && n.session === hero.name) : null;
  const match = { All: () => true, Working: (s: Session) => s.status === 'working', 'Needs you': (s: Session) => s.status === 'blocked', 'Near limit': (s: Session) => s.contextPct >= 80, Idle: (s: Session) => s.status === 'idle' || s.status === 'done' };
  const tiles = snap.sessions.filter((s) => s !== hero).filter(match[filter]);
  const L = snap.limits;
  return (
    <div className="page">
      <section className="rise row" style={{ flexWrap: 'wrap', alignItems: 'stretch', justifyContent: 'space-between', gap: 32 }}>
        <div className="col" style={{ gap: 22, maxWidth: 900 }}>
          <span className="eyebrow"><Dot color={C.green} blink />Fleet · live · {snap.feed.length} recent events</span>
          <h1 className="hero">{snap.sessions.length} sessions running.<br /><span className="faint">{blocked.length} need{blocked.length === 1 ? 's' : ''} you, {near.length} near the limit.</span></h1>
        </div>
        <div className="col" style={{ justifyContent: 'space-between', alignItems: 'flex-end', gap: 24 }}>
          <div className="row tour-quick" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <a className="pill sm" href={href('tasks', 'new')}>+ New task</a>
            <button type="button" className={'pill sm' + (near.length ? ' r' : '')} aria-expanded={replacing} onClick={() => { setReplacing(!replacing); setSpawning(false); }}>Replace…</button>
            <button type="button" className="pill sm w" aria-expanded={spawning} onClick={() => { setSpawning(!spawning); setReplacing(false); }}>+ New session</button>
          </div>
          <Seg label="Filter" value={filter} options={['All', 'Working', 'Needs you', 'Near limit', 'Idle'] as const} onChange={setFilter} />
        </div>
      </section>
      {spawning && <NewSession onDone={() => setSpawning(false)} />}
      {replacing && <ReplaceMany onDone={() => setReplacing(false)} />}
      <Alerts />
      {snap.replacements.length > 0 && (
        <section className="shell rise" aria-label="Replacements">
          <div className="core col" style={{ gap: 18, padding: 22 }}>
            <span className="label">Replacements · {snap.replacements.filter((r) => activeRepl(r.state)).length} under way</span>
            {snap.replacements.slice(0, 8).map((r) => <ReplacementProgress key={r.id} r={r} compact />)}
          </div>
        </section>
      )}

      <section className="grid12">
        {hero ? (
          <Card span={8} className="stretch tour-lead" tone={hero.status === 'blocked' ? 'amber' : undefined} pad={28}>
            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              <span className="eyebrow" style={{ borderColor: statusColor(hero.status), color: statusColor(hero.status) }}>{hero === lead ? (hero.status === 'blocked' ? 'Lead · needs you' : 'Lead') : hero.status === 'blocked' ? 'Needs you' : 'Fullest context'}</span>
              <span className="mono dim" style={{ fontSize: 12 }}>{hero.name} · {hero.model ?? 'model unknown'}</span>
              <span style={{ flex: 1 }} />
              <a className="pill sm" href={href('session', hero.name)}>Open session<Arrow /></a>
            </div>
            <h2 style={{ fontSize: 30, lineHeight: 1.15 }}>{snap.tasks.find((t) => t.session === hero.name && t.stage >= 2 && t.stage <= 4)?.title ?? lastSay(hero) ?? hero.name}</h2>
            {need && (
              <div className="col" style={{ gap: 12, padding: '16px 18px', borderRadius: 16, border: '1px solid rgba(245,165,36,0.22)', background: 'rgba(245,165,36,0.04)' }}>
                <span className="mono" style={{ fontSize: 13, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{need.code || need.title}</span>
                <div className="row" style={{ gap: 10 }}>
                  <button type="button" className="pill w sm" onClick={() => act(() => api('POST', `/api/sessions/${encodeURIComponent(hero.name)}/focus`), 'Opened in herdr')}>Answer in herdr</button>
                  <span className="faint" style={{ fontSize: 12 }}>waiting {ago(need.createdAt)} · ShiftBoss never approves for you</span>
                </div>
              </div>
            )}
            <Lines s={hero} n={40} height={230} grow />
            <div className="row" style={{ gap: 28, flexWrap: 'wrap' }}>
              {[['Context', Math.round(hero.contextPct) + '%'], ['Tokens today', fmtTok(hero.tokensToday)], ['Last tool', hero.lastTool ?? '—'], ['Active', ago(hero.lastActivity)]].map(([k, v]) => (
                <div key={k} className="col" style={{ gap: 4 }}><span className="label">{k}</span><span className="mono" style={{ fontSize: 15 }}>{v}</span></div>
              ))}
            </div>
          </Card>
        ) : <Card span={8}><Empty text="No Claude sessions found in herdr." /></Card>}

        <div className="col" style={{ gridColumn: 'span 4', gap: 16 }}>
          <Card span={4} delay={80}>
            <div className="row" style={{ justifyContent: 'space-between' }}><span className="eyebrow">Context pressure</span><span className="faint" style={{ fontSize: 12 }}>replace at {th.replace}%</span></div>
            {[...snap.sessions].sort((a, b) => b.contextPct - a.contextPct).slice(0, 5).map((s) => (
              <a key={s.name} href={href('session', s.name)} className="col" style={{ gap: 8 }}>
                <span className="row" style={{ justifyContent: 'space-between' }}><span className="mono ellipsis" style={{ fontSize: 13 }}>{s.name}</span><span className="mono" style={{ fontSize: 13, color: ctxColor(s.contextPct, th.warn, th.replace) }}>{Math.round(s.contextPct)}%</span></span>
                <Bar pct={s.contextPct} color={ctxColor(s.contextPct, th.warn, th.replace)} />
              </a>
            ))}
          </Card>
          <Card span={4} delay={140}>
            <div className="row" style={{ justifyContent: 'space-between' }}><span className="eyebrow">Usage limits</span><span className="faint" style={{ fontSize: 12 }}>{L.estimate ? 'estimate' : 'from Claude Code'}</span></div>
            {[['5-hour window', L.fiveHourPct], ['Weekly', L.weeklyPct]].map(([k, v]) => (
              <div key={k as string} className="col" style={{ gap: 8 }}>
                <span className="row" style={{ justifyContent: 'space-between' }}><span style={{ fontSize: 13 }}>{k}</span><span className="mono" style={{ fontSize: 15, color: ctxColor(v as number) }}>{Math.round(v as number)}%</span></span>
                <Bar pct={v as number} color={ctxColor(v as number)} />
              </div>
            ))}
            <span className="faint" style={{ fontSize: 12 }}>{fmtTok(L.fiveHourTokens)} tokens in the last 5 hours</span>
          </Card>
          <Card span={4} delay={200} className="tour-intake" tone={snap.intakeState.paused ? 'amber' : undefined}>
            <IntakeControl compact />
          </Card>
        </div>

        {tiles.map((s, i) => (
          <article key={s.name} className="shell rise" style={{ gridColumn: 'span 3', animationDelay: 200 + i * 50 + 'ms' }}>
            <div className="core col" style={{ gap: 14, padding: 20 }}>
              <div className="row" style={{ gap: 10 }}><Dot color={statusColor(s.status)} blink={s.status === 'working'} /><span className="mono ellipsis" style={{ fontSize: 13 }}>{s.name}</span><span className="mono faint" style={{ fontSize: 11, marginLeft: 'auto' }}>{s.status}</span></div>
              <span className="ellipsis" style={{ fontSize: 14 }}>{snap.tasks.find((t) => t.session === s.name && t.stage >= 2 && t.stage <= 4)?.title ?? lastSay(s) ?? (s.lane || 'No task from ShiftBoss')}</span>
              <Lines s={s} n={4} height={84} />
              <div className="col" style={{ gap: 6 }}>
                <span className="row mono" style={{ justifyContent: 'space-between', fontSize: 11 }}><span className="faint">context</span><span style={{ color: ctxColor(s.contextPct, th.warn, th.replace) }}>{Math.round(s.contextPct)}%</span></span>
                <Bar pct={s.contextPct} color={ctxColor(s.contextPct, th.warn, th.replace)} />
              </div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="mono faint" style={{ fontSize: 11 }}>{fmtTok(s.tokensToday)} · {ago(s.lastActivity)}</span>
                <a className="pill sm" href={href('session', s.name)}>Open</a>
              </div>
            </div>
          </article>
        ))}

        <Card span={tiles.length % 4 === 0 ? 12 : 3} delay={300}>
          <div className="row" style={{ gap: 8 }}><Dot color={C.green} blink /><span style={{ fontSize: 13 }}>Event stream</span><a className="mono faint" style={{ marginLeft: 'auto', fontSize: 11 }} href={href('intake')}>intake →</a></div>
          <div className="mono col" style={{ fontSize: 11, maxHeight: 260, overflow: 'hidden' }}>
            {snap.feed.slice(0, 12).map((f, i) => (
              <div key={i + f.at} className="row" style={{ gap: 10, padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <span className="faint">{hhmm(f.at)}</span><span style={{ color: f.who === 'you' ? C.amber : C.fg }}>{f.who}</span><span className="dim ellipsis" style={{ flex: 1 }}>{f.text}</span>
              </div>
            ))}
            {!snap.feed.length && <span className="faint">Quiet so far.</span>}
          </div>
        </Card>
      </section>
    </div>
  );
}

export function SessionPage({ name }: { name: string }) {
  const snap = useSnap()!;
  const s = snap.sessions.find((x) => x.name === name);
  const [draft, setDraft] = useState('');
  const [hideAlert, setHideAlert] = useState(false);
  const [screen, setScreen] = useState<string | null>(null);
  const th = snap.settings.thresholds;
  useEffect(() => { setScreen(null); }, [name]);
  // The raw terminal is read from herdr on demand; while it is open, refresh it every 3 s.
  const showingScreen = screen !== null;
  useEffect(() => {
    if (!showingScreen) return;
    const id = setInterval(() => { api('GET', `/api/sessions/${encodeURIComponent(name)}/screen`).then((r) => setScreen(r.text)).catch(() => {}); }, 3000);
    return () => clearInterval(id);
  }, [showingScreen, name]);
  if (!s) return <div className="page"><Hero eyebrow="Session" title={name} sub="Not running in herdr right now." /><a className="pill" href={href('roster')}>Back to roster</a></div>;
  const tasks = snap.tasks.filter((t) => t.session === s.name && t.stage >= 1 && t.stage <= 4);
  const current = tasks.find((t) => t.stage >= 2);
  const c = ctxColor(s.contextPct, th.warn, th.replace);
  const post = (path: string, body: unknown, ok: string) => act(() => api('POST', `/api/sessions/${encodeURIComponent(s.name)}/${path}`, body), ok);
  const send = async () => { const t = draft.trim(); if (!t) return; await post('prompt', { text: t }, 'Sent to ' + s.name); setDraft(''); };
  // The newest replacement this session is part of, as the old one or as the successor.
  const repl = snap.replacements.find((r) => r.oldName === s.name) ?? snap.replacements.find((r) => r.newName === s.name);
  const replacingNow = !!repl && repl.oldName === s.name && activeRepl(repl.state);
  const replace = () => act(async () => {
    const r = await api<{ results: { error?: string }[] }>('POST', '/api/sessions/replace', { sessions: [s.name] });
    if (r.results[0]?.error) throw new Error(r.results[0].error);
  }, `Asked ${s.name} for its handoff · the replacement starts once it is written`);
  return (
    <div className="page" style={{ gap: 40 }}>
      <section className="rise row" style={{ flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 32 }}>
        <div className="col" style={{ gap: 20, minWidth: 0 }}>
          <div className="row" style={{ gap: 10 }}>
            <a className="eyebrow" href={href('roster')}>‹ Sessions</a>
            <span className="eyebrow" style={{ color: statusColor(s.status), borderColor: statusColor(s.status) }}><Dot color={statusColor(s.status)} blink={s.status === 'working'} />{s.status}</span>
          </div>
          <h1 className="hero mono" style={{ letterSpacing: '-0.045em' }}>{s.name}</h1>
          <div className="row mono faint" style={{ gap: 20, fontSize: 12, flexWrap: 'wrap' }}>
            <span>{s.model ?? 'model unknown'}</span><span>herdr {s.paneId}</span><span>{s.cwd}</span>{s.lane && <span>lane · {s.lane}</span>}
          </div>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="pill" onClick={() => post('interrupt', {}, 'Interrupted ' + s.name)}>Interrupt</button>
          <button type="button" className="pill" onClick={() => post('focus', {}, 'Opened in herdr')}>Open in herdr</button>
          <button type="button" className="pill" onClick={() => act(async () => setScreen((await api('GET', `/api/sessions/${encodeURIComponent(s.name)}/screen`)).text), 'Screen loaded')}>Raw screen</button>
          <button type="button" className={'pill tour-replace' + (s.contextPct >= th.replace && !replacingNow ? ' r' : '')} disabled={replacingNow} onClick={replace}>{replacingNow ? 'Replacing…' : 'Replace'}</button>
        </div>
      </section>

      {s.contextPct >= th.replace && !hideAlert && !replacingNow && (
        <section role="alert" className="shell rise alert-red">
          <div className="core row" style={{ gap: 24, padding: '22px 26px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 40, fontWeight: 500, letterSpacing: '-0.04em', color: C.red }}>{Math.round(s.contextPct)}%</span>
            <span style={{ flex: '1 1 480px', lineHeight: 1.55, fontSize: 15 }}>Context is nearly full and the session will start losing track. <span className="dim">Replace asks it to write its handoff, then starts a fresh session that reads it and takes over its tasks. This one stays open for you to close.</span></span>
            <button type="button" className="pill" onClick={() => setHideAlert(true)}>Later</button>
            <button type="button" className="pill w" onClick={replace}>Replace<Arrow dark /></button>
          </div>
        </section>
      )}
      {repl && (
        <section className={'shell rise' + (repl.state === 'stalled' || repl.state === 'failed' ? ' alert-red' : '')} aria-label="Replacement">
          <div className="core col" style={{ gap: 14, padding: '20px 24px' }}>
            <span className="label">{repl.oldName === s.name ? 'Replacing this session' : `Replaces ${repl.oldName}`}</span>
            <ReplacementProgress r={repl} />
          </div>
        </section>
      )}

      <section className="grid12" style={{ alignItems: 'stretch' }}>
        <article className="shell rise" style={{ gridColumn: 'span 8', gridRow: 'span 2' }}>
          <div className="core col" style={{ gap: 16, padding: 22 }}>
            <div className="row" style={{ gap: 10 }}><Dot color={C.green} blink={s.status === 'working'} /><span style={{ fontWeight: 500 }}>{screen ? 'Raw screen · refreshes every 3 s' : 'Live output'}</span>
              <span className="mono faint" style={{ marginLeft: 'auto', fontSize: 12 }}>{screen ? <button type="button" className="pill sm" onClick={() => setScreen(null)}>Back to live</button> : 'from the transcript · ' + s.lines.length + ' lines'}</span></div>
            {screen ? <pre className="term" style={{ height: 460, margin: 0, padding: 18, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{screen}</pre> : <Lines s={s} n={60} height={460} stamps />}
            <form aria-label="Send a prompt" className="row" style={{ gap: 10, padding: 6, borderRadius: 999, border: '1px solid rgba(255,255,255,0.08)', background: '#070707' }} onSubmit={(e) => { e.preventDefault(); void send(); }}>
              <label htmlFor="prompt" className="faint" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden' }}>Prompt</label>
              <input id="prompt" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`Message ${s.name} · arrives in its herdr pane as your next prompt`}
                style={{ flex: 1, height: 40, padding: '0 16px', border: 'none', background: 'transparent', fontSize: 14, outline: 'none' }} />
              <button type="submit" className="pill w" disabled={!draft.trim()}>Send<Arrow dark /></button>
            </form>
          </div>
        </article>
        <Card span={4}>
          <div className="row" style={{ justifyContent: 'space-between' }}><span className="label">Context window</span><span className="mono faint" style={{ fontSize: 12 }}>{fmtTok(s.contextTokens)} / {fmtTok(s.contextWindow)}</span></div>
          <span style={{ fontSize: 56, fontWeight: 500, letterSpacing: '-0.045em', lineHeight: 1, color: c }}>{Math.round(s.contextPct)}%</span>
          <Bar pct={s.contextPct} color={c} />
          <span className="faint" style={{ fontSize: 12 }}>{fmtTok(s.tokensToday)} tokens today · {fmtTok(s.tokens5h)} in 5 h</span>
        </Card>
        <Card span={4} delay={60}>
          <span className="label">Working on</span>
          {current ? <a href={href('task', current.id)} style={{ fontSize: 18, fontWeight: 500, lineHeight: 1.35 }}>{current.id} · {current.title}</a> : <span className="dim">Nothing from ShiftBoss right now.</span>}
          {tasks.filter((t) => t !== current).slice(0, 3).map((t) => <a key={t.id} href={href('task', t.id)} className="row dim ellipsis" style={{ gap: 12, fontSize: 13 }}><span className="mono faint">{t.id}</span>{t.title}</a>)}
        </Card>
      </section>
      <section className="grid12">
        <Card span={6}>
          <div className="row" style={{ justifyContent: 'space-between' }}><span className="label">Handoff</span>
            <span className="mono" style={{ fontSize: 12, color: s.handoffAgeMin == null ? C.amber : s.handoffAgeMin > th.staleMin ? C.amber : C.green }}>{s.handoffAgeMin == null ? 'no file found' : 'updated ' + s.handoffAgeMin + ' min ago'}</span></div>
          <span className="mono" style={{ fontSize: 13, wordBreak: 'break-all' }}>{s.handoffPath ?? 'Set a handoffs folder in Settings'}</span>
        </Card>
        <Card span={6} delay={60}>
          <span className="label">Pull requests seen</span>
          {s.prUrls.length ? s.prUrls.slice(-5).map((u) => <a key={u} href={safeHref(u)} target="_blank" rel="noreferrer" className="mono dim ellipsis" style={{ fontSize: 13 }}>{u.replace('https://github.com/', '')} ↗</a>) : <Empty text="None in this transcript." />}
        </Card>
      </section>
    </div>
  );
}

export function Roster() {
  const snap = useSnap()!;
  const [sort, setSort] = useState<'Context' | 'Name' | 'Status'>('Context');
  const th = snap.settings.thresholds;
  const rows = [...snap.sessions].sort(sort === 'Context' ? (a, b) => b.contextPct - a.contextPct : sort === 'Name' ? (a, b) => a.name.localeCompare(b.name) : (a, b) => a.status.localeCompare(b.status));
  const grid = { display: 'grid', gridTemplateColumns: 'minmax(0,1.3fr) minmax(0,1.4fr) minmax(0,1.5fr) 130px 90px 110px 80px', gap: 16, alignItems: 'center' } as const;
  return (
    <div className="page">
      <Hero eyebrow="Roster" title="Every session." sub={`${snap.sessions.length} in herdr right now.`}>
        <Seg label="Sort" value={sort} options={['Context', 'Name', 'Status'] as const} onChange={setSort} />
        <a className="pill" href={href('health')}>Health</a><a className="pill" href={href('overlap')}>Overlaps</a>
      </Hero>
      <section className="shell rise"><div className="core" style={{ padding: 12, overflowX: 'auto' }}>
        <div className="label" style={{ ...grid, padding: '14px 16px 10px', minWidth: 980 }}><span>Session</span><span>Lane</span><span>Working on</span><span>Context</span><span>Tokens today</span><span>Handoff</span><span style={{ textAlign: 'right' }}>Active</span></div>
        {rows.map((s) => (
          <a key={s.name} href={href('session', s.name)} className="trow" style={{ ...grid, minWidth: 980 }}>
            <span className="row" style={{ gap: 10, minWidth: 0 }}><Dot color={statusColor(s.status)} blink={s.status === 'working'} /><span className="col" style={{ gap: 3, minWidth: 0 }}><span className="mono ellipsis">{s.name}</span><span className="mono faint" style={{ fontSize: 11 }}>{(s.model ?? '?') + ' · ' + s.status}</span></span></span>
            <span className="dim ellipsis" style={{ fontSize: 13 }}>{s.lane || '—'}</span>
            <span className="ellipsis" style={{ fontSize: 13 }}>{snap.tasks.find((t) => t.session === s.name && t.stage >= 2 && t.stage <= 4)?.title ?? '—'}</span>
            <span className="col" style={{ gap: 6 }}><span className="mono" style={{ fontSize: 13, color: ctxColor(s.contextPct, th.warn, th.replace) }}>{Math.round(s.contextPct)}%</span><Bar pct={s.contextPct} color={ctxColor(s.contextPct, th.warn, th.replace)} /></span>
            <span className="mono dim" style={{ fontSize: 13 }}>{fmtTok(s.tokensToday)}</span>
            <span className="mono" style={{ fontSize: 12, color: s.handoffAgeMin == null || s.handoffAgeMin > th.staleMin ? C.amber : C.dim }}>{s.handoffAgeMin == null ? 'none' : s.handoffAgeMin + 'm ago'}</span>
            <span className="mono faint" style={{ fontSize: 12, textAlign: 'right' }}>{ago(s.lastActivity)}</span>
          </a>
        ))}
        {!rows.length && <Empty text="No sessions found. Is herdr running?" />}
      </div></section>
    </div>
  );
}

export function Health() {
  const snap = useSnap()!;
  const [filter, setFilter] = useState<'Needs action' | 'Watch' | 'All'>('Needs action');
  const act2 = (v: string) => ['looping', 'stuck', 'lost'].includes(v);
  const watch = (v: string) => ['heavy', 'waiting', 'burning'].includes(v);
  const cards = snap.health.filter((h) => filter === 'All' ? h.verdict !== 'healthy' || true : filter === 'Needs action' ? act2(h.verdict) : watch(h.verdict));
  const VC: Record<string, string> = { looping: C.red, stuck: C.red, lost: C.red, heavy: C.amber, waiting: C.amber, burning: C.amber, healthy: C.green };
  const nAct = snap.health.filter((h) => act2(h.verdict)).length;
  const shade = (v: number) => (v < 0 ? C.amber : v === 0 ? 'rgba(255,255,255,0.06)' : v < 3 ? 'rgba(255,255,255,0.25)' : v < 8 ? 'rgba(255,255,255,0.55)' : C.fg);
  return (
    <div className="page">
      <Hero eyebrow="Session health" live title={nAct ? `${nAct} session${nAct === 1 ? '' : 's'} need${nAct === 1 ? 's' : ''} a nudge.` : 'Every session is moving.'}
        sub={`${snap.health.filter((h) => watch(h.verdict)).length} to watch, ${snap.health.filter((h) => h.verdict === 'healthy').length} healthy.`}>
        <Seg label="Filter" value={filter} options={['Needs action', 'Watch', 'All'] as const} onChange={setFilter} />
      </Hero>
      <Card>
        <div className="row" style={{ justifyContent: 'space-between' }}><span className="label">Transcript activity, last 60 min · one cell per 2 min</span><span className="mono faint" style={{ fontSize: 11 }}>amber = the same command repeating</span></div>
        {snap.sessions.map((s) => {
          const h = snap.health.find((x) => x.session === s.name);
          return (
            <a key={s.name} href={href('session', s.name)} className="row" style={{ gap: 16 }}>
              <span className="mono ellipsis" style={{ width: 'min(200px, 28%)', fontSize: 12, flex: 'none' }}>{s.name}</span>
              <span style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(30, minmax(0,1fr))', gap: 3 }}>{s.heat.map((v, i) => <span key={i} style={{ height: 18, borderRadius: 3, background: shade(v) }} />)}</span>
              <span className="mono" style={{ width: 70, textAlign: 'right', fontSize: 12, color: VC[h?.verdict ?? 'healthy'] }}>{h?.verdict}</span>
            </a>
          );
        })}
      </Card>
      <section className="grid12">
        {cards.map((h, i) => (
          <Card key={h.session} span={6} delay={i * 50} tone={VC[h.verdict] === C.red ? 'red' : undefined} pad={26}>
            <div className="row" style={{ gap: 12 }}><Dot color={VC[h.verdict]} /><a className="mono" style={{ fontSize: 18 }} href={href('session', h.session)}>{h.session}</a><span className="eyebrow" style={{ borderColor: VC[h.verdict], color: VC[h.verdict] }}>{h.verdict}</span></div>
            <h2 style={{ fontSize: 22, lineHeight: 1.3 }}>{h.title}</h2>
            {h.signals.map((sg) => <div key={sg.k} className="row well" style={{ gap: 12, padding: '10px 14px', fontSize: 13 }}><span className="mono" style={{ width: 70, fontSize: 11, color: toneColor(sg.tone) }}>{sg.k}</span><span className="dim" style={{ flex: 1, wordBreak: 'break-word' }}>{sg.v}</span></div>)}
            {h.loop.length > 0 && <pre className="mono" style={{ margin: 0, padding: '12px 14px', borderRadius: 12, border: '1px dashed rgba(245,165,36,0.35)', fontSize: 12, color: C.dim, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{h.loop.join('\n')}</pre>}
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <span className="faint" style={{ fontSize: 12, marginRight: 'auto' }}>Suggested: {h.suggest}</span>
              {h.verdict !== 'healthy' && h.verdict !== 'waiting' && <button type="button" className="pill sm w" onClick={() => act(() => api('POST', `/api/sessions/${encodeURIComponent(h.session)}/prompt`, { text: h.verdict === 'looping' ? 'You have run the same command several times with the same result. Stop, explain what you think is wrong, and try a different approach.' : h.verdict === 'stuck' ? 'ShiftBoss: you have queued work waiting. Pick up the next task now, or say what is blocking you.' : 'ShiftBoss check-in: please give a one-line status.' }), 'Nudge sent')}>Send nudge</button>}
              {h.verdict === 'looping' && <button type="button" className="pill sm" onClick={() => act(() => api('POST', `/api/sessions/${encodeURIComponent(h.session)}/interrupt`, {}), 'Interrupted')}>Interrupt</button>}
              {h.verdict === 'waiting' && <a className="pill sm w" href={href('needs')}>Go to Needs you</a>}
              <a className="pill sm" href={href('session', h.session)}>Open</a>
            </div>
          </Card>
        ))}
        {!cards.length && <Card><Empty text="Nothing here." /></Card>}
      </section>
    </div>
  );
}

export function Overlap() {
  const snap = useSnap()!;
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});
  const list = snap.overlaps.filter((o) => !dismissed[o.id]);
  return (
    <div className="page">
      <Hero eyebrow="Overlap check · before two sessions collide" title={list.length ? `${list.length} overlap${list.length === 1 ? '' : 's'} right now.` : 'No overlaps.'} sub="From the files each session edited in the last 3 hours." />
      <section className="grid12">
        <div className="col" style={{ gridColumn: 'span 7', gap: 14 }}>
          {list.map((o, i) => (
            <Card key={o.id} delay={i * 50} tone={o.severity}>
              <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}><span className="eyebrow" style={{ borderColor: o.severity === 'red' ? C.red : C.amber, color: o.severity === 'red' ? C.red : C.amber }}>{o.kind}</span><span className="mono dim" style={{ fontSize: 12 }}>{o.where}</span></div>
              <h2 style={{ fontSize: 22, lineHeight: 1.3 }}>{o.title}</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 40px minmax(0,1fr)', gap: 10 }}>
                {[o.a, null, o.b].map((x, k) => x ? <a key={k} href={href('session', x.session)} className="col well" style={{ gap: 6, padding: 14 }}><span className="mono">{x.session}</span><span className="faint" style={{ fontSize: 12, wordBreak: 'break-all' }}>{x.what}</span></a> : <span key={k} className="row faint" style={{ justifyContent: 'center' }} aria-hidden="true">⇄</span>)}
              </div>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <span className="dim" style={{ fontSize: 13, marginRight: 'auto' }}>{o.fix}</span>
                <button type="button" className="pill sm w" onClick={() => act(() => api('POST', `/api/sessions/${encodeURIComponent(o.b.session)}/prompt`, { text: `ShiftBoss overlap check: ${o.title} ${o.fix} Coordinate before you push.` }), 'Told ' + o.b.session)}>Tell {o.b.session}</button>
                <button type="button" className="pill sm" onClick={() => setDismissed({ ...dismissed, [o.id]: true })}>Dismiss</button>
              </div>
            </Card>
          ))}
          {!list.length && <Card><Empty text="No two sessions touched the same file, migration number or task." /></Card>}
        </div>
        <Card span={5}>
          <span className="label">Files edited, last 3 hours</span>
          {snap.sessions.filter((s) => s.filesTouched.length).map((s) => (
            <div key={s.name} className="col" style={{ gap: 4 }}>
              <span className="mono" style={{ fontSize: 13 }}>{s.name} <span className="faint">· {s.filesTouched.length}</span></span>
              {s.filesTouched.slice(-4).map((f) => <span key={f} className="mono faint ellipsis" style={{ fontSize: 11 }}>{f}</span>)}
            </div>
          ))}
          {!snap.sessions.some((s) => s.filesTouched.length) && <Empty text="No edits recorded yet." />}
        </Card>
      </section>
    </div>
  );
}
