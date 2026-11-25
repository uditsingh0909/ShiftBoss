// Thin wrapper over the herdr CLI. ShiftBoss only reads state, focuses panes and
// submits prompts the user typed. It never answers a permission prompt.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { HANDOVER_MAX, inWorkspace, pickSplit, tabWithRoom, workspaceFor, type PaneInfo, type PaneRect, type TabInfo } from './panes';
import { isStartupQuestion } from './fleet';

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
  tab_id?: string;
  name?: string; // set with `herdr agent rename`; wins over the terminal title
  terminal_title_stripped?: string;
  workspace_id: string;
}

class SplitUnreadable extends Error {}
/** A split was sent and may have happened: nothing else may be opened, or a bare shell is left behind. */
class SplitUncertain extends Error {}

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
  async panes(workspace = ''): Promise<PaneInfo[]> {
    const ps: (PaneInfo & { workspace_id?: string })[] = JSON.parse(await run(this.bin, ['pane', 'list']))?.result?.panes ?? [];
    return ps.filter((p) => !workspace || p.workspace_id === workspace);
  }
  async tabs(workspace = ''): Promise<TabInfo[]> {
    const ts: TabInfo[] = JSON.parse(await run(this.bin, ['tab', 'list']))?.result?.tabs ?? [];
    return ts.filter((t) => !workspace || t.workspace_id === workspace);
  }
  async layout(pane: string): Promise<PaneRect[]> {
    return JSON.parse(await run(this.bin, ['pane', 'layout', '--pane', pane]))?.result?.layout?.panes ?? [];
  }
  async renamePane(pane: string, label: string): Promise<void> { await run(this.bin, ['pane', 'rename', pane, label]); }
  async renameAgent(pane: string, name: string): Promise<void> { await run(this.bin, ['agent', 'rename', pane, name]); }
  async renameTab(tab: string, label: string): Promise<void> { await run(this.bin, ['tab', 'rename', tab, label]); }
  /** Move a live pane next to another one (in another tab). Nothing restarts. */
  async movePane(pane: string, tab: string, target: string, split: 'right' | 'down'): Promise<void> {
    await run(this.bin, ['pane', 'move', pane, '--tab', tab, '--target-pane', target, '--split', split, '--no-focus']);
  }
  /** Move a live pane into a tab of its own; returns that tab's id. */
  async movePaneToNewTab(pane: string, label: string): Promise<string> {
    await run(this.bin, ['pane', 'move', pane, '--new-tab', '--tab-label', label, '--no-focus']);
    const p = (await this.panes()).find((x) => x.pane_id === pane);
    if (!p) throw new Error('herdr moved it but the pane is gone');
    return p.tab_id;
  }
  /**
   * Split `at` and return the new pane. Once the split is sent, a slow or unreadable reply is not trusted: the tab
   * is listed again and a pane that was not there before is the new one, so no bare shell is left behind unnoticed.
   */
  private async split(at: { pane: string; direction: 'right' | 'down' }, cwd: string, tab: string): Promise<string> {
    const before = new Set((await this.panes()).filter((p) => p.tab_id === tab).map((p) => p.pane_id));
    let refused = false; const t0 = Date.now();
    try {
      const out = JSON.parse(await run(this.bin, ['pane', 'split', at.pane, '--direction', at.direction, '--cwd', cwd, '--no-focus'], 20_000));
      const pane: string | undefined = out?.result?.pane?.pane_id;
      if (pane) return pane;
    } catch (e) { refused = e instanceof HerdrError && Date.now() - t0 < 15_000; } // a quick error is herdr saying no; a timeout is not
    // Look twice, a few seconds apart, for a split that landed late.
    for (let i = 0; i < 2; i++) {
      let now;
      try { now = await this.panes(); } catch { throw new SplitUncertain('herdr may have split a pane but did not say; look for a bare shell in herdr'); }
      const fresh = now.find((p) => p.tab_id === tab && !before.has(p.pane_id));
      if (fresh) return fresh.pane_id;
      if (refused) break;
      await Bun.sleep(3000);
    }
    if (refused) throw new SplitUnreadable('herdr did not split the pane');
    throw new SplitUncertain('herdr may have split a pane but did not say; look for a bare shell in herdr');
  }

  /**
   * Where a new session goes: with perTab > 1, a split of the newest Claude-only tab that has room
   * (the biggest pane, so 4 make a 2x2); otherwise, or when every tab is full, a new tab.
   */
  private async placeNewPane(opts: { name: string; cwd: string; workspace?: string; perTab?: number; avoidTabs?: Set<string>; beside?: string }): Promise<{ pane: string; split: boolean }> {
    const workspace = opts.workspace;
    if (opts.beside) {
      try {
        const panes = await this.panes();
        const home = panes.find((p) => p.pane_id === opts.beside);
        const mates = home ? panes.filter((p) => p.tab_id === home.tab_id) : [];
        if (home && mates.length < HANDOVER_MAX && mates.every((p) => p.agent === 'claude')) {
          const at = pickSplit(await this.layout(home.pane_id));
          if (at) return { pane: await this.split(at, opts.cwd, home.tab_id), split: true };
        }
      } catch (e) { if (e instanceof SplitUncertain) throw e; /* nothing was split: use the usual rule */ }
    }
    if ((opts.perTab ?? 1) > 1) {
      try {
        const [allTabs, allPanes] = await Promise.all([this.tabs(), this.panes()]);
        // With no workspace set, share tabs in the one the owner is looking at; a new tab still goes to herdr's default.
        const ws = workspaceFor(allTabs, opts.workspace ?? '');
        const room = tabWithRoom(inWorkspace(allTabs, ws), inWorkspace(allPanes, ws), opts.perTab!, opts.avoidTabs);
        const at = room ? pickSplit(await this.layout(room.panes[0])) : null;
        if (at && room) return { pane: await this.split(at, opts.cwd, room.tab), split: true };
      } catch (e) { if (e instanceof SplitUncertain) throw e; /* no split happened: a tab of its own */ }
    }
    const tabArgs = ['tab', 'create', '--cwd', opts.cwd, '--label', opts.name, '--no-focus'];
    if (workspace) tabArgs.push('--workspace', workspace);
    const out = JSON.parse(await run(this.bin, tabArgs));
    const pane: string | undefined = out?.result?.root_pane?.pane_id;
    if (!pane) throw new Error('herdr did not return a pane for the new tab');
    return { pane, split: false };
  }

  /**
   * A Claude Code session in a new pane (see placeNewPane), labelled with its name. Returns the pane id. Waits
   * until Claude is ready for input. If Claude does not start in a split pane, the pane is closed again so no bare
   * shell is left in a shared tab (a startup question such as "trust this folder?" keeps it: the owner answers it).
   */
  async spawnClaude(opts: { name: string; cwd: string; workspace?: string; model?: string; resume?: string; perTab?: number; avoidTabs?: Set<string>; beside?: string }): Promise<string> {
    const { pane, split } = await this.placeNewPane(opts);
    try {
      try { await this.renamePane(pane, opts.name); } catch { /* the label is cosmetic */ }
      const startArgs = ['agent', 'start', opts.name, '--kind', 'claude', '--pane', pane, '--timeout', '60000'];
      const claudeArgs = [...(opts.model ? ['--model', opts.model] : []), ...(opts.resume ? ['--resume', opts.resume] : [])];
      if (claudeArgs.length) startArgs.push('--', ...claudeArgs);
      await run(this.bin, startArgs, 70_000); // herdr waits up to 60 s for Claude to be ready
    } catch (e) {
      if (split && !isStartupQuestion((e as Error).message)) {
        let loading = false;
        try { loading = parseAgentList(await run(this.bin, ['agent', 'list']), '').some((a) => a.pane_id === pane); } catch { loading = true; } // unsure: leave it
        if (!loading) { try { await run(this.bin, ['pane', 'close', pane]); } catch { /* already gone */ } }
      }
      throw e;
    }
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
  /** Close a pane (its Claude session ends; the transcript stays, so it can be resumed). Refuses while it works or waits on a prompt. */
  async close(pane: string): Promise<void> {
    const live = parseAgentList(await run(this.bin, ['agent', 'list']), '').find((a) => a.pane_id === pane);
    if (live?.agent_status === 'blocked') throw new PaneBlockedError();
    if (live?.agent_status === 'working') throw new Error('it is working');
    await run(this.bin, ['pane', 'close', pane]);
  }
}
