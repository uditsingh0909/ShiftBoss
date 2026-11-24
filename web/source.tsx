// Where an item came from and which way it went: the "Open in Slack" button, the ↓ / ↑ chip, the
// "No source link" marker and the small "Add link" field that fixes it.
import { useState } from 'react';
import type { Direction } from '../shared/types';
import { act, api, C, safeHref } from './lib';

/** "Slack", "Gmail" or null, from the link's host. */
export function linkKind(url: string): 'Slack' | 'Gmail' | null {
  let host = '';
  try { host = new URL(url).host.toLowerCase(); } catch { return null; }
  if (host === 'slack.com' || host.endsWith('.slack.com')) return 'Slack';
  if (host === 'mail.google.com') return 'Gmail';
  return null;
}
export const linkLabel = (url: string) => { const k = linkKind(url); return k ? 'Open in ' + k : 'Open link'; };

/** The button that opens the original message. `via`: the link is borrowed from that task. `short` for narrow cards. */
export function SourceButton({ url, via, short, what }: { url: string; via?: string | null; short?: boolean; what?: string }) {
  const h = safeHref(url);
  if (!h) return <NoSourceLink />;
  const label = linkLabel(url);
  return (
    <span className="row" style={{ gap: 6, minWidth: 0 }}>
      <a href={h} target="_blank" rel="noreferrer" className="pill sm" style={{ height: 26, fontSize: 11, padding: '0 10px', whiteSpace: 'nowrap' }}
        aria-label={label + (what ? ': ' + what : '') + (via ? ` (the link of ${via})` : '')} title={url}>
        {short ? (linkKind(url) ?? 'Link') : label} ↗
      </a>
      {via && <span className="mono faint" style={{ fontSize: 11, whiteSpace: 'nowrap' }} title={`This has no link of its own; this is the link of ${via}`}>via {via}</span>}
    </span>
  );
}

/** ↓ Inbound / ↑ Outbound. Nothing when the direction was not recorded. */
export function DirectionChip({ d }: { d: Direction | undefined }) {
  if (!d) return null;
  const inbound = d === 'inbound';
  return (
    <span className="mono" style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.14)', whiteSpace: 'nowrap' }}
      title={inbound ? 'Someone asked us or wrote to you' : 'You or a session said or sent it'}>
      {inbound ? '↓ Inbound' : '↑ Outbound'}
    </span>
  );
}

export function NoSourceLink() {
  return <span className="mono" style={{ fontSize: 11, color: C.amber, whiteSpace: 'nowrap' }} title="No link to the message this came from was recorded">No source link</span>;
}

/**
 * A collapsed "Add link" button that opens a field for the permalink (and, if unknown, the direction).
 * `path` is the PATCH endpoint; `field` the body key for the link (tasks: sourceUrl, promises: url).
 */
export function AddLink({ path, field, direction, what }: { path: string; field: 'sourceUrl' | 'url'; direction?: Direction; what: string }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [dir, setDir] = useState<Direction>(direction ?? null);
  if (!open) return <button type="button" className="pill sm" style={{ height: 26, fontSize: 11, padding: '0 10px' }} onClick={() => setOpen(true)} aria-label={'Add a source link to ' + what}>Add link</button>;
  const save = () => act(async () => {
    await api('PATCH', path, { [field]: url.trim(), ...(dir !== (direction ?? null) ? { direction: dir } : {}), who: 'you' });
    setOpen(false); setUrl('');
  }, 'Link saved');
  const id = 'addlink-' + path.replace(/\W+/g, '-');
  return (
    <form className="row" style={{ gap: 8, flexWrap: 'wrap', width: '100%' }} onSubmit={(e) => { e.preventDefault(); if (url.trim()) void save(); }}>
      <label htmlFor={id} className="faint" style={{ fontSize: 12 }}>Link</label>
      <input id={id} className="field mono" style={{ height: 34, flex: '1 1 200px', minWidth: 0, fontSize: 12 }} type="url" required autoFocus
        placeholder="https://…slack.com/archives/… or Gmail link" value={url} onChange={(e) => setUrl(e.target.value)} />
      {!direction && (
        <span className="seg" role="group" aria-label="Which way it went">
          <button type="button" aria-pressed={dir === 'inbound'} onClick={() => setDir(dir === 'inbound' ? null : 'inbound')}>↓ Inbound</button>
          <button type="button" aria-pressed={dir === 'outbound'} onClick={() => setDir(dir === 'outbound' ? null : 'outbound')}>↑ Outbound</button>
        </span>
      )}
      <button type="submit" className="pill sm w" disabled={!url.trim()}>Save</button>
      <button type="button" className="pill sm" onClick={() => setOpen(false)}>Cancel</button>
    </form>
  );
}
