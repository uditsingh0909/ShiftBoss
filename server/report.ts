// Builds the daily report from the store. ShiftBoss never posts it; the user copies it.
import type { Need, Task } from '../shared/types';

export type Audience = 'plain' | 'team' | 'me';

export function buildReport(aud: Audience, tasks: Task[], needs: Need[], day = new Date()): { sections: { title: string; tone: 'green' | 'amber' | 'dim'; lines: string[] }[]; text: string } {
  const d0 = new Date(day); d0.setHours(0, 0, 0, 0);
  const today = (iso: string) => Date.parse(iso) >= d0.getTime();
  const live = tasks.filter((t) => t.stage >= 5 && today(t.liveAt ?? t.updatedAt));
  const waitingOnYou = needs.filter((n) => !n.answer && !n.auto);
  const inFlight = tasks.filter((t) => t.stage >= 2 && t.stage <= 4);
  const next = tasks.filter((t) => t.stage === 4);
  const sections: { title: string; tone: 'green' | 'amber' | 'dim'; lines: string[] }[] = [];
  if (aud === 'me') {
    sections.push({ title: 'Done', tone: 'green', lines: [`${live.length} task${live.length === 1 ? '' : 's'} live today, ${inFlight.length} in flight.`] });
    sections.push({ title: 'Needs you', tone: 'amber', lines: waitingOnYou.length ? waitingOnYou.map((n) => n.title) : ['Nothing.'] });
  } else {
    sections.push({ title: aud === 'plain' ? 'Live today' : 'Shipped', tone: 'green', lines: live.length ? live.map((t) => aud === 'team' ? `${t.id} ${t.title}` : t.title) : ['Nothing new went live today.'] });
    sections.push({ title: aud === 'plain' ? 'Waiting on a decision' : 'Open', tone: 'amber', lines: aud === 'plain' ? (waitingOnYou.length ? waitingOnYou.map((n) => n.title) : ['Nothing.']) : (inFlight.length ? inFlight.map((t) => `${t.id} ${t.title} (${t.session ?? 'unassigned'})`) : ['Nothing.']) });
    sections.push({ title: aud === 'plain' ? 'Coming next' : 'Next', tone: 'dim', lines: next.length ? next.map((t) => aud === 'team' ? `${t.id} ${t.title} — on dev` : t.title) : ['Nothing queued for release.'] });
  }
  const text = sections.map((s) => `*${s.title}*\n` + s.lines.map((l) => '• ' + l).join('\n')).join('\n\n');
  return { sections, text };
}
