#!/usr/bin/env node
// Opt-in status line tap for ShiftBoss.
// Claude Code pipes its status line JSON (context %, 5-hour and weekly usage) to this
// script. It saves a copy to <data dir>/status/<session_id>.json, then hands the same
// input to your existing status line command so nothing on screen changes.
//
// The data dir is the one the server reads: SHIFTBOSS_DATA_DIR if set, else shiftboss/data.
// A first argument --data-dir=<path> overrides both (for installs that keep data elsewhere).
//
// settings.json:
//   "statusLine": { "type": "command",
//     "command": "node <path-to-shiftboss>/cli/statusline-tap.cjs node C:/Users/you/.claude/statusline-command.js" }
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
let dataDir = process.env.SHIFTBOSS_DATA_DIR || path.join(__dirname, '..', 'data');
if (argv[0] && argv[0].startsWith('--data-dir=')) dataDir = argv.shift().slice('--data-dir='.length);

/** Quote one argument for cmd.exe, which is what runs .cmd/.bat shims (npx, bunx, pnpm) on Windows. */
function quoteForCmd(a) {
  return a && !/[\s"&|<>^()%!,;=]/.test(a) ? a : '"' + String(a).replace(/"/g, '\\"') + '"';
}

/**
 * Run the user's own status line command with the same input. Without a shell first, exactly as before;
 * on Windows, a command that is a .cmd shim cannot start that way (ENOENT, or EINVAL for an explicit
 * .cmd), so it is retried through cmd.exe.
 */
function runUserCommand(cmd, args, input) {
  const opts = { input, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 };
  let r = spawnSync(cmd, args, opts);
  if (r.error && process.platform === 'win32' && (r.error.code === 'ENOENT' || r.error.code === 'EINVAL')) {
    r = spawnSync([cmd, ...args].map(quoteForCmd).join(' '), { ...opts, shell: true });
  }
  return r;
}

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  try {
    const j = JSON.parse(raw);
    if (j.session_id && /^[A-Za-z0-9-]+$/.test(j.session_id)) {
      const dir = path.join(dataDir, 'status');
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, j.session_id + '.json.tmp');
      fs.writeFileSync(tmp, JSON.stringify({ ...j, _tappedAt: Date.now() }));
      fs.renameSync(tmp, path.join(dir, j.session_id + '.json'));
    }
  } catch (e) { /* never break the status line */ }
  const [cmd, ...args] = argv;
  if (!cmd) return;
  try {
    const r = runUserCommand(cmd, args, raw);
    if (r.stdout) { process.stdout.write(r.stdout); return; }
    // Nothing printed and it failed: say so in one short line rather than leave the status line blank.
    if (r.error || r.status !== 0) {
      const why = (r.error && r.error.message) || String(r.stderr || '').trim().split(/\r?\n/)[0] || 'exit ' + r.status;
      process.stdout.write(('tap: ' + cmd + ' failed: ' + why).slice(0, 200));
    }
  } catch (e) {
    process.stdout.write(('tap: ' + cmd + ' failed: ' + e.message).slice(0, 200));
  }
});
