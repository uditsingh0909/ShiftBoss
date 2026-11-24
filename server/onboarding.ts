// First-run onboarding: the prompt a running session gets when the owner asks it to register its work.
/** What a running session is asked during onboarding: register its work on the board, change nothing else. */
export function onboardingPrompt(owner: string, session: string, repo: string): string {
  return `${owner} is setting up ShiftBoss, a local board that tracks every session's tasks. Please register what you are working on. Do not change, pause or restart your work for this.

1. Check the board first: call the shiftboss tool my_tasks with session "${session}". Skip anything already there.
2. For each task you are on or have queued, call task_add: title, ask (the requester's own words), from, source (channel or meeting), url (the Slack, Jira or PR link), session "${session}".
3. Move each one to where it really is with task_stage: queued, progress, pr, dev or live.
4. Anything you told someone you would do or report back: promise_add, linked to that task.
5. From now on, put "ShiftBoss: T-n" in the description of new PRs for that task.

No shiftboss tools in this session? Use the CLI instead: bun ${repo}/cli/shiftboss.ts help
Then carry on exactly where you were.`;
}

/** The owner's own way of working, appended to prompts ShiftBoss sends. Empty when none is set. */
export function ownerRules(owner: string, instructions: string | undefined): string {
  const t = (instructions ?? '').trim();
  return t ? `\n\n${owner}'s way of working (follow it; it overrides ShiftBoss's defaults where they differ):\n${t}` : '';
}
