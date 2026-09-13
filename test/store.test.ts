import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SeenStore } from "../src/store.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("SeenStore", () => {
  it("persists play IDs across reload so the same miss is not tweeted twice", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "missed-kick-"));
    dirs.push(dir);
    const file = path.join(dir, "seen.json");

    const first = new SeenStore(file);
    await first.load();
    expect(first.has("4018729234815")).toBe(false);
    first.add("4018729234815");
    first.add("401872659257");
    await first.save();

    const second = new SeenStore(file);
    await second.load();
    expect(second.has("4018729234815")).toBe(true);
    expect(second.has("401872659257")).toBe(true);
    expect(second.has("never-seen")).toBe(false);
    expect(second.size).toBe(2);
  });

  it("treats a missing file as empty state", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "missed-kick-"));
    dirs.push(dir);
    const store = new SeenStore(path.join(dir, "missing", "seen.json"));
    await store.load();
    expect(store.size).toBe(0);
  });
});
