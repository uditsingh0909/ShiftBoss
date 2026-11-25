// Settings → Slack: set up the optional ShiftBoss bot (create the app from the manifest, paste its token), then
// choose the DM and the channel and which alerts go to each. Everything saves at once.
import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { DEFAULT_SLACK, type NotifySettings, type SlackDest, type SlackSettings } from '../shared/types';
import { GROUPS } from './notify';
import { act, api, C, Pick, toast, useSnap } from './lib';

type SectionProps = { id: string; title: string; text: string; children: ReactNode };
type SwitchProps = { label: string; hint?: string; on: boolean; onChange: (v: boolean) => void };

const save = (patch: Partial<{ [K in keyof SlackSettings]: Partial<SlackSettings[K]> }>, ok = 'Saved') => act(() => api('PUT', '/api/settings', { slack: patch }), ok);

/** Step one: create the app and connect its token. */
function Connect() {
  const [token, setToken] = useState('');
  const [manifest, setManifest] = useState('');
  useEffect(() => { fetch('/api/slack/manifest').then((r) => r.text()).then(setManifest).catch(() => setManifest('')); }, []);
  const copy = () => navigator.clipboard.writeText(manifest).then(() => toast('Manifest copied'), () => toast('Could not copy; select the text below'));
  return (
    <ol className="col" style={{ gap: 16, margin: 0, paddingLeft: 20, gridColumn: '1 / -1', fontSize: 14, lineHeight: 1.6 }}>
      <li>
        Create the app: open <a href="https://api.slack.com/apps?new_app=1" target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>api.slack.com/apps</a> →
        Create New App → <b>From a manifest</b> → pick your workspace → paste this, then Create.
        <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <button type="button" className="pill sm w" onClick={() => void copy()} disabled={!manifest}>Copy manifest</button>
          <details style={{ flex: '1 1 100%' }}><summary className="faint" style={{ fontSize: 12, cursor: 'pointer' }}>Show it</summary>
            <pre className="well mono" style={{ fontSize: 11, padding: 12, overflowX: 'auto', margin: '6px 0 0' }}>{manifest}</pre></details>
        </div>
      </li>
      <li>On the app's page: <b>Install to Workspace</b> and allow. <span className="faint">Some workspaces need an admin to approve new apps; Slack says so and sends them the request.</span></li>
      <li>
        Copy the <b>Bot User OAuth Token</b> (starts with <span className="mono">xoxb-</span>) from <b>OAuth &amp; Permissions</b> and connect it here.
        It stays in ShiftBoss's database on this computer; the pages and Claude sessions never see it.
        <form className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); void act(async () => { await api('POST', '/api/slack/connect', { token }); setToken(''); }, 'Connected to Slack'); }}>
          <label htmlFor="slack-token" className="sr-only">Bot token</label>
          <input id="slack-token" className="field mono" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="xoxb-…" style={{ flex: '1 1 260px', minWidth: 0 }} />
          <button type="submit" className="pill sm w" disabled={!token.trim().startsWith('xoxb-')}>Connect</button>
        </form>
      </li>
    </ol>
  );
}

/** Which alerts go where: one row per kind, a box for the DM and one for the channel. */
function Kinds({ s }: { s: SlackSettings }) {
  const flip = (dest: SlackDest, k: keyof NotifySettings, v: boolean) => void save({ kinds: { [dest]: { [k]: v } } as any });
  return (
    <div className="col" style={{ gridColumn: '1 / -1', gap: 14 }}>
      <div className="row label" style={{ gap: 12 }}><span style={{ flex: 1 }}>Send</span><span style={{ width: 60, textAlign: 'center' }}>DM</span><span style={{ width: 60, textAlign: 'center' }}>Channel</span></div>
      {GROUPS.map((g) => (
        <div key={g.name} className="col" style={{ gap: 8 }}>
          <span className="faint" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.08em' }}>{g.name}</span>
          {g.kinds.map(([k, label, hint]) => (
            <div key={k} className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
              <span className="col" style={{ flex: 1, minWidth: 0, gap: 2 }}><span style={{ fontSize: 13 }}>{label}</span><span className="faint" style={{ fontSize: 12 }}>{hint}</span></span>
              {(['dm', 'channel'] as const).map((d) => (
                <label key={d} style={{ width: 60, display: 'flex', justifyContent: 'center', paddingTop: 2, cursor: 'pointer' }}>
                  <span className="sr-only">{label} to the {d === 'dm' ? 'DM' : 'channel'}</span>
                  <input type="checkbox" checked={!!s.kinds[d][k]} disabled={!s[d].on} onChange={(e) => flip(d, k, e.target.checked)} />
                </label>
              ))}
            </div>
          ))}
        </div>
      ))}
      <span className="faint" style={{ fontSize: 12 }}>Messages carry ShiftBoss's own summary (such as a question's title) and a link back here, never a session's transcript or output. Follow-ups (approved, fixed, fine again) reply in the same thread.</span>
    </div>
  );
}

