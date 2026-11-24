// HTTP API. Every write needs the X-ShiftBoss header, so a web page on another origin
// cannot trigger one (the custom header forces a CORS preflight that we never allow).
import { MONITOR_DAYS, MONITOR_HOURS, MONITOR_SESSION, resolveLead, type Need, type PromiseItem, type SlackMsg, type Stage, type Task, type TaskEvent } from '../shared/types';
import { monitorSessionPrompt } from './monitors';
import type { Engine } from './engine';
import { existsSync, statSync } from 'node:fs';
import { buildReport, type Audience } from './report';
import { setupInfo } from './setup';
import { safeUrl } from './guard';
import { isMode, MODE_LABEL, type Actor, type Mode } from './gate';
import { HerdrError } from './herdr';
import { NotFound } from './db';
import { mergeSettings } from './settings';
import { onboardingPrompt } from './onboarding';
import { checkSpawnMany, SPAWN_MANY_CAP } from './fleet';
import { isSessionId, listOutside } from './outside';
import { PaneBlockedError } from './herdr';
import { SnapshotHub } from './stream';

const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (msg: string, status = 400) => json({ error: msg }, status);

async function body<T>(req: Request): Promise<T> {
  try { return (await req.json()) as T; } catch { throw new Error('Body must be JSON'); }
}
function str(v: unknown, field: string, max = 4000): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(field + ' is required');
  if (v.length > max) throw new Error(field + ' is too long');
  return v.trim();
}
const optStr = (v: unknown, max = 4000) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
export const UNDO_MS = 10_000;
const STAGE_WORDS: Record<string, Stage> = { inbox: 0, queued: 1, progress: 2, pr: 3, dev: 4, live: 5, told: 6 };

