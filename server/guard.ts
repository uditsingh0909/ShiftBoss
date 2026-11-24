// Who may talk to the API. ShiftBoss binds 127.0.0.1, but a web page can still reach it through DNS
// rebinding (evil.example resolving to 127.0.0.1 makes the page same-origin, header and all). So every
// /api request must name this machine in Host, and a write that carries an Origin must come from here.
export function allowedHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

export function checkRequest(req: Request, port: number): string | null {
  const hosts = allowedHosts(port);
  const host = (req.headers.get('host') ?? '').toLowerCase();
  if (!hosts.has(host)) return `Host ${host || '(none)'} is not this machine`;
  const origin = req.headers.get('origin');
  if (origin && req.method !== 'GET') {
    let o = '';
    try { o = new URL(origin).host.toLowerCase(); } catch { /* "null" or garbage */ }
    if (!hosts.has(o)) return `Origin ${origin} is not allowed`;
  }
  return null;
}

/** Links stored from Slack, sessions or imports: only http(s), so a `javascript:` link can never run. */
export function safeUrl(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const s = v.trim();
  if (s.length > 500) throw new Error('URL is too long');
  let u: URL;
  try { u = new URL(s); } catch { throw new Error('Not a valid URL: ' + s.slice(0, 80)); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http and https links are allowed');
  return u.toString();
}
