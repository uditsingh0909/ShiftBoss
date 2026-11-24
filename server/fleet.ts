// Fleet actions: start many sessions at once, and replace a session through a handoff file.
// Everything here is pure (or only reads the file system) so it can be unit tested; the engine
// runs the replacement state machine and the API validates spawn requests with these helpers.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$/;
export const MODELS = ['sonnet', 'opus', 'haiku', 'fable'] as const;
export const SPAWN_MANY_CAP = 20;
/** A handoff not written within this long after the request is shown as stalled. */
export const HANDOFF_TIMEOUT_MS = 20 * 60e3;

export interface SpawnSpec { name: string; cwd: string; model: string | null; prompt: string | null; /** Claude session id to continue (claude --resume) */ resume?: string | null }

/**
 * The same checks the single spawn makes, for one row. `taken` holds names already running or
 * already used earlier in the same batch. Throws a plain-words message for the first problem.
 */
export function checkSpawn(raw: any, taken: Set<string>): SpawnSpec {
  const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
  if (!NAME_RE.test(name)) throw new Error(`Name "${name || '(empty)'}": letters, digits, - and _ only (2-40 characters).`);
  if (taken.has(name)) throw new Error(`A session named ${name} is already running or listed twice.`);
  const cwd = typeof raw?.cwd === 'string' ? raw.cwd.trim() : '';
  if (!cwd || cwd.length > 400) throw new Error(`${name}: folder is required.`);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`${name}: that folder does not exist.`);
  const model = typeof raw?.model === 'string' && raw.model.trim() ? raw.model.trim() : null;
  if (model && !(MODELS as readonly string[]).includes(model)) throw new Error(`${name}: unknown model.`);
  const prompt = typeof raw?.prompt === 'string' && raw.prompt.trim() ? raw.prompt.trim().slice(0, 8000) : null;
  return { name, cwd, model, prompt };
}

/** Checks a whole batch before anything starts: one bad row refuses the batch, so nothing half-starts. */
export function checkSpawnMany(rows: unknown, running: string[]): SpawnSpec[] {
  if (!Array.isArray(rows) || !rows.length) throw new Error('sessions must list at least one session.');
  if (rows.length > SPAWN_MANY_CAP) throw new Error(`At most ${SPAWN_MANY_CAP} sessions at once.`);
  const taken = new Set(running);
  return rows.map((r) => { const s = checkSpawn(r, taken); taken.add(s.name); return s; });
}

/** A herdr start error that means Claude is up but waiting on a startup question (such as trusting the folder). */
export const isStartupQuestion = (msg: string) => /agent_not_ready|blocked during startup/.test(msg);

// ---------- replacement names ----------
const V_RE = /^(.*)-v(\d+)$/i;
/** The name without a trailing -vN. */
export const baseName = (name: string) => name.match(V_RE)?.[1] ?? name;
/**
 * Next free `<base>-vN`: one above the highest version of that base among `taken` (and the name
 * itself), at least v2, skipping names already taken. Kept within the 40-character name limit.
 */
export function nextReplacementName(name: string, taken: Iterable<string>): string {
  const base = baseName(name);
  const lower = base.toLowerCase();
  const all = new Set([...taken].map((t) => t.toLowerCase()));
  all.add(name.toLowerCase());
  let v = 1;
  for (const t of all) {
    if (t === lower) continue;
    const m = t.match(V_RE);
    if (m && m[1] === lower) v = Math.max(v, Number(m[2]));
  }
  for (let n = v + 1; ; n++) {
    const suffix = '-v' + n;
    const cand = base.slice(0, 40 - suffix.length) + suffix;
    if (!all.has(cand.toLowerCase())) return cand;
  }
}

/** The model to start the replacement with: an exact model id when known, else the family alias. */
export function modelArg(model: string | null): string | null {
  if (!model) return null;
  const m = model.trim();
  if (/^claude-[a-z0-9.-]+(\[1m\])?$/i.test(m)) return m;
  const fam = m.toLowerCase().match(/opus|sonnet|haiku|fable/)?.[0];
  return fam ?? null;
}

