// Browser notifications while ShiftBoss is open in a tab. No service worker and no push server: the open
// page compares each live snapshot with the one before and shows a notification for what is new.
// Only one tab notifies (a leader lock in localStorage), and never for something already on screen.
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { DEFAULT_NOTIFY, type NotifySettings, type Snapshot } from '../shared/types';
import { newNotifications, tabTitle, type NotifyEvent } from '../shared/notify';
import { api, C, toast, useSnap } from './lib';

const supported = () => typeof window !== 'undefined' && 'Notification' in window;
const store = {
  get(k: string, session = false): string | null { try { return (session ? sessionStorage : localStorage).getItem(k); } catch { return null; } },
  set(k: string, v: string, session = false) { try { (session ? sessionStorage : localStorage).setItem(k, v); } catch { /* private mode */ } },
  del(k: string, session = false) { try { (session ? sessionStorage : localStorage).removeItem(k); } catch { /* private mode */ } },
};

// This tab's id survives a reload (sessionStorage), so a tab that reloads after an update stays the leader.
const TAB = (() => {
  let id = store.get('shiftboss.tab', true);
  if (!id) { id = Math.random().toString(36).slice(2); store.set('shiftboss.tab', id, true); }
  return id;
})();
const LOCK = 'shiftboss.notify.leader';
const STALE_MS = 20_000;

/** True when this tab is the one that notifies. Takes the lock if it is free or its holder went quiet. */
function lead(): boolean {
  try {
    const cur = JSON.parse(localStorage.getItem(LOCK) ?? 'null') as { id: string; at: number } | null;
    if (cur && cur.id !== TAB && Date.now() - cur.at < STALE_MS) return false;
    localStorage.setItem(LOCK, JSON.stringify({ id: TAB, at: Date.now() }));
    return (JSON.parse(localStorage.getItem(LOCK) ?? 'null') as { id: string } | null)?.id === TAB;
  } catch { return true; } // no localStorage: this tab is on its own
}
function resign() {
  try { const cur = JSON.parse(localStorage.getItem(LOCK) ?? 'null'); if (cur?.id === TAB) localStorage.removeItem(LOCK); } catch { /* ignore */ }
}

/** Keys notified recently, across tabs: a lock hand-over never repeats one. */
function claim(key: string): boolean {
  try {
    const list: string[] = JSON.parse(localStorage.getItem('shiftboss.notified') ?? '[]');
    if (list.includes(key)) return false;
    localStorage.setItem('shiftboss.notified', JSON.stringify([...list, key].slice(-300)));
  } catch { /* ignore */ }
  return true;
}

/** The person is looking at that very page in this tab: nothing to tell them. */
function onScreen(route: string): boolean {
  const here = (location.hash || '#/').replace(/\/$/, '') || '#';
  return document.visibilityState === 'visible' && document.hasFocus() && here === route.replace(/\/$/, '');
}

function show(title: string, body: string, route: string, tag: string) {
  if (!supported() || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag });
    n.onclick = () => { window.focus(); location.hash = route; n.close(); };
  } catch { /* some browsers only allow notifications from a service worker */ }
}


/** Run once in the app: notifications for new items, and the tab title. */
export function useNotifications(snap: Snapshot | null) {
  const prev = useRef<Snapshot | null>(null);
  useEffect(() => {
    const beat = setInterval(lead, 5000);
    lead();
    addEventListener('pagehide', resign);
    return () => { clearInterval(beat); removeEventListener('pagehide', resign); };
  }, []);
  useEffect(() => {
    document.title = tabTitle(snap);
    if (!snap) return;
    const on = { ...DEFAULT_NOTIFY, ...snap.settings.notify };
    const before = prev.current;
    prev.current = snap;
    if (!lead()) return;
    // The page reloaded because ShiftBoss installed a new version.
    if (!before) {
      const to = store.get('shiftboss.updatedTo', true);
      store.del('shiftboss.updatedTo', true);
      if (to && on.updated && claim('update:' + to)) show('ShiftBoss updated', snap.update?.current ? `Now running ${snap.update.current.sha}: ${snap.update.current.subject}` : 'A new version is running.', '#/settings', 'update');
    }
    const fresh: NotifyEvent[] = newNotifications(before, snap, on);
    for (const e of fresh.slice(0, 5)) {
      if (onScreen(e.route) || !claim(e.kind + '|' + e.key)) continue;
      show(e.title, e.body, e.route, e.key);
    }
    if (fresh.length > 5) show(`${fresh.length - 5} more in ShiftBoss`, 'Open ShiftBoss to see them all.', '#/', 'more');
  }, [snap]);
}

// ---------------------------------------------------------------- Settings

