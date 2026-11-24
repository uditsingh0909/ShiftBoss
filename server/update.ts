// Keeps a git checkout of ShiftBoss on the latest version of its branch.
// Only ever fast-forwards: a copy with local edits or local commits is left alone and says why.
// After updating it checks that the new code builds, rolls back if not, and asks run.sh to restart it.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const RESTART_CODE = 75; // scripts/run.sh restarts at once, quietly, on this exit code

export interface VersionInfo { sha: string; date: string; subject: string }
export interface UpdateStatus {
  supported: boolean; // a git checkout (the desktop app's bundled server is not)
  current: VersionInfo | null;
  latest: VersionInfo | null;
  behind: number;
  checking: boolean;
  checkedAt: string | null;
  state: 'up-to-date' | 'available' | 'updated' | 'blocked' | 'failed' | 'unknown';
  note: string;
}

type Run = (args: string[], timeoutMs?: number) => Promise<{ ok: boolean; out: string }>;

async function exec(cmd: string[], cwd: string, timeoutMs = 30_000): Promise<{ ok: boolean; out: string }> {
  try {
    const p = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    const t = setTimeout(() => p.kill(), timeoutMs);
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(t);
    return { ok: code === 0, out: (out + err).trim() };
  } catch (e) { return { ok: false, out: (e as Error).message }; }
}

/** Files whose change needs `bun install` first. */
export const needsInstall = (files: string[]) => files.some((f) => f === 'package.json' || f === 'bun.lock' || f === 'bun.lockb');

export class Updater {
  readonly repo: string;
  status: UpdateStatus = { supported: false, current: null, latest: null, behind: 0, checking: false, checkedAt: null, state: 'unknown', note: 'Not checked yet' };
  private git: Run = (args, t) => exec(['git', ...args], this.repo, t);

  constructor(private hooks: { busy: () => string | null; log: (text: string) => void; supervised: boolean; repo?: string }) {
    this.repo = hooks.repo ?? resolve(import.meta.dir, '..');
    this.status.supported = existsSync(join(this.repo, '.git'));
    if (!this.status.supported) this.status.note = 'Not a git checkout, so it cannot update itself';
  }

  private async info(ref: string): Promise<VersionInfo | null> {
    const r = await this.git(['log', '-1', '--format=%h%x09%cI%x09%s', ref]);
    if (!r.ok) return null;
    const [sha, date, ...s] = r.out.split('\t');
    return { sha, date, subject: s.join('\t') };
  }

  async readCurrent() { if (this.status.supported) this.status.current = await this.info('HEAD'); return this.status.current; }

  /** Look for a newer version; with `apply`, install it and restart. Never throws. */
  async check(apply: boolean): Promise<UpdateStatus> {
    const st = this.status;
    if (!st.supported || st.checking) return st;
    st.checking = true;
    try {
      await this.readCurrent();
      const branch = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])).out;
      if (!branch || branch === 'HEAD') return this.done('blocked', 'Not on a branch, so there is nothing to follow');
      const fetched = await this.git(['fetch', '--quiet', 'origin', branch], 60_000);
      if (!fetched.ok) return this.done('failed', 'Could not reach GitHub: ' + fetched.out.split('\n')[0].slice(0, 160));
      const up = `origin/${branch}`;
      st.latest = await this.info(up);
      st.behind = Number((await this.git(['rev-list', '--count', `HEAD..${up}`])).out) || 0;
      const ahead = Number((await this.git(['rev-list', '--count', `${up}..HEAD`])).out) || 0;
      if (!st.behind) return this.done('up-to-date', 'Up to date');
      const dirty = (await this.git(['status', '--porcelain', '--untracked-files=no'])).out;
      if (ahead || dirty) return this.done('blocked', `${st.behind} update${st.behind === 1 ? '' : 's'} available, but this copy has local ${ahead ? 'commits' : 'edits'}, so it is not updated automatically`);
      if (!apply) return this.done('available', `${st.behind} update${st.behind === 1 ? '' : 's'} available`);
      const busy = this.hooks.busy();
      if (busy) return this.done('available', `${st.behind} update${st.behind === 1 ? '' : 's'} available; waiting until ${busy}`);
      return await this.apply(up);
    } finally { st.checking = false; }
  }

  private async apply(up: string): Promise<UpdateStatus> {
    const prev = (await this.git(['rev-parse', 'HEAD'])).out;
    const files = (await this.git(['diff', '--name-only', 'HEAD', up])).out.split('\n').filter(Boolean);
    const ff = await this.git(['merge', '--ff-only', '--quiet', up]);
    if (!ff.ok) return this.done('failed', 'Could not update: ' + ff.out.split('\n')[0].slice(0, 160));
    const back = async (why: string) => {
      await this.git(['reset', '--keep', prev]); // the tree was clean, so this only undoes the fast-forward
      if (needsInstall(files)) await exec(['bun', 'install'], this.repo, 180_000);
      return this.done('failed', why + '; went back to the version that was running');
    };
    if (needsInstall(files)) {
      const inst = await exec(['bun', 'install'], this.repo, 180_000);
      if (!inst.ok) return back('Installing the new packages failed');
    }
    // The new server must at least build (every import resolves, no syntax errors) before we restart into it.
    const out = mkdtempSync(join(tmpdir(), 'shiftboss-update-'));
    const built = await exec(['bun', 'build', 'server/index.ts', '--target=bun', '--outdir', out], this.repo, 120_000);
    rmSync(out, { recursive: true, force: true });
    if (!built.ok) return back('The new version did not build');
    await this.readCurrent();
    const v = this.status.current;
    this.hooks.log(`updated to ${v?.sha} (${v?.subject?.slice(0, 80)})${this.hooks.supervised ? '; restarting' : '; restart ShiftBoss to use it'}`);
    this.status.behind = 0;
    this.done('updated', this.hooks.supervised ? 'Updated; restarting' : 'Updated; restart ShiftBoss to use it');
    if (this.hooks.supervised) setTimeout(() => process.exit(RESTART_CODE), 1500);
    return this.status;
  }

  private done(state: UpdateStatus['state'], note: string): UpdateStatus {
    this.status.state = state; this.status.note = note; this.status.checkedAt = new Date().toISOString();
    return this.status;
  }
}
