import app from '../web/index.html';
import { makeApi } from './api';
import { loadConfig } from './config';
import { Store } from './db';
import { Engine } from './engine';
import { Herdr } from './herdr';
import { checkRequest } from './guard';

// One bad poll must never take the whole control room down: log it and keep serving.
process.on('unhandledRejection', (e) => console.error(new Date().toISOString(), 'unhandled rejection:', e));
process.on('uncaughtException', (e) => console.error(new Date().toISOString(), 'uncaught exception:', e));

const cfg = loadConfig();
const store = new Store(cfg.dataDir);
const engine = new Engine(cfg, store, new Herdr(cfg.herdrBin));
const api = makeApi(engine);
const linked = store.linkOrphanPromises(); // older promises predate the one-task-per-promise rule
if (linked) console.log(`Filed ${linked} task(s) for promises that had none`);
engine.start();

// If the port is taken (an old copy still shutting down), exit so scripts/run.sh retries in 3 s.
// The uncaughtException handler above would otherwise keep this process alive with no server.
let server: ReturnType<typeof Bun.serve>;
try {
  server = serve();
} catch (e) {
  console.error(new Date().toISOString(), 'could not listen on port', cfg.port, '-', (e as Error).message);
  process.exit(1);
}

function serve() { return Bun.serve({
  hostname: '127.0.0.1', // never exposed beyond this machine: the API can prompt sessions
  port: cfg.port,
  idleTimeout: 0, // keep event streams open
  development: process.env.NODE_ENV !== 'production',
  routes: { '/': app },
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      const bad = checkRequest(req, cfg.port);
      if (bad) return Response.json({ error: bad }, { status: 403 });
    }
    const res = await api(req, url);
    return res ?? new Response('Not found', { status: 404 });
  },
}); }

console.log(`ShiftBoss on http://127.0.0.1:${server.port}`);

// Open the UI on a first start (scripts/run.sh sets SHIFTBOSS_OPEN=1 only for its first launch, so a
// crash restart or an update does not open another tab). Set "openBrowser": false in the config to stop it.
if (process.env.SHIFTBOSS_OPEN === '1' && cfg.openBrowser !== false) {
  const url = `http://127.0.0.1:${server.port}/`;
  const cmd = process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : process.platform === 'darwin' ? ['open', url] : ['xdg-open', url];
  try { Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' }).unref(); } catch { /* no browser on this machine: fine */ }
}
