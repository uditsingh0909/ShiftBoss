import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Snapshot } from '../shared/types';

export const SnapshotCtx = createContext<Snapshot | null>(null);
export const useSnap = () => useContext(SnapshotCtx);

/** Live snapshot over server-sent events; reconnects on its own. */
export function useLiveSnapshot(): { snap: Snapshot | null; connected: boolean } {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const es = new EventSource('/api/stream');
    let version: string | null = null;
    es.onmessage = (e) => {
      const s: Snapshot = JSON.parse(e.data);
      // After a self-update the server restarts with new screens: load them instead of running stale code.
      const v = s.update?.current?.sha ?? null;
      if (version && v && v !== version) {
        try { sessionStorage.setItem('shiftboss.updatedTo', v); } catch { /* the reloaded page just will not say so */ }
        location.reload(); return;
      }
      if (v) version = v;
      setSnap(s); setConnected(true);
    };
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, []);
  return { snap, connected };
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-shiftboss': '1', 'x-shiftboss-actor': 'owner' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

// ---------- router: plain paths (/needs, /task/T-12) ----------
const NAV = 'shiftboss:nav';
/** Old links (#/needs) still work: they become /needs. */
function fromOldHash() {
  if (typeof location !== 'undefined' && location.hash.startsWith('#/')) history.replaceState(null, '', location.hash.slice(1) || '/');
}
fromOldHash();
/** Go to a page inside ShiftBoss without reloading. */
export function navigate(to: string, replace = false) {
  const path = to.startsWith('#/') ? to.slice(1) : to;
  if (path === location.pathname + location.search) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', path);
  dispatchEvent(new Event(NAV));
  scrollTo(0, 0);
}
/** Same-origin links (<a href="/needs">) move inside the app instead of reloading the page. */
if (typeof document !== 'undefined') document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = (e.target as Element | null)?.closest?.('a');
  if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
  const raw = a.getAttribute('href') ?? '';
  if (!(raw.startsWith('/') || raw.startsWith('#/')) || raw.startsWith('//') || raw.startsWith('/api/')) return;
  e.preventDefault();
  navigate(raw);
});
export function useRoute(): string[] {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => { fromOldHash(); setPath(location.pathname); };
    addEventListener('popstate', on); addEventListener(NAV, on); addEventListener('hashchange', on);
    return () => { removeEventListener('popstate', on); removeEventListener(NAV, on); removeEventListener('hashchange', on); };
  }, []);
  return path.split('/').filter(Boolean).map(decodeURIComponent);
}
export const href = (...parts: string[]) => '/' + parts.map(encodeURIComponent).join('/');

// ---------- toast ----------
type ToastAction = { label: string; run: () => void };
let pushToast: (t: string, action?: ToastAction, ms?: number) => void = () => {};
export const toast = (t: string, action?: ToastAction, ms?: number) => pushToast(t, action, ms);
export function Toaster() {
  const [t, setT] = useState<{ text: string; action?: ToastAction } | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    pushToast = (text, action, ms) => { setT({ text, action }); clearTimeout(timer); timer = setTimeout(() => setT(null), ms ?? (action ? 10000 : 3500)); };
  }, []);
  if (!t) return null;
  return (
    <div className="toast rise row" role="status" style={{ gap: 14 }}>
      <span>{t.text}</span>
      {t.action && <button type="button" className="pill xs w" onClick={() => { t.action!.run(); setT(null); }}>{t.action.label}</button>}
    </div>
  );
}
/** Run an action, toast the result or the error. */
export async function act(fn: () => Promise<unknown>, ok: string) {
  try { await fn(); toast(ok); } catch (e) { toast((e as Error).message); }
}

