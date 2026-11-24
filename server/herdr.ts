// Thin wrapper over the herdr CLI. ShiftBoss only reads state, focuses panes and
// submits prompts the user typed. It never answers a permission prompt.

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

async function run(bin: string, args: string[], timeoutMs = 8000): Promise<string> {
  const proc = Bun.spawn([bin, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  if (code !== 0) throw new Error((err || out).trim() || `herdr ${args.join(' ')} exited ${code}`);
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
  /** Same as pressing Esc in the pane: stops the current turn. */
  async interrupt(pane: string): Promise<void> {
    await run(this.bin, ['agent', 'send-keys', pane, 'esc']);
  }
}
