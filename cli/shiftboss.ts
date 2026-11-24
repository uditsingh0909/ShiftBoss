#!/usr/bin/env bun
// The CLI sessions use to write to ShiftBoss. Every command is one HTTP call to the local server.
import { resolvePort } from '../shared/port';
const PORT = resolvePort();
const BASE = `http://127.0.0.1:${PORT}`;

const HELP = `shiftboss: tell ShiftBoss what happened

  shiftboss task add "<title>" [--ask TEXT] [--from NAME] [--source WHERE] [--url URL] [--session NAME] [--prio P1|P2|P3]
  shiftboss task stage <T-n> queued|progress|pr|dev|live|told
  shiftboss task assign <T-n> <session>
  shiftboss task note <T-n> "<text>" [--src Session|GitHub|Slack] [--who NAME]
  shiftboss slack <T-n> "<text>" --kind ask|promise|draft|sent [--who NAME]
  shiftboss slack sent <message-id>
  shiftboss promise "<what was said>" --to NAME [--where CHANNEL] [--when "kept when…"] [--task T-n] [--due 2026-12-01]
  shiftboss need "<question>" --answers "Yes,Not now" [--kind Decision|"Production write"|"Live customers"|Money|Access] [--body TEXT] [--session NAME] [--task T-n]
  shiftboss intake begin | checkpoint <ISO time> | pause [--until ISO] | resume [--from-now]
  shiftboss intake --src WHERE --text "<message>" --verdict "filed T-n|dropped|answered|to lead" [--who NAME] [--task T-n] [--url PERMALINK]
  shiftboss audit --text "<what was sent>" [--where Slack|Jira|GitHub|Email] [--channel C] [--by SESSION] [--approval TEXT]
  shiftboss decide "<what the lead decided>"
  shiftboss import <tasks.json>     (re-runnable: matched on extId)
  shiftboss status

Setup and onboarding (the same steps as the Get started screen, which updates live):
  shiftboss setup status [--json]                 what is connected, sessions, what is left to do
  shiftboss setup lead <session> [--workspace W]  set the lead session (and herdr workspace)
  shiftboss setup ask <session...> | --all        ask running sessions to put their work on the board
  shiftboss setup backfill <1|2|3|7|14>           send the intake back that many days
  shiftboss setup done                            mark setup finished
  shiftboss session spawn <name> --cwd DIR [--model sonnet|opus|haiku] [--prompt TEXT]
  shiftboss session spawn-many <file.json>       start up to 20, one after another:
                                                 [{ "name", "cwd", "model"?, "prompt"? }, …] (or { "sessions": [...] })
  shiftboss session replace <name...>            handoff, then a fresh <name>-vN takes over its tasks
                                                 (the old sessions stay open for you to close)
  shiftboss session replacements                 progress of replacements under way
`;

function parse(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { flags[a.slice(2)] = argv[i + 1] ?? ''; i++; } else pos.push(a);
  }
  return { pos, flags };
}

async function call(method: string, path: string, body?: unknown) {
  let res: Response;
  try {
    res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', 'x-shiftboss': '1' }, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error(`ShiftBoss is not running on ${BASE}. Start it with: bun run start (in the shiftboss folder)`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any).error ?? `HTTP ${res.status}`);
  return data as any;
}

async function main() {
  const { pos, flags } = parse(process.argv.slice(2));
  const [cmd, sub, a1, a2] = pos;
  const who = flags.who ?? process.env.SHIFTBOSS_SESSION ?? 'session';
  switch (cmd) {
    case 'task': {
      if (sub === 'add') {
        const t = await call('POST', '/api/tasks', { title: a1, ask: flags.ask, requester: flags.from, source: flags.source, sourceUrl: flags.url, session: flags.session, prio: flags.prio });
        return console.log(t.id);
      }
      if (sub === 'stage') { await call('PATCH', `/api/tasks/${a1}`, { stage: a2, who }); return console.log(`${a1} → ${a2}`); }
      if (sub === 'assign') { await call('PATCH', `/api/tasks/${a1}`, { session: a2, who }); return console.log(`${a1} → ${a2}`); }
      if (sub === 'note') { await call('POST', `/api/tasks/${a1}/events`, { src: flags.src ?? 'Session', who, text: a2 }); return console.log('noted'); }
      break;
    }
    case 'slack': {
      if (sub === 'sent') { await call('POST', `/api/slack/${a1}/sent`, {}); return console.log('marked sent'); }
      await call('POST', `/api/tasks/${sub}/slack`, { who, text: a1, kind: flags.kind ?? 'sent' });
      return console.log('saved');
    }
    case 'promise': {
      const p = await call('POST', '/api/promises', { said: sub, to: flags.to, where: flags.where, keptWhen: flags.when, taskId: flags.task, dueAt: flags.due });
      return console.log('promise ' + p.id);
    }
    case 'need': {
      const n = await call('POST', '/api/needs', { title: sub, answers: (flags.answers ?? '').split(',').map((s) => s.trim()).filter(Boolean), kind: flags.kind, body: flags.body, session: flags.session ?? process.env.SHIFTBOSS_SESSION, taskId: flags.task });
      return console.log('asked, item ' + n.id);
    }
    case 'intake': {
      if (sub === 'begin') return console.log(JSON.stringify(await call('POST', '/api/intake/begin', {}), null, 1));
      if (sub === 'checkpoint') { await call('POST', '/api/intake/checkpoint', { readUntil: a1 }); return console.log('checkpoint saved: ' + a1); }
      if (sub === 'pause') { const st = await call('POST', '/api/intake/pause', { until: flags.until }); return console.log(st.resumeAt ? 'paused until ' + st.resumeAt : 'paused'); }
      if (sub === 'resume') { await call('POST', '/api/intake/resume', { catchUp: flags['from-now'] === undefined }); return console.log(flags['from-now'] === undefined ? 'resumed, catching up' : 'resumed from now'); }
      await call('POST', '/api/intake', { src: flags.src, who: flags.who, text: flags.text, verdict: flags.verdict, taskId: flags.task, url: flags.url });
      return console.log('logged');
    }
    case 'audit': {
      await call('POST', '/api/audit', { where: flags.where, channel: flags.channel, text: flags.text, by: flags.by ?? who, approval: flags.approval });
      return console.log('logged');
    }
    case 'decide': { await call('POST', '/api/decisions', { text: sub }); return console.log('logged'); }
    case 'import': {
      // shiftboss import tasks.json  — [{ extId, title, stage 0-6, ask?, session?, sourceUrl?, links? }]
      const tasks = JSON.parse(await Bun.file(sub).text());
      const r = await call('POST', '/api/import', { tasks });
      return console.log(`${r.created} added, ${r.updated} updated`);
    }
    case 'setup': {
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
