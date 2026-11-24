// One snapshot per change for every open tab. The engine emits on every poll, but most polls change
// nothing, and each tab used to build and serialize its own ~240 KB copy every time.
import type { Snapshot } from '../shared/types';

/** Send even an unchanged snapshot this often, so `snap.now` moves and relative times stay fresh. */
export const STREAM_KEEPALIVE_MS = 30_000;

/**
 * Turns snapshots into SSE frames, skipping a frame whose content (everything but `now`, plus `version`)
 * matches the last one sent, unless `keepaliveMs` has passed. `now` stays the first key, so the JSON the
 * UI receives is the same shape as before.
 */
export class SnapshotFrames {
  private lastHash: number | bigint | null = null;
  private lastAt = 0;
  last: string | null = null;

  constructor(private keepaliveMs = STREAM_KEEPALIVE_MS) {}

  /**
   * The frame to send for `snap`, or null when nothing changed since the last one. `version` covers
   * changes the snapshot does not show (a new task event, say), so those still reach the UI.
   */
  next(snap: Snapshot, nowMs = Date.now(), version: string | number = ''): string | null {
    const { now, ...rest } = snap;
    const body = JSON.stringify(rest);
    const hash = Bun.hash(version + '\n' + body);
    if (hash === this.lastHash && this.last !== null && nowMs - this.lastAt < this.keepaliveMs) return null;
    this.lastHash = hash;
    this.lastAt = nowMs;
    this.last = 'data: {"now":' + JSON.stringify(now) + (body.length > 2 ? ',' + body.slice(1) : '}') + '\n\n';
    return this.last;
  }
}

type Client = (frame: Uint8Array) => void;

/** Fan-out of snapshot frames to every connected SSE client: built and encoded once per change. */
export class SnapshotHub {
  private clients = new Set<Client>();
  private frames: SnapshotFrames;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private enc = new TextEncoder();
  private lastBytes: Uint8Array | null = null;

  constructor(private build: () => Snapshot, private version: () => string | number = () => '', private debounceMs = 250, private keepaliveMs = STREAM_KEEPALIVE_MS) {
    this.frames = new SnapshotFrames(keepaliveMs);
  }

  /** Something may have changed: build once, after a short debounce, and send to all if it did. */
  changed() {
    if (this.pending || !this.clients.size) return;
    this.pending = setTimeout(() => { this.pending = null; this.flush(); }, this.debounceMs);
  }

  flush(nowMs = Date.now()) {
    let frame: string | null;
    try { frame = this.frames.next(this.build(), nowMs, this.version()); } catch { return; } // a bad build never kills the stream; the next change retries
    if (frame === null) return;
    const bytes = this.enc.encode(frame);
    this.lastBytes = bytes;
    for (const c of this.clients) c(bytes);
  }

  /** A new tab gets the latest snapshot at once, then every change. Returns the unsubscribe. */
  add(client: Client): () => void {
    this.flush(); // brings everyone up to date; a no-op when nothing changed
    if (this.lastBytes) client(this.lastBytes);
    this.clients.add(client);
    if (!this.keepalive) this.keepalive = setInterval(() => this.flush(), this.keepaliveMs);
    return () => {
      this.clients.delete(client);
      if (!this.clients.size) {
        if (this.keepalive) { clearInterval(this.keepalive); this.keepalive = null; }
        if (this.pending) { clearTimeout(this.pending); this.pending = null; }
      }
    };
  }

  get size() { return this.clients.size; }
}