export function makeApi(engine: Engine) {
  const store = engine.store;
  const done = (r: Response) => { engine.emit(); return r; };
  const hub = new SnapshotHub(() => engine.snapshot(), () => store.writeCount());
  engine.onChange(() => hub.changed());
  const session = (name: string) => {
    const s = engine.sessions.find((x) => x.name === name);
    if (!s) throw new Error(name + ' is not running in herdr');
    return s;
  };

  const outsideNow = (days: number) => listOutside(engine.cfg.transcriptsDir,
    new Set(engine.sessions.map((x) => x.sessionId).filter((x): x is string => !!x)), new Set(engine.takenNames()), days);

  // The owner's own clicks (the UI, and setup run with their consent) carry this header and always run.
  // Sessions (MCP, CLI) and ShiftBoss itself go through the gate (server/gate.ts).
  const actorOf = (req: Request): Actor => (req.headers.get('x-shiftboss-actor') === 'owner' ? 'owner' : 'session');
  const byOf = (req: Request, b: any) => (typeof b?.by === 'string' && b.by.trim() ? b.by.trim().slice(0, 100) : 'a session');
  const gated = (r: Awaited<ReturnType<Engine['act']>>, ok: (result: any) => Response) =>
    r.status === 'done' ? ok(r.result)
      : json({ held: r.status, id: r.id, message: r.status === 'dry' ? `Dry run: recorded "${r.summary}", nothing was done` : `Waiting for the owner's approval in Needs you: ${r.summary}` }, 202);

  return async function handle(req: Request, url: URL): Promise<Response | null> {
    const p = url.pathname;
    if (!p.startsWith('/api/')) return null;
    const write = req.method !== 'GET';
    if (write && req.headers.get('x-shiftboss') !== '1') return fail('Missing X-ShiftBoss header', 403);
    const m = (re: RegExp) => p.match(re);
    try {
      if (p === '/api/snapshot' && req.method === 'GET') return json(engine.snapshot());

      if (p === '/api/stream' && req.method === 'GET') {
        // All tabs share one hub: one snapshot build and one serialized frame per change, none when unchanged.
        let off: (() => void) | null = null;
        const stream = new ReadableStream({
          start(ctrl) { off = hub.add((frame) => { try { ctrl.enqueue(frame); } catch { off?.(); } }); },
          cancel() { off?.(); },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } });
      }

      // ----- tasks -----
      if (p === '/api/tasks' && req.method === 'POST') {
        const b = await body<any>(req);
        const t = store.addTask({ title: str(b.title, 'title', 300), ask: optStr(b.ask), requester: optStr(b.requester, 100), source: optStr(b.source, 200),
          sourceUrl: safeUrl(b.sourceUrl), session: optStr(b.session, 100) ?? null, prio: ['P1', 'P2', 'P3'].includes(b.prio) ? b.prio : 'P2' });
        if (b.who === 'you' && t.session) store.vetTask(t.id);
        engine.pushFeed('shiftboss', `filed ${t.id}: ${t.title}`);
        return done(json(t, 201));
      }
      let r = m(/^\/api\/tasks\/(T-\d+)$/);
      if (r && req.method === 'GET') {
        const t = store.getTask(r[1]);
        if (!t) return fail('No task ' + r[1], 404);
        return json({ task: t, events: store.events(t.id), slack: store.slack(t.id), promises: store.listPromises().filter((x) => x.taskId === t.id) });
      }
      if (r && req.method === 'PATCH') {
        const b = await body<any>(req);
        const patch: Partial<Task> = {};
        if (b.stage !== undefined) {
          const st = typeof b.stage === 'string' ? STAGE_WORDS[b.stage] : b.stage;
          if (!Number.isInteger(st) || st < 0 || st > 6) throw new Error('stage must be 0-6 or inbox|queued|progress|pr|dev|live|told');
          patch.stage = st as Stage;
        }
        if (b.session !== undefined) patch.session = b.session || null;
        if (b.prio !== undefined) patch.prio = b.prio;
        if (b.held !== undefined) patch.held = !!b.held;
        if (b.title !== undefined) patch.title = str(b.title, 'title', 300);
        if (b.ask !== undefined) patch.ask = String(b.ask);
        if (patch.session && patch.stage === undefined) { const cur = store.getTask(r[1]); if (cur?.stage === 0) patch.stage = 1; }
        const who = optStr(b.who, 100) ?? 'session';
        const updated = store.updateTask(r[1], patch, who);
        if (who === 'you' && (patch.session || patch.stage === 1)) store.vetTask(r[1]);
        return done(json(updated));
      }
      r = m(/^\/api\/tasks\/(T-\d+)\/dispatch$/);
      if (r && write) {
        const b = await body<any>(req).catch(() => ({}));
        const actor = actorOf(req);
        if (actor === 'owner') store.vetTask(r[1]);
        const t = store.getTask(r[1]);
        if (!t) throw new NotFound('No task ' + r[1]);
        const g = await engine.act('dispatch', { taskId: r[1] }, { actor, by: byOf(req, b), summary: `send ${r[1]}'s brief to ${t.session ?? 'its session'}`, detail: t.title });
        return done(gated(g, () => json({ ok: true })));
      }
      r = m(/^\/api\/tasks\/(T-\d+)\/brief$/);
      if (r) return json({ brief: engine.briefFor(r[1]) });
      r = m(/^\/api\/tasks\/(T-\d+)\/events$/);
      if (r && write) {
        const b = await body<any>(req);
        const src = (['Slack', 'GitHub', 'Session', 'ShiftBoss'].includes(b.src) ? b.src : 'Session') as TaskEvent['src'];
        store.addEvent(r[1], src, str(b.who, 'who', 100), str(b.text, 'text', 1000));
        return done(json({ ok: true }, 201));
      }
      r = m(/^\/api\/tasks\/(T-\d+)\/slack$/);
      if (r && write) {
        const b = await body<any>(req);
        const kind = (['ask', 'promise', 'sent', 'draft'].includes(b.kind) ? b.kind : 'sent') as SlackMsg['kind'];
        store.addSlack(r[1], str(b.who, 'who', 100), str(b.text, 'text', 4000), kind);
        return done(json({ ok: true }, 201));
      }
      r = m(/^\/api\/slack\/(\d+)\/approve$/);
      if (r && write) {
        const id = Number(r[1]);
        const msg: any = store.db.query('SELECT * FROM slack_msgs WHERE id = ?').get(id);
        if (!msg || msg.kind !== 'draft') return fail('Not a draft', 404);
        const t = store.getTask(msg.task_id);
        const s = t?.session ? engine.sessions.find((x) => x.name === t.session) : null;
        if (!s) return fail('The session that owns this draft is not running, so nobody can post it', 409);
        store.approveSlack(id);
        await engine.herdr.prompt(s.paneId, `${engine.cfg.ownerName} approved your draft for ${t!.id}. Post it exactly as written, then run: shiftboss slack sent ${id}\n\n${msg.text}`);
        store.addEvent(t!.id, 'Slack', 'you', 'Approved the draft; ' + s.name + ' will post it');
        return done(json({ ok: true }));
      }
      r = m(/^\/api\/slack\/(\d+)\/sent$/);
      if (r && write) {
        const id = Number(r[1]);
        const msg: any = store.db.query('SELECT * FROM slack_msgs WHERE id = ?').get(id);
        if (!msg) return fail('No message ' + id, 404);
        store.setSlackKind(id, 'sent');
        store.addAudit({ where: 'Slack', channel: '', text: msg.text, by: store.getTask(msg.task_id)?.session ?? '', approval: msg.approved_at ? 'approved by you' : 'not approved' }); // only a draft approved here counts
        return done(json({ ok: true }));
      }

      if (p === '/api/import' && write) {
        const b = await body<{ tasks: any[] }>(req);
        if (!Array.isArray(b.tasks) || b.tasks.length > 2000) throw new Error('tasks must be an array of at most 2000');
        let created = 0, updated = 0;
        const tx = store.db.transaction(() => {
          for (const t of b.tasks) {
            const stage = Number(t.stage);
            if (!Number.isInteger(stage) || stage < 0 || stage > 6) throw new Error(`stage for ${t.extId} must be 0-6`);
            const r = store.importTask({ extId: str(t.extId, 'extId', 200), title: str(t.title, 'title', 300), ask: optStr(t.ask), requester: optStr(t.requester, 100), source: optStr(t.source, 200),
              sourceUrl: safeUrl(t.sourceUrl), session: optStr(t.session, 100) ?? null, stage: stage as Stage, prio: ['P1', 'P2', 'P3'].includes(t.prio) ? t.prio : 'P2', held: !!t.held,
              links: Array.isArray(t.links) ? t.links.filter((l: any) => typeof l?.url === 'string').slice(0, 10).map((l: any) => ({ ...l, url: safeUrl(l.url)! })) : [] });
            r.created ? created++ : updated++;
          }
        });
        tx();
        engine.pushFeed('import', `${created} tasks added, ${updated} updated`);
        return done(json({ created, updated }));
      }

      // ----- promises -----
      if (p === '/api/promises' && write) {
        const b = await body<any>(req);
        const pr = store.addPromise({ to: str(b.to, 'to', 100), where: optStr(b.where, 200), said: str(b.said, 'said', 1000), keptWhen: optStr(b.keptWhen, 300), taskId: optStr(b.taskId, 20) ?? null, dueAt: dueIso(b.dueAt) });
        return done(json(pr, 201));
      }
      r = m(/^\/api\/promises\/(\d+)$/);
      if (r && req.method === 'PATCH') {
        const b = await body<any>(req);
        if (b.taskId !== undefined) store.linkPromise(Number(r[1]), str(b.taskId, 'taskId', 20));
        if (b.state !== undefined) {
          if (!['open', 'ready', 'waiting', 'due', 'kept'].includes(b.state)) throw new Error('state must be open|ready|waiting|due|kept');
          store.setPromiseState(Number(r[1]), b.state as PromiseItem['state']);
        }
        return done(json({ ok: true }));
      }

      // ----- needs -----
      if (p === '/api/needs' && write) {
        const b = await body<any>(req);
        const answers = Array.isArray(b.answers) ? [...new Set(b.answers.map((a: unknown) => str(a, 'answer', 60).trim()))].slice(0, 4) as string[] : [];
        if (!answers.length) throw new Error('answers must list 1-4 choices');
        // 'Permission' is reserved for blocked panes ShiftBoss detects itself.
        const kinds = ['Decision', 'Production write', 'Live customers', 'Money', 'Access'];
        if (b.kind !== undefined && !kinds.includes(b.kind)) throw new Error('kind must be one of: ' + kinds.join(', '));
        const n = store.addNeed({ kind: b.kind ?? 'Decision', source: optStr(b.source, 200), title: str(b.title, 'title', 300), body: optStr(b.body, 2000),
          code: optStr(b.code, 2000), answers, session: optStr(b.session, 100) ?? null, taskId: optStr(b.taskId, 20) ?? null });
        engine.pushFeed(n.session ?? 'shiftboss', 'asked you: ' + n.title);
        return done(json(n, 201));
      }
      r = m(/^\/api\/needs\/(\d+)\/answer$/);
      if (r && write) {
        const b = await body<any>(req);
        const n = store.listNeeds().find((x) => x.id === Number(r![1]));
        if (!n) return fail('No item ' + r[1], 404);
        if (n.answer) return fail('Already answered: ' + n.answer, 409);
        const answer = str(b.answer, 'answer', 60);
        if (!n.answers.includes(answer)) throw new Error('Pick one of: ' + n.answers.join(', '));
        if (n.auto) {
          // Permission prompts are answered by the user in herdr. ShiftBoss only brings the pane forward.
          await engine.herdr.focus(session(n.session!).paneId);
          return json({ ok: true, focused: true });
        }
        // Held for UNDO_MS so it can be taken back; the engine sends it to the session after that.
        const saved: Need = store.answerNeed(n.id, answer);
        if (n.taskId) store.addEvent(n.taskId, 'ShiftBoss', 'you', `Answered "${n.title}": ${answer}`);
        engine.pushFeed('you', `answered ${n.title}: ${answer}`);
        return done(json({ ...saved, undoMs: UNDO_MS }));
      }
      r = m(/^\/api\/needs\/(\d+)\/undo$/);
      if (r && write) {
        // If the engine is typing this answer into the pane right now, let it finish first: the undo then
        // sees it as sent and tells the session to disregard it, instead of racing the send.
        await engine.sendingAnswers.get(Number(r[1]));
        const { was } = store.undoAnswer(Number(r[1]));
        if (was.sentAt) {
          const s = was.session ? engine.sessions.find((x) => x.name === was.session) : null;
          if (s) await engine.herdr.prompt(s.paneId, `${engine.cfg.ownerName} took back the answer "${was.answer}" to "${was.title}". Do not act on it; wait for a new answer.`);
        }
        if (was.taskId) store.addEvent(was.taskId, 'ShiftBoss', 'you', `Took back the answer "${was.answer}"`);
        engine.pushFeed('you', `took back: ${was.title}`);
        return done(json({ ok: true, wasSent: !!was.sentAt }));
      }

      // ----- audit, intake, decisions -----
      if (p === '/api/audit' && req.method === 'GET') return json(store.listAudit());
      if (p === '/api/audit' && write) {
        const b = await body<any>(req);
        store.addAudit({ where: ['Slack', 'Jira', 'GitHub', 'Email'].includes(b.where) ? b.where : 'Slack', channel: optStr(b.channel, 200) ?? '', text: str(b.text, 'text', 4000), by: optStr(b.by, 100) ?? '', approval: optStr(b.approval, 100) ?? '', note: optStr(b.note, 500) });
        return done(json({ ok: true }, 201));
      }
      r = m(/^\/api\/audit\/(\d+)\/correct$/);
      if (r && write) { const b = await body<any>(req); store.markCorrected(Number(r[1]), str(b.note, 'note', 500)); return done(json({ ok: true })); }
      if (p === '/api/intake/pause' && write) {
        const b = await body<any>(req);
        const st = store.pauseIntake(optStr(b.until, 40) ?? null);
        engine.pushFeed('you', st.resumeAt ? 'paused intake until ' + st.resumeAt : 'paused intake');
        return done(json(st));
      }
      if (p === '/api/intake/resume' && write) {
        const b = await body<any>(req);
        const st = store.resumeIntake(b.catchUp !== false);
        engine.pushFeed('you', b.catchUp !== false ? 'resumed intake and asked it to catch up' : 'resumed intake from now');
        return done(json(st));
      }
      if (p === '/api/sessions/spawn' && write) {
        // Quick action: a new herdr tab running Claude Code, optionally with a first prompt.
        const b = await body<any>(req);
        const name = str(b.name, 'name', 40).trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$/.test(name)) return json({ error: 'Name: letters, digits, - and _ only (2-40 characters).' }, 400);
        if (engine.snapshot().sessions.some((x) => x.name === name)) return json({ error: `A session named ${name} is already running.` }, 409);
        const cwd = str(b.cwd, 'cwd', 400).trim();
        if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return json({ error: 'That folder does not exist.' }, 400);
        const model = optStr(b.model, 20);
        if (model && !['sonnet', 'opus', 'haiku', 'fable'].includes(model)) return json({ error: 'Unknown model.' }, 400);
        const first = optStr(b.prompt, 8000)?.trim();
        // herdr waits for Claude to be ready (several seconds); answer now and report the result in the feed.
        // A folder Claude has not seen before asks "trust this folder?": ShiftBoss never answers it (see spawnOne).
        const spec = { name, cwd, model: model ?? null, prompt: first ?? null };
        const g = await engine.act('spawn', { spec }, { actor: actorOf(req), by: byOf(req, b), summary: `start a new session ${name} in ${cwd}`, detail: first ?? '' });
        if (g.status === 'done') engine.pushFeed('you', `starting session ${name}`);
        return done(gated(g, () => json({ ok: true, name }, 202)));
      }
      if (p === '/api/sessions/spawn-many' && write) {
        // Start up to SPAWN_MANY_CAP sessions, one after another. Every row is checked like a single
        // spawn before any starts, so a typo never leaves half a batch running.
        const b = await body<any>(req);
        const specs = checkSpawnMany(b.sessions, engine.sessions.map((x) => x.name));
        const g = await engine.act('spawn-many', { specs }, { actor: actorOf(req), by: byOf(req, b), summary: `start ${specs.length} new sessions: ${specs.map((x) => x.name).join(', ')}` });
        return done(gated(g, () => json({ ok: true, names: specs.map((x) => x.name) }, 202)));
      }
      if (p === '/api/sessions/replace' && write) {
        const b = await body<any>(req);
        const names: string[] = Array.isArray(b.sessions) ? [...new Set<string>(b.sessions.filter((x: unknown) => typeof x === 'string' && x.trim()).map((x: string) => x.trim()))] : [];
        if (!names.length) return json({ error: 'Pick at least one session.' }, 400);
        if (names.length > SPAWN_MANY_CAP) return json({ error: `At most ${SPAWN_MANY_CAP} sessions at once.` }, 400);
        for (const n of names) if (!engine.sessions.some((x) => x.name === n)) return json({ error: n + ' is not running in herdr' }, 400);
        const g = await engine.act('replace', { names }, { actor: actorOf(req), by: byOf(req, b), summary: `replace ${names.join(', ')} with fresh sessions through a handoff` });
        return done(gated(g, (res) => {
          const results = res.results as { id?: number; error?: string }[];
          return results.some((x) => x.id) ? json({ results }, 202) : json({ error: results.map((x) => x.error).join('; '), results }, 400);
        }));
      }
      r = m(/^\/api\/replacements\/(\d+)\/cancel$/);
      if (r && write) { engine.cancelReplacement(Number(r[1])); return done(json({ ok: true })); }
      // ----- approvals and mode (server/gate.ts) -----
      r = m(/^\/api\/actions\/(\d+)\/(approve|reject)$/);
      if (r && write) {
        if (actorOf(req) !== 'owner') return fail('Only the owner can approve or reject, from ShiftBoss itself', 403);
        if (r[2] === 'reject') { engine.rejectAction(Number(r[1])); return done(json({ ok: true })); }
        return done(json({ ok: true, result: await engine.approveAction(Number(r[1])) }));
      }
      if (p === '/api/actions/decide-all' && write) {
        if (actorOf(req) !== 'owner') return fail('Only the owner can approve or reject, from ShiftBoss itself', 403);
        const b = await body<any>(req);
        const ids = store.listActions().filter((a) => a.state === 'waiting').map((a) => a.id);
        let ok = 0; const failed: string[] = [];
        for (const id of ids) {
          try { if (b.approve) await engine.approveAction(id); else engine.rejectAction(id); ok++; } catch (e) { failed.push((e as Error).message.slice(0, 120)); }
        }
        return done(json({ ok, failed }));
      }
      if (p === '/api/mode' && write) {
        // Switching modes. Leaving Dry run, what it recorded is either reviewed (it becomes approvals) or dropped.
        if (actorOf(req) !== 'owner') return fail('Only the owner can change the mode, from ShiftBoss itself', 403);
        const b = await body<any>(req);
        if (!isMode(b.mode)) return fail('mode must be dry, ask, safe or auto');
        const was = store.settings().mode ?? 'auto';
        store.saveSettings(mergeSettings(store.settings(), { mode: b.mode }));
        const settled = was === 'dry' && b.mode !== 'dry' ? store.settleDryActions(b.dryRun === 'review') : 0;
        engine.pushFeed('you', `switched to ${MODE_LABEL[b.mode as Mode]}` + (settled ? `; ${settled} dry-run action${settled === 1 ? '' : 's'} ${b.dryRun === 'review' ? 'moved to Needs you' : 'dropped'}` : ''));
        return done(json({ mode: b.mode, settled }));
      }
      // ----- monitors -----
      if (p === '/api/monitors' && req.method === 'GET') {
        const ms = store.listMonitors();
        const ms2 = engine.monitorSession();
        const lead = resolveLead(engine.sessions, store.settings().leadSession ?? '');
        return json({
          monitors: ms.map((x) => ({ ...x, checks: store.monitorChecks(x.id, 200) })),
          session: ms2 ? { name: ms2.name, status: ms2.status, cwd: ms2.cwd } : null,
          sessionName: MONITOR_SESSION, leadCwd: lead?.cwd ?? null,
          startPrompt: monitorSessionPrompt(engine.cfg.ownerName, setupInfo(engine.cfg.port).repoPath),
        });
      }
      if (p === '/api/monitors' && req.method === 'POST') {
        const mon = store.addMonitor(monitorInput(await body<any>(req), store, true) as Parameters<typeof store.addMonitor>[0]);
        engine.pushFeed('you', `started watching ${mon.title} for ${mon.durationDays} day${mon.durationDays === 1 ? '' : 's'}, every ${mon.intervalHours} h`);
        return done(json(mon, 201));
      }
      r = m(/^\/api\/monitors\/(\d+)$/);
      if (r && req.method === 'GET') return json({ ...store.getMonitor(Number(r[1])), checks: store.monitorChecks(Number(r[1]), 200) });
      if (r && req.method === 'PATCH') {
        const id = Number(r[1]);
        const b = await body<any>(req);
        let mon = store.getMonitor(id);
        const edit = monitorInput(b, store, false);
        if (Object.keys(edit).length) mon = store.updateMonitor(id, edit);
        if (b.action !== undefined) {
          if (!['pause', 'resume', 'stop'].includes(b.action)) throw new Error('action must be pause, resume or stop');
          mon = store.setMonitorState(id, b.action);
          engine.pushFeed('you', `${b.action === 'pause' ? 'paused' : b.action === 'resume' ? 'resumed' : 'stopped'} the monitor for ${mon.title}`);
        }
        return done(json(mon));
      }
      r = m(/^\/api\/monitors\/(\d+)\/check-now$/);
      if (r && write) {
        const id = Number(r[1]);
        store.getMonitor(id); // 404 for an unknown id
        const s = engine.monitorSession();
        if (!s) return fail(`No monitor session is running, so nobody can check. Start it on the Monitors page (a session named ${MONITOR_SESSION}).`, 409);
        const mon = store.checkMonitorNow(id);
        if (actorOf(req) === 'owner') engine.ownerMonitorChecks.add(id); // the owner's click: runs in every mode
        const busy = s.status !== 'idle' && s.status !== 'done';
        const queued = !!store.monitorInFlight();
        engine.pushFeed('you', `asked for a check of ${mon.title} now`);
        return done(json({ ...mon, session: s.name, waiting: s.status === 'blocked' ? `${s.name} is waiting on a prompt in herdr; the check goes once you answer it there`
          : busy ? `${s.name} is busy; the check goes when it is idle` : queued ? 'another check is running; this one goes next' : null }));
      }
      r = m(/^\/api\/monitors\/(\d+)\/report$/);
      if (r && write) {
        const b = await body<any>(req);
        if (!['ok', 'warn', 'bad', 'error'].includes(b.verdict)) throw new Error('verdict must be ok, warn, bad or error');
        const links: string[] = Array.isArray(b.links) ? b.links.slice(0, 5).map((u: unknown) => safeUrl(u)).filter((u: string | null): u is string => !!u) : [];
        const res = store.reportMonitor(Number(r[1]), { verdict: b.verdict, summary: str(b.summary, 'summary', 500), details: optStr(b.details, 4000), links });
        engine.pushFeed('monitor', `${res.monitor.title}: ${b.verdict}, ${res.check.summary}`);
        if (res.becameAlerting) engine.pushFeed('monitor', `${res.monitor.title} is alerting`);
        return done(json(res));
      }
      // ----- self-update -----
      if (p === '/api/update' && req.method === 'GET') return json(engine.updateStatus() ?? { supported: false });
      if (p === '/api/update/check' && write) {
        if (!engine.updater) return fail('Updates are not available here', 404);
        const b = await body<any>(req).catch(() => ({}));
        const st = await engine.updater.check(b?.apply !== false);
        engine.emit();
        return done(json(st));
      }
      // ----- sessions that run outside herdr -----
      if (p === '/api/outside-sessions' && req.method === 'GET') {
        const days = Math.min(60, Math.max(1, Number(url.searchParams.get('days')) || 14));
        return json(outsideNow(days));
      }
      if (p === '/api/sessions/bring-in' && write) {
        // Reopen sessions from plain Claude Code (CLI, TUI, desktop app) inside herdr with `claude --resume`.
        const b = await body<any>(req);
        const rows: any[] = Array.isArray(b.sessions) ? b.sessions : [];
        if (!rows.length) throw new Error('Pick at least one session.');
        if (rows.length > SPAWN_MANY_CAP) throw new Error(`At most ${SPAWN_MANY_CAP} at once.`);
        const known = new Map(outsideNow(60).map((o) => [o.sessionId, o]));
        const specs = checkSpawnMany(rows.map((r) => {
          if (!isSessionId(r?.sessionId)) throw new Error('Each row needs a Claude session id.');
          const o = known.get(r.sessionId);
          if (!o) throw new Error(`No history found for ${r.sessionId}, or it is already running in herdr.`);
          if (!o.cwdExists) throw new Error(`${o.suggestedName}: its folder ${o.cwd} no longer exists.`);
          return { name: typeof r.name === 'string' && r.name.trim() ? r.name : o.suggestedName, cwd: o.cwd, model: null, prompt: null };
        }), engine.takenNames()).map((spec, i) => ({ ...spec, resume: rows[i].sessionId }));
        const g = await engine.act('bring-in', { specs }, { actor: actorOf(req), by: byOf(req, b), summary: `reopen ${specs.length} session${specs.length === 1 ? '' : 's'} in herdr: ${specs.map((x) => x.name).join(', ')}` });
        return done(gated(g, () => json({ ok: true, starting: specs.map((x) => x.name) }, 202)));
      }
      // ----- first-run onboarding -----
      if (p === '/api/onboarding' && req.method === 'GET') {
        // Everything a setup run (Claude, the CLI or the Get started screen) needs to decide the next step.
        const snap = engine.snapshot();
        const ob = store.onboarding();
        const intake = snap.sessions.find((x) => /intake/i.test(x.name));
        return json({
          setup: setupInfo(engine.cfg.port), onboarding: ob, owner: engine.cfg.ownerName, herdrOk: snap.herdrOk, herdrError: snap.herdrError,
          settings: { leadSession: snap.settings.leadSession ?? '', herdrWorkspace: snap.settings.herdrWorkspace ?? '', watchedChannels: snap.settings.watchedChannels ?? [] },
          sessions: snap.sessions.map((x) => ({ name: x.name, status: x.status, cwd: x.cwd, tasks: snap.tasks.filter((t) => t.session === x.name).length, askedAt: ob.asked[x.name] ?? null, usesTools: x.usesShiftbossTools })),
          intake: { running: intake?.name ?? null, state: snap.intakeState },
          board: { tasks: snap.tasks.length, promises: snap.promises.length },
        });
      }

      if (p === '/api/onboarding/ask' && write) {
        // Ask running sessions to put their current work on the board. Never touches their work.
        const b = await body<any>(req);
        const names: string[] = Array.isArray(b.sessions) ? b.sessions.filter((x: any) => typeof x === 'string').slice(0, 50) : [];
        if (!names.length) return json({ error: 'Pick at least one session.' }, 400);
        const g = await engine.act('onboarding-ask', { sessions: names }, { actor: actorOf(req), by: byOf(req, b), summary: `ask ${names.length} session(s) to put their work on the board: ${names.join(', ')}` });
        return done(gated(g, (res) => json(res)));
      }
      if (p === '/api/onboarding/backfill' && write) {
        const b = await body<any>(req);
        const days = Number(b.days);
        if (![1, 2, 3, 7, 14].includes(days)) return json({ error: 'days must be 1, 2, 3, 7 or 14' }, 400);
        const st = store.backfillIntake(new Date(Date.now() - days * 864e5).toISOString());
        const s = engine.snapshot().sessions.find((x) => /intake/i.test(x.name));
        // The read-back time is saved either way: the intake starts from it on its next run. A nudge now just
        // saves waiting for the loop; if the tab is at a startup or permission prompt, it waits for the owner.
        let prompted = false, waiting: string | null = null;
        if (s) {
          try { await engine.herdr.prompt(s.paneId, `${engine.cfg.ownerName} is setting up ShiftBoss and sent you back ${days} day(s). Run one pass now: intake_begin returns readFrom ${st.since}. Read the whole gap oldest first (Slack and Gmail, as docs/INTAKE.md says), paging until you reach now, file what is open, then intake_checkpoint.`); prompted = true; }
          catch (e) { waiting = /blocked|interactive|not ready/i.test((e as Error).message) ? 'waiting on a prompt in herdr' : (e as Error).message.slice(0, 200); }
        }
        engine.pushFeed('you', `sent the intake back ${days} day(s)`);
        return done(json({ ...st, prompted, intake: s?.name ?? null, waiting }));
      }
      if (p === '/api/onboarding/done' && write) {
        const b = await body<any>(req);
        return done(json(store.saveOnboarding({ doneAt: b.done === false ? null : new Date().toISOString() })));
      }
      if (p === '/api/intake/run' && write) {
        // "Check now": ask the intake session for one pass right away instead of waiting for its loop.
        if (store.intakeState().paused) return json({ error: 'Intake is paused. Resume it first.' }, 409);
        const s = engine.snapshot().sessions.find((x) => /intake/i.test(x.name));
        if (!s) return json({ error: 'No intake session is running in herdr.' }, 404);
        const b = await body<any>(req).catch(() => ({}));
        const g = await engine.act('intake-run', {}, { actor: actorOf(req), by: byOf(req, b), summary: 'ask the intake for a pass now' });
        return done(gated(g, (res) => json(res)));
      }
      if (p === '/api/intake/begin' && write) {
        const st = store.intakeBegin();
        const set = store.settings();
        return done(json({ ...st, run: !st.paused, readFrom: st.since ?? st.catchUpFrom, owner: engine.cfg.ownerName, watchedChannels: set.watchedChannels ?? [], ownerInstructions: set.instructions ?? '',
          note: st.paused ? 'Intake is paused: do nothing this run.' : st.catchUpFrom ? `Catching up: read everything since ${st.since ?? st.catchUpFrom}, oldest first, then checkpoint.` : st.since ? `Read messages newer than ${st.since}.` : 'First run: read the last 2 hours.' }));
      }
      if (p === '/api/intake/checkpoint' && write) {
        const b = await body<any>(req);
        return done(json(store.intakeCheckpoint(str(b.readUntil, 'readUntil', 40))));
      }
      if (p === '/api/intake' && write) {
        const b = await body<any>(req);
        store.addIntake({ src: str(b.src, 'src', 200), who: optStr(b.who, 100) ?? '', text: str(b.text, 'text', 2000), verdict: str(b.verdict, 'verdict', 100), taskId: optStr(b.taskId, 20) ?? null,
          url: safeUrl(b.url) });
        return done(json({ ok: true }, 201));
      }
      r = m(/^\/api\/intake\/(\d+)\/resolve$/);
      if (r && write) { store.resolveIntake(Number(r[1])); return done(json({ ok: true })); }
      if (p === '/api/owner-instructions' && req.method === 'GET') return json({ owner: engine.cfg.ownerName, instructions: store.settings().instructions ?? '' });
      if (p === '/api/intake/days') { const tz = Number(url.searchParams.get('tz') ?? 0); return json(store.intakeCountsByDay(14, Number.isFinite(tz) && Math.abs(tz) <= 14 * 60 ? tz : 0)); }
      if (p === '/api/decisions' && write) { const b = await body<any>(req); store.addDecision(str(b.text, 'text', 500)); return done(json({ ok: true }, 201)); }

      // ----- sessions -----
      r = m(/^\/api\/sessions\/([^/]+)\/(prompt|focus|interrupt|screen|meta)$/);
      if (r) {
        const name = decodeURIComponent(r[1]);
        if (r[2] === 'screen') return json({ text: await engine.herdr.read(session(name).paneId, 80) });
        if (!write) return fail('Use POST', 405);
        if (r[2] === 'prompt') {
          const b = await body<any>(req);
          session(name);
          const text = str(b.text, 'text', 8000);
          const g = await engine.act('prompt', { session: name, text }, { actor: actorOf(req), by: byOf(req, b), summary: `send a prompt to ${name}`, detail: text.slice(0, 1000) });
          if (g.status !== 'done') return done(gated(g, () => json({ ok: true })));
        }
        if (r[2] === 'focus') await engine.herdr.focus(session(name).paneId);
        // Esc on a permission prompt denies it. ShiftBoss never answers a permission prompt, so no interrupt then.
        // The last poll is checked here and herdr's live status again in Herdr.interrupt.
        if (r[2] === 'interrupt') {
          const blocked = () => fail(`${name} is waiting on a permission prompt: answer it in herdr`, 409);
          if (session(name).status === 'blocked') return blocked();
          const b = await body<any>(req).catch(() => ({}));
          let g;
          try { g = await engine.act('interrupt', { session: name }, { actor: actorOf(req), by: byOf(req, b), summary: `stop what ${name} is doing (Esc)` }); }
          catch (e) { if (e instanceof PaneBlockedError || /permission prompt/.test((e as Error).message)) return blocked(); throw e; }
          if (g.status !== 'done') return done(gated(g, () => json({ ok: true })));
        }
        if (r[2] === 'meta') { const b = await body<any>(req); store.setMeta(name, { lane: typeof b.lane === 'string' ? b.lane.trim().slice(0, 300) : undefined, slots: b.slots === undefined ? undefined : Number(b.slots), handoffPath: b.handoffPath === undefined ? undefined : optStr(b.handoffPath, 500) ?? null }); }
        return done(json({ ok: true }));
      }

      // ----- settings, report, dispatcher -----
      if (p === '/api/settings' && req.method === 'PUT') {
        const cur = store.settings();
        const next = mergeSettings(cur, await body<unknown>(req));
        if ((next.instructions ?? '') !== (cur.instructions ?? '')) { next.instructionsPrev = cur.instructions ?? ''; engine.pushFeed('you', 'changed your way of working'); }
        store.saveSettings(next);
        return done(json(next));
      }
      if (p === '/api/owner-instructions' && write) {
        // From the CLI (shiftboss instructions add/set): a session doing it because the owner asked. Logged, undoable.
        const b = await body<any>(req);
        const cur = store.settings();
        const old = cur.instructions ?? '';
        const text = b.add !== undefined ? (old.trim() ? old.trimEnd() + '\n' : '') + '- ' + str(b.add, 'add', 500).trim().replace(/^-\s*/, '')
          : b.set !== undefined ? String(b.set) : b.undo ? cur.instructionsPrev ?? '' : null;
        if (text === null) return fail('Pass add, set or undo');
        store.saveSettings(mergeSettings(cur, { instructions: text, instructionsPrev: old }));
        engine.pushFeed(byOf(req, b), b.undo ? 'restored the previous way of working' : 'updated your way of working');
        return done(json({ instructions: text }));
      }
      if (p === '/api/report') {
        const aud = (['plain', 'team', 'me'].includes(url.searchParams.get('aud') ?? '') ? url.searchParams.get('aud') : 'plain') as Audience;
        return json(buildReport(aud, store.listTasks(), store.listNeeds()));
      }
      if (p === '/api/ready') return json(engine.readyToDispatch());
      if (p === '/api/setup') return json(setupInfo(engine.cfg.port));
      return fail('Not found', 404);
    } catch (e) {
      return fail((e as Error).message, e instanceof NotFound ? 404 : e instanceof HerdrError ? 502 : 400);
    }
  };
}

