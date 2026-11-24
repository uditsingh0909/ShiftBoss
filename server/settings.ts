// Validate a settings update before it is stored. Any session can call PUT /api/settings, and one
// bad value (a string where a number goes) used to crash every screen.
import { z } from 'zod';
import type { Settings } from '../shared/types';

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const Patch = z.object({
  thresholds: z.object({
    warn: int(50, 90), replace: int(70, 95), needsCap: int(1, 6), staleMin: int(10, 120), stuckMin: int(5, 60), loopRepeats: int(2, 6),
  }).partial().optional(),
  switches: z.object({ autoDispatch: z.boolean(), quietHours: z.boolean() }).partial().optional(),
  budgets: z.object({ fiveHourTokens: int(0, 1e12), weeklyTokens: int(0, 1e13) }).partial().optional(),
  herdrWorkspace: z.string().max(40).optional(),
  handoffsDir: z.string().max(500).optional(),
  leadSession: z.string().max(100).optional(),
  watchedChannels: z.array(z.string().min(1).max(100)).max(100).optional(),
  autoUpdate: z.boolean().optional(),
  mode: z.enum(['dry', 'ask', 'safe', 'auto']).optional(),
  instructions: z.string().max(4000).optional(),
}).strip();

export function mergeSettings(cur: Settings, input: unknown): Settings {
  const r = Patch.safeParse(input);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new Error(`Invalid setting ${i.path.join('.') || '(body)'}: ${i.message}`);
  }
  const b = r.data;
  const next: Settings = {
    ...cur, ...b,
    thresholds: { ...cur.thresholds, ...b.thresholds }, switches: { ...cur.switches, ...b.switches }, budgets: { ...cur.budgets, ...b.budgets },
    leadSession: (b.leadSession ?? cur.leadSession).trim(), herdrWorkspace: (b.herdrWorkspace ?? cur.herdrWorkspace).trim(),
  };
  if (next.thresholds.warn >= next.thresholds.replace) throw new Error('The context warning must be below the replace line');
  return next;
}
