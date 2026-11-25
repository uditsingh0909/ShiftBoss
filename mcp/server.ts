#!/usr/bin/env bun
// ShiftBoss as MCP tools. A thin layer over the same local HTTP API the CLI uses, so a
// session can report progress without remembering commands.
// Register once (user scope):  claude mcp add --scope user shiftboss -- bun <path-to-shiftboss>/mcp/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { resolvePort } from '../shared/port';

const BASE = `http://127.0.0.1:${resolvePort()}`;

/**
 * `owner`: the owner asked for this in the conversation (or it is setup, which they agreed to). Their decisions
 * (approvals, the mode, settings, answers) need it; ShiftBoss logs which session acted on their behalf.
 */
async function call(method: string, path: string, body?: unknown, owner?: { by?: string }): Promise<any> {
  let res: Response;
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-shiftboss': '1',
    ...(owner ? { 'x-shiftboss-actor': 'owner', 'x-shiftboss-by': owner.by || process.env.SHIFTBOSS_SESSION || 'a session' } : {}) };
  try {
    res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error(`ShiftBoss is not running on ${BASE}. Nothing was recorded.`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  if (res.status === 202 && data?.held) return { ...data, __held: true };
  return data;
}

const OWNER_ASKED = z.literal(true).describe('Set to true ONLY when the owner asked you to do exactly this in this conversation. It is their decision; the feed shows you did it on their behalf.');
const heldOr = (r: any, ok: string) => (r?.__held ? r.message : ok);

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const wrap = <A,>(fn: (a: A) => Promise<string>) => async (a: A) => {
  try { return ok(await fn(a)); } catch (e) { return { ...ok('ShiftBoss: ' + (e as Error).message), isError: true }; }
};
const TASK = z.string().regex(/^T-\d+$/).describe('ShiftBoss task id, e.g. T-12 (it is in your brief)');
const ME = z.string().max(100).optional().describe('Your session name, e.g. billing-fix');
const LINK = z.string().url().max(500).optional()
  .describe('Permalink to the message it came from (Slack "Copy link", or the Gmail message link). Required whenever the item came from Slack or Gmail, backfill included');
const DIRECTION = z.enum(['inbound', 'outbound']).optional()
  .describe('inbound: someone asked us or wrote to the owner. outbound: the owner or a session said or sent it. Always pass it for Slack and Gmail items');

const server = new McpServer({ name: 'shiftboss', version: '0.1.0' });

server.registerTool('task_stage', {
  title: 'Move a task',
  description: 'Report that your ShiftBoss task moved. Stages: progress (started), pr (PR open), dev (live on dev and checked), live (live on prod), told (requester told). Run it at each step.',
  inputSchema: { task: TASK, stage: z.enum(['queued', 'progress', 'pr', 'dev', 'live', 'told']), who: ME },
}, wrap(async ({ task, stage, who }) => { await call('PATCH', `/api/tasks/${task}`, { stage, who: who ?? 'session' }); return `${task} → ${stage}`; }));

server.registerTool('task_note', {
  title: 'Add to a task log',
  description: "Add one line to a task's activity log, e.g. 'PR #81 opened' or 'tested on dev with a real request'.",
  inputSchema: { task: TASK, text: z.string().min(1).max(1000), source: z.enum(['Session', 'GitHub', 'Slack']).optional(), who: ME },
}, wrap(async ({ task, text, source, who }) => { await call('POST', `/api/tasks/${task}/events`, { src: source ?? 'Session', who: who ?? 'session', text }); return 'noted on ' + task; }));

server.registerTool('task_add', {
  title: 'File a new task',
  description: 'File a new task in ShiftBoss. Use the asker\'s own words for `ask`. Leave `session` empty to put it in the inbox for triage. A task from Slack or Gmail must carry `url` (the permalink) and `direction`, so the owner can open the original in one click.',
  inputSchema: {
    title: z.string().min(1).max(300), ask: z.string().max(4000).optional(), from: z.string().max(100).optional(),
    source: z.string().max(200).optional().describe('Channel or meeting'), url: LINK, direction: DIRECTION,
    session: z.string().max(100).optional(), prio: z.enum(['P1', 'P2', 'P3']).optional(),
  },
}, wrap(async (a) => {
  const t = await call('POST', '/api/tasks', { title: a.title, ask: a.ask, requester: a.from, source: a.source, sourceUrl: a.url, direction: a.direction, session: a.session, prio: a.prio });
  return 'filed ' + t.id + (a.url ? '' : ' (no source link: pass url when it came from Slack or Gmail)');
}));

server.registerTool('task_assign', {
  title: 'Assign a task',
  description: 'Give a task to a session (lead only).',
  inputSchema: { task: TASK, session: z.string().min(1).max(100), who: ME },
}, wrap(async ({ task, session, who }) => { await call('PATCH', `/api/tasks/${task}`, { session, who: who ?? 'lead' }); return `${task} → ${session}`; }));

server.registerTool('task_get', {
  title: 'Read a task',
  description: 'Read a ShiftBoss task: the ask, stage, owner, log and Slack thread.',
  inputSchema: { task: TASK },
}, wrap(async ({ task }) => JSON.stringify(await call('GET', `/api/tasks/${task}`), null, 1).slice(0, 8000)));

server.registerTool('slack_draft', {
  title: 'Draft a Slack reply for approval',
  description: 'Save a reply you want to post in the task\'s Slack thread. The owner approves it in ShiftBoss; you are then asked to post it. Use kind "sent" only to record something already posted. Kind "ask" (a question the requester asked) is inbound; the others are outbound. Pass `url`, the thread permalink, when you have it: it becomes the task\'s source link if the task has none.',
  inputSchema: { task: TASK, text: z.string().min(1).max(4000), kind: z.enum(['draft', 'sent', 'ask', 'promise']).optional(), who: ME, url: LINK },
}, wrap(async ({ task, text, kind, who, url }) => { await call('POST', `/api/tasks/${task}/slack`, { who: who ?? 'session', text, kind: kind ?? 'draft', url }); return (kind ?? 'draft') + ' saved on ' + task; }));

server.registerTool('slack_sent', {
  title: 'Mark an approved draft as posted',
  description: 'After posting an approved draft, mark it sent using the message id from the approval prompt.',
  inputSchema: { message_id: z.number().int().positive() },
}, wrap(async ({ message_id }) => { await call('POST', `/api/slack/${message_id}/sent`, {}); return 'marked sent'; }));

server.registerTool('promise_add', {
  title: 'Record a promise',
  description: 'Record a line sent from the owner\'s account that says what we will do or tell someone, so it is tracked until kept. Pass `url`, the permalink of the message where it was said (required for Slack and Gmail, backfill included), and `direction` (usually outbound).',
  inputSchema: { said: z.string().min(1).max(1000), to: z.string().min(1).max(100), where: z.string().max(200).optional(), kept_when: z.string().max(300).optional(), task: TASK.optional(), due: z.string().max(40).optional().describe('When it is due, e.g. 2026-12-01 or 2026-12-01T17:00. Overdue promises show in red'), url: LINK, direction: DIRECTION },
}, wrap(async (a) => {
  const p = await call('POST', '/api/promises', { said: a.said, to: a.to, where: a.where, keptWhen: a.kept_when, taskId: a.task, dueAt: a.due, url: a.url, direction: a.direction });
  return 'promise ' + p.id + (p.link ? '' : ' (no source link: pass url when it came from Slack or Gmail)');
}));

server.registerTool('ask_owner', {
  title: 'Ask the owner for a decision',
  description: 'Put a real decision in front of the person who runs ShiftBoss (production writes, money, live customers, access). They answer with one of `answers`, and the answer comes back to you as your next prompt. Do not use for things you can decide yourself.',
  inputSchema: {
    question: z.string().min(1).max(300), answers: z.array(z.string().min(1).max(60)).min(1).max(4),
    kind: z.enum(['Decision', 'Production write', 'Live customers', 'Money', 'Access']).optional(),
    detail: z.string().max(2000).optional(), session: z.string().min(1).max(100).describe('Your session name (required): the answer is sent back to this session as a prompt'), task: TASK.optional(),
  },
}, wrap(async (a) => { const n = await call('POST', '/api/needs', { title: a.question, answers: a.answers, kind: a.kind ?? 'Decision', body: a.detail, session: a.session, taskId: a.task }); return `asked (item ${n.id}); the answer will arrive as a prompt`; }));

server.registerTool('intake_begin', {
  title: 'Start an intake run',
  description: 'Intake only: call FIRST on every run. Says whether intake is paused (then do nothing and stop) and from what time to read (readFrom). After a pause with catch-up, readFrom is where reading stopped, so the missed messages are read too.',
  inputSchema: {},
}, wrap(async () => JSON.stringify(await call('POST', '/api/intake/begin', {}))));

server.registerTool('intake_checkpoint', {
  title: 'Finish an intake run',
  description: 'Intake only: call LAST on every run with readUntil = the time of the newest message you read (or the run start if none). The next run reads from there.',
  inputSchema: { read_until: z.string().describe('ISO time, e.g. 2026-11-25T03:20:00Z') },
}, wrap(async ({ read_until }) => { await call('POST', '/api/intake/checkpoint', { readUntil: read_until }); return 'checkpoint saved: ' + read_until; }));

server.registerTool('intake_log', {
  title: 'Log a message the intake read',
  description: 'Intake session only: log one message once, with a verdict (filed T-n, linked T-n, answered, dropped, to lead), its permalink (`url`, always, backfill and catch-up included) and its `direction` (inbound: written to the owner; outbound: sent by the owner).',
  inputSchema: { source: z.string().min(1).max(200), who: z.string().max(100).optional(), text: z.string().min(1).max(2000), verdict: z.string().min(1).max(100), task: TASK.optional(), url: LINK, direction: DIRECTION },
}, wrap(async (a) => {
  await call('POST', '/api/intake', { src: a.source, who: a.who, text: a.text, verdict: a.verdict, taskId: a.task, url: a.url, direction: a.direction });
  return 'logged' + (a.url ? '' : ' (no link: the Intake screen will show "No source link")');
}));

server.registerTool('decide', {
  title: 'Log a lead decision',
  description: 'Lead only: record something you decided yourself, so the owner can see it without being asked.',
  inputSchema: { text: z.string().min(1).max(500) },
}, wrap(async ({ text }) => { await call('POST', '/api/decisions', { text }); return 'logged'; }));

server.registerTool('owner_instructions', {
  title: "The owner's way of working",
  description: "How the person who runs ShiftBoss wants work done (for example: always let them review PRs before merging and deploying). Read it when you start and follow it; it overrides ShiftBoss's defaults where they differ.",
  inputSchema: {},
}, wrap(async () => { const r = await call('GET', '/api/owner-instructions'); return r.instructions ? `${r.owner}'s way of working:\n${r.instructions}` : `${r.owner} has not written any instructions; use ShiftBoss's defaults.`; }));

server.registerTool('my_tasks', {
  title: 'List my tasks',
  description: 'List open ShiftBoss tasks for a session (or all open tasks if no session is given).',
  inputSchema: { session: z.string().max(100).optional() },
}, wrap(async ({ session }) => {
  const s = await call('GET', '/api/snapshot');
  const names = ['inbox', 'queued', 'progress', 'pr', 'dev', 'live', 'told'];
  const rows = s.tasks.filter((t: any) => t.stage < 6 && (!session || t.session === session));
  return rows.length ? rows.map((t: any) => `${t.id} [${names[t.stage]}${t.held ? ', held' : ''}] ${t.title}${session ? '' : ' — ' + (t.session ?? 'unassigned')}`).join('\n') : 'No open tasks.';
}));

// ----- setup and onboarding: the same steps as the Get started screen, which updates live -----
server.registerTool('setup_status', {
  title: 'ShiftBoss setup status',
  description: 'What is connected (MCP, status line, intake), the lead session, every running session with its task count and whether it was asked to register its work, and what is left to do. Start any setup or onboarding here.',
  inputSchema: {},
}, wrap(async () => JSON.stringify(await call('GET', '/api/onboarding'), null, 2)));

server.registerTool('setup_lead', {
  title: 'Set the lead session',
  description: 'Set the session that coordinates the others (its base name; name-v2 replacements take over automatically), and optionally the herdr workspace to show.',
  inputSchema: { lead: z.string().max(100), workspace: z.string().max(40).optional().describe('herdr workspace id, empty for every workspace') },
}, wrap(async ({ lead, workspace }) => {
  const snap = await call('GET', '/api/snapshot');
  await call('PUT', '/api/settings', { ...snap.settings, leadSession: lead, ...(workspace !== undefined ? { herdrWorkspace: workspace } : {}) }, { by: 'setup' });
  return `lead session: ${lead}`;
}));

server.registerTool('onboarding_ask', {
  title: 'Ask sessions to register their work',
  description: 'Sends each named session one prompt asking it to put its current tasks, their stage and its promises on the board, without changing its work. all_unasked picks every session (except the intake) not asked yet and with no tasks. Confirm the list with the owner first: this prompts their sessions.',
  inputSchema: { sessions: z.array(z.string().max(100)).max(50).optional(), all_unasked: z.boolean().optional() },
}, wrap(async ({ sessions, all_unasked }) => {
  let names = sessions ?? [];
  if (all_unasked) {
    const o = await call('GET', '/api/onboarding');
    names = o.sessions.filter((x: any) => !/intake/i.test(x.name) && !x.askedAt && !x.tasks).map((x: any) => x.name);
  }
  if (!names.length) return 'Nobody to ask.';
  const r = await call('POST', '/api/onboarding/ask', { sessions: names });
  if (r.__held) return r.message;
  return `asked ${r.asked}${r.failed.length ? `; could not reach ${r.failed.join(', ')}` : ''}`;
}));

server.registerTool('onboarding_backfill', {
  title: 'Send the intake back in time',
  description: 'The intake session reads Slack and Gmail from this many days ago up to now and files what is still open.',
  inputSchema: { days: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(7), z.literal(14)]) },
}, wrap(async ({ days }) => { const r = await call('POST', '/api/onboarding/backfill', { days }); return `intake reads from ${r.since}` + (r.prompted ? ' (asked it to start now)' : r.waiting ? ` (${r.intake} is ${r.waiting}: answer it there, and it reads from this time on its next run)` : ' (no intake session running yet; it starts from this time when one does)'); }));

