// The ShiftBoss Slack bot (optional). It posts ShiftBoss's own alerts as itself, only to the DM and the channel
// the owner set up, never as the owner and never to anyone else. Outbound HTTPS only, so the server stays local.
// The token lives in the secrets table (or SHIFTBOSS_SLACK_TOKEN), never in settings or the snapshot.
import { notifyItems, type NotifyEvent } from '../shared/notify';
import { DEFAULT_SLACK, type SlackDest, type SlackSettings, type SlackStatus, type Snapshot } from '../shared/types';
import type { Store } from './db';

export const SLACK_TOKEN_KEY = 'slack.botToken';
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export class SlackError extends Error {
  constructor(public code: string) { super(SLACK_HELP[code] ?? 'Slack said: ' + code); }
}
/** Slack's error codes in plain words, with what to do. */
const SLACK_HELP: Record<string, string> = {
  invalid_auth: 'Slack does not accept this token. Copy the Bot User OAuth Token (xoxb-…) again.',
  not_authed: 'No token was sent.',
  token_revoked: 'This token was revoked. Reinstall the app and paste the new token.',
  account_inactive: 'The app was uninstalled from the workspace.',
  not_in_channel: 'The bot is not in that channel. In Slack, type /invite @ShiftBoss in the channel.',
  channel_not_found: 'Slack cannot find that channel (for a private one, invite the bot first).',
  users_not_found: 'No Slack user has that email in this workspace.',
  missing_scope: 'The app lacks a permission. Create it again from the manifest, or add the missing scope and reinstall.',
  ratelimited: 'Slack asked us to slow down; trying again shortly.',
};

/** A thin Slack Web API client: form-encoded POSTs, which every method used here accepts. */
export class SlackApi {
  constructor(private token: string, private f: Fetch = fetch) {}
  async call<T = any>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== null) body.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    const r = await this.f('https://slack.com/api/' + method, { method: 'POST', headers: { authorization: 'Bearer ' + this.token, 'content-type': 'application/x-www-form-urlencoded' }, body });
    const j: any = await r.json().catch(() => ({ ok: false, error: 'http_' + r.status }));
    if (!j.ok) throw new SlackError(j.error ?? 'unknown_error');
    return j as T;
  }
  authTest() { return this.call<{ team: string; user: string; user_id: string; team_id: string }>('auth.test'); }
  lookupByEmail(email: string) { return this.call<{ user: { id: string; real_name?: string; name: string } }>('users.lookupByEmail', { email }); }
  async openDm(user: string): Promise<string> { return (await this.call<{ channel: { id: string } }>('conversations.open', { users: user })).channel.id; }
  post(channel: string, text: string, thread_ts?: string) {
    return this.call<{ ts: string; channel: string }>('chat.postMessage', { channel, text, thread_ts, unfurl_links: false, unfurl_media: false });
  }
  async channels(): Promise<{ id: string; name: string; member: boolean; private: boolean }[]> {
    const out: { id: string; name: string; member: boolean; private: boolean }[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const r = await this.call<{ channels: any[]; response_metadata?: { next_cursor?: string } }>('conversations.list', { types: 'public_channel,private_channel', exclude_archived: true, limit: 1000, cursor });
      out.push(...r.channels.map((c) => ({ id: c.id, name: c.name, member: !!c.is_member, private: !!c.is_private })));
      cursor = r.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    return out.sort((a, b) => Number(b.member) - Number(a.member) || a.name.localeCompare(b.name));
  }
}

/** Slack's three reserved characters. */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The message for one event. ShiftBoss's own words and a link back, never a session's output: a finished
 * turn's last line stays on this machine.
 */
export function slackText(e: NotifyEvent, base: string): string {
  const body = e.kind === 'finished' ? '' : e.body;
  return [`*${esc(e.title)}*`, body ? esc(body) : '', `<${base}${e.route}|Open in ShiftBoss>`].filter(Boolean).join('\n');
}

/** Events about the same thing share a Slack thread: a monitor's alert, checks and finish; a task's moves; an action's result. */
export function threadOf(e: NotifyEvent): string | null {
  const k = e.key;
  let m;
  if ((m = /^(?:monitor|mcheck|mdone):([^:]+)/.exec(k))) return 'monitor:' + m[1];
  if ((m = /^action:(\d+)/.exec(k))) return 'action:' + m[1];
  if ((m = /^task:([^:]+)/.exec(k))) return 'task:' + m[1];
  if ((m = /^repl:(\d+)/.exec(k))) return 'repl:' + m[1];
  if ((m = /^health:([^:]+)/.exec(k))) return 'session:' + m[1];
  if ((m = /^need:(\d+)/.exec(k))) return 'need:' + m[1];
  if ((m = /^promise:(\d+)/.exec(k)) || (m = /^kept:(\d+)/.exec(k))) return 'promise:' + m[1];
  if ((m = /^overlap:(.+)/.exec(k))) return 'overlap:' + m[1];
  return null;
}

