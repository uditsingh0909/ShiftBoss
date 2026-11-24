import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Snapshot } from '../shared/types';

export const SnapshotCtx = createContext<Snapshot | null>(null);
export const useSnap = () => useContext(SnapshotCtx);

/** Live snapshot over server-sent events; reconnects on its own. */
export function useLiveSnapshot(): { snap: Snapshot | null; connected: boolean } {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const es = new EventSource('/api/stream');
    es.onmessage = (e) => { setSnap(JSON.parse(e.data)); setConnected(true); };
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, []);
  return { snap, connected };
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-shiftboss': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

// ---------- hash router ----------
export function useRoute(): string[] {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
}
export const href = (...parts: string[]) => '#/' + parts.map(encodeURIComponent).join('/');

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
      {t.action && <button type="button" className="pill sm w" style={{ height: 28 }} onClick={() => { t.action!.run(); setT(null); }}>{t.action.label}</button>}
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
