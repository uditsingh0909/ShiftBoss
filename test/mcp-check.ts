// Manual check of the MCP server as a real client, against a running ShiftBoss: bun test/mcp-check.ts
// Reads only, plus two calls that change nothing (mode set to the mode it already has, warn to its value).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const c = new Client({ name: 'check', version: '1' });
await c.connect(new StdioClientTransport({ command: 'bun', args: [import.meta.dir + '/../mcp/server.ts'], env: { ...process.env, SHIFTBOSS_SESSION: 'mcp-check' } as Record<string, string> }));
console.log((await c.listTools()).tools.length, 'tools');

const show = async (name: string, args: Record<string, unknown> = {}) => {
  try {
    const r: any = await c.callTool({ name, arguments: args });
    console.log(`--- ${name}${r.isError ? ' (error)' : ''}:`, String(r.content?.[0]?.text).split('\n').slice(0, 3).join(' | ').slice(0, 180));
  } catch (e) { console.log(`--- ${name} (refused):`, (e as Error).message.split('\n')[0].slice(0, 140)); }
};

const snap = await (await fetch('http://127.0.0.1:4400/api/snapshot')).json();
await show('needs_list');
await show('sessions_list');
await show('health_get');
await show('tasks_list', { stage: 'pr' });
await show('promises_list', { open_only: true });
await show('mode_set', { mode: snap.settings.mode ?? 'auto' });                        // refused: no owner_asked
await show('mode_set', { mode: snap.settings.mode ?? 'auto', owner_asked: true });     // allowed, logged as on your behalf
await show('settings_set', { changes: { thresholds: { warn: snap.settings.thresholds.warn } } }); // refused: no owner_asked
await show('session_prompt', { session: 'no-such-session', text: 'x' });
await show('report_get', { audience: 'me' });
await c.close();
