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
    expect(first.newMisses.map((m) => m.kicker).sort()).toEqual(["Daniel Carlson", "Spencer Shrader"]);
    expect(posted).toHaveLength(2);
    expect(posted).toContain(composeTweet(first.newMisses.find((m) => m.kicker === "Daniel Carlson")!));
    expect(first.newMisses.find((m) => m.kicker === "Daniel Carlson")?.seasonFgMisses).toBe(1);
    expect(first.newMisses.find((m) => m.kicker === "Daniel Carlson")?.seasonPatMisses).toBe(0);
    expect(first.newMisses.find((m) => m.kicker === "Spencer Shrader")?.seasonFgMisses).toBe(0);
    expect(first.newMisses.find((m) => m.kicker === "Spencer Shrader")?.seasonPatMisses).toBe(1);
    expect(posted.find((t) => t.includes("Daniel Carlson"))).toContain("Season: 1 missed FG · 0 missed PAT");
    expect(posted.find((t) => t.includes("Spencer Shrader"))).toContain("Season: 0 missed FG · 1 missed PAT");
    expect(first.seasonTallies).toEqual(
      expect.arrayContaining([
        { kicker: "Daniel Carlson", teamAbbr: "NO", fg: 1, pat: 0 },
        { kicker: "Spencer Shrader", teamAbbr: "IND", fg: 0, pat: 1 },
      ]),
    );

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

  it("exits after the scoreboard when no game is in the watch window", async () => {
    let scoreboardCalls = 0;
    let summaryCalls = 0;
    const espn = {
      concurrency: 2,
      getScoreboard: async (query?: { week?: number }) => {
        scoreboardCalls += 1;
        if (query?.week !== undefined) {
          throw new Error("weekly scoreboard should not run on idle cron");
        }
        return {
          season: { type: 2, year: 2026 },
          week: { number: 3 },
          events: [
            {
              id: "pre-only",
              shortName: "KC @ BUF",
              date: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
              status: { type: { state: "pre", name: "STATUS_SCHEDULED", completed: false } },
              competitions: [],
            },
          ],
        };
      },
      getSummary: async () => {
        summaryCalls += 1;
        throw new Error("summary should not run on idle scoreboard");
      },
    } as unknown as EspnClient;

    const result = await pollOnce(
      { espn, store: new SeenStore(path.join(os.tmpdir(), "unused-seen.json")), poster: { post: async () => ({}) } },
      { dryRun: true, seedSeen: false, allToday: false, persist: false, recentFinalWindowMin: 45 },
    );

    expect(result.gamesScanned).toBe(0);
    expect(result.tweets).toEqual([]);
    expect(scoreboardCalls).toBe(1);
    expect(summaryCalls).toBe(0);
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