// ---------- handoff ----------
export const HANDOFF_SECTIONS = [
  'Open tasks', 'PRs', 'Promises owed', 'Scheduled jobs', 'Worktrees and branches', 'Decisions made', 'Open questions', 'Next steps',
] as const;
export const HANDOFF_MARKER = 'HANDOFF COMPLETE';

/** Where the handoff goes: the session's own handoff path (meta or handoffs folder), else HANDOFF-<name>.md in its folder. */
export function handoffPathFor(name: string, cwd: string, known: string | null): string {
  return known || join(cwd, `HANDOFF-${name}.md`);
}

/** What the old session is asked. Composed by ShiftBoss; it never answers a prompt in the pane. */
/**
 * The request sent to the old session. `existing`: the file already holds a handoff in the team's own format,
 * so it is updated in place (structure kept) and only the missing headings are added.
 */
export function handoffRequest(owner: string, name: string, path: string, existing = false): string {
  return `${owner} is replacing this session with a fresh one through ShiftBoss, because its context is filling up. Do not stop mid-change: finish the step you are on, then write the handoff.

${existing
    ? `Update your handoff at ${path} so it is complete as of now. Keep its existing structure, headings and content: other sessions read it in that format. Then make sure it also has each heading below as a markdown "## " heading; add the ones it lacks. Under a heading that your own sections already cover, write "see <your section> above"; write "none" where there is nothing:`
    : `Write the whole handoff to ${path}. Use exactly these headings, each as a markdown "## " heading, and write "none" under a heading that has nothing:`}

## Open tasks
Every task you own, with its ShiftBoss task id (T-n), where it stands, and what is left.
## PRs
Every PR you opened or are reviewing: link, branch, state (draft, open, approved, merged), what it waits on.
## Promises owed
What you told someone you would do or report back, to whom, and where (channel or thread).
## Scheduled jobs
Crons, loops, reminders or background runs you started, and how to stop them.
## Worktrees and branches
Each worktree path and branch, and whether it has unpushed or uncommitted work.
## Decisions made
Decisions taken in this session that the next one must respect, and who made them.
## Open questions
What is still unanswered, and who was asked.
## Next steps
The exact next actions, in order, so the new session can start without asking.

End the file with this line on its own: ${HANDOFF_MARKER}

Then reply "done" and stop starting new work. ShiftBoss watches the file and starts the replacement (${name} is not closed; the owner does that).`;
}

/** Does the handoff text have every section heading and the final marker? */
export function handoffCheck(text: string): { complete: boolean; missing: string[] } {
  const missing: string[] = HANDOFF_SECTIONS.filter((h) => !new RegExp('^\\s*#{1,6}\\s*' + h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'im').test(text));
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines.at(-1) ?? '';
  if (!/^[*_`#\s]*HANDOFF COMPLETE[*_`\s.]*$/.test(last)) missing.push(HANDOFF_MARKER);
  return { complete: missing.length === 0, missing };
}

/** The replacement's first prompt. */
export function replacementPrompt(o: { newName: string; oldName: string; handoffPath: string; transcriptPath: string | null; shiftbossCli: string }): string {
  return `You are ${o.newName}. You replace ${o.oldName}, whose context was nearly full, and continue its work.

1. Read the handoff file in full before anything else: ${o.handoffPath}
2. If anything in it is unclear, look it up in ${o.oldName}'s transcript${o.transcriptPath ? `: ${o.transcriptPath}` : ' (in ~/.claude/projects, by its session id)'}. It is JSON lines and large: search it for what you need rather than reading it all.
3. Register with ShiftBoss: call the shiftboss tool my_tasks with session "${o.newName}". ${o.oldName}'s open tasks were moved to you. Without shiftboss tools, run: bun ${o.shiftbossCli} status
4. Then continue from the handoff's Next steps. Do not redo finished work, keep the promises it lists, and put "ShiftBoss: T-n" in new PR descriptions.

${o.oldName} is still open. Do not message it or close it; the owner closes it.`;
}