/** Kinds that clear by themselves (answered, unstuck, fixed): the thread gets "Cleared" when they go. */
const CLEARS = new Set(['needs', 'blocked', 'stuck', 'trouble', 'overlap', 'promiseDue', 'monitor', 'system', 'limits']);

/** Is HH:MM local time now inside from..to (which may cross midnight)? */
export function inQuiet(q: SlackSettings['quiet'], now = new Date()): boolean {
  if (!q.on) return false;
  const min = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
  const t = now.getHours() * 60 + now.getMinutes(), a = min(q.from), b = min(q.to);
  return a === b ? false : a < b ? t >= a && t < b : t >= a || t < b;
}

type Out = { dest: SlackDest; text: string; thread: string | null; title: string };

/**
 * Watches each snapshot and posts what is new. Like browser notifications, what was already there when
 * ShiftBoss started does not post. One message at a time, about one a second; a burst over 15 becomes one
 * summary. A failure is logged once and does not stop ShiftBoss.
 */
export class SlackNotifier {
  private prev: Map<string, NotifyEvent> | null = null;
  private queue: Out[] = [];
  private draining: Promise<void> | null = null;
  private lastSend = 0;
  private dmChannel: { user: string; id: string } | null = null;
  private ident: { team: string; bot: string } | null = null;
  error: string | null = null;
  private sentDay = '';
  private sentToday = 0;

  constructor(private store: Store, private base: string, private log: (text: string) => void, private f: Fetch = fetch, private now = () => new Date(), private gapMs = 1100) {}

  token(): string | null { return process.env.SHIFTBOSS_SLACK_TOKEN || this.store.getSecret(SLACK_TOKEN_KEY); }
  api(token = this.token()): SlackApi | null { return token ? new SlackApi(token, this.f) : null; }
  settings(): SlackSettings { return { ...DEFAULT_SLACK, ...this.store.settings().slack }; }

  status(): SlackStatus {
    return { connected: !!this.token(), team: this.ident?.team ?? null, bot: this.ident?.bot ?? null, error: this.error, sentToday: this.sentToday, held: this.store.heldSlack().length, queued: this.queue.length };
  }

  /** Check a token and keep it. Returns who the bot is. */
  async connect(token: string): Promise<{ team: string; bot: string }> {
    if (!/^xoxb-[A-Za-z0-9-]{10,}$/.test(token.trim())) throw new Error('That is not a bot token. Copy the "Bot User OAuth Token" (it starts with xoxb-) from the app\'s OAuth & Permissions page.');
    const who = await new SlackApi(token.trim(), this.f).authTest();
    this.store.setSecret(SLACK_TOKEN_KEY, token.trim());
    this.ident = { team: who.team, bot: who.user };
    this.error = null; this.dmChannel = null;
    return this.ident;
  }
  disconnect() { this.store.setSecret(SLACK_TOKEN_KEY, null); this.ident = null; this.error = null; this.dmChannel = null; this.queue = []; }

  /** Who the bot is, checked once (and again after an error). */
  async whoami() {
    const api = this.api();
    if (!api) return null;
    if (!this.ident) { const w = await api.authTest(); this.ident = { team: w.team, bot: w.user }; }
    return this.ident;
  }

  private async channelFor(dest: SlackDest, s: SlackSettings, api: SlackApi): Promise<string | null> {
    if (dest === 'channel') return s.channel.on && s.channel.id ? s.channel.id : null;
    if (!s.dm.on || !s.dm.userId) return null;
    if (this.dmChannel?.user !== s.dm.userId) this.dmChannel = { user: s.dm.userId, id: await api.openDm(s.dm.userId) };
    return this.dmChannel.id;
  }

  /** Send one message now, to the DM or the channel (the Test button). */
  async test(dest: SlackDest) {
    const api = this.api();
    if (!api) throw new Error('Connect the bot first.');
    const s = this.settings();
    const ch = await this.channelFor(dest, s, api);
    if (!ch) throw new Error(dest === 'dm' ? 'Turn the DM on and pick yourself first.' : 'Turn the channel on and pick one first.');
    await api.post(ch, `*ShiftBoss is connected.* Alerts you switched on for this ${dest === 'dm' ? 'DM' : 'channel'} will show up here.\n<${this.base}/settings/slack|Slack settings>`);
    this.error = null;
  }

