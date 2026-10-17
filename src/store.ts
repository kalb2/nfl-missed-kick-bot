import { FileStateBackend, type StateBackend } from "./state-backend.js";

/** Plenty for several seasons of misses; only misses (not every play) are stored. */
const MAX_HANDLED = 5000;
const PENDING_TTL_MS = 24 * 60 * 60_000;

export type HandledStatus =
  /** Tweet succeeded. */
  | "posted"
  /** Durably claimed right before posting. If a run dies here we never retry (at-most-once). */
  | "posting"
  /** X rejected/failed the post; a needs-manual-post issue is opened instead of retrying. */
  | "failed"
  /** Recorded without posting (SEED_SEEN, bootstrap, or legacy import). */
  | "seeded"
  /** Kaleb handled it by hand (closed needs-manual-post issue or override alreadyPosted). */
  | "manual"
  /** DRY_RUN "post". */
  | "dry-run";

export interface HandledEntry {
  playId: string;
  eventId?: string;
  status: HandledStatus;
  at: string;
  tweetId?: string;
}

/** A miss seen on one poll, waiting for an identical second sighting. */
export interface PendingEntry {
  playId: string;
  eventId?: string;
  fingerprint: string;
  firstSeenAt: string;
}

export interface SeenStoreFileV2 {
  version: 2;
  /** "<eventId>:<playId>" → entry. */
  handled: Record<string, HandledEntry>;
  pending: Record<string, PendingEntry>;
  /** playId → GitHub issue number for misses held back because the kicker was unknown. */
  notifiedIssues?: Record<string, number>;
  updatedAt: string;
}

/** v1 = the old Actions-cache seen.json. Still readable so bootstrap can import it. */
interface SeenStoreFileV1 {
  version: 1;
  seenPlayIds: string[];
  notifiedIssues?: Record<string, number>;
}

export type LoadStatus = "loaded" | "missing";

/** ESPN play ids are the 9-digit event id followed by a sequence number. */
export function eventIdFromPlayId(playId: string): string | undefined {
  const m = /^(\d{9})\d+$/.exec(String(playId));
  return m ? m[1] : undefined;
}

export function handledKey(playId: string, eventId?: string): string {
  return `${eventId ?? eventIdFromPlayId(playId) ?? "?"}:${playId}`;
}

export class SeenStore {
  private handled = new Map<string, HandledEntry>();
  private byPlayId = new Set<string>();
  private pending = new Map<string, PendingEntry>();
  private notified = new Map<string, number>();
  private version: string | undefined;
  private dirty = false;
  private loaded = false;
  readonly backend: StateBackend;

  constructor(target: string | StateBackend) {
    this.backend = typeof target === "string" ? new FileStateBackend(target) : target;
  }

