import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_SEEN = 4000;

export interface SeenStoreFile {
  version: 1;
  seenPlayIds: string[];
  updatedAt: string;
}

export class SeenStore {
  private seen = new Set<string>();
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
      updatedAt: new Date().toISOString(),
    };
    await writeFile(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
}