server.registerTool('onboarding_done', {
  title: 'Finish setup',
  description: 'Marks setup finished, so the UI stops opening on Get started.',
  inputSchema: {},
}, wrap(async () => { await call('POST', '/api/onboarding/done', { done: true }); return 'setup finished'; }));

server.registerTool('outside_sessions', {
  title: 'Claude sessions outside herdr',
  description: 'Claude Code sessions with recent history that are not running in herdr (started from the plain CLI, TUI or the desktop app), with their folder, name and last activity. Use with session_bring_in during setup.',
  inputSchema: { days: z.number().int().min(1).max(60).optional() },
}, wrap(async ({ days }) => JSON.stringify(await call('GET', '/api/outside-sessions?days=' + (days ?? 14)), null, 2)));

server.registerTool('session_bring_in', {
  title: 'Bring sessions into herdr',
  description: 'Reopens Claude sessions from outside herdr inside herdr, each in its own tab with claude --resume, so they keep their full history. Confirm the list with the owner first, and ask them to close each old window so two copies do not write the same history.',
  inputSchema: { sessions: z.array(z.object({ sessionId: z.string(), name: z.string().max(40).optional() })).min(1).max(20) },
}, wrap(async ({ sessions }) => { const r = await call('POST', '/api/sessions/bring-in', { sessions }); if (r.__held) return r.message; return `opening in herdr: ${r.starting.join(', ')}`; }));

