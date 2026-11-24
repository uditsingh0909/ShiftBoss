// Reads Claude Code transcripts (~/.claude/projects/<slug>/<sessionId>.jsonl)
// incrementally: only new bytes are parsed on each poll.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { OutputLine } from '../shared/types';

const INITIAL_TAIL = 4 * 1024 * 1024; // first read: last 4 MB only

export interface ToolCall { at: number; name: string; key: string; files: string[] }

export interface TranscriptState {
  path: string;
  offset: number;
  /** Bytes after the last newline: an unfinished line, possibly cut inside a UTF-8 character. */
  partial: Buffer;
  /** First read started mid-file: the first line is cut, so drop it. */
  skipFirst?: boolean;
  model: string | null;
  contextTokens: number;
  usage: { at: number; tokens: number }[]; // per assistant message, last 8 days
  tools: ToolCall[]; // last 3 hours
  lines: (OutputLine & { ts: number })[];
  lastActivity: number | null;
  prUrls: string[];
}

function summarize(name: string, input: any): { text: string; key: string; files: string[] } {
  const files: string[] = [];
  const fp = input?.file_path ?? input?.notebook_path ?? input?.path;
  if (typeof fp === 'string' && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) files.push(fp);
  let arg = '';
  if (name === 'Bash' || name === 'PowerShell') arg = String(input?.command ?? '');
  else if (typeof fp === 'string') arg = fp;
  else if (input?.pattern) arg = String(input.pattern);
  else if (input?.url) arg = String(input.url);
  else if (input?.description) arg = String(input.description);
  arg = arg.replace(/\s+/g, ' ').trim();
  return { text: (name + '  ' + arg).slice(0, 240), key: name + ':' + arg.slice(0, 400), files };
}

function textOf(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join(' ');
  return '';
}

export function applyLine(st: TranscriptState, raw: string) {
  if (!raw) return;
  let d: any;
  try { d = JSON.parse(raw); } catch { return; }
  const ts = d.timestamp ? Date.parse(d.timestamp) : NaN;
  const at = Number.isFinite(ts) ? ts : null;
  if (at) st.lastActivity = Math.max(st.lastActivity ?? 0, at);
  if (d.type === 'pr-link' && d.prUrl && !st.prUrls.includes(d.prUrl)) st.prUrls.push(d.prUrl);
  const m = d.message;
  if (d.type === 'assistant' && m && typeof m === 'object') {
    if (m.model && !String(m.model).startsWith('<')) st.model = m.model;
    const u = m.usage;
    if (u && !d.isSidechain) {
      st.contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      if (at) st.usage.push({ at, tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0) });
    }
    for (const c of Array.isArray(m.content) ? m.content : []) {
      if (c?.type === 'tool_use') {
        const s = summarize(c.name, c.input);
        if (at) st.tools.push({ at, name: c.name, key: s.key, files: s.files });
        st.lines.push({ ts: at ?? Date.now(), at: new Date(at ?? Date.now()).toISOString(), kind: 'tool', text: s.text });
      } else if (c?.type === 'text' && c.text?.trim()) {
        st.lines.push({ ts: at ?? Date.now(), at: new Date(at ?? Date.now()).toISOString(), kind: 'say', text: c.text.trim().replace(/\s+/g, ' ').slice(0, 300) });
      }
    }
  } else if (d.type === 'user' && m && typeof m === 'object' && !d.isMeta) {
    const content = m.content;
    if (Array.isArray(content) && content.some((c: any) => c?.type === 'tool_result')) {
      const r = content.find((c: any) => c?.type === 'tool_result');
      const t = textOf(r?.content).replace(/\s+/g, ' ').trim();
      if (t) st.lines.push({ ts: at ?? Date.now(), at: new Date(at ?? Date.now()).toISOString(), kind: 'out', text: t.slice(0, 200) });
    } else {
      const t = textOf(content).trim();
      if (t && !t.startsWith('<')) st.lines.push({ ts: at ?? Date.now(), at: new Date(at ?? Date.now()).toISOString(), kind: 'you', text: t.replace(/\s+/g, ' ').slice(0, 300) });
    }
  }
}

