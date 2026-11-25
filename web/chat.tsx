// The lead chat: a side panel on every page (and the Floor). Your message goes into the lead's herdr pane, marked as a
// chat message; its reply is read back from its local transcript. Cron check-ins and peer messages stay out.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { resolveLead, clockTime, type ChatMsg } from '../shared/types';
import { api, C, toast, useSnap } from './lib';

// ---------- open / close from anywhere ----------
const EV = 'shiftboss:chat';
export const openChat = (open = true) => dispatchEvent(new CustomEvent(EV, { detail: open }));
function useChatOpen(): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(() => { try { return sessionStorage.getItem('sb-chat') === '1'; } catch { return false; } });
  useEffect(() => {
    const on = (e: Event) => setOpen((e as CustomEvent<boolean>).detail);
    addEventListener(EV, on);
    return () => removeEventListener(EV, on);
  }, []);
  useEffect(() => { try { sessionStorage.setItem('sb-chat', open ? '1' : '0'); } catch { /* private window */ } }, [open]);
  return [open, (v) => openChat(v)];
}

const STATUS: Record<string, [string, string]> = {
  working: ['working', C.fg], idle: ['idle', C.green], done: ['idle', C.green], blocked: ['waiting on a prompt in herdr', C.red], unknown: ['unknown', C.faint], lost: ['not running', C.red],
};

/** The button that opens the panel: in the sidebar foot, the phone top bar and the Floor's top bar. */
export function ChatButton({ variant }: { variant: 'side' | 'icon' | 'floor' }) {
  const snap = useSnap();
  const lead = snap ? resolveLead(snap.sessions, snap.settings.leadSession ?? '') : null;
  const fresh = useUnread(snap?.chat ?? []);
  const icon = <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5.5h16v10H9l-5 4z" /><path d="M8.5 10.5h7" /></svg>;
  const label = 'Chat with the lead' + (fresh ? ' (new reply)' : '');
  if (variant === 'side') return (
    <button type="button" className="side-item row" onClick={() => openChat()} aria-label={label} title={label}>
      <span className="side-ico">{icon}{fresh && <span className="side-pip" style={{ background: C.green }} aria-hidden="true" />}</span>
      <span className="side-text ellipsis" style={{ flex: 1, textAlign: 'left' }}>Chat with lead</span>
      {lead && <span className="side-text mono faint ellipsis" style={{ fontSize: 11, maxWidth: 90 }}>{lead.name}</span>}
    </button>
  );
  return (
    <button type="button" className={variant === 'floor' ? 'fl-ibtn' : 'icon-btn'} aria-label={label} title={label} onClick={() => openChat()} style={{ position: 'relative' }}>
      {icon}{fresh && <span className={variant === 'floor' ? 'fl-badge' : 'side-pip'} style={{ background: C.green, color: '#050505' }}>{variant === 'floor' ? '1' : ''}</span>}
    </button>
  );
}

/** A reply newer than the last time the panel was open. */
function useUnread(chat: ChatMsg[]): boolean {
  const last = [...chat].reverse().find((m) => m.role === 'lead');
  let seen = 0; try { seen = Number(localStorage.getItem('sb-chat-seen') ?? 0); } catch { /* none */ }
  return !!last && Date.parse(last.at) > seen;
}
const markSeen = () => { try { localStorage.setItem('sb-chat-seen', String(Date.now())); } catch { /* none */ } };