server.registerTool('session_spawn', {
  title: 'Start a Claude Code session',
  description: 'Opens a new herdr tab in the folder and starts Claude Code, with an optional model and first prompt. A folder Claude has not opened before asks "trust this folder?" in herdr first; only the owner answers that.',
  inputSchema: { name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$/), cwd: z.string().max(400), model: z.enum(['sonnet', 'opus', 'haiku', 'fable']).optional(), prompt: z.string().max(8000).optional() },
}, wrap(async ({ name, cwd, model, prompt }) => { const r = await call('POST', '/api/sessions/spawn', { name, cwd, model: model ?? null, prompt: prompt ?? null }); if (r.__held) return r.message; return `starting ${name}; watch the ShiftBoss feed for "ready" or "waiting for you"`; }));

server.registerTool('session_replace', {
  title: 'Replace sessions through a handoff',
  description: 'For each named session: ShiftBoss asks it to write a handoff file with fixed sections, waits until the file is complete, starts a fresh <name>-vN in the same folder with the same model, moves its open tasks and lane to the new name, and gives the new session its first prompt (read the handoff, register with my_tasks, continue). The old session is closed automatically once the new one has taken over for the time set in Settings (closeOldAfterMin, default 30 min; 0 = never), and never while it works or waits on a permission prompt. Use it for sessions near their context limit. Do not use it on yourself unless the owner asked.',
  inputSchema: { sessions: z.array(z.string().min(1).max(100)).min(1).max(20) },
}, wrap(async ({ sessions }) => {
  const r = await call('POST', '/api/sessions/replace', { sessions });
  if (r.__held) return r.message;
  return r.results.map((x: any) => (x.error ? `${x.name}: could not start (${x.error})` : `${x.name}: asked for its handoff; ${x.newName} starts once it is written`)).join('\n');
}));

