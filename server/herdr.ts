// Thin wrapper over the herdr CLI. ShiftBoss only reads state, focuses panes and
// submits prompts the user typed. It never answers a permission prompt.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const RAISE = join(import.meta.dir, '..', 'scripts', 'raise-herdr.ps1');

/** Windows: bring the terminal hosting herdr to the front. Best effort; never throws. */
async function raiseHerdrWindow(): Promise<void> {
  if (process.platform !== 'win32' || !existsSync(RAISE)) return;
  try {
    const p = Bun.spawn(['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', RAISE], { stdout: 'ignore', stderr: 'ignore' });
    const t = setTimeout(() => p.kill(), 8000);
    await p.exited; clearTimeout(t);
  } catch { /* the pane is focused either way */ }
}

/** The pane shows a permission prompt; ShiftBoss must not send it keys. */
export class PaneBlockedError extends Error {
  constructor() { super('It is waiting on a permission prompt: answer it in herdr'); }
}

export interface HerdrAgent {
  agent: string;
  agent_status: string;
  agent_session?: { value: string } | null;
  cwd: string;
  focused: boolean;
  pane_id: string;
  name?: string; // set with `herdr agent rename`; wins over the terminal title
  terminal_title_stripped?: string;
  workspace_id: string;
}

/** herdr itself failed (not running, pane gone): the API answers 502, not 400. */
export class HerdrError extends Error {}

async function run(bin: string, args: string[], timeoutMs = 8000): Promise<string> {
  const proc = Bun.spawn([bin, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  if (code !== 0) throw new HerdrError((err || out).trim() || `herdr ${args.join(' ')} exited ${code}`);
  return out;
}

export function parseAgentList(json: string, workspace: string): HerdrAgent[] {
  const data = JSON.parse(json);
  const agents: HerdrAgent[] = data?.result?.agents ?? [];
  return agents.filter((a) => a.agent === 'claude' && (!workspace || a.workspace_id === workspace));
}

export function nameOf(a: HerdrAgent): string {
  return (a.name || a.terminal_title_stripped || a.pane_id).trim();
}

export class Herdr {
  constructor(private bin: string) {}
  async list(workspace: string): Promise<HerdrAgent[]> {
    return parseAgentList(await run(this.bin, ['agent', 'list']), workspace);
  }
  async read(pane: string, lines = 40): Promise<string> {
    return run(this.bin, ['agent', 'read', pane, '--source', 'recent', '--lines', String(lines)]);
  }
  async prompt(pane: string, text: string): Promise<void> {
    if (!text.trim()) throw new Error('Empty prompt');
    await run(this.bin, ['agent', 'prompt', pane, text]);
  }
  async focus(pane: string): Promise<void> {
    await run(this.bin, ['agent', 'focus', pane]);
    await raiseHerdrWindow();
  }
  /** New tab with a Claude Code session in it. Returns the pane id. Waits until Claude is ready for input. */
  async spawnClaude(opts: { name: string; cwd: string; workspace?: string; model?: string }): Promise<string> {
    const tabArgs = ['tab', 'create', '--cwd', opts.cwd, '--label', opts.name, '--no-focus'];
    if (opts.workspace) tabArgs.push('--workspace', opts.workspace);
    const out = JSON.parse(await run(this.bin, tabArgs));
    const pane: string | undefined = out?.result?.root_pane?.pane_id;
    if (!pane) throw new Error('herdr did not return a pane for the new tab');
    const startArgs = ['agent', 'start', opts.name, '--kind', 'claude', '--pane', pane, '--timeout', '60000'];
    if (opts.model) startArgs.push('--', '--model', opts.model);
    await run(this.bin, startArgs);
    return pane;
  }
  /**
   * Same as pressing Esc in the pane: stops the current turn. Esc on a permission prompt would deny it,
   * so this checks the pane's live status first and refuses while it is blocked (unlike `agent prompt`,
   * `send-keys` has no agent_blocked check of its own).
   */
  async interrupt(pane: string): Promise<void> {
    const live = parseAgentList(await run(this.bin, ['agent', 'list']), '').find((a) => a.pane_id === pane);
    if (live?.agent_status === 'blocked') throw new PaneBlockedError();
    await run(this.bin, ['agent', 'send-keys', pane, 'esc']);
  }
}
