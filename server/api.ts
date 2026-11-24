// HTTP API. Every write needs the X-ShiftBoss header, so a web page on another origin
// cannot trigger one (the custom header forces a CORS preflight that we never allow).
import type { Need, PromiseItem, Settings, SlackMsg, Stage, Task, TaskEvent } from '../shared/types';
import type { Engine } from './engine';
import { buildReport, type Audience } from './report';
import { setupInfo } from './setup';

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
  const session = (name: string) => {
    const s = engine.sessions.find((x) => x.name === name);
    if (!s) throw new Error(name + ' is not running in herdr');
    return s;
  };

  return async function handle(req: Request, url: URL): Promise<Response | null> {
    const p = url.pathname;
    if (!p.startsWith('/api/')) return null;
    const write = req.method !== 'GET';
    if (write && req.headers.get('x-shiftboss') !== '1') return fail('Missing X-ShiftBoss header', 403);
    const m = (re: RegExp) => p.match(re);
    try {
      if (p === '/api/snapshot' && req.method === 'GET') return json(engine.snapshot());

      if (p === '/api/stream' && req.method === 'GET') {
        let off: (() => void) | null = null;
        let pending: ReturnType<typeof setTimeout> | null = null;
        const stream = new ReadableStream({
          start(ctrl) {
            const enc = new TextEncoder();
            const send = () => { try { ctrl.enqueue(enc.encode('data: ' + JSON.stringify(engine.snapshot()) + '\n\n')); } catch { off?.(); } };
            send();
            off = engine.onChange(() => { if (!pending) pending = setTimeout(() => { pending = null; send(); }, 250); });
          },
          cancel() { off?.(); if (pending) clearTimeout(pending); },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } });
      }

      // ----- tasks -----
      if (p === '/api/tasks' && req.method === 'POST') {
        const b = await body<any>(req);
        const t = store.addTask({ title: str(b.title, 'title', 300), ask: optStr(b.ask), requester: optStr(b.requester, 100), source: optStr(b.source, 200),
          sourceUrl: optStr(b.sourceUrl, 500) ?? null, session: optStr(b.session, 100) ?? null, prio: ['P1', 'P2', 'P3'].includes(b.prio) ? b.prio : 'P2' });
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
        return done(json(store.updateTask(r[1], patch, optStr(b.who, 100) ?? 'you')));
      }
      r = m(/^\/api\/tasks\/(T-\d+)\/dispatch$/);
      if (r && write) { await engine.dispatchTask(r[1]); return done(json({ ok: true })); }
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
        store.addAudit({ where: 'Slack', channel: '', text: msg.text, by: store.getTask(msg.task_id)?.session ?? '', approval: 'approved by you' });
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
              sourceUrl: optStr(t.sourceUrl, 500) ?? null, session: optStr(t.session, 100) ?? null, stage: stage as Stage, prio: ['P1', 'P2', 'P3'].includes(t.prio) ? t.prio : 'P2', held: !!t.held,
              links: Array.isArray(t.links) ? t.links.filter((l: any) => typeof l?.url === 'string').slice(0, 10) : [] });
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
        const pr = store.addPromise({ to: str(b.to, 'to', 100), where: optStr(b.where, 200), said: str(b.said, 'said', 1000), keptWhen: optStr(b.keptWhen, 300), taskId: optStr(b.taskId, 20) ?? null, dueAt: optStr(b.dueAt, 40) ?? null });
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
        const answers = Array.isArray(b.answers) ? b.answers.map((a: unknown) => str(a, 'answer', 60)).slice(0, 4) : [];
        if (!answers.length) throw new Error('answers must list 1-4 choices');
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
      if (p === '/api/intake/run' && write) {
        // "Check now": ask the intake session for one pass right away instead of waiting for its loop.
        if (store.intakeState().paused) return json({ error: 'Intake is paused. Resume it first.' }, 409);
        const s = engine.snapshot().sessions.find((x) => /intake/i.test(x.name));
        if (!s) return json({ error: 'No intake session is running in herdr.' }, 404);
        const repo = setupInfo(engine.cfg.port).repoPath;
        await engine.herdr.prompt(s.paneId, `${engine.cfg.ownerName} asked for an intake check now. Run one pass immediately, exactly as ${repo}/docs/INTAKE.md says: intake_begin, then Slack, then Gmail (meeting notes and emails with asks), then intake_checkpoint. Then carry on with your normal loop.`);
        engine.pushFeed('you', 'asked the intake for a check now');
        return done(json({ ok: true, session: s.name, busy: s.status === 'working' }));
      }
      if (p === '/api/intake/begin' && write) {
        const st = store.intakeBegin();
        return done(json({ ...st, run: !st.paused, readFrom: st.since ?? st.catchUpFrom,
          note: st.paused ? 'Intake is paused: do nothing this run.' : st.catchUpFrom ? `Catching up: read everything since ${st.since ?? st.catchUpFrom}, oldest first, then checkpoint.` : st.since ? `Read messages newer than ${st.since}.` : 'First run: read the last 2 hours.' }));
      }
      if (p === '/api/intake/checkpoint' && write) {
        const b = await body<any>(req);
        return done(json(store.intakeCheckpoint(str(b.readUntil, 'readUntil', 40))));
      }
      if (p === '/api/intake' && write) {
        const b = await body<any>(req);
        store.addIntake({ src: str(b.src, 'src', 200), who: optStr(b.who, 100) ?? '', text: str(b.text, 'text', 2000), verdict: str(b.verdict, 'verdict', 100), taskId: optStr(b.taskId, 20) ?? null,
          url: optStr(b.url, 500) && /^https:\/\//.test(b.url) ? b.url.trim() : null });
        return done(json({ ok: true }, 201));
      }
      if (p === '/api/intake/days') return json(store.intakeCountsByDay());
      if (p === '/api/decisions' && write) { const b = await body<any>(req); store.addDecision(str(b.text, 'text', 500)); return done(json({ ok: true }, 201)); }

      // ----- sessions -----
      r = m(/^\/api\/sessions\/([^/]+)\/(prompt|focus|interrupt|screen|meta)$/);
      if (r) {
        const name = decodeURIComponent(r[1]);
        if (r[2] === 'screen') return json({ text: await engine.herdr.read(session(name).paneId, 80) });
        if (!write) return fail('Use POST', 405);
        if (r[2] === 'prompt') { const b = await body<any>(req); await engine.herdr.prompt(session(name).paneId, str(b.text, 'text', 8000)); engine.pushFeed('you', '→ ' + name); }
        if (r[2] === 'focus') await engine.herdr.focus(session(name).paneId);
        if (r[2] === 'interrupt') { await engine.herdr.interrupt(session(name).paneId); engine.pushFeed('you', 'interrupted ' + name); }
        if (r[2] === 'meta') { const b = await body<any>(req); store.setMeta(name, { lane: optStr(b.lane, 300), slots: b.slots === undefined ? undefined : Number(b.slots), handoffPath: b.handoffPath === undefined ? undefined : optStr(b.handoffPath, 500) ?? null }); }
        return done(json({ ok: true }));
      }

      // ----- settings, report, dispatcher -----
      if (p === '/api/settings' && req.method === 'PUT') {
        const b = await body<Settings>(req);
        const cur = store.settings();
        const next: Settings = { ...cur, ...b, thresholds: { ...cur.thresholds, ...b.thresholds }, switches: { ...cur.switches, ...b.switches }, budgets: { ...cur.budgets, ...b.budgets } };
        store.saveSettings(next);
        return done(json(next));
      }
      if (p === '/api/report') {
        const aud = (['plain', 'team', 'me'].includes(url.searchParams.get('aud') ?? '') ? url.searchParams.get('aud') : 'plain') as Audience;
        return json(buildReport(aud, store.listTasks(), store.listNeeds()));
      }
      if (p === '/api/ready') return json(engine.readyToDispatch());
      if (p === '/api/setup') return json(setupInfo(engine.cfg.port));
      return fail('Not found', 404);
    } catch (e) {
      return fail((e as Error).message, 400);
    }
  };
}
