// Read-only checks for the Connect page: is the MCP server registered, is the status line tap on,
// and the exact commands for this install. Reads the user's Claude config files; never writes them.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface SetupInfo {
  repoPath: string;
  port: number;
  mcp: { registered: boolean; command: string | null; pointsHere: boolean };
  statusTap: { configured: boolean; command: string | null };
  commands: { mcpAdd: string; mcpCheck: string; cli: string; statusLine: string; intakeLoop: string };
}

function readJson(path: string): any {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; } catch { return null; }
}

export function setupInfo(port: number): SetupInfo {
  const repo = resolve(import.meta.dir, '..').replace(/\\/g, '/');
  const claudeJson = readJson(join(homedir(), '.claude.json'));
  const settings = readJson(join(homedir(), '.claude', 'settings.json'));
  const mcpEntry = claudeJson?.mcpServers?.shiftboss ?? null;
  const mcpCommand = mcpEntry ? [mcpEntry.command, ...(mcpEntry.args ?? [])].join(' ') : null;
  const statusCmd: string | null = settings?.statusLine?.command ?? null;
  const portEnv = port === 4400 ? '' : ` --env SHIFTBOSS_PORT=${port}`;
  // Claude Code runs the tap without the server's environment, so an install that keeps its data outside
  // the repo (SHIFTBOSS_DATA_DIR, as the desktop app does) passes the folder to the tap explicitly.
  const dataDir = process.env.SHIFTBOSS_DATA_DIR?.replace(/\\/g, '/');
  const tapArg = dataDir ? ' ' + (/\s/.test(dataDir) ? `"--data-dir=${dataDir}"` : `--data-dir=${dataDir}`) : '';
  return {
    repoPath: repo,
    port,
    mcp: { registered: !!mcpEntry, command: mcpCommand, pointsHere: !!mcpCommand && mcpCommand.replace(/\\/g, '/').includes(repo + '/mcp/server.ts') },
    statusTap: { configured: !!statusCmd && statusCmd.includes('statusline-tap'), command: statusCmd },
    commands: {
      mcpAdd: `claude mcp add --scope user${portEnv} shiftboss -- bun ${repo}/mcp/server.ts`,
      mcpCheck: 'claude mcp get shiftboss',
      cli: `bun ${repo}/cli/shiftboss.ts status`,
      statusLine: statusCmd && !statusCmd.includes('statusline-tap')
        ? `node ${repo}/cli/statusline-tap.cjs${tapArg} ${statusCmd}`
        : `node ${repo}/cli/statusline-tap.cjs${tapArg}`,
      intakeLoop: `/loop 2m You are ShiftBoss's intake session. Each run, read ${repo}/docs/INTAKE.md and follow it exactly: start with intake_begin, read Slack (mentions, DMs, watched channels, and new replies in threads the owner is in), then Gmail (meeting notes and emails with asks) from readFrom, log every message with the shiftboss tools, file new asks as tasks, record promises, end with intake_checkpoint. Never post, react, DM or do the work yourself.`,
    },
  };
}
