import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Everything specific to one team lives in foreman.config.json (gitignored).
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
}

const defaults: Config = {
  ownerName: 'The owner',
  port: 4400,
  dataDir: join(import.meta.dir, '..', 'data'),
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
};

export function loadConfig(): Config {
  const path = process.env.FOREMAN_CONFIG ?? join(import.meta.dir, '..', 'foreman.config.json');
  if (!existsSync(path)) return defaults;
  const user = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>;
  return { ...defaults, ...user, contextWindows: { ...defaults.contextWindows, ...(user.contextWindows ?? {}) } };
}

export function contextWindowFor(cfg: Config, model: string | null): number {
  if (!model) return 1_000_000;
  const m = model.toLowerCase();
  for (const [k, v] of Object.entries(cfg.contextWindows)) if (m.includes(k)) return v;
  return 1_000_000;
}
