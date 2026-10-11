import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_SEEN = 4000;

export interface SeenStoreFile {
  version: 1;
  seenPlayIds: string[];
  /** playId → GitHub issue number for misses held back because the kicker was unknown. */
  notifiedIssues?: Record<string, number>;
  updatedAt: string;
}

export class SeenStore {
  private seen = new Set<string>();
  private notified = new Map<string, number>();
  constructor(private readonly filePath: string) {}

  get size(): number {
    return this.seen.size;
  }

  has(playId: string): boolean {
    return this.seen.has(playId);
  }

  add(playId: string): void {
    this.seen.add(playId);
  }

  notifiedIssue(playId: string): number | undefined {
    return this.notified.get(playId);
  }

  setNotified(playId: string, issue: number): void {
    this.notified.set(playId, issue);
  }

  clearNotified(playId: string): void {
    this.notified.delete(playId);
  }

  addMany(playIds: string[]): void {
    for (const id of playIds) this.seen.add(id);
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const data = JSON.parse(raw) as SeenStoreFile;
      if (Array.isArray(data.seenPlayIds)) {
        this.seen = new Set(data.seenPlayIds.map(String));
      }
      if (data.notifiedIssues && typeof data.notifiedIssues === "object") {
        this.notified = new Map(Object.entries(data.notifiedIssues).map(([k, v]) => [k, Number(v)]));
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
  }

  async save(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    let ids = [...this.seen];
    if (ids.length > MAX_SEEN) ids = ids.slice(ids.length - MAX_SEEN);
    const payload: SeenStoreFile = {
      version: 1,
      seenPlayIds: ids,
      ...(this.notified.size ? { notifiedIssues: Object.fromEntries(this.notified) } : {}),
      updatedAt: new Date().toISOString(),
    };
    await writeFile(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
}
