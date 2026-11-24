#!/usr/bin/env node
// Opt-in status line tap for Shiftboss.
// Claude Code pipes its status line JSON (context %, 5-hour and weekly usage) to this
// script. It saves a copy to shiftboss/data/status/<session_id>.json, then hands the same
// input to your existing status line command so nothing on screen changes.
//
// settings.json:
//   "statusLine": { "type": "command",
//     "command": "node <path-to-shiftboss>/cli/statusline-tap.cjs node C:/Users/you/.claude/statusline-command.js" }
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  try {
    const j = JSON.parse(raw);
    if (j.session_id && /^[A-Za-z0-9-]+$/.test(j.session_id)) {
      const dir = path.join(__dirname, '..', 'data', 'status');
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, j.session_id + '.json.tmp');
      fs.writeFileSync(tmp, JSON.stringify({ ...j, _tappedAt: Date.now() }));
      fs.renameSync(tmp, path.join(dir, j.session_id + '.json'));
    }
  } catch (e) { /* never break the status line */ }
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) return;
  const r = spawnSync(cmd, args, { input: raw, encoding: 'utf8' });
  process.stdout.write(r.stdout || '');
});