// ---------- the panel ----------
export function LeadChat() {
  const snap = useSnap();
  const [open, setOpen] = useChatOpen();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const atBottom = useRef(true);
  const chat = snap?.chat ?? [];
  const lead = snap ? resolveLead(snap.sessions, snap.settings.leadSession ?? '') : null;
  const sig = chat.length + ':' + (chat[chat.length - 1]?.text.length ?? 0);

  useEffect(() => { if (open) { markSeen(); setTimeout(() => box.current?.focus(), 60); } }, [open]);
  useEffect(() => { if (open) markSeen(); }, [open, sig]);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [open]);
  // keep the newest message in view, unless you scrolled up to read
  useLayoutEffect(() => { const b = body.current; if (b && atBottom.current) b.scrollTop = b.scrollHeight; }, [sig, open]);
  useLayoutEffect(() => { const t = box.current; if (t) { t.style.height = '0'; t.style.height = Math.min(160, t.scrollHeight) + 'px'; } }, [text, open]);

  if (!open || !snap) return null;
  const [word, tone] = lead ? STATUS[lead.status] ?? STATUS.unknown : ['no lead running', C.red];
  const lastYou = [...chat].reverse().find((m) => m.role === 'you');
  const answered = lastYou && chat.some((m) => m.role === 'lead' && m.id > lastYou.id);
  const thinking = lastYou && !answered && lead?.status === 'working';
  const queued = lastYou && lastYou.state === 'sent' && !answered;

  const send = async () => {
    const t = text.trim(); if (!t || sending) return;
    setSending(true); setErr(null);
    try { await api('POST', '/api/chat', { text: t }); setText(''); atBottom.current = true; }
    catch (e) { setErr((e as Error).message); }
    finally { setSending(false); }
  };
  const clear = async () => { try { await api('POST', '/api/chat/clear', {}); toast('Chat cleared'); } catch (e) { toast((e as Error).message); } };

  return (
    <>
      <div className="lc-scrim" onClick={() => setOpen(false)} aria-hidden="true" />
      <aside className="lc" aria-label="Chat with the lead">
        <header className="lc-head">
          <div className="col" style={{ gap: 3, minWidth: 0, flex: 1 }}>
            <span className="lc-title">Lead</span>
            <span className="row lc-sub"><span className="dot" style={{ background: tone }} aria-hidden="true" /><span className="mono ellipsis">{lead ? `${lead.name} · ${word}` : 'Set one in Settings → Lead session'}</span></span>
          </div>
          {chat.length > 0 && <button type="button" className="pill xs" onClick={() => void clear()}>Clear</button>}
          <button type="button" className="icon-btn" aria-label="Close the chat" onClick={() => setOpen(false)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </header>

        <div className="lc-body" ref={body} onScroll={(e) => { const b = e.currentTarget; atBottom.current = b.scrollHeight - b.scrollTop - b.clientHeight < 40; }}>
          {!chat.length && (
            <div className="lc-empty">
              <b>Ask the lead anything.</b>
              <span>Your message goes straight into its herdr pane. Its reply shows up here as it writes it. Its own check-ins and messages from other sessions stay out of this chat.</span>
              <div className="col" style={{ gap: 6, marginTop: 6 }}>
                {['What is everyone working on?', 'Anything blocked or waiting on me?', 'What shipped today?'].map((q) => (
                  <button key={q} type="button" className="lc-suggest" onClick={() => { setText(q); box.current?.focus(); }}>{q}</button>
                ))}
              </div>
            </div>
          )}
          {chat.map((m, i) => {
            const prev = chat[i - 1];
            const handover = prev && prev.session !== m.session && m.role === 'lead';
            const day = !prev || new Date(prev.at).toDateString() !== new Date(m.at).toDateString();
            return (
              <Fragment key={m.id}>
                {day && <div className="lc-sep">{new Date(m.at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</div>}
                {handover && <div className="lc-sep">{m.session} took over</div>}
                <div className={'lc-msg ' + m.role}>
                  <div className="lc-bubble">{m.role === 'lead' ? <Rich text={m.text} /> : m.text}</div>
                  <span className="lc-meta">{clockTime(m.at)}{m.role === 'you' && m.state === 'sent' ? ' · sent' : ''}</span>
                </div>
              </Fragment>
            );
          })}
          {thinking && <div className="lc-msg lead"><div className="lc-bubble lc-typing" aria-label="The lead is working"><i /><i /><i /></div></div>}
          {queued && !thinking && <div className="lc-note">Typed into {lastYou!.session}'s pane. It reads it after its current step.</div>}
        </div>

        <form className="lc-foot" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          {err && <div className="lc-err" role="alert">{err}</div>}
          <div className="lc-compose">
            <textarea ref={box} value={text} rows={1} placeholder={lead ? `Message ${lead.name}` : 'No lead running'} aria-label="Message to the lead" disabled={!lead}
              onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
            <button type="submit" className="lc-send" disabled={!text.trim() || sending || !lead} aria-label="Send">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
            </button>
          </div>
          <span className="lc-hint">Enter to send · Shift+Enter for a new line</span>
        </form>
      </aside>
    </>
  );
}

// ---------- just enough markdown for a lead's reply: paragraphs, bullets, **bold**, `code`, code blocks ----------
function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    out.push(t.startsWith('`') ? <code key={k++}>{t.slice(1, -1)}</code> : <b key={k++}>{t.slice(2, -2)}</b>);
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
function Rich({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const parts = text.split(/```[a-z]*\n?/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) { blocks.push(<pre key={'p' + i}>{part.replace(/\n$/, '')}</pre>); return; }
    let list: string[] = [];
    const flush = (key: string) => { if (list.length) { blocks.push(<ul key={key}>{list.map((l, j) => <li key={j}>{inline(l)}</li>)}</ul>); list = []; } };
    part.split('\n').forEach((line, j) => {
      const b = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/);
      if (b) { list.push(b[1]); return; }
      flush(`l${i}-${j}`);
      const h = line.match(/^#{1,4}\s+(.*)$/);
      if (h) blocks.push(<p key={`h${i}-${j}`}><b>{inline(h[1])}</b></p>);
      else if (line.trim()) blocks.push(<p key={`t${i}-${j}`}>{inline(line)}</p>);
    });
    flush(`l${i}-end`);
  });
  return <>{blocks}</>;
}

