// Exact context and plan-usage numbers come from Claude Code's status line input.
// Two sources, best first:
//  1. data/status/<sessionId>.json, written by cli/statusline-tap.js when the user opts in.
//  2. The footer text herdr shows ("ctx 16% | 5h 9% (4h 2m) | 7d 41% (3d 2h)").
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface StatusInfo {
  ctxPct: number | null;
  fiveHourPct: number | null;
  fiveHourResetsAt: number | null; // epoch seconds
  weeklyPct: number | null;
  weeklyResetsAt: number | null;
  model: string | null;
  /** The prompt cache, from the tap only. */
  cache?: { warm: boolean | null; expiresAt: number | null; hitRatio: number | null };
  source: 'tap' | 'footer';
  at: number;
}

export function readTap(dataDir: string, sessionId: string): StatusInfo | null {
  const p = join(dataDir, 'status', sessionId + '.json');
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    const rl = j.rate_limits ?? {};
    return {
      // Right after a resume or compact Claude Code reports 0 input tokens and 0 %; that 0 is "unknown", not empty.
      ctxPct: j.context_window && j.context_window.total_input_tokens === 0 ? null : j.context_window?.used_percentage ?? null,
      fiveHourPct: rl.five_hour?.used_percentage ?? null,
      fiveHourResetsAt: rl.five_hour?.resets_at ?? null,
      weeklyPct: rl.seven_day?.used_percentage ?? null,
      weeklyResetsAt: rl.seven_day?.resets_at ?? null,
      model: j.model?.display_name ?? null,
      cache: j.prompt_cache ? { warm: typeof j.prompt_cache.warm === 'boolean' ? j.prompt_cache.warm : null, expiresAt: j.prompt_cache.expires_at ?? null, hitRatio: j.prompt_cache.hit_ratio ?? null } : undefined,
      source: 'tap',
      at: j._tappedAt ?? Date.now(),
    };
  } catch { return null; }
}

export function parseFooter(text: string): StatusInfo | null {
  const num = (re: RegExp) => { const m = text.match(re); return m ? Number(m[1]) : null; };
  const ctx = num(/\bctx (\d+)%/);
  const five = num(/\b5h (\d+)%/);
  const week = num(/\b7d (\d+)%/);
  if (ctx === null && five === null && week === null) return null;
  const model = text.match(/\|\s*((?:Opus|Sonnet|Haiku|Fable)[^|]*?)\s*\|/)?.[1]?.trim() ?? null;
  return { ctxPct: ctx, fiveHourPct: five, fiveHourResetsAt: null, weeklyPct: week, weeklyResetsAt: null, model, source: 'footer', at: Date.now() };
}

/** Context use: the larger of what the status line says and what the transcript implies (either can lag). */
export function contextPercent(reported: number | null | undefined, tokens: number, window: number): number {
  const fromTranscript = window ? Math.min(100, (tokens / window) * 100) : 0;
  return Math.max(reported ?? 0, fromTranscript);
}