/**
 * A monitor from a request body. `create`: title, prompt, days and hours are required. Otherwise only the
 * fields present are returned, for an edit. Links must be http(s); a task must exist.
 */
function monitorInput(b: any, store: Engine['store'], create: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (create || b.title !== undefined) out.title = str(b.title, 'title', 200);
  if (create || b.prompt !== undefined) out.prompt = str(b.prompt, 'what to check', 4000);
  if (b.links !== undefined) {
    if (typeof b.links !== 'object' || b.links === null) throw new Error('links must be { pr, ticket, dashboard }');
    const l: Record<string, string | null> = {};
    for (const k of ['pr', 'ticket', 'dashboard'] as const) if (b.links[k] !== undefined) l[k] = safeUrl(b.links[k]);
    out.links = l;
  }
  if (b.taskId !== undefined) {
    const t = optStr(b.taskId, 20) ?? null;
    if (t && (!/^T-\d+$/.test(t) || !store.getTask(t))) throw new Error('No task ' + t);
    out.taskId = t;
  }
  if (create || b.durationDays !== undefined) {
    const d = Number(b.durationDays);
    if (!(MONITOR_DAYS as readonly number[]).includes(d)) throw new Error('days must be ' + MONITOR_DAYS.join(', '));
    out.durationDays = d;
  }
  if (create || b.intervalHours !== undefined) {
    const h = Number(b.intervalHours);
    if (!(MONITOR_HOURS as readonly number[]).includes(h)) throw new Error('every must be ' + MONITOR_HOURS.join(', ') + ' hours');
    out.intervalHours = h;
  }
  return out;
}

/** A promise's due time: an ISO date or time, stored as ISO, or nothing. */
function dueIso(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  const t = Date.parse(String(v));
  if (!Number.isFinite(t)) throw new Error('due must be a date or time, e.g. 2026-12-01 or 2026-12-01T17:00');
  return new Date(t).toISOString();
}
