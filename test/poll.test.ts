import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { composeTweet } from "../src/compose.js";
import { EspnClient } from "../src/espn.js";
import { pollOnce } from "../src/poll.js";
import { SeenStore } from "../src/store.js";
import type { GameSummary, ScoreboardEvent } from "../src/types.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function loadFixture(name: string): GameSummary {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), "utf8")) as GameSummary;
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function liveEvent(id: string, shortName: string): ScoreboardEvent {
  return {
    id,
    shortName,
    date: new Date().toISOString(),
    status: { type: { state: "in", name: "STATUS_IN_PROGRESS", completed: false } },
    competitions: [],
  };
}

function mockEspn(summaries: Record<string, GameSummary>, events: ScoreboardEvent[]): EspnClient {
  return {
    concurrency: 2,
    getScoreboard: async () => ({ events }),
    getSummary: async (eventId: string) => {
      const summary = summaries[eventId];
      if (!summary) throw new Error(`unexpected event ${eventId}`);
      return summary;
    },
  } as unknown as EspnClient;
}

describe("pollOnce", () => {
  it("posts each new miss once and skips it on the next poll", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "missed-kick-"));
    dirs.push(dir);
    const store = new SeenStore(path.join(dir, "seen.json"));
    const posted: string[] = [];
    const poster = {
      post: async (text: string) => {
        posted.push(text);
        return { id: "1" };
      },
    };

    const carlson = loadFixture("fg-missed-carlson.json");
    const shrader = loadFixture("pat-missed-shrader.json");
    const espn = mockEspn(
      { "401872923": carlson, "401872659": shrader },
      [liveEvent("401872923", "NO @ DET"), liveEvent("401872659", "BAL @ IND")],
    );

    const options = {
      dryRun: false,
      seedSeen: false,
      allToday: false,
      persist: true,
      recentFinalWindowMin: 45,
    };

    const first = await pollOnce({ espn, store, poster }, options);
    expect(first.newMisses.map((m) => m.kicker).sort()).toEqual(["D.Carlson", "S.Shrader"]);
    expect(posted).toHaveLength(2);
    expect(posted).toContain(composeTweet(first.newMisses.find((m) => m.kicker === "D.Carlson")!));

    const second = await pollOnce({ espn, store, poster }, options);
    expect(second.newMisses).toEqual([]);
    expect(second.skippedSeen).toBe(2);
    expect(posted).toHaveLength(2);
  });

  it("seed mode records misses without posting", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "missed-kick-"));
    dirs.push(dir);
    const store = new SeenStore(path.join(dir, "seen.json"));
    const posted: string[] = [];
    const sanders = loadFixture("fg-missed-sanders.json");
    const espn = mockEspn({ "401872924": sanders }, [liveEvent("401872924", "NYJ @ TEN")]);

    const result = await pollOnce(
      { espn, store, poster: { post: async (text) => { posted.push(text); return {}; } } },
      { dryRun: false, seedSeen: true, allToday: false, persist: true, recentFinalWindowMin: 45 },
    );

    expect(result.newMisses).toHaveLength(1);
    expect(posted).toEqual([]);
    expect(store.has("4018729241674")).toBe(true);
  });

  it("ignores Extra Point Good games", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "missed-kick-"));
    dirs.push(dir);
    const store = new SeenStore(path.join(dir, "seen.json"));
    const good = loadFixture("extra-point-good.json");
    const espn = mockEspn({ "401872925": good }, [liveEvent("401872925", "TB @ CIN")]);
    const result = await pollOnce(
      { espn, store, poster: { post: async () => ({}) } },
      { dryRun: true, seedSeen: false, allToday: false, persist: false, recentFinalWindowMin: 45 },
    );
    expect(result.missesFound).toBe(0);
    expect(result.tweets).toEqual([]);
  });
});
