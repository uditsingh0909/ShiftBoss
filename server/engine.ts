// The engine polls herdr, transcripts and status-line data, keeps the store in sync
// (auto "needs you" items for blocked panes, dispatch), and builds the snapshot the UI streams.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentStatus, EnvVersion, Limits, MergedPr, Session, Snapshot } from '../shared/types';
import { healthOf, loopKeys, overlapsOf } from './analysis';
import { contextWindowFor, type Config } from './config';
import { Store } from './db';
import { Herdr, nameOf, type HerdrAgent } from './herdr';
import { parseFooter, readTap, type StatusInfo } from './statusline';
import { contains, fetchPr, targetStage, taskIdsIn } from './github';
import { heatOf, Transcripts } from './transcripts';

type Listener = () => void;

export class Engine {
  sessions: Session[] = [];
  herdrOk = false;
  herdrError: string | null = null;
  private status = new Map<string, StatusInfo>(); // by session name
  private footerTurn = 0;
  private feed: { at: string; who: string; text: string }[] = [];
  private lastStatus = new Map<string, AgentStatus>();
  private releases: Snapshot['releases'] = { envs: [], merged: [], freeze: null };
  private listeners = new Set<Listener>();
  private transcripts: Transcripts;
  private timer: ReturnType<typeof setInterval> | null = null;
  private relTimer: ReturnType<typeof setInterval> | null = null;
  private ghTimer: ReturnType<typeof setInterval> | null = null;
  private ghBusy = false;
  private busy = false;

  constructor(public cfg: Config, public store: Store, public herdr: Herdr) {
    this.transcripts = new Transcripts(cfg.transcriptsDir);
  }

  onChange(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(); }
  pushFeed(who: string, text: string) {
    this.feed.unshift({ at: new Date().toISOString(), who, text });
    this.feed = this.feed.slice(0, 60);
  }

