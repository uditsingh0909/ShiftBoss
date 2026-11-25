// Shared list controls: a date range (Today, Yesterday, 7 days, 30 days, All, or a custom range up to
// MAX_DAYS), a filter bar that wraps on a phone, and a pager (Prev / Next, rows per page).
import { useState, type ReactNode } from 'react';
import { Pick, Seg } from './lib';

export const RANGES = ['Today', 'Yesterday', '7 days', '30 days', 'All', 'Custom'] as const;
export type RangeId = (typeof RANGES)[number];
/** The longest custom range, so a query never scans everything by accident. */
export const MAX_DAYS = 90;
export interface Range { id: RangeId; from?: string; to?: string } // custom: local dates YYYY-MM-DD, both inclusive

const dayStart = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fromYmd = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };

/** The range as ISO bounds in the viewer's time zone: from is inclusive, to exclusive. All: no bounds. */
export function rangeBounds(r: Range, now = new Date()): { from?: string; to?: string } {
  const today = dayStart(now), day = 864e5;
  switch (r.id) {
    case 'Today': return { from: today.toISOString() };
    case 'Yesterday': return { from: new Date(today.getTime() - day).toISOString(), to: today.toISOString() };
    case '7 days': return { from: new Date(today.getTime() - 6 * day).toISOString() };
    case '30 days': return { from: new Date(today.getTime() - 29 * day).toISOString() };
    case 'All': return {};
    case 'Custom': {
      if (!r.from || !r.to) return {};
      const to = new Date(fromYmd(r.to).getTime() + day);
      return { from: fromYmd(r.from).toISOString(), to: to.toISOString() };
    }
  }
}
/** True when an ISO time falls in the range (for lists filtered in the page). */
export function inRange(iso: string | null | undefined, r: Range, now = new Date()): boolean {
  if (r.id === 'All') return true;
  if (!iso) return false;
  const b = rangeBounds(r, now), t = Date.parse(iso);
  return (!b.from || t >= Date.parse(b.from)) && (!b.to || t < Date.parse(b.to));
}

/** The date range picker. Custom asks for two dates and keeps them within MAX_DAYS. */
export function DateRange({ value, onChange, id = 'range' }: { value: Range; onChange: (r: Range) => void; id?: string }) {
  const today = ymd(new Date());
  const [from, setFrom] = useState(value.from ?? ymd(new Date(Date.now() - 6 * 864e5)));
  const [to, setTo] = useState(value.to ?? today);
  const span = Math.round((fromYmd(to).getTime() - fromYmd(from).getTime()) / 864e5) + 1;
  const bad = !from || !to ? 'Pick both dates' : span < 1 ? 'The start is after the end' : span > MAX_DAYS ? `At most ${MAX_DAYS} days` : null;
  const minFrom = ymd(new Date(fromYmd(to).getTime() - (MAX_DAYS - 1) * 864e5));
  return (
    <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <Seg label="Date range" value={value.id} options={RANGES} onChange={(r) => onChange(r === 'Custom' ? { id: r, from, to } : { id: r })} />
      {value.id === 'Custom' && (
        <span className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <label className="sr-only" htmlFor={id + '-from'}>From</label>
          <input id={id + '-from'} type="date" className="field" style={{ width: 150, padding: '6px 10px' }} value={from} min={minFrom} max={to} onChange={(e) => setFrom(e.target.value)} />
          <span className="faint">to</span>
          <label className="sr-only" htmlFor={id + '-to'}>To</label>
          <input id={id + '-to'} type="date" className="field" style={{ width: 150, padding: '6px 10px' }} value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} />
          <button type="button" className="pill sm w" disabled={!!bad} onClick={() => onChange({ id: 'Custom', from, to })}>Apply</button>
          <span className={bad ? 'amber' : 'faint'} style={{ fontSize: 12 }}>{bad ?? `${span} day${span === 1 ? '' : 's'} · at most ${MAX_DAYS}`}</span>
        </span>
      )}
    </div>
  );
}

/** A row of filters above a list; wraps on a phone. */
export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>{children}</div>;
}

/** A search box for a filter bar. */
export function Search({ value, onChange, placeholder, id }: { value: string; onChange: (v: string) => void; placeholder: string; id: string }) {
  return (
    <span className="row" style={{ gap: 6, flex: '1 1 200px', minWidth: 0, maxWidth: 320 }}>
      <label className="sr-only" htmlFor={id}>Search</label>
      <input id={id} type="search" className="field" style={{ width: '100%', padding: '6px 12px' }} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </span>
  );
}

export const PAGE_SIZES = [25, 50, 100, 200];
/** "1–50 of 312", Prev, Next and rows per page. */
export function Pager({ total, offset, limit, onOffset, onLimit, id = 'pager' }: { total: number; offset: number; limit: number; onOffset: (n: number) => void; onLimit: (n: number) => void; id?: string }) {
  const first = total ? offset + 1 : 0, last = Math.min(total, offset + limit);
  const page = Math.floor(offset / limit) + 1, pages = Math.max(1, Math.ceil(total / limit));
  return (
    <nav className="row" aria-label="Pages" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8 }}>
      <span className="faint" style={{ fontSize: 12 }}>{first}–{last} of {total} · page {page} of {pages}</span>
      <span className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="faint" style={{ fontSize: 12 }}>Rows</span>
        <Pick id={id + '-size'} label="Rows per page" value={String(limit)} options={PAGE_SIZES.map((n) => ({ value: String(n) }))} onChange={(v) => { onLimit(Number(v)); onOffset(0); }} />
        <button type="button" className="pill sm" disabled={offset <= 0} onClick={() => onOffset(Math.max(0, offset - limit))}>‹ Prev</button>
        <button type="button" className="pill sm" disabled={offset + limit >= total} onClick={() => onOffset(offset + limit)}>Next ›</button>
      </span>
    </nav>
  );
}

/** Page an array in the page itself (for lists the snapshot already holds in full). */
export function usePaged<T>(items: T[], reset: unknown, size = 25) {
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(size);
  const [key, setKey] = useState(reset);
  if (key !== reset) { setKey(reset); setOffset(0); }
  const off = offset >= items.length && items.length ? Math.floor((items.length - 1) / limit) * limit : offset;
  return { shown: items.slice(off, off + limit), pager: { total: items.length, offset: off, limit, onOffset: setOffset, onLimit: setLimit } };
}