server.registerTool('monitor_add', {
  title: 'Watch something you shipped',
  description: 'After shipping something, have ShiftBoss check on it for a few days: the monitor session runs one check every few hours and reports. Give what was shipped (title), what to check and what "bad" looks like (prompt), and optional links and task.',
  inputSchema: {
    title: z.string().min(1).max(200).describe('What was shipped, e.g. "New store: phone numbers and texting registration"'),
    prompt: z.string().min(1).max(4000).describe('What to check each time, and what counts as bad'),
    days: z.union([z.literal(1), z.literal(3), z.literal(7), z.literal(14)]).describe('How long to watch, in days'),
    every_hours: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12), z.literal(24)]).describe('How often to check, in hours'),
    pr: z.string().url().optional(), ticket: z.string().url().optional(), dashboard: z.string().url().optional(),
    task: TASK.optional(),
    tell_lead: z.boolean().optional().describe('Send the lead session a note when a check comes back bad, and when it is fine again (default true)'),
  },
}, wrap(async (a) => {
  const m = await call('POST', '/api/monitors', { title: a.title, prompt: a.prompt, durationDays: a.days, intervalHours: a.every_hours, links: { pr: a.pr, ticket: a.ticket, dashboard: a.dashboard }, taskId: a.task, informLead: a.tell_lead });
  return `monitor ${m.id} watching "${m.title}" for ${m.durationDays} day(s), every ${m.intervalHours} h; the first check is due now`;
}));

server.registerTool('monitor_report', {
  title: 'Report a monitor check',
  description: 'Monitor session only: report the check ShiftBoss asked for. verdict ok (all fine), warn (worth a look), bad (what the owner called bad is happening), error (you could not check). summary: one line in plain words. details: the numbers you saw and where you looked.',
  inputSchema: {
    monitor_id: z.number().int().positive(),
    verdict: z.enum(['ok', 'warn', 'bad', 'error']),
    summary: z.string().min(1).max(500),
    details: z.string().max(4000).optional(),
    links: z.array(z.string().url()).max(5).optional().describe('Pages you looked at, e.g. a dashboard or log search'),
  },
}, wrap(async (a) => {
  const r = await call('POST', `/api/monitors/${a.monitor_id}/report`, { verdict: a.verdict, summary: a.summary, details: a.details, links: a.links });
  return `recorded: ${a.verdict}. ${r.monitor.state === 'finished' ? 'That was the last check.' : `${r.monitor.checksLeft} check(s) left; next due ${r.monitor.nextDueAt}.`} Wait for the next prompt.`;
}));

server.registerTool('monitor_list', {
  title: 'List monitors',
  description: 'Monitors being watched (and finished in the last day): state, next check, last verdict and summary.',
  inputSchema: {},
}, wrap(async () => {
  const s = await call('GET', '/api/snapshot');
  if (!s.monitors.length) return 'No monitors.';
  return s.monitors.map((m: any) => `${m.id}  ${m.state.padEnd(9)} ${m.title}  next ${m.nextDueAt ?? '-'}  last ${m.lastVerdict ?? '-'}${m.lastSummary ? ': ' + m.lastSummary : ''}`).join('\n');
}));


