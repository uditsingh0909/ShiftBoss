import { useEffect, useState } from 'react';
import { resolveLead } from '../../shared/types';
import { act, ago, agoText, api, Arrow, C, Card, Empty, Hero, hhmm, href, navigate, Pick, Seg, toast, useSnap } from '../lib';
import { Cmd, Step, type SetupInfo } from './setup';
import { ModePicker } from '../mode';

const IMPORT_SHAPE = `[
  { "extId": "JIRA-123", "title": "Fix the billing export", "stage": 2,
    "ask": "Exports are missing the tax column", "session": "billing-fix",
    "sourceUrl": "https://…", "prio": "P2" }
]
stage: 0 Inbox · 1 Queued · 2 In progress · 3 PR open · 4 On dev · 5 Live · 6 Told`;

type Outside = { sessionId: string; cwd: string; cwdExists: boolean; title: string | null; firstAsk: string | null; lastAt: string; sizeKB: number; recent: boolean; suggestedName: string };

/** Sessions from plain Claude Code (CLI, TUI, the desktop app) that are not in herdr: reopen them there with their history. */
export function BringIn() {
  const snap = useSnap()!;
  const [days, setDays] = useState<'1' | '3' | '7' | '14'>('3');
  const [rows, setRows] = useState<Outside[] | null>(null);
  const [picked, setPicked] = useState<Record<string, string>>({}); // sessionId -> name
  useEffect(() => { api<Outside[]>('GET', '/api/outside-sessions?days=' + days).then(setRows).catch(() => setRows([])); }, [days, snap.sessions.length]);
  const n = Object.keys(picked).length;
  const toggle = (o: Outside) => setPicked((p) => { const c = { ...p }; if (c[o.sessionId] !== undefined) delete c[o.sessionId]; else c[o.sessionId] = o.suggestedName; return c; });
  const bring = () => act(async () => {
    await api('POST', '/api/sessions/bring-in', { sessions: Object.entries(picked).map(([sessionId, name]) => ({ sessionId, name })) });
    setPicked({});
  }, `Opening ${n} session${n === 1 ? '' : 's'} in herdr · each appears on Sessions when ready`);
  return (
    <>
      <span className="dim" style={{ fontSize: 14 }}>
        Using Claude Code without herdr (the CLI, the TUI or the desktop app)? Every session keeps its history, so it can carry on inside herdr with nothing lost.
        Pick the ones to bring in: each opens in its own herdr tab with <code className="mono">claude --resume</code>. Close the old window first, so two copies don't write the same history.
      </span>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <span className="faint" style={{ fontSize: 12 }}>Active in the last</span>
        <Seg label="Days" value={days} options={['1', '3', '7', '14'] as const} onChange={setDays} />
        <span className="faint" style={{ fontSize: 12 }}>days</span>
      </div>
      <div className="col divide scrollbox" style={{ maxHeight: 420 }}>
        {rows === null && <span className="faint" style={{ padding: '10px 0' }}>Looking for sessions…</span>}
        {rows?.map((o) => {
          const on = picked[o.sessionId] !== undefined;
          return (
            <div key={o.sessionId} className="row" style={{ gap: 12, padding: '10px 0', flexWrap: 'wrap', opacity: o.cwdExists ? 1 : 0.5 }}>
              <input type="checkbox" aria-label={'Bring in ' + o.suggestedName} checked={on} disabled={!o.cwdExists} onChange={() => toggle(o)} style={{ width: 16, height: 16, accentColor: '#F4F4F5' }} />
              <div className="col" style={{ gap: 3, flex: '1 1 260px', minWidth: 0 }}>
                <span className="ellipsis" style={{ fontSize: 14 }}>{o.title ?? o.firstAsk ?? 'Untitled session'}</span>
                <span className="mono faint ellipsis" style={{ fontSize: 11 }}>{o.cwd} · {o.sizeKB > 1024 ? (o.sizeKB / 1024).toFixed(1) + ' MB' : o.sizeKB + ' KB'} · {agoText(o.lastAt)}</span>
                {o.recent && <span style={{ fontSize: 12, color: C.amber }}>Active a moment ago: probably still open somewhere. Exit it there before bringing it in.</span>}
                {!o.cwdExists && <span style={{ fontSize: 12, color: C.faint }}>Its folder no longer exists.</span>}
              </div>
              {on
                ? <input className="field mono" aria-label="Name in herdr" style={{ width: 220, height: 36, fontSize: 12 }} value={picked[o.sessionId]} onChange={(e) => setPicked({ ...picked, [o.sessionId]: e.target.value })} />
                : <span className="mono faint" style={{ fontSize: 12, width: 220, textAlign: 'right' }}>{o.suggestedName}</span>}
            </div>
          );
        })}
        {rows?.length === 0 && <Empty text="No Claude sessions outside herdr in that time. Everything is already here." />}
      </div>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <button type="button" className="pill sm w" disabled={!n} onClick={() => void bring()}>Open {n || ''} in herdr</button>
        <span className="faint" style={{ fontSize: 12 }}>A folder Claude has not opened in herdr before may ask "trust this folder?" in the new tab. Answer it there.</span>
      </div>
    </>
  );
}