  start() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.cfg.pollMs);
    void this.pollReleases();
    this.relTimer = setInterval(() => void this.pollReleases(), 5 * 60e3);
    setTimeout(() => void this.pollGitHub(), 15e3);
    this.ghTimer = setInterval(() => void this.pollGitHub(), 2 * 60e3);
  }
  stop() { for (const t of [this.timer, this.relTimer, this.ghTimer]) if (t) clearInterval(t); }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const settings = this.store.settings();
      const intake = this.store.intakeState();
      if (intake.paused && intake.resumeAt && Date.parse(intake.resumeAt) <= Date.now()) {
        this.store.resumeIntake(true);
        this.pushFeed('intake', 'resumed on schedule; catching up on what came in while paused');
      }
      let agents: HerdrAgent[] = [];
      try {
        agents = await this.herdr.list(settings.herdrWorkspace || this.cfg.herdrWorkspace);
        this.herdrOk = true; this.herdrError = null;
      } catch (e) {
        this.herdrOk = false; this.herdrError = (e as Error).message;
      }
      // Footer text from one pane per tick keeps herdr load flat.
      if (agents.length) {
        const a = agents[this.footerTurn++ % agents.length];
        try {
          const f = parseFooter(await this.herdr.read(a.pane_id, 6));
          if (f) this.status.set(nameOf(a), f);
        } catch { /* pane busy */ }
      }
      this.sessions = agents.map((a) => this.buildSession(a));
      this.syncNeeds();
      await this.flushAnswers();
      this.dispatch(settings.switches.autoDispatch);
      this.emit();
    } catch (e) {
      this.pushFeed('shiftboss', 'poll failed: ' + (e as Error).message); // next tick retries
    } finally {
      this.busy = false;
    }
  }

  private buildSession(a: HerdrAgent): Session {
    const name = nameOf(a);
    const sid = a.agent_session?.value ?? null;
    const st = sid ? this.transcripts.read(sid) : null;
    const tap = sid ? readTap(this.cfg.dataDir, sid) : null;
    const foot = this.status.get(name) ?? null;
    const info = tap && Date.now() - tap.at < 15 * 60e3 ? tap : foot;
    if (tap) this.status.set(name, tap);
    const model = st?.model ?? null;
    const window = contextWindowFor(this.cfg, model);
    const ctxTokens = st?.contextTokens ?? 0;
    const contextPct = info?.ctxPct ?? (window ? Math.min(100, (ctxTokens / window) * 100) : 0);
    const meta = this.store.meta(name) ?? { lane: this.cfg.lanes[name]?.lane ?? '', slots: this.cfg.lanes[name]?.slots ?? 2, handoffPath: null };
    const settings = this.store.settings();
    const handoffsDir = settings.handoffsDir || this.cfg.handoffsDir;
    const handoffPath = meta.handoffPath ?? (handoffsDir ? join(handoffsDir, name + '.md') : null);
    let handoffAgeMin: number | null = null;
    if (handoffPath && existsSync(handoffPath)) handoffAgeMin = Math.round((Date.now() - statSync(handoffPath).mtimeMs) / 60e3);
    const nowMs = Date.now();
    const tokensSince = (ms: number) => (st?.usage ?? []).filter((u) => u.at > nowMs - ms).reduce((s, u) => s + u.tokens, 0);
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const status = (['working', 'idle', 'done', 'blocked'].includes(a.agent_status) ? a.agent_status : 'unknown') as AgentStatus;
    const prev = this.lastStatus.get(name);
    if (prev && prev !== status) this.pushFeed(name, status === 'blocked' ? 'waiting for permission' : status === 'done' ? 'finished its turn' : status);
    this.lastStatus.set(name, status);
    const loops = loopKeys(st?.tools ?? [], settings.thresholds.loopRepeats);
    return {
      name, paneId: a.pane_id, sessionId: sid, status, cwd: a.cwd, model: info?.model ?? model,
      contextTokens: ctxTokens, contextWindow: window, contextPct,
      tokensToday: tokensSince(nowMs - startOfDay.getTime()), tokens5h: tokensSince(5 * 3600e3),
      lastActivity: st?.lastActivity ? new Date(st.lastActivity).toISOString() : null,
      lastTool: st?.tools.at(-1)?.name ?? null,
      lines: (st?.lines ?? []).slice(-60).map(({ at, kind, text }) => ({ at, kind, text })),
      heat: heatOf(st, loops),
      filesTouched: [...new Set((st?.tools ?? []).flatMap((t) => t.files))],
      lane: meta.lane, slots: meta.slots, handoffPath, handoffAgeMin, prUrls: st?.prUrls ?? [],
      usesShiftbossTools: (st?.tools ?? []).some((t) => t.name.startsWith('mcp__shiftboss__')),
      exactUsage: !!tap && Date.now() - tap.at < 15 * 60e3,
    };
  }

  /** A blocked pane becomes a Permission item; it closes itself once the pane moves on. */
  private syncNeeds() {
    for (const s of this.sessions) {
      const open = this.store.openAutoNeedFor(s.name);
      if (s.status === 'blocked' && !open) {
        const last = s.lines.filter((l) => l.kind === 'tool').at(-1);
        this.store.addNeed({ kind: 'Permission', source: s.name + ' · herdr ' + s.paneId, title: `${s.name} is waiting for your permission.`,
          body: 'Approve or deny it in herdr. ShiftBoss never answers a permission prompt for you.', code: last ? '⏺ ' + last.text : '',
          answers: ['Open in herdr'], session: s.name, auto: true });
        this.pushFeed(s.name, 'needs your permission');
      } else if (s.status !== 'blocked' && open) {
        this.store.answerNeed(open.id, 'Answered in herdr');
      }
    }
    // A pane that was closed can never answer: close its item. Only when herdr answered this tick,
    // so a herdr hiccup does not wipe every open item.
    if (this.herdrOk) {
      const running = new Set(this.sessions.map((s) => s.name));
      for (const n of this.store.openAutoNeeds()) if (n.session && !running.has(n.session)) this.store.answerNeed(n.id, 'Session closed');
    }
  }

  /** Deliver answers whose undo window has passed. */
  private async flushAnswers() {
    for (const n of this.store.pendingAnswers(10_000)) {
      const s = n.session ? this.sessions.find((x) => x.name === n.session) : null;
      try {
        if (s) await this.herdr.prompt(s.paneId, `${this.cfg.ownerName}'s answer to "${n.title}": ${n.answer}`);
        this.store.markSent(n.id);
        if (n.taskId) this.store.addEvent(n.taskId, 'ShiftBoss', 'shiftboss', s ? `Sent the answer to ${s.name}` : 'Answer recorded; no running session to send it to');
      } catch (e) {
        this.pushFeed('shiftboss', `could not send answer to ${n.session}: ${(e as Error).message}`);
      }
    }
  }

  briefFor(taskId: string): string {
    const t = this.store.getTask(taskId);
    if (!t) throw new Error('No task ' + taskId);
    return [`ShiftBoss task ${t.id} (${t.prio}): ${t.title}`, t.ask ? 'Ask: ' + t.ask : '', t.requester || t.source ? `From: ${t.requester} ${t.source} ${t.sourceUrl ?? ''}`.trim() : '',
      `Put "ShiftBoss: ${t.id}" in your PR description: ShiftBoss then moves this task to PR open, On dev and Live by itself.`,
      `Done means merged, live on dev and checked, and the requester told. When you have told them, use the shiftboss task_stage tool with stage "told" (or run: shiftboss task stage ${t.id} told).`].filter(Boolean).join('\n');
  }

  /** Send a queued task to its session now. */
  async dispatchTask(taskId: string, who = 'you') {
    const t = this.store.getTask(taskId);
    if (!t?.session) throw new Error('Assign a session first');
    const s = this.sessions.find((x) => x.name === t.session);
    if (!s) throw new Error(t.session + ' is not running in herdr');
    await this.herdr.prompt(s.paneId, this.briefFor(taskId));
    this.store.updateTask(taskId, { stage: 2 }, who);
    this.store.addEvent(taskId, 'ShiftBoss', 'dispatcher', 'Sent the brief to ' + s.name);
    this.pushFeed('dispatcher', `${taskId} → ${s.name}`);
  }

  /** Tasks that can go now: queued, session idle with a free slot. */
  readyToDispatch(): string[] {
    const tasks = this.store.listTasks();
    const out: string[] = [];
    for (const s of this.sessions) {
      if (s.status !== 'idle' && s.status !== 'done') continue;
      const active = tasks.filter((t) => t.session === s.name && t.stage >= 2 && t.stage <= 4 && !t.held).length;
      const next = tasks.filter((t) => t.session === s.name && t.stage === 1 && !t.held).at(-1); // oldest (list is newest first)
      if (next && active < s.slots) out.push(next.id);
    }
    return out;
  }

  private dispatch(auto: boolean) {
    if (!auto) return;
    for (const id of this.readyToDispatch()) void this.dispatchTask(id, 'dispatcher').catch((e) => this.pushFeed('dispatcher', 'could not send ' + id + ': ' + e.message));
  }

  limits(): Limits {
    const settings = this.store.settings();
    const infos = [...this.status.values()].filter((i) => i.fiveHourPct != null || i.weeklyPct != null).sort((a, b) => b.at - a.at);
    const tok5 = this.sessions.reduce((s, x) => s + x.tokens5h, 0);
    if (infos.length) {
      const i = infos[0];
      return { fiveHourPct: i.fiveHourPct ?? 0, weeklyPct: i.weeklyPct ?? 0, fiveHourTokens: tok5, weeklyTokens: 0, estimate: false };
    }
    const b = settings.budgets;
    return { fiveHourPct: b.fiveHourTokens ? (tok5 / b.fiveHourTokens) * 100 : 0, weeklyPct: 0, fiveHourTokens: tok5, weeklyTokens: 0, estimate: true };
  }

  private async pollReleases() {
    const envs: EnvVersion[] = await Promise.all(this.cfg.releaseEnvs.map(async (e) => {
      try {
        const r = await fetch(e.url, { signal: AbortSignal.timeout(5000) });
        const body = await r.text();
        let version = body.trim().slice(0, 60);
        try { const j = JSON.parse(body); version = String(j.version ?? j.message ?? j.commit ?? version); } catch { /* plain text */ }
        return { name: e.name, url: e.url, version, ok: r.ok, checkedAt: new Date().toISOString() };
      } catch { return { name: e.name, url: e.url, version: null, ok: false, checkedAt: new Date().toISOString() }; }
    }));
    let merged: MergedPr[] = [];
    let freeze: boolean | null = null;
    if (this.cfg.releaseRepo) {
      try {
        const p = Bun.spawn(['gh', 'pr', 'list', '--repo', this.cfg.releaseRepo, '--state', 'merged', '--limit', '15', '--json', 'number,title,author,mergedAt,url'], { stdout: 'pipe', stderr: 'pipe' });
        const out = await new Response(p.stdout).text();
        if ((await p.exited) === 0) merged = JSON.parse(out).map((x: any) => ({ number: x.number, title: x.title, author: x.author?.login ?? '', mergedAt: x.mergedAt, url: x.url }));
      } catch { /* gh missing */ }
    }
    if (this.cfg.freezeVar) {
      try {
        const p = Bun.spawn(['gh', 'variable', 'get', this.cfg.freezeVar.name, '--repo', this.cfg.freezeVar.repo], { stdout: 'pipe', stderr: 'pipe' });
        const out = (await new Response(p.stdout).text()).trim();
        if ((await p.exited) === 0) freeze = out.toLowerCase() === 'true';
      } catch { /* gh missing */ }
    }
    this.releases = { envs, merged, freeze };
    this.emit();
  }

  /**
   * Move tasks forward from the PRs sessions opened (seen in their transcripts) and from which
   * environments already run the merge. See server/github.ts for the rules.
   */
  async pollGitHub() {
    if (this.ghBusy) return;
    this.ghBusy = true;
    try {
      const urls = [...new Set(this.sessions.flatMap((s) => s.prUrls))];
      const devSha = this.releases.envs.find((e) => /dev/i.test(e.name))?.version ?? null;
      const prodSha = this.releases.envs.find((e) => /prod/i.test(e.name))?.version ?? null;
      for (const url of urls) {
        const known = this.store.prLink(url);
        if (known?.done) continue;
        let pr;
        try { pr = await fetchPr(url); } catch { continue; }
        if (!pr) continue;
        try {
        const ids = taskIdsIn(`${pr.title}
${pr.body}
${pr.branch}`).filter((id) => this.store.getTask(id));
        let onDev = false, onProd = false;
        const shipsHere = pr.repo === this.cfg.releaseRepo;
        if (pr.state === 'MERGED' && pr.mergeSha && shipsHere) {
          try { if (prodSha) onProd = await contains(pr.repo, pr.mergeSha, prodSha); } catch { /* compare failed */ }
          try { if (!onProd && devSha) onDev = await contains(pr.repo, pr.mergeSha, devSha); } catch { /* compare failed */ }
        }
        const target = targetStage(pr, onDev || onProd, onProd);
        for (const id of ids) {
          const t = this.store.getTask(id)!;
          const label = `${pr.repo.split('/')[1]} #${pr.number}`;
          if (!known || !known.taskIds.includes(id)) this.store.addEvent(id, 'GitHub', 'github', `${label} ${pr.state === 'OPEN' ? 'opened' : pr.state.toLowerCase()}: ${pr.title}`);
          if (known && known.state !== pr.state && pr.state === 'MERGED') this.store.addEvent(id, 'GitHub', 'github', `${label} merged`);
          if (target !== null && t.stage < target) {
            this.store.updateTask(id, { stage: target as 0 | 1 | 2 | 3 | 4 | 5 | 6 }, 'github');
            this.pushFeed('github', `${id} → ${['', '', '', 'PR open', 'On dev', 'Live'][target]} (${label})`);
          }
        }
        // Finished with this PR once it is closed, live on prod, or merged in a repo ShiftBoss cannot see deploys for.
        const done = pr.state === 'CLOSED' || onProd || (pr.state === 'MERGED' && !shipsHere);
        this.store.savePrLink({ url, taskIds: ids, state: pr.state, mergeSha: pr.mergeSha, repo: pr.repo, number: pr.number, done });
        } catch (e) {
          this.pushFeed('github', `skipped ${url}: ${(e as Error).message}`); // retried next pass
        }
      }
    } finally {
      this.ghBusy = false;
      this.emit();
    }
  }

  snapshot(): Snapshot {
    const settings = this.store.settings();
    const tasks = this.store.listTasks();
    const transcripts = this.sessions.map((s) => ({ s, tools: s.sessionId ? this.transcripts.read(s.sessionId)?.tools ?? [] : [] }));
    return {
      now: new Date().toISOString(),
      herdrOk: this.herdrOk, herdrError: this.herdrError,
      sessions: this.sessions,
      tasks,
      needs: this.store.listNeeds(),
      promises: this.store.listPromises(),
      intake: this.store.listIntake(100),
      decisions: this.store.listDecisions(30),
      health: transcripts.map(({ s, tools }) => healthOf(s, tools, tasks, settings)),
      overlaps: overlapsOf(this.sessions.map((s) => ({ name: s.name, files: s.filesTouched, lines: s.lines })), tasks),
      limits: this.limits(),
      releases: this.releases,
      settings,
      intakeState: this.store.intakeState(),
      onboarding: this.store.onboarding(),
      owner: this.cfg.ownerName,
      feed: this.feed.slice(0, 40),
    };
  }
}