// ---------- everything else ShiftBoss can do, so a session can do it when asked ----------
server.registerTool('session_spawn_many', {
  title: 'Start several Claude Code sessions',
  description: "Up to 20 at once, one after another, each in its own herdr tab. Goes through the owner's mode (risky: waits in Ask first and Safe auto).",
  inputSchema: { sessions: z.array(z.object({ name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$/), cwd: z.string().max(400), model: z.enum(['sonnet', 'opus', 'haiku']).optional(), prompt: z.string().max(8000).optional() })).min(1).max(20), by: ME },
}, wrap(async ({ sessions, by }) => { const r = await call('POST', '/api/sessions/spawn-many', { sessions, by }); return r.__held ? r.message : `starting ${r.names.join(', ')}`; }));

server.registerTool('task_update', {
  title: 'Change a task',
  description: 'Change a task\'s priority, title, ask, direction or source link, or put it on hold / resume it.',
  inputSchema: { task: TASK, prio: z.enum(['P1', 'P2', 'P3']).optional(), title: z.string().max(300).optional(), ask: z.string().max(4000).optional(),
    hold: z.boolean().optional(), direction: z.enum(['inbound', 'outbound']).optional(), url: z.string().optional(), who: ME },
}, wrap(async (a) => {
  const patch: any = { who: a.who ?? 'session' };
  if (a.prio) patch.prio = a.prio; if (a.title) patch.title = a.title; if (a.ask !== undefined) patch.ask = a.ask;
  if (a.hold !== undefined) patch.held = a.hold; if (a.direction) patch.direction = a.direction; if (a.url) patch.sourceUrl = a.url;
  await call('PATCH', `/api/tasks/${a.task}`, patch);
  return `${a.task} updated`;
}));

server.registerTool('task_send', {
  title: "Send a task's brief to its session",
  description: 'Sends the task brief to the session it is assigned to. Goes through the owner\'s mode: in Dry run it is only recorded, in Ask first it waits for approval.',
  inputSchema: { task: TASK, by: ME },
}, wrap(async ({ task, by }) => heldOr(await call('POST', `/api/tasks/${task}/dispatch`, { by }), `${task}: brief sent`)));

server.registerTool('task_new_session', {
  title: 'Start a new session for a task',
  description: 'Starts a fresh Claude session in herdr just for this task: it is assigned the task and its first prompt is the task brief. Name and folder are optional (default: named after the task, in the folder of the lead session). Goes through the mode of the owner like any new session.',
  inputSchema: { task: TASK, name: z.string().max(40).optional(), cwd: z.string().max(400).optional(), model: z.enum(['opus', 'sonnet', 'haiku', 'fable']).optional(), by: ME },
}, wrap(async ({ task, name, cwd, model, by }) => heldOr(await call('POST', `/api/tasks/${task}/new-session`, { name, cwd, model, by }), `${task}: starting a new session for it`)));

server.registerTool('tasks_list', {
  title: 'List tasks',
  description: 'Tasks on the board, filtered by stage and/or session. Stages: inbox, queued, progress, pr, dev, live, told.',
  inputSchema: { stage: z.enum(['inbox', 'queued', 'progress', 'pr', 'dev', 'live', 'told']).optional(), session: z.string().max(100).optional() },
}, wrap(async ({ stage, session }) => {
  const W = ['inbox', 'queued', 'progress', 'pr', 'dev', 'live', 'told'];
  const s = await call('GET', '/api/snapshot');
  const rows = s.tasks.filter((t: any) => (stage ? W[t.stage] === stage : t.stage < 6) && (!session || t.session === session));
  return rows.map((t: any) => `${t.id} [${W[t.stage]}] ${t.prio} ${t.session ?? 'unassigned'}: ${t.title}${t.sourceUrl ? ' ' + t.sourceUrl : ''}`).join('\n') || 'No tasks.';
}));

server.registerTool('promises_list', {
  title: 'List promises',
  description: 'Promises made from the owner\'s account and their state (open, due, kept), with their task and link.',
  inputSchema: { open_only: z.boolean().optional() },
}, wrap(async ({ open_only }) => {
  const s = await call('GET', '/api/snapshot');
  return s.promises.filter((p: any) => !open_only || p.state !== 'kept').map((p: any) => `#${p.id} [${p.state}] to ${p.to}${p.taskId ? ' (' + p.taskId + ')' : ''}: "${p.said}"${p.link?.url ? ' ' + p.link.url : ''}`).join('\n') || 'No promises.';
}));

server.registerTool('promise_update', {
  title: 'Change a promise',
  description: 'Mark a promise kept, overdue or open, or set its link and direction.',
  inputSchema: { id: z.number().int(), state: z.enum(['open', 'due', 'kept']).optional(), url: z.string().optional(), direction: z.enum(['inbound', 'outbound']).optional(), task: TASK.optional() },
}, wrap(async ({ id, state, url, direction, task }) => { await call('PATCH', `/api/promises/${id}`, { state, url, direction, taskId: task }); return `promise ${id} updated`; }));

server.registerTool('needs_list', {
  title: 'What waits on the owner',
  description: 'Open Needs you items (questions for the owner) and actions held for their approval.',
  inputSchema: {},
}, wrap(async () => {
  const s = await call('GET', '/api/snapshot');
  const needs = s.needs.filter((n: any) => !n.answer).map((n: any) => `need #${n.id} (${n.kind}, ${n.session ?? 'no session'}): ${n.title} [${n.answers.join(' | ')}]`);
  const held = s.actions.filter((a: any) => a.state === 'waiting' || a.state === 'dry').map((a: any) => `action #${a.id} [${a.state}] by ${a.by}: ${a.summary}`);
  return [`Mode: ${s.settings.mode ?? 'auto'}`, ...needs, ...held].join('\n');
}));

