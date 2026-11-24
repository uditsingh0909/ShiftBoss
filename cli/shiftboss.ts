#!/usr/bin/env bun
// The CLI sessions use to write to ShiftBoss. Every command is one HTTP call to the local server.
import { resolvePort } from '../shared/port';
const PORT = resolvePort();
const BASE = `http://127.0.0.1:${PORT}`;

const HELP = `shiftboss: tell ShiftBoss what happened

  shiftboss task add "<title>" [--ask TEXT] [--from NAME] [--source WHERE] [--url URL] [--direction inbound|outbound] [--session NAME] [--prio P1|P2|P3]
  shiftboss task stage <T-n> queued|progress|pr|dev|live|told
  shiftboss task assign <T-n> <session>
  shiftboss task note <T-n> "<text>" [--src Session|GitHub|Slack] [--who NAME]
  shiftboss task link <T-n> <URL> [--direction inbound|outbound]     set a missing source link
  shiftboss slack <T-n> "<text>" --kind ask|promise|draft|sent [--who NAME] [--url THREAD-PERMALINK]
  shiftboss slack sent <message-id>
  shiftboss promise "<what was said>" --to NAME [--where CHANNEL] [--when "kept when…"] [--task T-n] [--due 2026-12-01] [--url URL] [--direction inbound|outbound]
  shiftboss promise link <id> <URL> [--direction inbound|outbound]   set a missing link
  shiftboss need "<question>" --answers "Yes,Not now" [--kind Decision|"Production write"|"Live customers"|Money|Access] [--body TEXT] [--session NAME] [--task T-n]
  shiftboss intake begin | checkpoint <ISO time> | pause [--until ISO] | resume [--from-now]
  shiftboss intake --src WHERE --text "<message>" --verdict "filed T-n|dropped|answered|to lead" --url PERMALINK --direction inbound|outbound [--who NAME] [--task T-n]

  Anything from Slack or Gmail carries --url (the permalink) and --direction: inbound when someone
  wrote to the owner, outbound when the owner or a session said or sent it.
  shiftboss audit --text "<what was sent>" [--where Slack|Jira|GitHub|Email] [--channel C] [--by SESSION] [--approval TEXT]
  shiftboss decide "<what the lead decided>"
  shiftboss import <tasks.json>     (re-runnable: matched on extId)
  shiftboss monitor add "<what was shipped>" --prompt "<what to check, what bad looks like>" --days 1|3|7|14 --every 1|3|6|12|24
                        [--pr URL] [--ticket URL] [--dashboard URL] [--task T-n]
  shiftboss monitor list
  shiftboss monitor report <id> ok|warn|bad|error "<one-line summary>" [--details TEXT] [--link URL]
  shiftboss status
  shiftboss instructions                        show the owner's way of working
  shiftboss instructions add "<rule>"            add one rule
  shiftboss instructions set "<text>" | --file F  replace them (undo: shiftboss instructions undo)
  shiftboss update [--check]                       install the newest ShiftBoss (--check: only say if there is one)

Setup and onboarding (the same steps as the Get started screen, which updates live):
  shiftboss setup status [--json]                 what is connected, sessions, what is left to do
  shiftboss setup lead <session> [--workspace W]  set the lead session (and herdr workspace)
  shiftboss setup ask <session...> | --all        ask running sessions to put their work on the board
  shiftboss setup backfill <1|2|3|7|14>           send the intake back that many days
  shiftboss setup done                            mark setup finished
  shiftboss session spawn <name> --cwd DIR [--model sonnet|opus|haiku] [--prompt TEXT]
  shiftboss session outside [--days N]             Claude sessions not in herdr (CLI, TUI, desktop app)
  shiftboss session bring-in <session-id> [--name N]   reopen one in herdr with its history (claude --resume)
  shiftboss session spawn-many <file.json>       start up to 20, one after another:
                                                 [{ "name", "cwd", "model"?, "prompt"? }, …] (or { "sessions": [...] })
  shiftboss session replace <name...>            handoff, then a fresh <name>-vN takes over its tasks
                                                 (the old sessions stay open for you to close)
  shiftboss session replacements                 progress of replacements under way

Everything you can do in ShiftBoss, from the command line:
  shiftboss task show <T-n>                       the task, its log and Slack thread
  shiftboss task update <T-n> [--prio P1|P2|P3] [--title T] [--ask T] [--hold | --resume] [--direction D]
  shiftboss task send <T-n>                       send its brief to its session (goes through the mode)
  shiftboss tasks [--stage inbox|queued|progress|pr|dev|live|told] [--session NAME]
  shiftboss promise list [--open]                 promises and who waits on them
  shiftboss promise state <id> open|due|kept
  shiftboss needs                                 what waits on the owner
  shiftboss need answer <id> "<answer>" --as-owner     answer one (only when the owner told you the answer)
  shiftboss need undo <id> --as-owner
  shiftboss approvals                             actions held for approval (and the dry-run log)
  shiftboss approve <id> | --all  --as-owner     reject <id> | --all  --as-owner
  shiftboss mode [dry|ask|safe|auto] [--review | --drop] [--as-owner]   show, or change (owner)
  shiftboss settings                              show all settings as JSON
  shiftboss settings set key=value… --as-owner    e.g. thresholds.warn=70 switches.autoDispatch=true
                                                  watchedChannels=#a,#b leadSession=lead autoUpdate=false
  shiftboss sessions                              every session: status, context, task
  shiftboss session prompt <name> "<text>"        send a prompt (goes through the mode)
  shiftboss session interrupt <name>              Esc (refused while it waits on a permission prompt)
  shiftboss session screen <name>                 what its terminal shows now
  shiftboss session lane <name> "<lane>" [--slots N]
  shiftboss session cancel-replace <id>
  shiftboss monitor pause|resume|stop|check <id>
  shiftboss monitor edit <id> [--title T] [--prompt T] [--days N] [--every N]
  shiftboss intake run                            ask the intake for a pass now
  shiftboss intake resolve <id>                   dismiss a flagged thread
  shiftboss slack approve <message-id> --as-owner      ask the owning session to post an approved draft
  shiftboss audit correct <id> "<note>"
  shiftboss report [plain|team|me]                the daily report
  shiftboss health                                health cards and overlaps

  --as-owner: only for things the owner asked you to do in this conversation. The feed shows that you
  did it on their behalf. Without it, the owner's decisions are refused.
`;

