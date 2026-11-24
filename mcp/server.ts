#!/usr/bin/env bun
// ShiftBoss as MCP tools. A thin layer over the same local HTTP API the CLI uses, so a
// session can report progress without remembering commands.
// Register once (user scope):  claude mcp add --scope user shiftboss -- bun <path-to-shiftboss>/mcp/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { resolvePort } from '../shared/port';

const BASE = `http://127.0.0.1:${resolvePort()}`;

async function call(method: string, path: string, body?: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', 'x-shiftboss': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error(`ShiftBoss is not running on ${BASE}. Nothing was recorded.`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const wrap = <A,>(fn: (a: A) => Promise<string>) => async (a: A) => {
  try { return ok(await fn(a)); } catch (e) { return { ...ok('ShiftBoss: ' + (e as Error).message), isError: true }; }
};
const TASK = z.string().regex(/^T-\d+$/).describe('ShiftBoss task id, e.g. T-12 (it is in your brief)');
const ME = z.string().max(100).optional().describe('Your session name, e.g. billing-fix');

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
  description: 'File a new task in ShiftBoss. Use the asker\'s own words for `ask`. Leave `session` empty to put it in the inbox for triage.',
  inputSchema: {
    title: z.string().min(1).max(300), ask: z.string().max(4000).optional(), from: z.string().max(100).optional(),
    source: z.string().max(200).optional().describe('Channel or meeting'), url: z.string().url().optional().describe('Slack permalink or other link'),
    session: z.string().max(100).optional(), prio: z.enum(['P1', 'P2', 'P3']).optional(),
  },
}, wrap(async (a) => { const t = await call('POST', '/api/tasks', { title: a.title, ask: a.ask, requester: a.from, source: a.source, sourceUrl: a.url, session: a.session, prio: a.prio }); return 'filed ' + t.id; }));

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
  description: 'Save a reply you want to post in the task\'s Slack thread. The owner approves it in ShiftBoss; you are then asked to post it. Use kind "sent" only to record something already posted.',
  inputSchema: { task: TASK, text: z.string().min(1).max(4000), kind: z.enum(['draft', 'sent', 'ask', 'promise']).optional(), who: ME },
}, wrap(async ({ task, text, kind, who }) => { await call('POST', `/api/tasks/${task}/slack`, { who: who ?? 'session', text, kind: kind ?? 'draft' }); return (kind ?? 'draft') + ' saved on ' + task; }));

server.registerTool('slack_sent', {
  title: 'Mark an approved draft as posted',
  description: 'After posting an approved draft, mark it sent using the message id from the approval prompt.',
  inputSchema: { message_id: z.number().int().positive() },
}, wrap(async ({ message_id }) => { await call('POST', `/api/slack/${message_id}/sent`, {}); return 'marked sent'; }));

server.registerTool('promise_add', {
  title: 'Record a promise',
  description: 'Record a line sent from the owner\'s account that says what we will do or tell someone, so it is tracked until kept.',
  inputSchema: { said: z.string().min(1).max(1000), to: z.string().min(1).max(100), where: z.string().max(200).optional(), kept_when: z.string().max(300).optional(), task: TASK.optional(), due: z.string().max(40).optional().describe('When it is due, e.g. 2026-12-01 or 2026-12-01T17:00. Overdue promises show in red') },
}, wrap(async (a) => { const p = await call('POST', '/api/promises', { said: a.said, to: a.to, where: a.where, keptWhen: a.kept_when, taskId: a.task, dueAt: a.due }); return 'promise ' + p.id; }));

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
  description: 'Intake session only: log one message once, with a verdict (filed T-n, linked T-n, answered, dropped, to lead) and its permalink.',
  inputSchema: { source: z.string().min(1).max(200), who: z.string().max(100).optional(), text: z.string().min(1).max(2000), verdict: z.string().min(1).max(100), task: TASK.optional(), url: z.string().url().optional() },
}, wrap(async (a) => { await call('POST', '/api/intake', { src: a.source, who: a.who, text: a.text, verdict: a.verdict, taskId: a.task, url: a.url }); return 'logged'; }));

server.registerTool('decide', {
  title: 'Log a lead decision',
  description: 'Lead only: record something you decided yourself, so the owner can see it without being asked.',
  inputSchema: { text: z.string().min(1).max(500) },
}, wrap(async ({ text }) => { await call('POST', '/api/decisions', { text }); return 'logged'; }));

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
  await call('PUT', '/api/settings', { ...snap.settings, leadSession: lead, ...(workspace !== undefined ? { herdrWorkspace: workspace } : {}) });
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

server.registerTool('session_spawn', {
  title: 'Start a Claude Code session',
  description: 'Opens a new herdr tab in the folder and starts Claude Code, with an optional model and first prompt. A folder Claude has not opened before asks "trust this folder?" in herdr first; only the owner answers that.',
  inputSchema: { name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$/), cwd: z.string().max(400), model: z.enum(['sonnet', 'opus', 'haiku']).optional(), prompt: z.string().max(8000).optional() },
}, wrap(async ({ name, cwd, model, prompt }) => { await call('POST', '/api/sessions/spawn', { name, cwd, model: model ?? null, prompt: prompt ?? null }); return `starting ${name}; watch the ShiftBoss feed for "ready" or "waiting for you"`; }));

server.registerTool('session_replace', {
  title: 'Replace sessions through a handoff',
  description: 'For each named session: ShiftBoss asks it to write a handoff file with fixed sections, waits until the file is complete, starts a fresh <name>-vN in the same folder with the same model, moves its open tasks and lane to the new name, and gives the new session its first prompt (read the handoff, register with my_tasks, continue). The old session is never closed; the owner does that. Use it for sessions near their context limit. Do not use it on yourself unless the owner asked.',
  inputSchema: { sessions: z.array(z.string().min(1).max(100)).min(1).max(20) },
}, wrap(async ({ sessions }) => {
  const r = await call('POST', '/api/sessions/replace', { sessions });
  return r.results.map((x: any) => (x.error ? `${x.name}: could not start (${x.error})` : `${x.name}: asked for its handoff; ${x.newName} starts once it is written`)).join('\n');
}));

await server.connect(new StdioServerTransport());