server.registerTool('need_answer', {
  title: "Answer a question for the owner",
  description: "Records the owner's answer to a Needs you item and sends it to the session that asked (after 10 seconds). Only with the answer the owner gave you.",
  inputSchema: { id: z.number().int(), answer: z.string().min(1).max(200), owner_asked: OWNER_ASKED, by: ME },
}, wrap(async ({ id, answer, by }) => { await call('POST', `/api/needs/${id}/answer`, { answer }, { by }); return `answered #${id}: ${answer}`; }));

server.registerTool('approval_decide', {
  title: 'Approve or reject held actions',
  description: 'Approve (it runs now, exactly as asked) or reject an action ShiftBoss held for the owner, or all of them.',
  inputSchema: { id: z.number().int().optional(), all: z.boolean().optional(), approve: z.boolean(), owner_asked: OWNER_ASKED, by: ME },
}, wrap(async ({ id, all, approve, by }) => {
  if (all) { const r = await call('POST', '/api/actions/decide-all', { approve }, { by }); return `${approve ? 'approved' : 'rejected'} ${r.ok}${r.failed.length ? '; failed: ' + r.failed.join('; ') : ''}`; }
  if (id === undefined) throw new Error('Pass id, or all: true');
  const r = await call('POST', `/api/actions/${id}/${approve ? 'approve' : 'reject'}`, {}, { by });
  return approve ? `approved #${id}: ${r.result ?? 'done'}` : `rejected #${id}`;
}));

server.registerTool('mode_set', {
  title: "Change ShiftBoss's mode",
  description: 'dry (Dry run: record only), ask (Ask first: everything waits for approval), safe (Safe auto: routine runs, risky waits), auto (Autopilot). Leaving Dry run, what it recorded is reviewed (becomes approvals) unless drop is true.',
  inputSchema: { mode: z.enum(['dry', 'ask', 'safe', 'auto']), drop_dry_run: z.boolean().optional(), owner_asked: OWNER_ASKED, by: ME },
}, wrap(async ({ mode, drop_dry_run, by }) => { const r = await call('POST', '/api/mode', { mode, dryRun: drop_dry_run ? 'discard' : 'review' }, { by }); return `mode: ${r.mode}${r.settled ? ` (${r.settled} dry-run actions ${drop_dry_run ? 'dropped' : 'moved to approvals'})` : ''}`; }));

server.registerTool('settings_get', {
  title: 'Read ShiftBoss settings',
  description: 'All settings: mode, thresholds, automation switches, intake channels, lead session, updates, notifications, budgets.',
  inputSchema: {},
}, wrap(async () => JSON.stringify((await call('GET', '/api/snapshot')).settings, null, 2)));

server.registerTool('settings_set', {
  title: 'Change ShiftBoss settings',
  description: 'Merge these fields into the settings, e.g. {"thresholds": {"warn": 70}}, {"switches": {"autoDispatch": true}}, {"watchedChannels": ["#team"]}, {"autoUpdate": false}, {"notify": {"finished": false}} (notify kinds: needs, blocked, stuck, overlap, promiseDue, monitor, updated, finished, trouble, tasks, releases, monitorReport, replaced, actions, limits, system). Use mode_set for the mode.',
  inputSchema: { changes: z.record(z.string(), z.any()), owner_asked: OWNER_ASKED, by: ME },
}, wrap(async ({ changes, by }) => {
  const cur = (await call('GET', '/api/snapshot')).settings;
  const merged: any = { ...cur };
  for (const [k, v] of Object.entries(changes)) merged[k] = v && typeof v === 'object' && !Array.isArray(v) && cur[k] && typeof cur[k] === 'object' ? { ...cur[k], ...v } : v;
  await call('PUT', '/api/settings', merged, { by });
  return 'settings saved';
}));

server.registerTool('sessions_list', {
  title: 'List sessions',
  description: 'Every Claude session ShiftBoss sees in herdr: status, context use, lane, current task, health.',
  inputSchema: {},
}, wrap(async () => {
  const s = await call('GET', '/api/snapshot');
  return s.sessions.map((x: any) => {
    const t = s.tasks.find((t: any) => t.session === x.name && t.stage >= 2 && t.stage <= 4);
    const h = s.health.find((h: any) => h.session === x.name);
    return `${x.name}: ${x.status}, context ${Math.round(x.contextPct)}%${x.lane ? ', lane ' + x.lane : ''}${t ? ', on ' + t.id + ' ' + t.title : ''}${h && h.verdict !== 'healthy' ? ', ' + h.verdict + ': ' + h.title : ''}`;
  }).join('\n');
}));

server.registerTool('session_prompt', {
  title: 'Send a prompt to another session',
  description: 'Types a prompt into another session in herdr. Goes through the owner\'s mode (risky: waits for approval in Ask first and Safe auto).',
  inputSchema: { session: z.string().max(100), text: z.string().min(1).max(8000), by: ME },
}, wrap(async ({ session, text, by }) => heldOr(await call('POST', `/api/sessions/${encodeURIComponent(session)}/prompt`, { text, by }), 'sent to ' + session)));