const BOOL = new Set(['as-owner', 'all', 'check', 'json', 'review', 'drop', 'hold', 'resume', 'open', 'from-now']);

function parse(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && a.includes('=')) { const i2 = a.indexOf('='); flags[a.slice(2, i2)] = a.slice(i2 + 1); continue; }
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (BOOL.has(k) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) flags[k] = 'true';
      else { flags[k] = argv[i + 1]; i++; }
    } else pos.push(a);
  }
  return { pos, flags };
}

// Setup commands are run with the owner's consent (SETUP.md asks them first), so they act as the owner.
// Everything else a session runs goes through the gate (Dry run / Ask first / Safe auto / Autopilot).
let asOwner = false;
let onBehalf = false; // --as-owner: a session doing what the owner asked; the feed names it
let setupCall = false; // setup commands: the owner's only until setup is finished
async function call(method: string, path: string, body?: unknown) {
  let res: Response;
  const by = setupCall ? 'setup' : process.env.SHIFTBOSS_SESSION || 'a session';
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-shiftboss': '1', ...(asOwner ? { 'x-shiftboss-actor': 'owner', ...(onBehalf ? { 'x-shiftboss-by': by } : {}) } : {}) };
  const withBy = body && typeof body === 'object' && !Array.isArray(body) ? { by: process.env.SHIFTBOSS_SESSION || undefined, ...body } : body;
  try {
    res = await fetch(BASE + path, { method, headers, body: withBy ? JSON.stringify(withBy) : undefined });
  } catch {
    throw new Error(`ShiftBoss is not running on ${BASE}. Start it with: bun run start (in the shiftboss folder)`);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 202 && (data as any)?.held) { console.log((data as any).message); process.exit(0); }
  if (!res.ok) throw new Error((data as any).error ?? `HTTP ${res.status}`);
  return data as any;
}

