// Which port this ShiftBoss install listens on, for the CLI, the MCP server and scripts.
// Same order as the server: SHIFTBOSS_PORT, then "port" in the install's config file, then 4400.
// Without this, a second install's tools would quietly talk to whichever ShiftBoss owns 4400.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function configPath(): string {
  return process.env.SHIFTBOSS_CONFIG
    ?? (process.env.SHIFTBOSS_DATA_DIR ? join(process.env.SHIFTBOSS_DATA_DIR, 'shiftboss.config.json') : join(import.meta.dir, '..', 'shiftboss.config.json'));
}

export function resolvePort(): number {
  const env = Number(process.env.SHIFTBOSS_PORT);
  if (Number.isInteger(env) && env > 0) return env;
  try {
    const p = configPath();
    if (existsSync(p)) {
      const port = Number(JSON.parse(readFileSync(p, 'utf8')).port);
      if (Number.isInteger(port) && port > 0) return port;
    }
  } catch { /* unreadable config: fall back */ }
  return 4400;
}

if (import.meta.main) console.log(resolvePort());