server.registerTool('session_interrupt', {
  title: 'Stop what a session is doing',
  description: 'Presses Esc in a session. Refused while it waits on a permission prompt. Goes through the owner\'s mode.',
  inputSchema: { session: z.string().max(100), by: ME },
}, wrap(async ({ session, by }) => heldOr(await call('POST', `/api/sessions/${encodeURIComponent(session)}/interrupt`, { by }), 'interrupted ' + session)));

server.registerTool('session_screen', {
  title: "Read a session's screen",
  description: 'What a session\'s terminal shows right now (last 80 lines).',
  inputSchema: { session: z.string().max(100) },
}, wrap(async ({ session }) => (await call('GET', `/api/sessions/${encodeURIComponent(session)}/screen`)).text));

server.registerTool('session_lane', {
  title: "Set a session's lane and slots",
  description: 'What the session works on, and how many tasks it may hold at once (0-6).',
  inputSchema: { session: z.string().max(100), lane: z.string().max(300).optional(), slots: z.number().int().min(0).max(6).optional() },
}, wrap(async ({ session, lane, slots }) => { await call('POST', `/api/sessions/${encodeURIComponent(session)}/meta`, { lane, slots }); return `${session} saved`; }));

server.registerTool('slack_bot', {
  title: 'The ShiftBoss Slack bot',
  description: 'The optional bot that sends ShiftBoss alerts to your Slack DM and a channel. action status (default): connected?, where it posts, which alerts. test: send a test to dm or channel. set (owner decision): turn dm/channel on or off, pick the channel by name, find the owner by Slack email, and switch alert kinds per place (kinds as in notifications: needs, blocked, stuck, trouble, overlap, promiseDue, monitor, monitorReport, releases, tasks, finished, replaced, actions, limits, system, updated). Connecting the token is not here: the owner pastes it in Settings → Slack.',
  inputSchema: {
    action: z.enum(['status', 'test', 'set']).optional(), dest: z.enum(['dm', 'channel']).optional(),
    dm_on: z.boolean().optional(), dm_email: z.string().email().optional(), channel_on: z.boolean().optional(), channel_name: z.string().max(100).optional(),
    kinds: z.record(z.string(), z.boolean()).optional().describe('Alert kinds to switch for `dest`, e.g. {"monitorReport": true}'),
    owner_asked: OWNER_ASKED, by: ME,
  },
}, wrap(async ({ action = 'status', dest, dm_on, dm_email, channel_on, channel_name, kinds, by }) => {
  if (action === 'test') { await call('POST', '/api/slack/test', { dest: dest ?? 'dm' }); return 'test sent to the ' + (dest ?? 'dm'); }
  if (action === 'set') {
    const slack: any = {};
    if (dm_email) { const u = await call('POST', '/api/slack/me', { email: dm_email }); slack.dm = { userId: u.id, label: u.label, on: true }; }
    if (dm_on !== undefined) slack.dm = { ...slack.dm, on: dm_on };
    if (channel_name) {
      const name = channel_name.replace(/^#/, '');
      const c = (await call('GET', '/api/slack/channels')).find((x: any) => x.name === name);
      if (!c) return `no channel #${name} the bot can see (for a private one, invite the bot first)`;
      slack.channel = { id: c.id, name: c.name, on: true };
    }
    if (channel_on !== undefined) slack.channel = { ...slack.channel, on: channel_on };
    if (kinds) slack.kinds = { [dest ?? 'dm']: kinds };
    await call('PUT', '/api/settings', { slack }, { by });
    return 'slack bot settings saved';
  }
  const r = await call('GET', '/api/slack');
  return JSON.stringify(r, null, 2);
}));

server.registerTool('replacement_cancel', {
  title: 'Cancel a replacement',
  description: 'Stops a session replacement that has not finished. With dismiss: true, removes a finished one (done, failed or cancelled) from the Replacements list instead.',
  inputSchema: { id: z.number().int(), dismiss: z.boolean().optional() },
}, wrap(async ({ id, dismiss }) => {
  if (dismiss) { await call('POST', `/api/replacements/${id}/dismiss`, {}); return `replacement ${id} removed from the list`; }
  await call('POST', `/api/replacements/${id}/cancel`, {}); return `replacement ${id} cancelled`;
}));

server.registerTool('monitor_update', {
  title: 'Change a monitor',
  description: 'Pause, resume or stop a monitor, run its check now (e.g. to see if a fix worked), resolve (dismiss an alerting monitor without a check; with note, e.g. "that is intentional", which every later check is told), add a note on its own (note without action), turn telling the lead on or off, or edit its title, prompt, days or interval.',
  inputSchema: { id: z.number().int(), action: z.enum(['pause', 'resume', 'stop', 'check_now', 'resolve']).optional(), tell_lead: z.boolean().optional(), note: z.string().max(1000).optional(), title: z.string().max(200).optional(), prompt: z.string().max(4000).optional(),
    days: z.union([z.literal(1), z.literal(3), z.literal(7), z.literal(14)]).optional(), every_hours: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12), z.literal(24)]).optional() },
}, wrap(async ({ id, action, title, prompt, days, every_hours, tell_lead, note }) => {
  if (action === 'check_now') { const r = await call('POST', `/api/monitors/${id}/check-now`, {}); return r.waiting ? 'queued: ' + r.waiting : 'check queued; the monitor session gets it when it is idle'; }
  const e: any = {};
  if (title) e.title = title; if (prompt) e.prompt = prompt; if (days) e.durationDays = days; if (every_hours) e.intervalHours = every_hours; if (action) e.action = action; if (tell_lead !== undefined) e.informLead = tell_lead;
  if (note && action === 'resolve') e.note = note;
  else if (note) await call('POST', `/api/monitors/${id}/notes`, { text: note });
  if (!Object.keys(e).length) return note ? `note added to monitor ${id}` : 'nothing to change';
  await call('PATCH', `/api/monitors/${id}`, e);
  return `monitor ${id} updated`;
}));