async function main() {
  const { pos, flags } = parse(process.argv.slice(2));
  const [cmd, sub, a1, a2] = pos;
  const who = flags.who ?? process.env.SHIFTBOSS_SESSION ?? 'session';
  if (flags['as-owner']) { asOwner = true; onBehalf = true; }
  const STAGE_N: Record<string, number> = { inbox: 0, queued: 1, progress: 2, pr: 3, dev: 4, live: 5, told: 6 };
  const STAGE_W = ['inbox', 'queued', 'progress', 'pr', 'dev', 'live', 'told'];
  switch (cmd) {
    case 'tasks': {
      const s = await call('GET', '/api/snapshot');
      const rows = s.tasks.filter((t: any) => (flags.stage ? t.stage === STAGE_N[flags.stage] : t.stage < 6) && (!flags.session || t.session === flags.session));
      for (const t of rows) console.log(`${t.id.padEnd(6)} ${STAGE_W[t.stage].padEnd(8)} ${t.prio} ${(t.session ?? 'unassigned').padEnd(28)} ${t.title}`);
      return console.log(`\n${rows.length} task${rows.length === 1 ? '' : 's'}`);
    }
    case 'needs': {
      const s = await call('GET', '/api/snapshot');
      const open = s.needs.filter((n: any) => !n.answer);
      for (const n of open) console.log(`${String(n.id).padEnd(5)} ${n.kind.padEnd(16)} ${(n.session ?? '').padEnd(24)} ${n.title}  [${n.answers.join(' | ')}]`);
      return console.log(open.length ? '' : 'Nothing waits on the owner.');
    }
    case 'approvals': {
      const s = await call('GET', '/api/snapshot');
      console.log('Mode: ' + ({ dry: 'Dry run', ask: 'Ask first', safe: 'Safe auto', auto: 'Autopilot' } as any)[s.settings.mode ?? 'auto']);
      for (const a of s.actions) console.log(`${String(a.id).padEnd(5)} ${a.state.padEnd(9)} ${a.by.padEnd(20)} ${a.summary}`);
      return console.log(s.actions.length ? '' : 'Nothing held.');
    }
    case 'approve': case 'reject': {
      if (flags.all) { const r = await call('POST', '/api/actions/decide-all', { approve: cmd === 'approve' }); return console.log(`${cmd === 'approve' ? 'approved' : 'rejected'} ${r.ok}${r.failed.length ? `; failed: ${r.failed.join('; ')}` : ''}`); }
      const r = await call('POST', `/api/actions/${sub}/${cmd}`, {});
      return console.log(cmd === 'approve' ? 'approved: ' + (r.result ?? 'done') : 'rejected');
    }
    case 'mode': {
      if (!sub) { const s = await call('GET', '/api/snapshot'); return console.log(s.settings.mode ?? 'auto'); }
      const r = await call('POST', '/api/mode', { mode: sub, dryRun: flags.drop ? 'discard' : 'review' });
      return console.log(`mode: ${r.mode}${r.settled ? ` (${r.settled} dry-run action${r.settled === 1 ? '' : 's'} ${flags.drop ? 'dropped' : 'moved to approvals'})` : ''}`);
    }
    case 'settings': {
      const s = await call('GET', '/api/snapshot');
      if (sub !== 'set') return console.log(JSON.stringify(s.settings, null, 2));
      if (pos.slice(2).some((kv) => kv.startsWith('mode='))) throw new Error('Change the mode with: shiftboss mode <dry|ask|safe|auto> --as-owner');
      const next: any = structuredClone(s.settings);
      for (const kv of pos.slice(2)) {
        const i = kv.indexOf('=');
        if (i < 1) throw new Error('Use key=value, e.g. thresholds.warn=70');
        const path = kv.slice(0, i).split('.'), raw = kv.slice(i + 1);
        const val = raw === 'true' ? true : raw === 'false' ? false : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : path[0] === 'watchedChannels' ? raw.split(',').map((x) => x.trim()).filter(Boolean) : raw;
        let o = next; for (const k of path.slice(0, -1)) o = o[k] ??= {};
        o[path.at(-1)!] = val;
      }
      await call('PUT', '/api/settings', next);
      return console.log('saved');
    }
    case 'sessions': {
      const s = await call('GET', '/api/snapshot');
      for (const x of s.sessions) {
        const t = s.tasks.find((t: any) => t.session === x.name && t.stage >= 2 && t.stage <= 4);
        console.log(`${x.name.padEnd(36)} ${x.status.padEnd(8)} ctx ${String(Math.round(x.contextPct)).padStart(3)}%  ${t ? t.id + ' ' + t.title : ''}`);
      }
      return;
    }
    case 'report': { const r = await call('GET', '/api/report?aud=' + (sub ?? 'plain')); return console.log(typeof r === 'string' ? r : r.text ?? JSON.stringify(r, null, 2)); }
    case 'health': {
      const s = await call('GET', '/api/snapshot');
      for (const h of s.health.filter((h: any) => !['healthy'].includes(h.verdict))) console.log(`${h.session.padEnd(36)} ${h.verdict.padEnd(8)} ${h.title}  → ${h.suggest}`);
      for (const o of s.overlaps) console.log(`overlap: ${o.title} (${o.a.session} and ${o.b.session}) → ${o.fix}`);
      return;
    }
    case 'task': {
      if (sub === 'add') {
        const t = await call('POST', '/api/tasks', { title: a1, ask: flags.ask, requester: flags.from, source: flags.source, sourceUrl: flags.url, direction: flags.direction, session: flags.session, prio: flags.prio });
        return console.log(t.id);
      }
      if (sub === 'link') { await call('PATCH', `/api/tasks/${a1}`, { sourceUrl: a2, direction: flags.direction, who }); return console.log(`${a1} linked`); }
      if (sub === 'show') { const d = await call('GET', `/api/tasks/${a1}`); return console.log(JSON.stringify(d, null, 2)); }
      if (sub === 'send') { await call('POST', `/api/tasks/${a1}/dispatch`, {}); return console.log(`${a1}: brief sent`); }
      if (sub === 'update') {
        const patch: any = { who };
        if (flags.prio) patch.prio = flags.prio;
        if (flags.title) patch.title = flags.title;
        if (flags.ask) patch.ask = flags.ask;
        if (flags.direction) patch.direction = flags.direction;
        if (flags.hold) patch.held = true;
        if (flags.resume) patch.held = false;
        await call('PATCH', `/api/tasks/${a1}`, patch);
        return console.log(`${a1} updated`);
      }
      if (sub === 'stage') { await call('PATCH', `/api/tasks/${a1}`, { stage: a2, who }); return console.log(`${a1} → ${a2}`); }
      if (sub === 'assign') { await call('PATCH', `/api/tasks/${a1}`, { session: a2, who }); return console.log(`${a1} → ${a2}`); }
      if (sub === 'note') { await call('POST', `/api/tasks/${a1}/events`, { src: flags.src ?? 'Session', who, text: a2 }); return console.log('noted'); }
      break;
    }
    case 'slack': {
      if (sub === 'sent') { await call('POST', `/api/slack/${a1}/sent`, {}); return console.log('marked sent'); }
      if (sub === 'approve') { await call('POST', `/api/slack/${a1}/approve`, {}); return console.log('approved; the owning session will post it'); }
      await call('POST', `/api/tasks/${sub}/slack`, { who, text: a1, kind: flags.kind ?? 'sent', url: flags.url });
      return console.log('saved');
    }
    case 'promise': {
      if (sub === 'link') { await call('PATCH', `/api/promises/${a1}`, { url: a2, direction: flags.direction, who }); return console.log(`promise ${a1} linked`); }
      if (sub === 'list') {
        const s = await call('GET', '/api/snapshot');
        for (const p of s.promises.filter((p: any) => !flags.open || p.state !== 'kept')) console.log(`${String(p.id).padEnd(5)} ${p.state.padEnd(7)} to ${p.to.padEnd(18)} ${p.taskId ?? ''}  "${p.said}"`);
        return;
      }
      if (sub === 'state') { await call('PATCH', `/api/promises/${a1}`, { state: a2 }); return console.log(`promise ${a1}: ${a2}`); }
      const p = await call('POST', '/api/promises', { said: sub, to: flags.to, where: flags.where, keptWhen: flags.when, taskId: flags.task, dueAt: flags.due, url: flags.url, direction: flags.direction });
      return console.log('promise ' + p.id);
    }
    case 'need': {
      if (sub === 'answer') { await call('POST', `/api/needs/${a1}/answer`, { answer: a2 }); return console.log('answered (sent to the session in 10 seconds)'); }
      if (sub === 'undo') { await call('POST', `/api/needs/${a1}/undo`, {}); return console.log('taken back'); }
      const n = await call('POST', '/api/needs', { title: sub, answers: (flags.answers ?? '').split(',').map((s) => s.trim()).filter(Boolean), kind: flags.kind, body: flags.body, session: flags.session ?? process.env.SHIFTBOSS_SESSION, taskId: flags.task });
      return console.log('asked, item ' + n.id);
    }
    case 'intake': {
      if (sub === 'begin') return console.log(JSON.stringify(await call('POST', '/api/intake/begin', {}), null, 1));
      if (sub === 'run') { await call('POST', '/api/intake/run', {}); return console.log('asked the intake for a pass now'); }
      if (sub === 'resolve') { await call('POST', `/api/intake/${a1}/resolve`, {}); return console.log('dismissed'); }
      if (sub === 'checkpoint') { await call('POST', '/api/intake/checkpoint', { readUntil: a1 }); return console.log('checkpoint saved: ' + a1); }
      if (sub === 'pause') { const st = await call('POST', '/api/intake/pause', { until: flags.until }); return console.log(st.resumeAt ? 'paused until ' + st.resumeAt : 'paused'); }
      if (sub === 'resume') { await call('POST', '/api/intake/resume', { catchUp: flags['from-now'] === undefined }); return console.log(flags['from-now'] === undefined ? 'resumed, catching up' : 'resumed from now'); }
      await call('POST', '/api/intake', { src: flags.src, who: flags.who, text: flags.text, verdict: flags.verdict, taskId: flags.task, url: flags.url, direction: flags.direction });
      return console.log('logged');
    }
    case 'audit': {
      if (sub === 'correct') { await call('POST', `/api/audit/${a1}/correct`, { note: a2 }); return console.log('marked corrected'); }
      await call('POST', '/api/audit', { where: flags.where, channel: flags.channel, text: flags.text, by: flags.by ?? who, approval: flags.approval });
      return console.log('logged');
    }
    case 'monitor': {
      if (['pause', 'resume', 'stop'].includes(sub)) { await call('PATCH', `/api/monitors/${a1}`, { action: sub }); return console.log(`monitor ${a1}: ${sub}`); }
      if (sub === 'check') { const r = await call('POST', `/api/monitors/${a1}/check-now`, {}); return console.log(r.waiting ? 'queued: ' + r.waiting : 'check queued; the monitor session gets it when it is idle'); }
      if (sub === 'edit') {
        const e: any = {};
        if (flags.title) e.title = flags.title;
        if (flags.prompt) e.prompt = flags.prompt;
        if (flags.days) e.durationDays = Number(flags.days);
        if (flags.every) e.intervalHours = Number(flags.every);
        await call('PATCH', `/api/monitors/${a1}`, e);
        return console.log(`monitor ${a1} updated`);
      }
      if (sub === 'add') {
        if (!a1) throw new Error('usage: shiftboss monitor add "<title>" --prompt TEXT --days N --every H');
        const m = await call('POST', '/api/monitors', { title: a1, prompt: flags.prompt, durationDays: Number(flags.days), intervalHours: Number(flags.every),
          links: { pr: flags.pr, ticket: flags.ticket, dashboard: flags.dashboard }, taskId: flags.task });
        return console.log(`monitor ${m.id}: watching for ${m.durationDays} day(s), every ${m.intervalHours} h; first check due now`);
      }
      if (sub === 'list') {
        const r = await call('GET', '/api/monitors');
        if (!r.monitors.length) return console.log('No monitors.');
        for (const m of r.monitors) console.log(`${String(m.id).padStart(3)}  ${m.state.padEnd(9)} ${m.title}\n     next ${m.nextDueAt ?? '-'}  ${m.checksDone} done, ${m.checksLeft} left  last ${m.lastVerdict ?? '-'}${m.lastSummary ? ': ' + m.lastSummary : ''}`);
        return console.log(r.session ? `\nmonitor session: ${r.session.name} (${r.session.status})` : `\nNo monitor session running: start one named ${r.sessionName} on the Monitors page.`);
      }
      if (sub === 'report') {
        if (!a1 || !a2) throw new Error('usage: shiftboss monitor report <id> ok|warn|bad|error "<summary>" [--details TEXT]');
        const r = await call('POST', `/api/monitors/${a1}/report`, { verdict: a2, summary: pos[4], details: flags.details, links: flags.link ? [flags.link] : [] });
        return console.log(`recorded: ${a2}${r.monitor.state === 'finished' ? ' (that was the last check)' : `, ${r.monitor.checksLeft} left`}`);
      }
      break;
    }
    case 'decide': { await call('POST', '/api/decisions', { text: sub }); return console.log('logged'); }
    case 'import': {
      // shiftboss import tasks.json  — [{ extId, title, stage 0-6, ask?, session?, sourceUrl?, links? }]
      const tasks = JSON.parse(await Bun.file(sub).text());
      const r = await call('POST', '/api/import', { tasks });
      return console.log(`${r.created} added, ${r.updated} updated`);
    }
    case 'setup': {
      asOwner = true; onBehalf = true; setupCall = true;
      const o = await call('GET', '/api/onboarding');
      if (sub === 'status' || !sub) {
        if ('json' in flags || pos.includes('--json')) return console.log(JSON.stringify(o, null, 2));
        const tick = (b: boolean) => (b ? '[x]' : '[ ]');
        console.log(`ShiftBoss on port ${o.setup.port}, owner ${o.owner}${o.herdrOk ? '' : `  (herdr not answering: ${o.herdrError})`}`);
        console.log(`${tick(o.setup.mcp.registered && o.setup.mcp.pointsHere)} MCP tools registered${o.setup.mcp.registered && !o.setup.mcp.pointsHere ? ' (points at another install)' : ''}`);
        console.log(`${tick(o.setup.statusTap.configured)} status line tap (optional)`);
        console.log(`${tick(!!o.settings.leadSession)} lead session: ${o.settings.leadSession || 'not set'}`);
        console.log(`${tick(!!o.intake.running)} intake session: ${o.intake.running ?? 'not running'}${o.intake.state.paused ? ' (paused)' : ''}`);
        console.log(`${tick(!!o.onboarding.backfillFrom)} intake read back from: ${o.onboarding.backfillFrom ?? 'not yet'}`);
        console.log(`${tick(!!o.onboarding.doneAt)} setup finished
`);
        console.log(`Sessions (${o.sessions.length}):`);
        for (const x of o.sessions) console.log(`  ${x.name.padEnd(36)} ${x.status.padEnd(8)} ${String(x.tasks).padStart(3)} tasks  ${x.askedAt ? 'asked' : 'not asked'}`);
        console.log(`
Board: ${o.board.tasks} tasks, ${o.board.promises} promises. UI: http://127.0.0.1:${o.setup.port}/#/welcome`);
        return;
      }
      if (sub === 'lead') {
        const snap = await call('GET', '/api/snapshot');
        await call('PUT', '/api/settings', { ...snap.settings, leadSession: a1 ?? '', ...(flags.workspace !== undefined ? { herdrWorkspace: flags.workspace } : {}) });
        return console.log(`lead session: ${a1}`);
      }
      if (sub === 'ask') {
        const names = 'all' in flags || pos.includes('--all')
          ? o.sessions.filter((x: any) => !/intake/i.test(x.name) && !x.askedAt && !x.tasks).map((x: any) => x.name)
          : pos.slice(2);
        if (!names.length) return console.log('Nobody left to ask.');
        const r = await call('POST', '/api/onboarding/ask', { sessions: names });
        return console.log(`asked ${r.asked}: ${names.filter((n: string) => !r.failed.includes(n)).join(', ')}${r.failed.length ? `
could not reach: ${r.failed.join(', ')}` : ''}`);
      }
      if (sub === 'backfill') { const r = await call('POST', '/api/onboarding/backfill', { days: Number(a1) }); return console.log(`intake reads from ${r.since}` + (r.prompted ? ' (asked it to start now)' : r.waiting ? ` (${r.intake} is ${r.waiting}: answer it there, and it reads from this time on its next run)` : ' (no intake session running yet; it starts from this time when one does)')); }
      if (sub === 'done') { await call('POST', '/api/onboarding/done', { done: true }); return console.log('setup finished'); }
      break;
    }
    case 'session': {
      if (sub === 'prompt') { await call('POST', `/api/sessions/${encodeURIComponent(a1)}/prompt`, { text: a2 }); return console.log('sent to ' + a1); }
      if (sub === 'interrupt') { await call('POST', `/api/sessions/${encodeURIComponent(a1)}/interrupt`, {}); return console.log('interrupted ' + a1); }
      if (sub === 'screen') { const r = await call('GET', `/api/sessions/${encodeURIComponent(a1)}/screen`); return console.log(r.text); }
      if (sub === 'lane') { await call('POST', `/api/sessions/${encodeURIComponent(a1)}/meta`, { lane: a2 ?? '', ...(flags.slots ? { slots: Number(flags.slots) } : {}) }); return console.log(`${a1}: lane saved`); }
      if (sub === 'cancel-replace') { await call('POST', `/api/replacements/${a1}/cancel`, {}); return console.log('replacement cancelled'); }
      if (sub === 'outside') {
        const rows = await call('GET', '/api/outside-sessions?days=' + (Number(flags.days) || 14));
        if (!rows.length) return console.log('No Claude sessions outside herdr in that time.');
        for (const o of rows) console.log(`${o.sessionId}  ${o.suggestedName.padEnd(30)} ${o.lastAt.slice(0, 16)}  ${o.recent ? 'ACTIVE NOW  ' : ''}${(o.title ?? o.firstAsk ?? '').slice(0, 60)}\n${' '.repeat(38)}${o.cwd}`);
        return console.log('\nBring one in: shiftboss session bring-in <session-id> [--name N]   (close its old window first)');
      }
      if (sub === 'bring-in') {
        asOwner = true; onBehalf = true; setupCall = true; // used during setup, with the owner's consent
        const r = await call('POST', '/api/sessions/bring-in', { sessions: pos.slice(2).map((id) => ({ sessionId: id, name: pos.length === 3 ? flags.name : undefined })) });
        return console.log(`opening in herdr: ${r.starting.join(', ')} (a new folder may ask "trust this folder?" there first)`);
      }
      if (sub === 'spawn') {
        await call('POST', '/api/sessions/spawn', { name: a1, cwd: flags.cwd, model: flags.model || null, prompt: flags.prompt || null });
        return console.log(`starting ${a1}; it appears in herdr within a few seconds (a new folder asks "trust this folder?" there first)`);
      }
      if (sub === 'spawn-many') {
        if (!a1) throw new Error('usage: shiftboss session spawn-many <file.json>');
        const data = JSON.parse(await Bun.file(a1).text());
        const sessions = Array.isArray(data) ? data : data?.sessions;
        const r = await call('POST', '/api/sessions/spawn-many', { sessions });
        return console.log(`starting ${r.names.length} one after another: ${r.names.join(', ')}\nResults arrive in the ShiftBoss feed (a new folder asks "trust this folder?" in herdr first).`);
      }
      if (sub === 'replace') {
        const names = pos.slice(2);
        if (!names.length) throw new Error('usage: shiftboss session replace <name...>');
        const r = await call('POST', '/api/sessions/replace', { sessions: names });
        for (const x of r.results) console.log(x.error ? `${x.name}: could not start (${x.error})` : `${x.name}: asked for its handoff; ${x.newName} starts once it is written`);
        return;
      }
      if (sub === 'replacements') {
        const s = await call('GET', '/api/snapshot');
        if (!s.replacements.length) return console.log('No replacements in the last day.');
        for (const x of s.replacements) console.log(`${String(x.id).padStart(3)}  ${x.oldName} -> ${x.newName}  ${x.state}${x.error ? '  (' + x.error + ')' : ''}${x.state === 'done' ? `  ${x.oldName} can be closed` : ''}`);
        return;
      }
      break;
    }
    case 'instructions': {
      if (!sub) { const r = await call('GET', '/api/owner-instructions'); return console.log(r.instructions || '(none yet)'); }
      if (sub === 'add') { await call('POST', '/api/owner-instructions', { add: a1 }); return console.log('added'); }
      if (sub === 'set') { const text = flags.file ? await Bun.file(flags.file).text() : a1 ?? ''; await call('POST', '/api/owner-instructions', { set: text }); return console.log('saved'); }
      if (sub === 'undo') { await call('POST', '/api/owner-instructions', { undo: true }); return console.log('restored the previous version'); }
      break;
    }
    case 'update': {
      const apply = !('check' in flags || pos.includes('--check'));
      let st: any;
      try { st = await call('POST', '/api/update/check', { apply }); }
      catch (e) {
        if (!/not running/.test((e as Error).message)) throw e;
        // ShiftBoss is not running: update the folder directly; it starts on the new version.
        const { Updater } = await import('../server/update');
        st = await new Updater({ busy: () => null, log: (t) => console.log(t), supervised: false }).check(apply);
      }
      return console.log(`${st.note}${st.current ? `  (running ${st.current.sha}: ${st.current.subject})` : ''}`);
    }
    case 'status': {
      const s = await call('GET', '/api/snapshot');
      for (const x of s.sessions) console.log(`${x.name.padEnd(36)} ${x.status.padEnd(8)} ctx ${Math.round(x.contextPct)}%`);
      console.log(`\n${s.tasks.filter((t: any) => t.stage < 5).length} open tasks, ${s.needs.filter((n: any) => !n.answer).length} waiting on you`);
      return;
    }
  }
  console.log(HELP);
  if (cmd && cmd !== 'help') process.exitCode = 1;
}

main().catch((e) => { console.error('shiftboss: ' + e.message); process.exit(1); });
