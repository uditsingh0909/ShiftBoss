// Pure rules: session health and cross-session overlaps. No I/O here, so it is easy to test.
import { basename } from 'node:path';
import { fmtCache, type HealthCard, type Overlap, type Session, type Settings, type Task } from '../shared/types';
import type { ToolCall } from './transcripts';

const MIN = 60e3;

/** Keys of commands repeated `repeats` times in a row within the last 15 minutes. */
export function loopKeys(tools: ToolCall[], repeats: number, nowMs = Date.now()): Set<string> {
  const recent = tools.filter((t) => nowMs - t.at < 15 * MIN && /^(Bash|PowerShell)$/.test(t.name));
  const out = new Set<string>();
  let run = 1;
  for (let i = 1; i < recent.length; i++) {
    run = recent[i].key === recent[i - 1].key ? run + 1 : 1;
    if (run >= repeats) out.add(recent[i].key);
  }
  return out;
}

export function healthOf(s: Session, tools: ToolCall[], tasks: Task[], set: Settings, nowMs = Date.now()): HealthCard {
  const t = set.thresholds;
  const silentMin = s.lastActivity ? (nowMs - Date.parse(s.lastActivity)) / MIN : Infinity;
  // Only work the session has actually been given and not yet shipped counts: a queued task (stage 1) waits on
  // the dispatcher or the owner, and PR open / On dev wait on review and deploys, not on the session.
  const working = tasks.filter((x) => x.session === s.name && x.stage === 2 && !x.held);
  const loops = loopKeys(tools, t.loopRepeats, nowMs);
  const edits15 = tools.filter((x) => nowMs - x.at < 15 * MIN && x.files.length).length;
  const card = (verdict: HealthCard['verdict'], title: string, signals: HealthCard['signals'], suggest: string, loop: string[] = []): HealthCard =>
    ({ session: s.name, verdict, title, signals, suggest, loop });

  if (s.status === 'lost') return card('lost', 'herdr cannot see this pane any more.', [{ k: 'pane', v: s.paneId, tone: 'red' }], 'open herdr and check the pane');
  if (s.status === 'blocked') return card('waiting', 'Waiting on a permission prompt.', [{ k: 'prompt', v: 'see Needs you', tone: 'amber' }], 'answer it in herdr');
  if (loops.size) {
    const key = [...loops][0];
    const hits = tools.filter((x) => x.key === key && nowMs - x.at < 15 * MIN);
    return card('looping', `Ran the same command ${hits.length} times in 15 minutes.`,
      [{ k: 'loop', v: key.split(':').slice(1).join(':').slice(0, 140), tone: 'red' }, { k: 'edits', v: edits15 + ' file edits in 15 min', tone: edits15 ? 'dim' : 'amber' }],
      'interrupt it and point it at the cause',
      hits.slice(-4).map((h) => new Date(h.at).toTimeString().slice(0, 5) + '  ' + h.key.split(':').slice(1).join(':').slice(0, 120)));
  }
  if (s.status !== 'working' && working.length && silentMin >= t.stuckMin) {
    return card('stuck', `No output for ${Math.round(silentMin)} minutes with ${working.length} task${working.length === 1 ? '' : 's'} in progress.`,
      [{ k: 'silent', v: 'last activity ' + (s.lastActivity ? new Date(s.lastActivity).toTimeString().slice(0, 5) : 'unknown'), tone: 'red' }, { k: 'in progress', v: working.map((q) => q.id).join(', '), tone: 'amber' }],
      'ask it how ' + working[0].id + ' is going');
  }
  // Worn out: context near the top, or the lifetime cache past the line. Compacting resets context but not the
  // cache, so a session can show 20 % context and still be due for a fresh start.
  const cacheM = (s.cache?.read ?? 0) / 1e6;
  if (s.contextPct >= t.replace || cacheM >= (t.cacheReplaceM ?? 1000)) {
    const byCache = s.contextPct < t.replace;
    return card('heavy', byCache ? `Cache ${fmtCache(s.cache.read)} read over its life (${s.cache.compactions} compaction${s.cache.compactions === 1 ? '' : 's'}), though context shows ${Math.round(s.contextPct)}%.` : `Context at ${Math.round(s.contextPct)}%.`,
      [byCache ? { k: 'cache', v: fmtCache(s.cache.read) + ' read · ' + s.cache.compactions + ' compactions', tone: 'red' } : { k: 'context', v: Math.round(s.contextPct) + '% of ' + Math.round(s.contextWindow / 1000) + 'k', tone: 'red' },
      { k: 'handoff', v: s.handoffAgeMin == null ? 'no handoff file found' : 'updated ' + s.handoffAgeMin + ' min ago', tone: s.handoffAgeMin != null && s.handoffAgeMin <= t.staleMin ? 'green' : 'amber' }],
      'Replace it from its handoff after the current step');
  }
  return card('healthy', 'Moving.', [{ k: 'status', v: s.status, tone: 'green' }], 'nothing');
}

