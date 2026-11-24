// The gate in front of everything ShiftBoss does to sessions on its own, or because a session asked it to.
// The owner picks one mode:
//   dry   Dry run      nothing happens; each action is recorded as "would do" (for trying ShiftBoss out)
//   ask   Ask first    every action waits for the owner's approval in Needs you
//   safe  Safe auto    routine actions run; risky ones wait for approval
//   auto  Autopilot    everything runs
// The owner's own clicks in the UI are the approval, so they always run.

export type Mode = 'dry' | 'ask' | 'safe' | 'auto';
export const MODES: readonly Mode[] = ['dry', 'ask', 'safe', 'auto'];
export const MODE_LABEL: Record<Mode, string> = { dry: 'Dry run', ask: 'Ask first', safe: 'Safe auto', auto: 'Autopilot' };

export type Actor = 'owner' | 'session' | 'auto';
export type ActionKind = 'dispatch' | 'dispatch-unvetted' | 'spawn' | 'spawn-many' | 'bring-in' | 'replace' | 'onboarding-ask' | 'intake-run' | 'prompt' | 'interrupt' | 'monitor-check';

/** Routine actions run in Safe auto; risky ones (new sessions, prompting or stopping another session) wait. */
export const RISK: Record<ActionKind, 'routine' | 'risky'> = {
  dispatch: 'routine', 'intake-run': 'routine', 'monitor-check': 'routine',
  'dispatch-unvetted': 'risky', // a brief for a task no person has queued (filed from Slack, say)
  spawn: 'risky', 'spawn-many': 'risky', 'bring-in': 'risky', replace: 'risky', 'onboarding-ask': 'risky', prompt: 'risky', interrupt: 'risky',
};

export type Decision = 'run' | 'record' | 'ask';

export function decide(mode: Mode, actor: Actor, kind: ActionKind): Decision {
  if (actor === 'owner' || mode === 'auto') return 'run';
  if (mode === 'dry') return 'record';
  if (mode === 'ask') return 'ask';
  return RISK[kind] === 'routine' ? 'run' : 'ask';
}

/** The same action asked twice (auto-dispatch every tick, a monitor still due) is one approval, not many. */
export const actionKey = (kind: ActionKind, params: unknown) => kind + ':' + JSON.stringify(params);

export const isMode = (v: unknown): v is Mode => typeof v === 'string' && (MODES as readonly string[]).includes(v);