// ---------- formatting ----------
export const C = { fg: '#F4F4F5', dim: 'rgba(255,255,255,0.55)', faint: 'rgba(255,255,255,0.32)', ghost: 'rgba(255,255,255,0.12)', red: '#FF5A4F', amber: '#F5A524', green: '#4ADE80' };
export const ctxColor = (pct: number, warn = 70, replace = 85) => (pct >= replace ? C.red : pct >= warn ? C.amber : C.fg);
export const hhmm = (iso: string | null) => (iso ? new Date(iso).toTimeString().slice(0, 5) : '—');
export function ago(iso: string | null): string {
  if (!iso) return '—';
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60e3));
  return m < 1 ? 'now' : m < 60 ? m + 'm' : m < 1440 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : Math.floor(m / 1440) + 'd';
}
/** "3m ago", or "just now" (never "now ago"). */
export const agoText = (iso: string | null) => { const a = ago(iso); return a === 'now' ? 'just now' : a === '—' ? '—' : a + ' ago'; };
export const fmtTok = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));
export const toneColor = (t: 'red' | 'amber' | 'green' | 'dim') => (t === 'red' ? C.red : t === 'amber' ? C.amber : t === 'green' ? C.green : C.dim);

// ---------- small components ----------
export function Card({ children, span = 12, tone, className = '', delay = 0, pad }: { children: ReactNode; span?: number; tone?: 'red' | 'amber'; className?: string; delay?: number; pad?: number }) {
  return (
    <article className={`shell rise ${tone ? 'alert-' + tone : ''} ${className}`} style={{ gridColumn: `span ${span}`, animationDelay: delay + 'ms' }}>
      <div className="core col" style={{ gap: 14, padding: pad ?? 24 }}>{children}</div>
    </article>
  );
}
export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: readonly T[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => <button key={o} type="button" aria-pressed={o === value} onClick={() => onChange(o)}>{o}</button>)}
    </div>
  );
}
export const Bar = ({ pct, color }: { pct: number; color: string }) => <span className="bar" style={{ display: 'block' }}><span style={{ width: Math.min(100, Math.max(0, pct)) + '%', background: color }} /></span>;
export const Dot = ({ color, blink }: { color: string; blink?: boolean }) => <span className={'dot' + (blink ? ' blink' : '')} style={{ background: color }} aria-hidden="true" />;
export const Arrow = ({ dark }: { dark?: boolean }) => (
  <span className="knob" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={dark ? '#050505' : '#F4F4F5'} strokeWidth="1.6"><path d="M7 17L17 7M9 7h8v8" /></svg></span>
);
export function Hero({ eyebrow, title, sub, live, children }: { eyebrow: string; title: ReactNode; sub?: ReactNode; live?: boolean; children?: ReactNode }) {
  return (
    <section className="rise row" style={{ flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 32 }}>
      <div className="col" style={{ gap: 22, maxWidth: 1000 }}>
        <span className="eyebrow">{live && <Dot color={C.green} blink />}{eyebrow}</span>
        <h1 className="hero">{title}{sub && <><br /><span className="faint">{sub}</span></>}</h1>
      </div>
      {children && <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>{children}</div>}
    </section>
  );
}
export const Empty = ({ text }: { text: string }) => <div className="faint" style={{ padding: '24px 4px', fontSize: 13 }}>{text}</div>;

// ---------- long lists ----------
/** Show a long list a page at a time; resets to the first page when `reset` changes (e.g. a filter). */
export function usePage<T>(items: T[], size = 25, reset?: unknown) {
  const [n, setN] = useState(size);
  useEffect(() => setN(size), [reset, size]);
  return { shown: items.slice(0, n), left: Math.max(0, items.length - n), more: () => setN((x) => x + size), size };
}
export function More({ page }: { page: { left: number; more: () => void; size: number } }) {
  if (page.left <= 0) return null;
  return <button type="button" className="pill sm" style={{ alignSelf: 'center', marginTop: 6 }} onClick={page.more}>Show {Math.min(page.left, page.size)} more · {page.left} left</button>;
}

// ---------- dropdowns ----------
// The browser draws <select> and <datalist> popups itself (white border, blue highlight), so they
// cannot match the UI. Pick is our own: a button (or a text box, with `free`) and a dark list.
/** `action`: a command row ("Create new session"), drawn with a plus icon and a line under it, not a choice. */
export type PickOption = { value: string; label?: string; hint?: string; action?: boolean };

