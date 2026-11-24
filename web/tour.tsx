import { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Arrow } from './lib';

// A short guided tour per page, shown the first time someone opens that page (and again from the
// palette). Which pages were seen is a per-browser convenience, so it lives in localStorage.

type TourStep = { sel: string; title: string; text: string };

const TOURS: Record<string, TourStep[]> = {
  home: [
    { sel: '.navwrap', title: 'Every page, one tap away', text: 'The bar follows you on every page. Ctrl+K searches pages, sessions and tasks, and runs commands.' },
    { sel: '[aria-label="Needs attention"]', title: 'What needs you', text: 'Decisions, stuck or looping sessions, overlaps, due promises and a silent intake, worst first. Arrows step through them.' },
    { sel: '.tour-lead', title: 'Your lead session', text: 'Always the session named in Settings, with its live output. A replacement called name-v2 takes over this card by itself.' },
    { sel: '.tour-quick', title: 'Start work', text: 'File a task, or start a new Claude Code session in its own herdr tab.' },
    { sel: '.tour-intake', title: 'The intake', text: 'Reads Slack and Gmail for you. Check now runs a pass; pause it overnight and catch up in the morning.' },
  ],
  tasks: [
    { sel: '[aria-label="View"]', title: 'Board or list', text: 'The board moves left to right as work ships. Drag a card, or let ShiftBoss move it when the PR opens, merges and deploys.' },
    { sel: '[aria-label="Filter"]', title: 'Narrow it down', text: 'Inbox is what nobody has picked up yet. Mine to ship is what is waiting on a deploy.' },
    { sel: '.tour-newtask', title: 'Add a task', text: 'Tasks also arrive from the intake and from sessions through the shiftboss tools.' },
  ],
  task: [
    { sel: '[aria-label="Stages"]', title: 'Where it stands', text: 'Click a stage to move it by hand. PR open, On dev and Live move by themselves from GitHub.' },
    { sel: '[aria-label="Session"]', title: 'Who works on it', text: 'Assign a session, then Send brief gives it the task in the requester’s words.' },
    { sel: '.tour-activity', title: 'Everything that happened', text: 'Slack, GitHub, the session and ShiftBoss in one log. Add your own notes at the bottom.' },
    { sel: '.tour-slack', title: 'The Slack thread', text: 'Drafts a session wrote wait here for your approval. ShiftBoss never posts for you.' },
  ],
  needs: [
    { sel: '[aria-label="View"]', title: 'One at a time', text: 'Focus shows one decision with Back, Next and Skip. Answers wait 10 seconds before they are sent, so Undo is safe.' },
  ],
  promises: [
    { sel: '[aria-label="Filter"]', title: 'What you said you would do', text: 'Every promise belongs to a task, and it is kept when that task reaches Requester told.' },
  ],
  intake: [
    { sel: '[aria-label="Filter"]', title: 'Every message it read', text: 'Filed became a task, To lead needs a person, Dropped was FYI. Each row links back to Slack or Gmail.' },
  ],
  session: [
    { sel: 'form[aria-label="Send a prompt"]', title: 'Talk to it', text: 'Sends a prompt to this session in herdr, as if you typed it there.' },
    { sel: '.tour-replace', title: 'Before it fills up', text: 'Prepare replace asks it to write a handoff so a fresh session can carry on.' },
  ],
  settings: [
    { sel: '[aria-label="General"]', title: 'Settings in sections', text: 'Each section saves with the Save button at the top. Lanes and slots save on their own.' },
  ],
};

const KEY = 'shiftboss-tour-seen';
function seen(): string[] { try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; } }
function markSeen(page: string) { try { localStorage.setItem(KEY, JSON.stringify([...new Set([...seen(), page])])); } catch { /* private window */ } }

/** Ask the current page's tour to run again (palette: "Show this page's tour"). */
export function replayTour() { dispatchEvent(new Event('shiftboss-tour')); }

export function Tour({ page }: { page: string }) {
  const [steps, setSteps] = useState<TourStep[] | null>(null);
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const start = (force: boolean) => {
    const all = TOURS[page];
    if (!all || (!force && seen().includes(page))) return;
    const here = all.filter((s) => document.querySelector(s.sel));
    if (here.length) { setSteps(here); setI(0); }
  };
  useEffect(() => {
    setSteps(null);
    const t = setTimeout(() => start(false), 1400); // after the entry animations
    const again = () => start(true);
    addEventListener('shiftboss-tour', again);
    return () => { clearTimeout(t); removeEventListener('shiftboss-tour', again); };
  }, [page]);

  const step = steps?.[i];
  useLayoutEffect(() => {
    if (!step) return;
    const el = document.querySelector(step.sel);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const place = () => setRect(el.getBoundingClientRect());
    place();
    const t = setTimeout(place, 450);
    addEventListener('resize', place); addEventListener('scroll', place, true);
    return () => { clearTimeout(t); removeEventListener('resize', place); removeEventListener('scroll', place, true); };
  }, [step]);
  useEffect(() => {
    if (!steps) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') end(); if (e.key === 'ArrowRight') next(); if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1)); };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  });

  const end = () => { markSeen(page); setSteps(null); setRect(null); };
  const next = () => (steps && i < steps.length - 1 ? setI(i + 1) : end());
  if (!steps || !step || !rect) return null;

  const pad = 8;
  const below = rect.bottom + 200 < innerHeight;
  const w = Math.min(360, innerWidth - 32);
  const left = Math.min(Math.max(16, rect.left), innerWidth - w - 16);
  return createPortal(
    <div className="tour" role="dialog" aria-modal="true" aria-label={`Tour: ${step.title}`}>
      <div className="tour-hole" style={{ left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }} />
      <div className="tour-card shell" style={{ left, width: w, ...(below ? { top: rect.bottom + pad + 12 } : { bottom: innerHeight - rect.top + pad + 12 }) }}>
        <div className="core col" style={{ gap: 10, padding: 18 }}>
          <span className="mono faint" style={{ fontSize: 11 }}>{i + 1} / {steps.length}</span>
          <strong style={{ fontSize: 16, fontWeight: 500 }}>{step.title}</strong>
          <span className="dim" style={{ fontSize: 13, lineHeight: 1.55 }}>{step.text}</span>
          <div className="row" style={{ gap: 8, marginTop: 4 }}>
            <button type="button" className="pill sm" onClick={end}>Skip</button>
            <span style={{ flex: 1 }} />
            {i > 0 && <button type="button" className="pill sm" onClick={() => setI(i - 1)}>Back</button>}
            <button type="button" className="pill sm w" onClick={next} autoFocus>{i < steps.length - 1 ? 'Next' : 'Done'}{i < steps.length - 1 && <Arrow dark />}</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