  /** Called with every snapshot. Works out what is new and queues it; sending happens in the background. */
  tick(snap: Snapshot) {
    const items = notifyItems(snap);
    const cur = new Map(items.map((e) => [e.kind + '|' + e.key, e]));
    const prev = this.prev;
    this.prev = cur;
    const s = this.settings();
    if (!this.token() || (!s.dm.on && !s.channel.on)) return;
    const quiet = inQuiet(s.quiet, this.now());
    // The first snapshot after a start only sets the baseline: what was already there never posts.
    if (prev) for (const [k, e] of cur) {
      if (prev.has(k)) continue;
      const thread = threadOf(e);
      if (s.dm.on && s.kinds.dm[e.kind]) {
        if (quiet) this.store.holdSlack(e.title, e.route);
        else this.queue.push({ dest: 'dm', text: slackText(e, this.base), thread, title: e.title });
      }
      if (s.channel.on && s.kinds.channel[e.kind]) this.queue.push({ dest: 'channel', text: slackText(e, this.base), thread, title: e.title });
    }
    // Gone since last time: tell the thread it cleared (answered, fixed, unstuck).
    if (prev) for (const [k, e] of prev) {
      if (cur.has(k) || !CLEARS.has(e.kind)) continue;
      const thread = threadOf(e);
      if (!thread) continue;
      for (const dest of ['dm', 'channel'] as const) if (this.store.slackThread(dest, thread)) this.queue.push({ dest, text: 'Cleared: ' + esc(e.title), thread, title: '' });
    }
    // Quiet hours are over (now, or before a restart): one digest of what was held.
    if (!quiet) {
      const held = this.store.heldSlack();
      if (held.length) {
        const lines = held.slice(0, 15).map((h) => `• <${this.base}${h.route}|${esc(h.title)}>`);
        this.queue.push({ dest: 'dm', thread: null, title: '', text: [`*While you were away: ${held.length} thing${held.length === 1 ? '' : 's'}*`, ...lines, held.length > 15 ? `…and ${held.length - 15} more` : '', `<${this.base}/|Open ShiftBoss>`].filter(Boolean).join('\n') });
        this.store.clearHeldSlack(held[held.length - 1].id);
      }
    }
    // A burst (a restart of herdr, a big import) becomes one message per place.
    for (const dest of ['dm', 'channel'] as const) {
      const mine = this.queue.filter((q) => q.dest === dest);
      if (mine.length > 15) {
        this.queue = this.queue.filter((q) => q.dest !== dest);
        this.queue.push({ dest, thread: null, title: '', text: `*${mine.length} things happened at once in ShiftBoss*\n` + mine.slice(0, 10).map((q) => '• ' + esc(q.title)).join('\n') + `\n<${this.base}/|Open ShiftBoss>` });
      }
    }
    // Offline for a while: keep the newest 50, so the queue cannot grow without end.
    if (this.queue.length > 50) this.queue = this.queue.slice(-50);
    void this.drain();
  }

  /** Post the queue one message at a time, about one a second (Slack's limit per channel). */
  drain(): Promise<void> {
    // A send already running may have checked the queue before this tick added to it: go again after it.
    if (this.draining) return this.draining.then(() => (this.queue.length ? this.drain() : undefined));
    return (this.draining = this.send().finally(() => { this.draining = null; }));
  }
  private async send() {
    {
      while (this.queue.length) {
        const api = this.api();
        if (!api) { this.queue = []; break; }
        const wait = this.lastSend + this.gapMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        const m = this.queue[0];
        try {
          const s = this.settings();
          const ch = await this.channelFor(m.dest, s, api);
          if (!ch) { this.queue.shift(); continue; }
          const parent = m.thread ? this.store.slackThread(m.dest, m.thread) : null;
          const r = await api.post(ch, m.text, parent && parent.channel === ch ? parent.ts : undefined);
          if (m.thread && !parent) this.store.setSlackThread(m.dest, m.thread, ch, r.ts, m.title);
          this.queue.shift();
          this.lastSend = Date.now();
          const day = this.now().toDateString();
          if (day !== this.sentDay) { this.sentDay = day; this.sentToday = 0; }
          this.sentToday++;
          this.error = null;
        } catch (e) {
          const err = e as Error;
          const code = err instanceof SlackError ? err.code : 'network';
          // Slack asked us to slow down, or the network is down: wait 30 s and try the same message again.
          if (code === 'ratelimited' || code === 'network') {
            if (code === 'network' && err.message !== this.error) this.log('Slack: cannot reach Slack, retrying (' + err.message.slice(0, 80) + ')');
            if (code === 'network') this.error = 'Cannot reach Slack; retrying.';
            this.lastSend = Date.now() + 30_000;
            continue;
          }
          if (err.message !== this.error) this.log('Slack: ' + err.message);
          this.error = err.message;
          if (['invalid_auth', 'token_revoked', 'account_inactive', 'not_authed'].includes(code)) { this.queue = []; break; }
          this.queue.shift(); // this message cannot go (no channel, no scope …): drop it, keep the rest
        }
      }
    }
  }
}