const MIGRATION = /[\\/](V(\d+(?:[._]\d+)*)__[^\\/]+\.sql)$/;

/** Shared notes every session writes on purpose (memory, handoffs) are not overlaps. */
export const DEFAULT_OVERLAP_IGNORE = ['/.claude/', '/handoffs/'];

export function overlapsOf(sessionsIn: { name: string; files: string[] }[], tasks: Task[], ignore: string[] = DEFAULT_OVERLAP_IGNORE): Overlap[] {
  const out: Overlap[] = [];
  const norm = (f: string) => f.replace(/\\/g, '/').toLowerCase();
  const skip = ignore.map((x) => x.toLowerCase());
  const sessions = sessionsIn.map((s) => ({ ...s, files: s.files.filter((f) => !skip.some((x) => norm(f).includes(x))) }));
  for (let i = 0; i < sessions.length; i++) {
    for (let j = i + 1; j < sessions.length; j++) {
      const a = sessions[i], b = sessions[j];
      const bSet = new Map(b.files.map((f) => [norm(f), f]));
      for (const f of a.files) {
        if (bSet.has(norm(f))) {
          out.push({ id: 'file:' + norm(f) + ':' + a.name + ':' + b.name, kind: 'Same file', severity: 'red', where: basename(f),
            title: `${a.name} and ${b.name} both edited ${basename(f)} in the last 3 hours.`,
            a: { session: a.name, what: f }, b: { session: b.name, what: bSet.get(norm(f))! },
            fix: 'Let one merge first, then the other rebases.' });
        }
      }
      const migA = a.files.map((f) => f.match(MIGRATION)).filter(Boolean) as RegExpMatchArray[];
      const migB = b.files.map((f) => f.match(MIGRATION)).filter(Boolean) as RegExpMatchArray[];
      for (const ma of migA) for (const mb of migB) {
        if (ma[2] === mb[2] && ma[1] !== mb[1]) {
          out.push({ id: 'mig:' + ma[2] + ':' + a.name + ':' + b.name, kind: 'Same migration number', severity: 'red', where: 'V' + ma[2],
            title: `Two sessions add migration V${ma[2]}. Whichever merges second fails.`,
            a: { session: a.name, what: ma[1] }, b: { session: b.name, what: mb[1] }, fix: 'The PR further along keeps the number; the other renumbers above main\'s max.' });
        }
      }
    }
  }
  return out.concat(taskOverlaps(sessions as (typeof sessions[number] & { lines?: { text: string }[] })[], tasks));
}

/** A task owned by one session whose id shows up in another session's recent output. */
function taskOverlaps(sessions: { name: string; lines?: { text: string }[] }[], tasks: Task[]): Overlap[] {
  const out: Overlap[] = [];
  for (const t of tasks) {
    if (!t.session || t.stage < 1 || t.stage > 4) continue;
    const re = new RegExp('\\b' + t.id + '\\b');
    for (const s of sessions) {
      if (s.name === t.session || !s.lines) continue;
      const hit = s.lines.find((l) => re.test(l.text));
      if (hit) out.push({ id: 'task:' + t.id + ':' + s.name, kind: 'Same task', severity: 'amber', where: t.id,
        title: `${t.id} belongs to ${t.session}, and ${s.name} is also working on it.`,
        a: { session: t.session, what: 'owner · ' + t.title }, b: { session: s.name, what: hit.text.slice(0, 120) },
        fix: `${t.id} stays with ${t.session}; ${s.name} goes back to its own work.` });
    }
  }
  return out;
}