/**
 * Split `partial + chunk` into complete lines on byte 0x0a. Lines are decoded only once whole, so a
 * multi-byte character cut across two reads is never decoded in halves. `rest` is carried to the next read.
 */
export function splitLines(partial: Buffer, chunk: Buffer): { lines: string[]; rest: Buffer } {
  const buf = partial.length ? Buffer.concat([partial, chunk]) : chunk;
  const lines: string[] = [];
  let start = 0;
  for (let i = buf.indexOf(0x0a); i !== -1; i = buf.indexOf(0x0a, start)) {
    lines.push(buf.toString('utf8', start, i));
    start = i + 1;
  }
  return { lines, rest: Buffer.from(buf.subarray(start)) };
}

function prune(st: TranscriptState) {
  const nowMs = Date.now();
  st.usage = st.usage.filter((u) => u.at > nowMs - 8 * 864e5);
  st.tools = st.tools.filter((t) => t.at > nowMs - 3 * 3600e3);
  if (st.lines.length > 200) st.lines = st.lines.slice(-200);
}

export class Transcripts {
  private states = new Map<string, TranscriptState>();
  private pathCache = new Map<string, string | null>();
  private lastRead = new Map<string, number>();
  constructor(private dir: string) {}

  /** Forget sessions not read for an hour (they ended): the state would otherwise grow for weeks. */
  evict(idleMs = 3600e3, nowMs = Date.now()) {
    for (const [sid, at] of this.lastRead) if (nowMs - at > idleMs) { this.states.delete(sid); this.pathCache.delete(sid); this.lastRead.delete(sid); }
  }

  findPath(sessionId: string): string | null {
    if (this.pathCache.has(sessionId)) return this.pathCache.get(sessionId)!;
    let found: string | null = null;
    try {
      for (const proj of readdirSync(this.dir)) {
        const p = join(this.dir, proj, sessionId + '.jsonl');
        if (existsSync(p)) { found = p; break; }
      }
    } catch { /* dir missing */ }
    if (found) this.pathCache.set(sessionId, found);
    return found;
  }

  read(sessionId: string): TranscriptState | null {
    this.lastRead.set(sessionId, Date.now());
    const path = this.findPath(sessionId);
    if (!path) return null;
    let st = this.states.get(sessionId);
    const size = statSync(path).size;
    if (!st) {
      const offset = Math.max(0, size - INITIAL_TAIL);
      st = { path, offset, partial: Buffer.alloc(0), skipFirst: offset > 0, model: null, contextTokens: 0, usage: [], tools: [], lines: [], lastActivity: null, prUrls: [] };
      this.states.set(sessionId, st);
    }
    if (size < st.offset) { st.offset = 0; st.partial = Buffer.alloc(0); st.skipFirst = false; } // file rotated
    if (size > st.offset) {
      const fd = openSync(path, 'r');
      try {
        const len = size - st.offset;
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, st.offset);
        st.offset = size;
        const { lines, rest } = splitLines(st.partial, buf);
        st.partial = rest;
        let startAt = 0;
        if (st.skipFirst && lines.length) { startAt = 1; st.skipFirst = false; } // drop the first, cut line
        for (let i = startAt; i < lines.length; i++) applyLine(st, lines[i]);
      } finally { closeSync(fd); }
      prune(st);
    }
    return st;
  }
}

/** Tokens per 2-minute bucket for the last hour; -1 marks a bucket where the same command repeated. */
export function heatOf(st: TranscriptState | null, loopKeys: Set<string>): number[] {
  const out = new Array(30).fill(0);
  if (!st) return out;
  const nowMs = Date.now();
  for (const l of st.lines) {
    const ago = nowMs - l.ts;
    if (ago < 0 || ago >= 3600e3) continue;
    out[29 - Math.floor(ago / 120e3)] += 1;
  }
  for (const t of st.tools) {
    const ago = nowMs - t.at;
    if (ago >= 0 && ago < 3600e3 && loopKeys.has(t.key)) out[29 - Math.floor(ago / 120e3)] = -1;
  }
  return out;
}
