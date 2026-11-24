#!/usr/bin/env bun
// Foreman as MCP tools. A thin layer over the same local HTTP API the CLI uses, so a
// session can report progress without remembering commands.
// Register once (user scope):  claude mcp add --scope user foreman -- bun D:/Ditra/foreman/mcp/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = `http://127.0.0.1:${process.env.FOREMAN_PORT ?? '4400'}`;

async function call(method: string, path: string, body?: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', 'x-foreman': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error(`Foreman is not running on ${BASE}. Nothing was recorded.`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const wrap = <A,>(fn: (a: A) => Promise<string>) => async (a: A) => {
  try { return ok(await fn(a)); } catch (e) { return { ...ok('Foreman: ' + (e as Error).message), isError: true }; }
};
const TASK = z.string().regex(/^T-\d+$/).describe('Foreman task id, e.g. T-12 (it is in your brief)');
const ME = z.string().max(100).optional().describe('Your session name, e.g. general-tasks');

const server = new McpServer({ name: 'foreman', version: '0.1.0' });

server.registerTool('task_stage', {
  title: 'Move a task',
  description: 'Report that your Foreman task moved. Stages: progress (started), pr (PR open), dev (live on dev and checked), live (live on prod), told (requester told). Run it at each step.',
  inputSchema: { task: TASK, stage: z.enum(['queued', 'progress', 'pr', 'dev', 'live', 'told']), who: ME },
}, wrap(async ({ task, stage, who }) => { await call('PATCH', `/api/tasks/${task}`, { stage, who: who ?? 'session' }); return `${task} → ${stage}`; }));

server.registerTool('task_note', {
  title: 'Add to a task log',
  description: "Add one line to a task's activity log, e.g. 'PR #3376 opened' or 'tested on dev with a real request'.",
  inputSchema: { task: TASK, text: z.string().min(1).max(1000), source: z.enum(['Session', 'GitHub', 'Slack']).optional(), who: ME },
}, wrap(async ({ task, text, source, who }) => { await call('POST', `/api/tasks/${task}/events`, { src: source ?? 'Session', who: who ?? 'session', text }); return 'noted on ' + task; }));

server.registerTool('task_add', {
  title: 'File a new task',
  description: 'File a new task in Foreman. Use the asker\'s own words for `ask`. Leave `session` empty to put it in the inbox for triage.',
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
  description: 'Read a Foreman task: the ask, stage, owner, log and Slack thread.',
  inputSchema: { task: TASK },
}, wrap(async ({ task }) => JSON.stringify(await call('GET', `/api/tasks/${task}`), null, 1).slice(0, 8000)));

server.registerTool('slack_draft', {
  title: 'Draft a Slack reply for approval',
  description: 'Save a reply you want to post in the task\'s Slack thread. Udit approves it in Foreman; you are then asked to post it. Use kind "sent" only to record something already posted.',
  inputSchema: { task: TASK, text: z.string().min(1).max(4000), kind: z.enum(['draft', 'sent', 'ask', 'promise']).optional(), who: ME },
}, wrap(async ({ task, text, kind, who }) => { await call('POST', `/api/tasks/${task}/slack`, { who: who ?? 'session', text, kind: kind ?? 'draft' }); return (kind ?? 'draft') + ' saved on ' + task; }));

server.registerTool('slack_sent', {
  title: 'Mark an approved draft as posted',
  description: 'After posting an approved draft, mark it sent using the message id from the approval prompt.',
  inputSchema: { message_id: z.number().int().positive() },
}, wrap(async ({ message_id }) => { await call('POST', `/api/slack/${message_id}/sent`, {}); return 'marked sent'; }));

server.registerTool('promise_add', {
  title: 'Record a promise',
  description: 'Record a line sent from Udit\'s account that says what we will do or tell someone, so it is tracked until kept.',
  inputSchema: { said: z.string().min(1).max(1000), to: z.string().min(1).max(100), where: z.string().max(200).optional(), kept_when: z.string().max(300).optional(), task: TASK.optional() },
}, wrap(async (a) => { const p = await call('POST', '/api/promises', { said: a.said, to: a.to, where: a.where, keptWhen: a.kept_when, taskId: a.task }); return 'promise ' + p.id; }));

server.registerTool('ask_udit', {
  title: 'Ask Udit for a decision',
  description: 'Put a real decision in front of Udit (production writes, money, live customers, access). He answers with one of `answers`, and the answer comes back to you as your next prompt. Do not use for things you can decide yourself.',
  inputSchema: {
    question: z.string().min(1).max(300), answers: z.array(z.string().min(1).max(60)).min(1).max(4),
    kind: z.enum(['Decision', 'Production write', 'Live customers', 'Money', 'Access']).optional(),
    detail: z.string().max(2000).optional(), session: ME.describe('Your session name, so the answer is sent back to you'), task: TASK.optional(),
  },
}, wrap(async (a) => { const n = await call('POST', '/api/needs', { title: a.question, answers: a.answers, kind: a.kind ?? 'Decision', body: a.detail, session: a.session, taskId: a.task }); return `asked (item ${n.id}); the answer will arrive as a prompt`; }));

server.registerTool('intake_log', {
  title: 'Log a message the intake read',
  description: 'Intake session only: log one message once, with a verdict (filed T-n, linked T-n, answered, dropped, to lead) and its permalink.',
  inputSchema: { source: z.string().min(1).max(200), who: z.string().max(100).optional(), text: z.string().min(1).max(2000), verdict: z.string().min(1).max(100), task: TASK.optional(), url: z.string().url().optional() },
}, wrap(async (a) => { await call('POST', '/api/intake', { src: a.source, who: a.who, text: a.text, verdict: a.verdict, taskId: a.task, url: a.url }); return 'logged'; }));

server.registerTool('decide', {
  title: 'Log a lead decision',
  description: 'Lead only: record something you decided yourself, so Udit can see it without being asked.',
  inputSchema: { text: z.string().min(1).max(500) },
}, wrap(async ({ text }) => { await call('POST', '/api/decisions', { text }); return 'logged'; }));

server.registerTool('my_tasks', {
  title: 'List my tasks',
  description: 'List open Foreman tasks for a session (or all open tasks if no session is given).',
  inputSchema: { session: z.string().max(100).optional() },
}, wrap(async ({ session }) => {
  const s = await call('GET', '/api/snapshot');
  const names = ['inbox', 'queued', 'progress', 'pr', 'dev', 'live', 'told'];
  const rows = s.tasks.filter((t: any) => t.stage < 6 && (!session || t.session === session));
  return rows.length ? rows.map((t: any) => `${t.id} [${names[t.stage]}${t.held ? ', held' : ''}] ${t.title}${session ? '' : ' — ' + (t.session ?? 'unassigned')}`).join('\n') : 'No open tasks.';
}));

await server.connect(new StdioServerTransport());