server.registerTool('intake_run', {
  title: 'Ask the intake for a pass now',
  description: 'The intake session reads Slack and Gmail now instead of waiting for its loop. Goes through the owner\'s mode.',
  inputSchema: { by: ME },
}, wrap(async ({ by }) => heldOr(await call('POST', '/api/intake/run', { by }), 'the intake is checking now')));

server.registerTool('intake_pause', {
  title: 'Pause or resume the intake',
  description: 'Pause (optionally until a time), or resume: with catch_up true it reads everything it missed.',
  inputSchema: { pause: z.boolean(), until: z.string().max(40).optional(), catch_up: z.boolean().optional() },
}, wrap(async ({ pause, until, catch_up }) => {
  if (pause) { const st = await call('POST', '/api/intake/pause', { until }); return st.resumeAt ? 'paused until ' + st.resumeAt : 'paused'; }
  await call('POST', '/api/intake/resume', { catchUp: catch_up !== false });
  return catch_up !== false ? 'resumed, catching up' : 'resumed from now';
}));

server.registerTool('thread_dismiss', {
  title: 'Dismiss a flagged thread',
  description: 'Removes a "sessions may be confused" thread from Needs attention once someone has looked at it.',
  inputSchema: { id: z.number().int() },
}, wrap(async ({ id }) => { await call('POST', `/api/intake/${id}/resolve`, {}); return 'dismissed'; }));

server.registerTool('slack_approve', {
  title: 'Approve a Slack draft',
  description: 'Approves a draft so the session that owns it posts it exactly as written.',
  inputSchema: { message_id: z.number().int(), owner_asked: OWNER_ASKED, by: ME },
}, wrap(async ({ message_id, by }) => { await call('POST', `/api/slack/${message_id}/approve`, {}, { by }); return 'approved; the owning session will post it'; }));

server.registerTool('audit_log', {
  title: 'Log or correct something sent as the owner',
  description: 'Record a message sent in the owner\'s name (Sent as you), or mark an entry corrected with a note.',
  inputSchema: { text: z.string().max(4000).optional(), where: z.enum(['Slack', 'Jira', 'GitHub', 'Email']).optional(), channel: z.string().max(200).optional(), approval: z.string().max(100).optional(),
    correct_id: z.number().int().optional(), note: z.string().max(500).optional(), by: ME },
}, wrap(async (a) => {
  if (a.correct_id !== undefined) { await call('POST', `/api/audit/${a.correct_id}/correct`, { note: a.note ?? '' }); return 'marked corrected'; }
  await call('POST', '/api/audit', { text: a.text, where: a.where, channel: a.channel, approval: a.approval, by: a.by ?? 'session' });
  return 'logged';
}));

server.registerTool('report_get', {
  title: 'The daily report',
  description: 'The daily summary: plain, for the team, or for the owner.',
  inputSchema: { audience: z.enum(['plain', 'team', 'me']).optional() },
}, wrap(async ({ audience }) => { const r = await call('GET', '/api/report?aud=' + (audience ?? 'plain')); return typeof r === 'string' ? r : r.text ?? JSON.stringify(r, null, 2); }));

server.registerTool('health_get', {
  title: 'Session health and overlaps',
  description: 'Sessions that are stuck, looping, heavy or lost, and two sessions on the same file, migration or task.',
  inputSchema: {},
}, wrap(async () => {
  const s = await call('GET', '/api/snapshot');
  const h = s.health.filter((x: any) => x.verdict !== 'healthy').map((x: any) => `${x.session}: ${x.verdict}: ${x.title} → ${x.suggest}`);
  const o = s.overlaps.map((x: any) => `overlap: ${x.title} (${x.a.session} and ${x.b.session}) → ${x.fix}`);
  return [...h, ...o].join('\n') || 'All healthy, no overlaps.';
}));

server.registerTool('instructions_update', {
  title: "Change the owner's way of working",
  description: 'Add a rule, replace the text, or undo the last change. Only when the owner asked you to.',
  inputSchema: { add: z.string().max(500).optional(), set: z.string().max(4000).optional(), undo: z.boolean().optional(), owner_asked: OWNER_ASKED, by: ME },
}, wrap(async ({ add, set, undo, by }) => { await call('POST', '/api/owner-instructions', { add, set, undo }, { by }); return undo ? 'restored the previous version' : 'saved'; }));

server.registerTool('update_check', {
  title: 'Update ShiftBoss',
  description: 'Check for a newer ShiftBoss version, and with install true install it (it restarts quietly).',
  inputSchema: { install: z.boolean().optional() },
}, wrap(async ({ install }) => (await call('POST', '/api/update/check', { apply: !!install })).note));

await server.connect(new StdioServerTransport());