const GROUPS: { name: string; kinds: [keyof NotifySettings, string, string][] }[] = [
  { name: 'You are needed', kinds: [
    ['needs', 'A new Needs you item', 'A session asks you to decide something, an action waits for approval, or sessions look confused in a thread.'],
    ['blocked', 'A session needs a permission answer', 'It is blocked in herdr until you answer there.'],
    ['promiseDue', 'A promise is overdue', 'Something you said you would do passed its due time.'],
    ['monitor', 'A monitor alert', 'A check after shipping came back bad.'],
  ] },
  { name: 'Sessions', kinds: [
    ['finished', 'A session finished its turn', 'It is waiting for its next prompt.'],
    ['stuck', 'A session is stuck or looping', 'No progress, or the same command again and again.'],
    ['trouble', 'A session is in trouble', 'Context nearly full, tokens burning fast, or herdr lost the pane.'],
    ['overlap', 'An overlap', 'Two sessions touch the same file, migration number or task.'],
    ['replaced', 'A replacement finished, stalled or failed', 'A session handed over to a new one.'],
  ] },
  { name: 'Work', kinds: [
    ['tasks', 'Tasks', 'A new task, a task moving stage (PR open, On dev, Live …), or a promise kept.'],
    ['releases', 'Releases', 'A PR merged, or dev or prod runs a new version.'],
    ['monitorReport', 'Every monitor check', 'Each ok / warn / bad result, and a monitor finishing.'],
    ['actions', 'Actions ShiftBoss held', 'An approved action ran or failed, or Dry run recorded one.'],
  ] },
  { name: 'ShiftBoss', kinds: [
    ['limits', 'Usage limits', 'The 5-hour or weekly usage passed 80% or 95%.'],
    ['system', 'Something stopped', 'herdr is not answering, or the intake went quiet for 15 minutes.'],
    ['updated', 'Updates', 'A new version is available, or one was installed.'],
  ] },
];
const ALL_KINDS = GROUPS.flatMap((g) => g.kinds.map((k) => k[0]));

type SectionProps = { id: string; title: string; text: string; children: ReactNode };
type SwitchProps = { label: string; hint?: string; on: boolean; onChange: (v: boolean) => void };

/**
 * The Notifications part of Settings. Takes the page's own section and switch components, so it looks
 * like the rest of the page. Switches save at once (to every tab), apart from the page's Save button.
 */
export function NotificationSettings({ Section, Switch }: { Section: ComponentType<SectionProps>; Switch: ComponentType<SwitchProps> }) {
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>(supported() ? Notification.permission : 'unsupported');
  const snap = useSnap();
  // A flip shows at once; the live snapshot (shared by every tab) confirms it a moment later.
  const [pending, setPending] = useState<Partial<NotifySettings>>({});
  const live = JSON.stringify(snap?.settings.notify ?? null);
  useEffect(() => setPending({}), [live]);
  const on: NotifySettings = { ...DEFAULT_NOTIFY, ...snap?.settings.notify, ...pending };
  const ask = async () => {
    if (!supported()) return;
    try { setPerm(await Notification.requestPermission()); } catch (e) { toast((e as Error).message); }
  };
  const test = () => {
    if (perm !== 'granted') return toast('Allow notifications first');
    show('ShiftBoss', 'Notifications work. Click to come back here.', '#/settings', 'test');
  };
  const save = (patch: Partial<NotifySettings>) => {
    setPending((p) => ({ ...p, ...patch }));
    api('PUT', '/api/settings', { notify: patch }).then(() => toast('Saved'), (e) => { setPending({}); toast((e as Error).message); });
  };
  const flip = (k: keyof NotifySettings, v: boolean) => save({ [k]: v });
  const all = (v: boolean) => save(Object.fromEntries(ALL_KINDS.map((k) => [k, v])) as Partial<NotifySettings>);
  const count = ALL_KINDS.filter((k) => on[k]).length;
  const status = perm === 'granted' ? ['Allowed in this browser.', C.green] : perm === 'denied' ? ['Blocked in this browser. Allow them in the site settings (the icon left of the address), then reload.', C.red]
    : perm === 'unsupported' ? ['This browser cannot show notifications.', C.faint] : ['Not allowed yet.', C.amber];
  return (
    <Section id="notifications" title="Notifications" text="Shown by your browser while ShiftBoss is open in a tab (one tab shows them, even in the background). Nothing is sent when no tab is open.">
      <div className="row" style={{ gridColumn: '1 / -1', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, color: status[1] as string, flex: '1 1 240px' }}>{status[0]}</span>
        {perm !== 'granted' && perm !== 'unsupported' && <button type="button" className="pill sm w" onClick={() => void ask()} disabled={perm === 'denied'}>Allow notifications</button>}
        <button type="button" className="pill sm" onClick={test} disabled={perm !== 'granted'}>Send a test</button>
      </div>
      <div className="row" style={{ gridColumn: '1 / -1', gap: 8, flexWrap: 'wrap' }}>
        <span className="faint" style={{ fontSize: 12, flex: '1 1 200px' }}>{count} of {ALL_KINDS.length} on</span>
        <button type="button" className="pill sm" onClick={() => all(true)} disabled={count === ALL_KINDS.length}>All on</button>
        <button type="button" className="pill sm" onClick={() => all(false)} disabled={count === 0}>All off</button>
      </div>
      {GROUPS.map((g) => (
        <div key={g.name} className="col" style={{ gridColumn: '1 / -1', gap: 18 }}>
          <span className="faint" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.08em' }}>{g.name}</span>
          {g.kinds.map(([k, label, hint]) => <Switch key={k} label={label} hint={hint} on={on[k]} onChange={(v) => flip(k, v)} />)}
        </div>
      ))}
    </Section>
  );
}
