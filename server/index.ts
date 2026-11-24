import app from '../web/index.html';
import { makeApi } from './api';
import { loadConfig } from './config';
import { Store } from './db';
import { Engine } from './engine';
import { Herdr } from './herdr';

const cfg = loadConfig();
const store = new Store(cfg.dataDir);
const engine = new Engine(cfg, store, new Herdr(cfg.herdrBin));
const api = makeApi(engine);
engine.start();

const server = Bun.serve({
  hostname: '127.0.0.1', // never exposed beyond this machine: the API can prompt sessions
  port: cfg.port,
  idleTimeout: 0, // keep event streams open
  development: process.env.NODE_ENV !== 'production',
  routes: { '/': app },
  async fetch(req) {
    const res = await api(req, new URL(req.url));
    return res ?? new Response('Not found', { status: 404 });
  },
});

console.log(`Foreman on http://127.0.0.1:${server.port}`);