  get size(): number {
    return this.byPlayId.size;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  has(playId: string): boolean {
    return this.byPlayId.has(String(playId));
  }

  handledEntry(playId: string, eventId?: string): HandledEntry | undefined {
    return this.handled.get(handledKey(String(playId), eventId));
  }

  /** Back-compat alias used by seed / override paths. */
  add(playId: string, eventId?: string, status: HandledStatus = "seeded", tweetId?: string): void {
    this.markHandled(playId, eventId, status, tweetId);
  }

  markHandled(playId: string, eventId: string | undefined, status: HandledStatus, tweetId?: string): void {
    const id = String(playId);
    const key = handledKey(id, eventId);
    const prev = this.handled.get(key);
    if (prev && prev.status === status && prev.tweetId === tweetId) return;
    this.handled.set(key, {
      playId: id,
      ...(eventId ?? eventIdFromPlayId(id) ? { eventId: eventId ?? eventIdFromPlayId(id) } : {}),
      status,
      at: new Date().toISOString(),
      ...(tweetId ? { tweetId } : {}),
    });
    this.byPlayId.add(id);
    this.pending.delete(key);
    this.dirty = true;
  }

  addMany(playIds: string[], status: HandledStatus = "seeded"): void {
    for (const id of playIds) this.markHandled(id, undefined, status);
  }

  handledEntries(): HandledEntry[] {
    return [...this.handled.values()];
  }

  getPending(playId: string, eventId?: string): PendingEntry | undefined {
    return this.pending.get(handledKey(String(playId), eventId));
  }

  setPending(entry: PendingEntry): void {
    this.pending.set(handledKey(entry.playId, entry.eventId), entry);
    this.dirty = true;
  }

  deletePending(playId: string, eventId?: string): void {
    if (this.pending.delete(handledKey(String(playId), eventId))) this.dirty = true;
  }

  pendingForEvent(eventId: string): PendingEntry[] {
    return [...this.pending.values()].filter((p) => (p.eventId ?? eventIdFromPlayId(p.playId)) === eventId);
  }

  notifiedIssue(playId: string): number | undefined {
    return this.notified.get(playId);
  }

  setNotified(playId: string, issue: number): void {
    if (this.notified.get(playId) === issue) return;
    this.notified.set(playId, issue);
    this.dirty = true;
  }

  clearNotified(playId: string): void {
    if (this.notified.delete(playId)) this.dirty = true;
  }

  /**
   * Loads state. Returns "missing" only when the backend says the document does
   * not exist; every other failure (network, auth, bad JSON) throws so callers
   * can refuse to post.
   */
  async load(): Promise<LoadStatus> {
    const snap = await this.backend.read();
    this.reset();
    if (!snap) {
      this.loaded = true;
      return "missing";
    }
    this.version = snap.version;
    this.ingest(snap.data);
    this.loaded = true;
    return "loaded";
  }

  /** Merge another state document (e.g. the legacy Actions-cache seen.json) into this one. */
  importLegacy(data: unknown): number {
    const before = this.byPlayId.size;
    this.ingest(data, "seeded");
    if (this.byPlayId.size !== before) this.dirty = true;
    return this.byPlayId.size - before;
  }

  private reset(): void {
    this.handled.clear();
    this.byPlayId.clear();
    this.pending.clear();
    this.notified.clear();
    this.version = undefined;
    this.dirty = false;
  }

  private ingest(raw: unknown, legacyStatus: HandledStatus = "posted"): void {
    if (!raw || typeof raw !== "object") throw new Error("state document is not an object");
    const data = raw as Partial<SeenStoreFileV2> & Partial<Omit<SeenStoreFileV1, "version">> & { version?: number };
    if (data.version === 2) {
      if (!data.handled || typeof data.handled !== "object") throw new Error("state v2 missing handled");
      for (const [key, entry] of Object.entries(data.handled)) {
        if (!entry || typeof entry !== "object" || !entry.playId) continue;
        this.handled.set(key, entry);
        this.byPlayId.add(String(entry.playId));
      }
      for (const [key, entry] of Object.entries(data.pending ?? {})) {
        if (entry && entry.playId && entry.fingerprint) this.pending.set(key, entry);
      }
    } else if (Array.isArray(data.seenPlayIds)) {
      const at = new Date().toISOString();
      for (const rawId of data.seenPlayIds) {
        const playId = String(rawId);
        const key = handledKey(playId);
        if (this.handled.has(key)) continue;
        const eventId = eventIdFromPlayId(playId);
        this.handled.set(key, { playId, ...(eventId ? { eventId } : {}), status: legacyStatus, at });
        this.byPlayId.add(playId);
      }
    } else {
      throw new Error(`unknown state document version ${String(data.version)}`);
    }
    if (data.notifiedIssues && typeof data.notifiedIssues === "object") {
      for (const [k, v] of Object.entries(data.notifiedIssues)) {
        if (!this.notified.has(k)) this.notified.set(k, Number(v));
      }
    }
  }

  /** Relative to the newest sighting, so it doesn't depend on the wall clock. */
  private prunedPending(): Array<[string, PendingEntry]> {
    const entries = [...this.pending];
    const newest = Math.max(...entries.map(([, p]) => Date.parse(p.firstSeenAt) || 0));
    return entries.filter(([, p]) => newest - (Date.parse(p.firstSeenAt) || 0) < PENDING_TTL_MS);
  }

  toJSON(): SeenStoreFileV2 {
    let entries = [...this.handled.entries()];
    if (entries.length > MAX_HANDLED) {
      entries.sort((a, b) => a[1].at.localeCompare(b[1].at));
      entries = entries.slice(entries.length - MAX_HANDLED);
    }
    return {
      version: 2,
      handled: Object.fromEntries(entries),
      // Sightings from games that left the watch window unconfirmed are dropped after a day.
      pending: Object.fromEntries(this.prunedPending()),
      ...(this.notified.size ? { notifiedIssues: Object.fromEntries(this.notified) } : {}),
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Persist if anything changed (or `force`). Throws on failure — callers must
   * treat a failed save before posting as "do not post".
   */
  async save({ force = false, message = "Update bot state" } = {}): Promise<boolean> {
    if (!this.dirty && !force) return false;
    this.version = await this.backend.write(this.toJSON(), this.version, message);
    this.dirty = false;
    return true;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }
}
