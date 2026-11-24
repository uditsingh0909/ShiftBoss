#!/usr/bin/env bun
// The CLI sessions use to write to ShiftBoss. Every command is one HTTP call to the local server.
const PORT = process.env.SHIFTBOSS_PORT ?? '4400';
const BASE = `http://127.0.0.1:${PORT}`;

const HELP = `shiftboss: tell ShiftBoss what happened

  shiftboss task add "<title>" [--ask TEXT] [--from NAME] [--source WHERE] [--url URL] [--session NAME] [--prio P1|P2|P3]
  shiftboss task stage <T-n> queued|progress|pr|dev|live|told
  shiftboss task assign <T-n> <session>
  shiftboss task note <T-n> "<text>" [--src Session|GitHub|Slack] [--who NAME]
  shiftboss slack <T-n> "<text>" --kind ask|promise|draft|sent [--who NAME]
  shiftboss slack sent <message-id>
  shiftboss promise "<what was said>" --to NAME [--where CHANNEL] [--when "kept when…"] [--task T-n]
  shiftboss need "<question>" --answers "Yes,Not now" [--kind Decision|"Production write"|"Live customers"|Money|Access] [--body TEXT] [--session NAME] [--task T-n]
  shiftboss intake begin | checkpoint <ISO time> | pause [--until ISO] | resume [--from-now]
  shiftboss intake --src WHERE --text "<message>" --verdict "filed T-n|dropped|answered|to lead" [--who NAME] [--task T-n] [--url PERMALINK]
  shiftboss audit --text "<what was sent>" [--where Slack|Jira|GitHub|Email] [--channel C] [--by SESSION] [--approval TEXT]
  shiftboss decide "<what the lead decided>"
  shiftboss import <tasks.json>     (re-runnable: matched on extId)
  shiftboss status
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
      const p = await call('POST', '/api/promises', { said: sub, to: flags.to, where: flags.where, keptWhen: flags.when, taskId: flags.task });
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
