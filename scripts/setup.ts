#!/usr/bin/env bun
// One-shot setup for a new machine. Claude Code runs this when given the repo (see SETUP.md);
// a person can run it too. Uses only built-ins, so it works before `bun install`.
//
//   bun scripts/setup.ts                      check everything, change nothing
//   bun scripts/setup.ts --owner Sam --start  write the config, install, start ShiftBoss
//
// Steps that change user-level config only run with their own flag:
//   --mcp           register the shiftboss MCP server for every Claude session (claude mcp add, user scope)
//   --status-line   put the usage tap in front of the status line (~/.claude/settings.json, backed up first)
//   --startup       start ShiftBoss at login (Windows Startup folder)
//   --intake        start the intake session in a new herdr tab
//   --intake-cwd D  the folder to start it in: the folder the setting-up Claude session runs in (already trusted).
//                   Without it: the lead session's folder, and only then the ShiftBoss folder (which asks "trust this folder?")
// Other flags: --owner NAME  --workspace W  --lead SESSION  --port N  --json
//   --mode dry|ask|safe|auto   what ShiftBoss may do on its own (new installs start in dry: Dry run)
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..').replace(/\\/g, '/');
const WIN = process.platform === 'win32';
const args = process.argv.slice(2);
const flag = (k: string) => args.includes('--' + k);
const opt = (k: string) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined; };

type Check = { step: string; ok: boolean; note: string };
const report: Check[] = [];
const log = (step: string, ok: boolean, note: string) => { report.push({ step, ok, note }); if (!flag('json')) console.log(`${ok ? '[x]' : '[ ]'} ${step}: ${note}`); };

function sh(cmd: string, a: string[], timeout = 20000) {
  const r = spawnSync(cmd, a, { encoding: 'utf8', timeout, shell: WIN, windowsHide: true });
  return { ok: r.status === 0, out: ((r.stdout ?? '') + (r.stderr ?? '')).trim() };
}
const has = (cmd: string, a = ['--version']) => sh(cmd, a, 15000);

// ---------- 1. prerequisites
log('bun', true, process.versions.bun ?? 'unknown');
const herdr = has('herdr', ['agent', 'list']);
let sessionCount = 0;
try { sessionCount = (JSON.parse(herdr.out).result?.agents ?? []).filter((a: any) => a.agent === 'claude').length; } catch { /* not JSON */ }
log('herdr', herdr.ok, herdr.ok ? `${sessionCount} Claude session(s) running` : 'not answering: start herdr, then run this again');
const claude = has('claude');
log('claude', claude.ok, claude.ok ? claude.out.split('\n')[0] : 'Claude Code not found on PATH');
const gh = has('gh', ['auth', 'status']);
log('gh (optional)', gh.ok, gh.ok ? 'signed in: tasks move to PR open / On dev / Live by themselves' : 'not signed in: automatic task moves are off');

// ---------- 2. dependencies
if (!existsSync(join(REPO, 'node_modules', 'react'))) {
  const r = sh('bun', ['install'], 180000);
  log('bun install', r.ok, r.ok ? 'done' : r.out.slice(-300));
} else log('bun install', true, 'already installed');

// ---------- 3. config
const cfgPath = join(REPO, 'shiftboss.config.json');
// A new config starts empty (every field has a working default), not from the example, whose
// placeholder URLs and lanes would otherwise become real settings.
let cfg: any = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};
const before = JSON.stringify(cfg);
if (opt('owner')) cfg.ownerName = opt('owner');
if (opt('workspace') !== undefined) cfg.herdrWorkspace = opt('workspace');
if (opt('port')) cfg.port = Number(opt('port'));
if (!existsSync(cfgPath) || JSON.stringify(cfg) !== before) writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
const port = Number(process.env.SHIFTBOSS_PORT || cfg.port || 4400);
const BASE = `http://127.0.0.1:${port}`;
log('config', !!cfg.ownerName && cfg.ownerName !== 'The owner', `owner ${cfg.ownerName ?? 'not set (use --owner)'}, port ${port}${cfg.herdrWorkspace ? ', workspace ' + cfg.herdrWorkspace : ''}`);

