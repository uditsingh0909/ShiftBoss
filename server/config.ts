import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configPath } from '../shared/port';

// Everything specific to one team lives in shiftboss.config.json (gitignored).
// The defaults below are safe for anyone.
export interface Config {
  ownerName: string; // who answers Needs-you items; used in prompts sent to sessions
  port: number;
  dataDir: string;
  transcriptsDir: string;
  herdrBin: string;
  herdrWorkspace: string; // '' = every workspace
  pollMs: number;
  handoffsDir: string;
  contextWindows: Record<string, number>; // substring of model id -> window size
  lanes: Record<string, { lane: string; slots: number }>;
  releaseEnvs: { name: string; url: string }[]; // GET <url> returns a version
  releaseRepo: string; // owner/repo for merged PRs via gh, '' to skip
  freezeVar: { repo: string; name: string } | null;
  openBrowser: boolean; // open the UI in the browser when ShiftBoss first starts (not on automatic restarts)
}

const defaults: Config = {
  ownerName: 'The owner',
  port: 4400,
  // The desktop app sets SHIFTBOSS_DATA_DIR to its own app-data folder; a source checkout uses ./data.
  dataDir: process.env.SHIFTBOSS_DATA_DIR ?? join(import.meta.dir, '..', 'data'),
  transcriptsDir: join(homedir(), '.claude', 'projects'),
  herdrBin: 'herdr',
  herdrWorkspace: '',
  pollMs: 2000,
  handoffsDir: '',
  contextWindows: { opus: 1_000_000, sonnet: 1_000_000, haiku: 200_000 },
  lanes: {},
  releaseEnvs: [],
  releaseRepo: '',
  freezeVar: null,
  openBrowser: true,
};

export function loadConfig(): Config {
  const path = configPath();
  const user = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>) : {};
  const cfg = { ...defaults, ...user, contextWindows: { ...defaults.contextWindows, ...(user.contextWindows ?? {}) } };
  if (process.env.SHIFTBOSS_PORT) cfg.port = Number(process.env.SHIFTBOSS_PORT);
  return cfg;
}

export function contextWindowFor(cfg: Config, model: string | null): number {
  if (!model) return 1_000_000;
  const m = model.toLowerCase();
  for (const [k, v] of Object.entries(cfg.contextWindows)) if (m.includes(k)) return v;
  return 1_000_000;
}