export function Pick({ id, value, options, onChange, placeholder, free, width, label, pill, prefix }: {
  id?: string; value: string; options: PickOption[]; onChange: (v: string) => void;
  placeholder?: string; free?: boolean; width?: number | string; label?: string; pill?: boolean;
  /** Shown before the chosen value on the button only, e.g. "Session". */ prefix?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [typed, setTyped] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number; maxHeight: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { const t = e.target as Node; if (!ref.current?.contains(t) && !listRef.current?.contains(t)) { setOpen(false); setTyped(null); } };
    // The list lives on <body> (cards are their own layers and would paint over it), so it follows the field.
    const place = () => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const below = innerHeight - r.bottom - 12, above = r.top - 12;
      const up = below < 220 && above > below;
      setPos({ left: r.left, width: Math.min(Math.max(r.width, 300), innerWidth - r.left - 12), maxHeight: Math.min(300, up ? above : below), ...(up ? { bottom: innerHeight - r.top + 6 } : { top: r.bottom + 6 }) });
    };
    place();
    addEventListener('mousedown', off);
    addEventListener('scroll', place, true);
    addEventListener('resize', place);
    return () => { removeEventListener('mousedown', off); removeEventListener('scroll', place, true); removeEventListener('resize', place); };
  }, [open]);
  const q = (typed ?? '').toLowerCase();
  const list = free && typed ? options.filter((o) => (o.value + ' ' + (o.label ?? '')).toLowerCase().includes(q)) : options;
  const current = options.find((o) => o.value === value);
  const choose = (v: string) => { onChange(v); setOpen(false); setTyped(null); };
  const openAt = () => { setOpen(true); setHi(Math.max(0, list.findIndex((o) => o.value === value))); };
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return openAt();
      setHi((h) => (h + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % Math.max(1, list.length));
    } else if (e.key === 'Enter') {
      if (open && list[hi]) { e.preventDefault(); choose(list[hi].value); }
      else if (free && typed !== null) { e.preventDefault(); choose(typed); }
      else if (!free) { e.preventDefault(); openAt(); }
    } else if (e.key === 'Escape') { setOpen(false); setTyped(null); }
    else if (e.key === 'Tab') { if (free && typed !== null) onChange(typed); setOpen(false); setTyped(null); }
  };
  const common = { id, role: 'combobox', 'aria-expanded': open, 'aria-controls': listId, 'aria-label': label, onKeyDown: key } as const;
  return (
    <div ref={ref} className={'pick' + (pill ? ' pick-pill' : '')} style={{ width: width ?? '100%' }}>
      {free ? (
        <input {...common} className="field mono pick-field" value={typed ?? value} placeholder={placeholder} autoComplete="off"
          onFocus={openAt} onChange={(e) => { setTyped(e.target.value); setOpen(true); setHi(0); }}
          onBlur={() => { if (typed !== null) onChange(typed); }} />
      ) : (
        <button {...common} type="button" className="field pick-field" onClick={() => (open ? setOpen(false) : openAt())}>
          <span className="ellipsis" style={{ color: current ? undefined : C.faint }}>{current ? (prefix && current.value ? prefix + ' · ' : '') + (current.label ?? current.value) : placeholder ?? 'Choose…'}</span>
        </button>
      )}
      {open && pos && list.length > 0 && createPortal(
        <ul ref={listRef} id={listId} role="listbox" className="pick-list" style={{ position: 'fixed', left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight }}>
          {list.map((o, i) => (
            <li key={o.value} role="option" aria-selected={o.value === value} className={(i === hi ? 'hi' : '') + (o.action ? ' pick-action' : '')}
              onMouseEnter={() => setHi(i)} onMouseDown={(e) => { e.preventDefault(); choose(o.value); }}>
              {o.action && (
                <span className="pick-plus" aria-hidden="true">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                </span>
              )}
              <span className="ellipsis" style={{ flex: '1 1 auto', minWidth: 0 }}>{o.label ?? o.value}</span>
              {o.hint && <span className="faint ellipsis" style={{ fontSize: 12, flex: 'none', maxWidth: '45%' }}>{o.hint}</span>}
              <span aria-hidden="true" style={{ width: 14, flex: 'none', color: C.green }}>{o.value === value ? '✓' : ''}</span>
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </div>
  );
}

/** An href from stored data: only http(s), so a stored `javascript:` link can never run. */
export function safeHref(u: string | null | undefined): string | undefined {
  if (!u) return undefined;
  try { const p = new URL(u).protocol; return p === 'https:' || p === 'http:' ? u : undefined; } catch { return undefined; }
}