// ---------- 4. start
async function up(): Promise<boolean> { try { return (await fetch(BASE + '/api/onboarding', { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } }
async function api(method: string, path: string, body?: unknown) {
  // Setup runs with the owner's consent, so its actions are the owner's (not held by the gate).
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', 'x-shiftboss': '1', 'x-shiftboss-actor': 'owner', 'x-shiftboss-by': 'setup' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
  return d;
}
function gitBash(): string | null {
  if (!WIN) return 'bash';
  for (const p of ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files (x86)/Git/bin/bash.exe', join(homedir(), 'AppData/Local/Programs/Git/bin/bash.exe')]) if (existsSync(p)) return p;
  return null; // never the WSL bash: it cannot see this Windows checkout's bun
}
let running = await up();
if (!running && flag('start')) {
  mkdirSync(join(REPO, 'data'), { recursive: true });
  const bash = gitBash();
  // run.sh restarts ShiftBoss whenever it exits; without bash, start the server once.
  const [cmd, a] = bash ? [bash, ['scripts/run.sh']] : ['bun', ['server/index.ts']];
  spawn(cmd, a, { cwd: REPO, detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, SHIFTBOSS_PORT: String(port) } }).unref();
  for (let i = 0; i < 40 && !running; i++) { await Bun.sleep(500); running = await up(); }
}
log('ShiftBoss running', running, running ? BASE : flag('start') ? `did not answer within 20 s; read ${REPO}/data/server.log` : 'not running (add --start)');

// ---------- 5. MCP tools (user scope)
if (claude.ok) {
  const get = sh('claude', ['mcp', 'get', 'shiftboss']);
  const pointsHere = get.ok && get.out.replace(/\\/g, '/').includes(REPO + '/mcp/server.ts');
  if (!pointsHere && flag('mcp')) {
    if (get.ok) sh('claude', ['mcp', 'remove', 'shiftboss', '-s', 'user']);
    const envArg = port === 4400 ? [] : ['--env', `SHIFTBOSS_PORT=${port}`];
    const add = sh('claude', ['mcp', 'add', '--scope', 'user', ...envArg, 'shiftboss', '--', 'bun', `${REPO}/mcp/server.ts`]);
    log('MCP tools', add.ok, add.ok ? 'registered; sessions started from now on have them (restart running ones to load them)' : add.out.slice(-300));
  } else log('MCP tools', pointsHere, pointsHere ? 'registered' : get.ok ? 'registered to another install (add --mcp to point it here)' : 'not registered (add --mcp)');
}

// ---------- 6. status line tap
const settingsPath = join(homedir(), '.claude', 'settings.json');
let settings: any = {};
try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch { /* none yet */ }
const current: string | undefined = settings.statusLine?.command;
const tapped = !!current && current.replace(/\\/g, '/').includes(REPO + '/cli/statusline-tap');
const tappedElsewhere = !!current && current.includes('statusline-tap') && !tapped;
if (!tapped && flag('status-line')) {
  if (existsSync(settingsPath)) copyFileSync(settingsPath, settingsPath + '.shiftboss-backup');
  else mkdirSync(join(homedir(), '.claude'), { recursive: true });
  // Another install's tap: replace it, keeping the user's own command that follows it.
  const own = tappedElsewhere ? current!.replace(/^node\s+\S*statusline-tap\.cjs\s*("--data-dir=[^"]*"\s*|--data-dir=\S*\s*)?/, '') : current;
  // The tap runs without this process's environment: pass a custom data folder to it explicitly.
  const dd = process.env.SHIFTBOSS_DATA_DIR?.replace(/\\/g, '/');
  const tapArg = dd ? ' ' + (/\s/.test(dd) ? `"--data-dir=${dd}"` : `--data-dir=${dd}`) : '';
  settings.statusLine = { type: 'command', ...(settings.statusLine ?? {}), command: `node ${REPO}/cli/statusline-tap.cjs${tapArg}${own ? ' ' + own : ''}` };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  log('status line tap', true, `added in front of ${current ? 'your status line' : 'an empty status line'}; backup at settings.json.shiftboss-backup`);
} else log('status line tap', tapped, tapped ? 'on' : tappedElsewhere ? 'points at another install (add --status-line to point it here)' : 'off (optional: add --status-line)');

// ---------- 7. start at login (Windows)
if (WIN) {
  const startup = join(process.env.APPDATA ?? join(homedir(), 'AppData/Roaming'), 'Microsoft/Windows/Start Menu/Programs/Startup/ShiftBoss.vbs');
  const bash = gitBash();
  const mine = existsSync(startup) && readFileSync(startup, 'utf8').replace(/\\/g, '/').includes(REPO);
  if (!mine && flag('startup') && bash) {
    writeFileSync(startup, `Set sh = CreateObject("WScript.Shell")\r\nsh.CurrentDirectory = "${REPO.replace(/\//g, '\\')}"\r\nsh.Run """${bash.replace(/\//g, '\\')}"" scripts/run.sh", 0, False\r\n`);
    log('start at login', true, startup);
  } else log('start at login', mine, mine ? 'on' : existsSync(startup) ? 'starts another install (add --startup to start this one)' : bash ? 'off (optional: add --startup)' : 'needs Git Bash');
}

// ---------- 8. lead session, intake
let next: string[] = [];
if (running) {
  if (opt('lead')) {
    const snap = await api('GET', '/api/snapshot');
    await api('PUT', '/api/settings', { ...snap.settings, leadSession: opt('lead'), ...(opt('workspace') !== undefined ? { herdrWorkspace: opt('workspace') } : {}) });
  }
  const MODE_NAMES: Record<string, string> = { dry: 'Dry run (records what it would do, does nothing)', ask: 'Ask first (every action waits for approval)', safe: 'Safe auto (routine actions run, risky ones wait)', auto: 'Autopilot (everything runs)' };
  if (opt('mode')) {
    try { await api('POST', '/api/mode', { mode: opt('mode'), dryRun: 'review' }); } catch (e) { log('mode', false, (e as Error).message); }
  }
  const mode = (await api('GET', '/api/snapshot')).settings.mode ?? 'auto';
  log('mode', true, MODE_NAMES[mode] ?? mode);
  let o = await api('GET', '/api/onboarding');
  log('lead session', !!o.settings.leadSession && o.sessions.some((s: any) => s.name === o.settings.leadSession || s.name.startsWith(o.settings.leadSession + '-v')),
    o.settings.leadSession ? `${o.settings.leadSession}${o.sessions.some((s: any) => s.name.startsWith(o.settings.leadSession)) ? '' : ' (not running yet)'}` : 'not set (use --lead)');
  if (!o.intake.running && flag('intake')) {
    // The intake needs nothing from the ShiftBoss folder (it reads INTAKE.md by its full path and uses the MCP
    // tools), so start it where Claude already works: no "trust this folder?" stop.
    const lead = o.sessions.find((s: any) => o.settings.leadSession && (s.name === o.settings.leadSession || s.name.startsWith(o.settings.leadSession + '-v')));
    const given = opt('intake-cwd');
    const cwd = given && existsSync(given) ? given : lead?.cwd && existsSync(lead.cwd) ? lead.cwd : REPO;
    const where = cwd === given ? 'your Claude session\'s folder' : cwd === lead?.cwd ? `the lead session's folder (${lead.name})` : 'the ShiftBoss folder';
    try {
      await api('POST', '/api/sessions/spawn', { name: 'intake', cwd, model: 'sonnet', prompt: o.setup.commands.intakeLoop });
      log('intake session', true, `starting in a new herdr tab, in ${where}: ${cwd}` + (cwd === REPO
        ? '. Claude has not opened this folder before, so the tab asks "trust this folder?": answer it in herdr (pass --intake-cwd <your project folder> to avoid it)'
        : ''));
    } catch (e) { log('intake session', false, (e as Error).message); }
  } else log('intake session', !!o.intake.running, o.intake.running ? `${o.intake.running} running` : 'not running (optional: add --intake; it needs the Slack connector, and Gmail for meeting notes)');
  o = await api('GET', '/api/onboarding');
  const unasked = o.sessions.filter((s: any) => !/intake/i.test(s.name) && !s.askedAt && !s.tasks);
  next = [
    ...(unasked.length ? [`Bring in current work from ${unasked.length} session(s): shiftboss setup ask --all   (or MCP onboarding_ask)`] : []),
    ...(!o.onboarding.backfillFrom ? ['Read back Slack and Gmail: shiftboss setup backfill 3   (or MCP onboarding_backfill)'] : []),
    ...(!o.onboarding.doneAt ? ['Finish: shiftboss setup done   (or MCP onboarding_done)'] : []),
    `Open the UI: ${BASE}/welcome  (it shows the same steps and updates live)`,
  ];
}

if (flag('json')) console.log(JSON.stringify({ repo: REPO, port, checks: report, next }, null, 2));
else if (next.length) console.log('\nNext:\n' + next.map((n) => '  - ' + n).join('\n') + `\n\nCLI: bun ${REPO}/cli/shiftboss.ts setup status`);
