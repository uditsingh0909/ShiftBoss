// Cache totals per session, over the WHOLE transcript. Context drops back after an auto-compact; the cache a
// session has read and written keeps growing for its whole life, and that is what makes a long session slow
// and costly. So this is the number to replace a session on (through a handoff), next to context.
// Pure line parser + an incremental reader: the first read scans the file once in chunks, later reads only
// what was appended.
import { closeSync, openSync, readSync, statSync } from 'node:fs';

export interface CacheTotals {
  /** Cache tokens read over the session's whole life (every turn re-reads the cached prompt). */
  read: number;
  /** Cache tokens written (created) over the session's life. */
  written: number;
  /** Auto and manual compactions so far, and when the last one was. */
  compactions: number;
  lastCompactAt: string | null;
  /** Assistant turns counted. */
  turns: number;
}

export const emptyTotals = (): CacheTotals => ({ read: 0, written: 0, compactions: 0, lastCompactAt: null, turns: 0 });

// The top-level usage block of an assistant line. Only its first fields are needed, and they always come in
// this order; nested "iterations" repeat them, so take the first match only.
const USAGE = /"usage":\{"input_tokens":\d+,"cache_creation_input_tokens":(\d+),"cache_read_input_tokens":(\d+)/;
const TS = /"timestamp":"([^"]+)"/;

/** Adds one transcript line to the totals. Side chains (sub-agents) have their own cache and are left out. */
export function addCacheLine(t: CacheTotals, line: string) {
  if (!line) return;
  if (line.includes('"subtype":"compact_boundary"')) {
    t.compactions++;
    t.lastCompactAt = TS.exec(line)?.[1] ?? t.lastCompactAt;
    return;
  }
  if (!line.includes('"type":"assistant"') || line.includes('"isSidechain":true')) return;
  const m = USAGE.exec(line);
  if (!m) return;
  t.written += Number(m[1]);
  t.read += Number(m[2]);
  t.turns++;
}

const CHUNK = 4 * 1024 * 1024;

/** Keeps totals per transcript file, reading each file once and then only its new bytes. */
export class CacheTracker {
  private files = new Map<string, { offset: number; partial: string; t: CacheTotals }>();

  /** Read what is new in this transcript (at most `budget` bytes per call, so a huge first scan spreads over ticks). */
  update(path: string, budget = 32 * CHUNK): CacheTotals {
    let f = this.files.get(path);
    if (!f) { f = { offset: 0, partial: '', t: emptyTotals() }; this.files.set(path, f); }
    let size: number;
    try { size = statSync(path).size; } catch { return f.t; }
    if (size < f.offset) { f.offset = 0; f.partial = ''; f.t = emptyTotals(); } // rewritten
    if (size === f.offset) return f.t;
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(CHUNK);
      let left = budget;
      while (f.offset < size && left > 0) {
        const n = readSync(fd, buf, 0, Math.min(CHUNK, size - f.offset), f.offset);
        if (n <= 0) break;
        f.offset += n; left -= n;
        const text = f.partial + buf.subarray(0, n).toString('utf8');
        const lines = text.split('\n');
        f.partial = lines.pop() ?? '';
        for (const l of lines) addCacheLine(f.t, l);
      }
    } finally { closeSync(fd); }
    return f.t;
  }
  /** True while a file is still being read for the first time. */
  scanning(path: string): boolean {
    const f = this.files.get(path);
    if (!f) return true;
    try { return f.offset < statSync(path).size - 1024 * 1024; } catch { return false; }
  }
  forget(path: string) { this.files.delete(path); }
}
