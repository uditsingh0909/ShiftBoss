// Claude Code sessions that run outside herdr (plain CLI / TUI, the desktop app's Code sessions).
// Every session keeps its history in ~/.claude/projects/<project>/<session-id>.jsonl, so it can be
// reopened inside herdr with `claude --resume <id>` and carry on with nothing lost.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface OutsideSession {
  sessionId: string;
  cwd: string;
  cwdExists: boolean;
  title: string | null; // from /rename (custom-title), if it was named
  firstAsk: string | null; // first thing the user typed, for recognising unnamed sessions
  lastAt: string;
  sizeKB: number;
  /** Written to in the last few minutes: probably still open in another window. */
  recent: boolean;
  suggestedName: string;
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isSessionId = (s: unknown): s is string => typeof s === 'string' && ID_RE.test(s);

function readSlice(path: string, from: number, len: number): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, from);
    return buf.subarray(0, n).toString('utf8');
  } finally { closeSync(fd); }
}

function lines(text: string): any[] {
  const out: any[] = [];
  for (const l of text.split('\n')) { try { out.push(JSON.parse(l)); } catch { /* cut line at a slice edge */ } }
  return out;
}

function userText(o: any): string | null {
  if (o?.type !== 'user' || o.isMeta) return null;
  const c = o.message?.content;
  const t = typeof c === 'string' ? c : Array.isArray(c) ? c.find((x: any) => x?.type === 'text')?.text : null;
  if (!t || t.startsWith('<') || t.startsWith('Caveat:')) return null; // command output, system notes
  return t.replace(/\s+/g, ' ').trim().slice(0, 140);
}

/** A herdr-friendly name: the /rename title, else the folder name plus the start of the session id. */
export function suggestName(title: string | null, cwd: string, sessionId: string, taken: Set<string>): string {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 34);
  let base = (title && clean(title)) || `${clean(basename(cwd.replace(/[\\/]+$/, ''))) || 'session'}-${sessionId.slice(0, 4)}`;
  if (!/^[a-z0-9]/.test(base)) base = 's-' + base;
  if (base.length < 2) base += '-1';
  let name = base, n = 2;
  while (taken.has(name)) name = `${base}-${n++}`;
  return name;
}

/** One history file: folder, title, first ask. Reads only the head and the tail, so large files stay cheap. */
export function readOutside(path: string, nowMs = Date.now()): Omit<OutsideSession, 'suggestedName'> | null {
  const sessionId = basename(path, '.jsonl');
  if (!isSessionId(sessionId)) return null;
  const st = statSync(path);
  const head = lines(readSlice(path, 0, 64 * 1024));
  const tailFrom = Math.max(0, st.size - 512 * 1024);
  const tail = tailFrom ? lines(readSlice(path, tailFrom, st.size - tailFrom)) : head;
  const cwd = (head.find((o) => typeof o?.cwd === 'string') ?? tail.find((o) => typeof o?.cwd === 'string'))?.cwd;
  if (!cwd) return null; // nothing ever ran: not worth bringing in
  const titles = [...head, ...tail].filter((o) => o?.type === 'custom-title' && typeof o.customTitle === 'string');
  let firstAsk: string | null = null;
  for (const o of head) { firstAsk = userText(o); if (firstAsk) break; }
  return {
    sessionId, cwd, cwdExists: existsSync(cwd), title: titles.at(-1)?.customTitle ?? null, firstAsk,
    lastAt: st.mtime.toISOString(), sizeKB: Math.round(st.size / 1024), recent: nowMs - st.mtimeMs < 3 * 60e3,
  };
}

/**
 * Sessions with history from the last `days` days that are not running in herdr now, newest first.
 * `running` holds the session ids herdr shows, `takenNames` the names in use (for unique suggestions).
 */
export function listOutside(projectsDir: string, running: Set<string>, takenNames: Set<string>, days = 14, limit = 60): OutsideSession[] {
  if (!existsSync(projectsDir)) return [];
  const since = Date.now() - days * 864e5;
  const found: { path: string; mtime: number }[] = [];
  for (const dir of readdirSync(projectsDir)) {
    const full = join(projectsDir, dir);
    let files: string[];
    try { files = readdirSync(full); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -6);
      if (!isSessionId(id) || running.has(id)) continue;
      try { const m = statSync(join(full, f)).mtimeMs; if (m >= since) found.push({ path: join(full, f), mtime: m }); } catch { /* gone */ }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  const taken = new Set(takenNames);
  const out: OutsideSession[] = [];
  for (const { path } of found) {
    if (out.length >= limit) break;
    try {
      const s = readOutside(path);
      if (!s) continue;
      const suggestedName = suggestName(s.title, s.cwd, s.sessionId, taken);
      taken.add(suggestedName);
      out.push({ ...s, suggestedName });
    } catch { /* unreadable file: skip it */ }
  }
  return out;
}