/** First run: connect the tools, set the basics, and fill the board from the sessions and messages that already exist. */
export function Welcome() {
  const snap = useSnap()!;
  const ob = snap.onboarding;
  const [info, setInfo] = useState<SetupInfo | null>(null);
  useEffect(() => { api<SetupInfo>('GET', '/api/setup').then(setInfo).catch(() => setInfo(null)); }, [snap.now]);

  // ----- step 2: basics
  const [lead, setLead] = useState(snap.settings.leadSession ?? '');
  const [ws, setWs] = useState(snap.settings.herdrWorkspace ?? '');
  const basicsSaved = lead === (snap.settings.leadSession ?? '') && ws === (snap.settings.herdrWorkspace ?? '');
  const leadRunning = !!resolveLead(snap.sessions, snap.settings.leadSession ?? '');
  const saveBasics = () => act(() => api('PUT', '/api/settings', { ...snap.settings, leadSession: lead.trim(), herdrWorkspace: ws.trim() }), 'Saved');

  // ----- step 3: sessions register their work
  const workers = snap.sessions.filter((s) => !/intake/i.test(s.name));
  const onBoard = (name: string) => snap.tasks.filter((t) => t.session === name).length;
  const [picked, setPicked] = useState<string[] | null>(null);
  const chosen = picked ?? workers.filter((s) => !ob.asked[s.name] && !onBoard(s.name)).map((s) => s.name);
  const toggle = (n: string) => setPicked(chosen.includes(n) ? chosen.filter((x) => x !== n) : [...chosen, n]);
  const ask = () => act(async () => {
    const r = await api<{ asked: number; failed: string[] }>('POST', '/api/onboarding/ask', { sessions: chosen });
    setPicked([]);
    if (r.failed.length) throw new Error(`Asked ${r.asked}; could not reach ${r.failed.join(', ')}`);
  }, `Asked ${chosen.length} session${chosen.length === 1 ? '' : 's'} · their tasks appear on the board as they answer`);
  const askedCount = workers.filter((s) => ob.asked[s.name]).length;

  // ----- step 4: intake backfill
  const intake = snap.sessions.find((s) => /intake/i.test(s.name));
  const [days, setDays] = useState<'1' | '2' | '3' | '7' | '14'>('3');
  const backfill = async () => {
    const n = `${days} day${days === '1' ? '' : 's'}`;
    try {
      const r = await api<{ prompted: boolean; waiting: string | null; intake: string | null }>('POST', '/api/onboarding/backfill', { days: Number(days) });
      toast(r.prompted ? `Intake sent back ${n} · it reads the gap now` : r.waiting ? `Saved. ${r.intake} is ${r.waiting}: answer it there, then it reads back ${n}` : `Saved. The intake reads back ${n} once it runs`);
    } catch (e) { toast((e as Error).message); }
  };

  const finish = () => act(async () => { await api('POST', '/api/onboarding/done', { done: true }); navigate('/'); }, 'Setup done');
  const connected = !!info && info.mcp.registered && info.mcp.pointsHere;

  return (
    <div className="page">
      <Hero eyebrow={ob.doneAt ? `Get started · finished ${hhmm(ob.doneAt)}` : 'Get started'} title="Set up ShiftBoss."
        sub="Then fill the board from work already running." />
      <section className="grid12">
        <Step n={1} title="Connect the tools" state={connected && info?.statusTap.configured ? 'ok' : connected ? 'optional' : 'todo'}>
          <span className="dim" style={{ fontSize: 14 }}>
            {!info ? 'Checking…' : connected
              ? <>The shiftboss tools are registered{info.statusTap.configured ? ', and the status line reports exact usage.' : '. The status line tap is optional: it gives exact usage numbers.'}</>
              : <>Sessions need the shiftboss tools (MCP) to report their tasks. Run this once, then restart the sessions you want to report:</>}
          </span>
          {info && !connected && <Cmd text={info.commands.mcpAdd} />}
          <a className="pill sm" style={{ alignSelf: 'flex-start' }} href={href('setup')}>All connection checks<Arrow /></a>
        </Step>

        <Step n={2} title="How much ShiftBoss may do on its own" state={snap.settings.mode && snap.settings.mode !== 'dry' ? 'ok' : 'optional'}>
          <span className="dim" style={{ fontSize: 14 }}>New installs start in <b>Dry run</b>: ShiftBoss only records what it would do, so you can watch it for a while before letting it act. Switch whenever you are ready; the sidebar has the same switch.</span>
          <ModePicker />
        </Step>

        <Step n={3} title="Your lead session and workspace" state={leadRunning && basicsSaved ? 'ok' : 'todo'}>
          <span className="dim" style={{ fontSize: 14 }}>The lead is the session that coordinates the others; it always gets the big card on Sessions. A replacement named <code className="mono">name-v2</code> takes over automatically.</span>
          <form className="settings-controls" onSubmit={(e) => { e.preventDefault(); void saveBasics(); }}>
            <div className="col" style={{ gap: 6 }}><label htmlFor="wl-lead" style={{ fontSize: 13 }}>Lead session</label>
              <Pick id="wl-lead" free value={lead} onChange={setLead} placeholder="lead"
                options={[...new Set(snap.sessions.map((s) => s.name.replace(/-v\d+$/, '')))].map((n) => ({ value: n }))} />
            </div>
            <label className="col" style={{ gap: 6 }}><span style={{ fontSize: 13 }}>herdr workspace</span>
              <input className="field mono" value={ws} onChange={(e) => setWs(e.target.value)} placeholder="empty = every workspace" />
            </label>
            <div className="row" style={{ gap: 10, gridColumn: '1 / -1' }}>
              <button type="submit" className="pill sm w" disabled={basicsSaved}>Save</button>
              <span className="faint" style={{ fontSize: 12 }}>{lead && !leadRunning ? `No session named ${lead} is running yet.` : leadRunning ? 'Lead found.' : ''}</span>
            </div>
          </form>
        </Step>

        <Step n={4} title="Not on herdr yet? Bring your sessions in" state="optional">
          <BringIn />
        </Step>

        <Step n={5} title="Bring in the work your sessions are already doing" state={askedCount ? 'ok' : workers.length ? 'todo' : 'optional'}>
          <span className="dim" style={{ fontSize: 14 }}>
            Each picked session gets one prompt asking it to put its current tasks, their stage and any promises on the board. It does not change their work. Sessions with tasks on the board already are left unticked.
          </span>
          <div className="col divide">
            {workers.map((s) => {
              const n = onBoard(s.name);
              return (
                <label key={s.name} className="row trow" style={{ gap: 14, cursor: 'pointer', flexWrap: 'wrap' }}>
                  <input type="checkbox" checked={chosen.includes(s.name)} onChange={() => toggle(s.name)} style={{ width: 16, height: 16, accentColor: '#F4F4F5' }} />
                  <span className="mono ellipsis" style={{ flex: '1 1 200px', minWidth: 0 }}>{s.name}</span>
                  <span className="mono" style={{ fontSize: 12, color: s.status === 'blocked' ? C.amber : C.faint }}>{s.status}</span>
                  <span className="mono" style={{ fontSize: 12, minWidth: 90, textAlign: 'right', color: n ? C.green : C.faint }}>{n} task{n === 1 ? '' : 's'}</span>
                  <span className="mono faint" style={{ fontSize: 12, minWidth: 110, textAlign: 'right' }}>{ob.asked[s.name] ? `asked ${agoText(ob.asked[s.name])}` : 'not asked'}</span>
                </label>
              );
            })}
            {!workers.length && <Empty text="No sessions running in herdr yet. Start some, then come back." />}
          </div>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <button type="button" className="pill sm w" disabled={!chosen.length} onClick={() => void ask()}>Ask {chosen.length || ''} session{chosen.length === 1 ? '' : 's'}</button>
            <button type="button" className="pill sm" onClick={() => setPicked(workers.map((s) => s.name))}>Pick all</button>
            <button type="button" className="pill sm" onClick={() => setPicked([])}>Clear</button>
            <span className="faint" style={{ fontSize: 12 }}>A busy session answers after its current step. Blocked ones answer once you unblock them in herdr.</span>
          </div>
        </Step>

        <Step n={6} title="Read back Slack and Gmail" state={ob.backfillFrom ? 'ok' : intake ? 'todo' : 'optional'}>
          <span className="dim" style={{ fontSize: 14 }}>
            {intake
              ? <>Send the intake session back in time: it reads mentions, DMs, threads you are in, watched channels and meeting notes from then until now, and files what is still open.{ob.backfillFrom && <> Last sent back to {new Date(ob.backfillFrom).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.</>}</>
              : <>Start an intake session first (Connect, step 4). It reads Slack and Gmail for you; then come back to send it back in time.</>}
          </span>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <Seg label="How far back" value={days} options={['1', '2', '3', '7', '14'] as const} onChange={setDays} />
            <span className="faint" style={{ fontSize: 12 }}>days</span>
            <button type="button" className="pill sm w" disabled={!intake} onClick={() => void backfill()}>Read back {days} day{days === '1' ? '' : 's'}</button>
          </div>
        </Step>

        <Step n={7} title="Import tasks from elsewhere" state="optional">
          <span className="dim" style={{ fontSize: 14 }}>Tasks from Jira or a spreadsheet can come in as a JSON file. Running it again updates the same tasks (matched by <code className="mono">extId</code>) instead of adding copies.</span>
          {info && <Cmd text={`bun ${info.repoPath}/cli/shiftboss.ts import tasks.json`} />}
          <Cmd text={IMPORT_SHAPE} />
        </Step>

        <Step n={8} title="Get alerts in Slack (recommended if you use Slack)" state={snap.slack?.connected && (snap.settings.slack?.dm.on || snap.settings.slack?.channel.on) ? 'ok' : 'optional'}>
          <span className="dim" style={{ fontSize: 14 }}>
            A ShiftBoss bot can DM you what needs you and what went wrong, and post what the team should see to a channel, so you hear about it away from this computer.
            It takes about three minutes: create a Slack app from our manifest, install it, paste its token. Skip it if your team does not use Slack.
          </span>
          <div className="row" style={{ gap: 8 }}><a className="pill sm w" href={href('settings', 'slack')}>{snap.slack?.connected ? 'Slack settings' : 'Set up the bot'}<Arrow dark /></a></div>
        </Step>

        <Card span={12}>
          <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
            <div className="col" style={{ gap: 4, flex: '1 1 300px' }}>
              <span style={{ fontSize: 16 }}>{snap.tasks.length} task{snap.tasks.length === 1 ? '' : 's'} and {snap.promises.length} promise{snap.promises.length === 1 ? '' : 's'} on the board.</span>
              <span className="faint" style={{ fontSize: 13 }}>Answers keep arriving after you leave this page. This page stays under Get started.</span>
            </div>
            <a className="pill sm" href={href('tasks')}>See the board</a>
            <button type="button" className="pill w" onClick={() => void finish()}>{ob.doneAt ? 'Back to Sessions' : 'Finish setup'}<Arrow dark /></button>
          </div>
        </Card>
      </section>
    </div>
  );
}
