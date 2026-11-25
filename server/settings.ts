// Validate a settings update before it is stored. Any session can call PUT /api/settings, and one
// bad value (a string where a number goes) used to crash every screen.
import { z } from 'zod';
import { DEFAULT_NOTIFY, DEFAULT_SLACK, type Settings } from '../shared/types';

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const Patch = z.object({
  thresholds: z.object({
    warn: int(50, 90), replace: int(70, 95), needsCap: int(1, 6), staleMin: int(10, 120), stuckMin: int(5, 60), loopRepeats: int(2, 6),
    cacheWarnM: int(50, 5000), cacheReplaceM: int(100, 10000),
  }).partial().optional(),
  switches: z.object({ autoDispatch: z.boolean(), quietHours: z.boolean() }).partial().optional(),
  budgets: z.object({ fiveHourTokens: int(0, 1e12), weeklyTokens: int(0, 1e13) }).partial().optional(),
  herdrWorkspace: z.string().max(40).optional(),
  handoffsDir: z.string().max(500).optional(),
  leadSession: z.string().max(100).optional(),
  watchedChannels: z.array(z.string().min(1).max(100)).max(100).optional(),
  autoUpdate: z.boolean().optional(),
  mode: z.enum(['dry', 'ask', 'safe', 'auto']).optional(),
  delegate: z.boolean().optional(),
  instructions: z.string().max(4000).optional(),
  instructionsPrev: z.string().max(4000).optional(),
  closeOldAfterMin: z.number().int().min(0).max(1440).optional(),
  slack: z.object({
    dm: z.object({ on: z.boolean(), userId: z.string().regex(/^[UW][A-Z0-9]{1,20}$/).nullable(), label: z.string().max(100).nullable() }).partial(),
    channel: z.object({ on: z.boolean(), id: z.string().regex(/^[CG][A-Z0-9]{1,20}$/).nullable(), name: z.string().max(100).nullable() }).partial(),
    kinds: z.object({ dm: z.record(z.string(), z.boolean()), channel: z.record(z.string(), z.boolean()) }).partial(),
    quiet: z.object({ on: z.boolean(), from: z.string().regex(/^\d{2}:\d{2}$/), to: z.string().regex(/^\d{2}:\d{2}$/) }).partial(),
  }).partial().optional(),
  notify: z.object({
    needs: z.boolean(), blocked: z.boolean(), stuck: z.boolean(), overlap: z.boolean(), promiseDue: z.boolean(), monitor: z.boolean(), updated: z.boolean(),
    finished: z.boolean(), trouble: z.boolean(), tasks: z.boolean(), releases: z.boolean(), monitorReport: z.boolean(), replaced: z.boolean(),
    actions: z.boolean(), limits: z.boolean(), system: z.boolean(),
  }).partial().optional(),
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
    notify: { ...DEFAULT_NOTIFY, ...cur.notify, ...b.notify },
    slack: mergeSlack(cur.slack, b.slack),
    leadSession: (b.leadSession ?? cur.leadSession).trim(), herdrWorkspace: (b.herdrWorkspace ?? cur.herdrWorkspace).trim(),
  };
  if ((next.thresholds.cacheWarnM ?? 500) >= (next.thresholds.cacheReplaceM ?? 1000)) throw new Error('The cache warning must be below the cache replace line');
  if (next.thresholds.warn >= next.thresholds.replace) throw new Error('The context warning must be below the replace line');
  return next;
}

/** Slack settings merge field by field; unknown kind names are dropped. */
function mergeSlack(cur: Settings['slack'], b: any): NonNullable<Settings['slack']> {
  const c = { ...DEFAULT_SLACK, ...cur, kinds: { dm: { ...DEFAULT_SLACK.kinds.dm, ...cur?.kinds?.dm }, channel: { ...DEFAULT_SLACK.kinds.channel, ...cur?.kinds?.channel } } };
  if (!b) return c;
  const pick = (base: Record<string, boolean>, patch?: Record<string, boolean>) =>
    Object.fromEntries(Object.keys(base).map((k) => [k, typeof patch?.[k] === 'boolean' ? patch[k] : base[k]])) as typeof base;
  return {
    dm: { ...c.dm, ...b.dm }, channel: { ...c.channel, ...b.channel }, quiet: { ...c.quiet, ...b.quiet },
    kinds: { dm: pick(c.kinds.dm, b.kinds?.dm) as any, channel: pick(c.kinds.channel, b.kinds?.channel) as any },
  };
}