export function SlackSettingsSection({ Section, Switch }: { Section: ComponentType<SectionProps>; Switch: ComponentType<SwitchProps> }) {
  const snap = useSnap()!;
  const st = snap.slack;
  const s: SlackSettings = { ...DEFAULT_SLACK, ...snap.settings.slack };
  const [email, setEmail] = useState('');
  const [channels, setChannels] = useState<{ id: string; name: string; member: boolean; private: boolean }[] | null>(null);
  useEffect(() => { if (st?.connected && s.channel.on && !channels) api('GET', '/api/slack/channels').then(setChannels).catch((e) => toast((e as Error).message)); }, [st?.connected, s.channel.on]);
  const test = (dest: SlackDest) => act(() => api('POST', '/api/slack/test', { dest }), `Test sent to the ${dest === 'dm' ? 'DM' : 'channel'}`);
  const findMe = () => act(async () => {
    const u = await api<{ id: string; label: string }>('POST', '/api/slack/me', { email: email.trim() });
    await api('PUT', '/api/settings', { slack: { dm: { userId: u.id, label: u.label, on: true } } });
  }, 'Found you in Slack');
  const picked = channels?.find((c) => c.id === s.channel.id);
  return (
    <Section id="slack" title="Slack (optional)" text="Recommended if your team uses Slack: a ShiftBoss bot sends alerts to your DM and, if you like, to a channel, so you hear about them away from this computer. It posts only as itself, only there, and never as you.">
      {!st?.connected ? <Connect /> : (
        <>
          <div className="row well" style={{ gridColumn: '1 / -1', gap: 10, padding: '12px 14px', flexWrap: 'wrap' }}>
            <span style={{ width: 8, height: 8, borderRadius: 999, background: st.error ? C.red : C.green }} aria-hidden="true" />
            <span style={{ flex: '1 1 240px', fontSize: 13 }}>{st.team ? `Connected as ${st.bot ?? 'ShiftBoss'} in ${st.team}` : 'Connected'}{st.sentToday ? ` · ${st.sentToday} sent today` : ''}{st.held ? ` · ${st.held} held for after quiet hours` : ''}</span>
            <button type="button" className="pill sm" onClick={() => void act(() => api('POST', '/api/slack/disconnect'), 'Disconnected')}>Disconnect</button>
            {st.error && <span className="red" style={{ fontSize: 12, flex: '1 1 100%' }}>{st.error}</span>}
          </div>
          <div className="col" style={{ gridColumn: '1 / -1', gap: 12 }}>
            <Switch label="Send to my DM" hint={s.dm.userId ? `To ${s.dm.label ?? s.dm.userId}.` : 'Find yourself by your Slack email first.'} on={s.dm.on} onChange={(v) => void save({ dm: { on: v } })} />
            <form className="row" style={{ gap: 8, flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); void findMe(); }}>
              <label htmlFor="slack-email" className="sr-only">Your Slack email</label>
              <input id="slack-email" className="field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={s.dm.userId ? 'Change: your Slack email' : 'Your Slack email'} style={{ flex: '1 1 240px', minWidth: 0 }} />
              <button type="submit" className="pill sm" disabled={!email.includes('@')}>Find me</button>
              <button type="button" className="pill sm" disabled={!s.dm.on || !s.dm.userId} onClick={() => void test('dm')}>Send a test</button>
            </form>
          </div>
          <div className="col" style={{ gridColumn: '1 / -1', gap: 12 }}>
            <Switch label="Send to a channel" hint="For alerts the team should see, e.g. #shiftboss-alerts. Invite the bot there with /invite @ShiftBoss." on={s.channel.on} onChange={(v) => void save({ channel: { on: v } })} />
            {s.channel.on && (
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <Pick id="slack-channel" width={260} label="Channel" value={s.channel.id ?? ''} placeholder={channels ? 'Pick a channel' : 'Loading channels…'}
                  options={(channels ?? []).map((c) => ({ value: c.id, label: '#' + c.name, hint: (c.private ? 'private · ' : '') + (c.member ? 'bot is in' : 'invite the bot') }))}
                  onChange={(v) => { const c = channels?.find((x) => x.id === v); if (c) void save({ channel: { id: c.id, name: c.name } }, 'Channel set'); }} />
                <button type="button" className="pill sm" disabled={!s.channel.id} onClick={() => void test('channel')}>Send a test</button>
                {picked && !picked.member && <span className="amber" style={{ fontSize: 12 }}>The bot is not in #{picked.name} yet: type /invite @ShiftBoss there.</span>}
              </div>
            )}
          </div>
          {(s.dm.on || s.channel.on) && <Kinds s={s} />}
          {s.dm.on && (
            <div className="col" style={{ gridColumn: '1 / -1', gap: 10 }}>
              <Switch label="Quiet hours for the DM" hint="Held, then one digest when they end. The channel is not held." on={s.quiet.on} onChange={(v) => void save({ quiet: { on: v } })} />
              {s.quiet.on && (
                <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <label htmlFor="quiet-from" className="faint" style={{ fontSize: 12 }}>From</label>
                  <input id="quiet-from" type="time" className="field" style={{ width: 120, padding: '6px 10px' }} value={s.quiet.from} onChange={(e) => void save({ quiet: { from: e.target.value } })} />
                  <label htmlFor="quiet-to" className="faint" style={{ fontSize: 12 }}>to</label>
                  <input id="quiet-to" type="time" className="field" style={{ width: 120, padding: '6px 10px' }} value={s.quiet.to} onChange={(e) => void save({ quiet: { to: e.target.value } })} />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Section>
  );
}
