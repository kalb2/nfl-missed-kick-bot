import { describe, expect, it } from "vitest";
import { testConfig } from "../src/config.js";
import { REFRESH_CRONS, TICK_CRONS } from "../src/cron.js";
import { GitHubDispatchError } from "../src/github.js";
import { handleScheduled, runRefreshOnly, runTick } from "../src/scheduler.js";
import type { Slate, SlateStore, StoredGame } from "../src/types.js";
import { LAST_DISPATCH_ERROR_KEY, LAST_DISPATCH_KEY, LAST_REFRESH_ATTEMPT_KEY, LAST_REFRESH_ERROR_KEY, SLATE_KEY } from "../src/types.js";
import week2 from "./fixtures/scoreboard-week2.json";

class MemoryKV implements SlateStore {
  readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
}

function storedGame(partial: StoredGame): StoredGame {
  return partial;
}

function scoreboard(games: Array<{ id: string; kickoff: string; name: string }>): string {
  return JSON.stringify({
    events: games.map((game) => ({
      id: game.id,
      date: game.kickoff,
      name: game.name,
      shortName: game.name,
    })),
    leagues: [],
  });
}

function seedSlate(kv: MemoryKV, games: StoredGame[], refreshedAt: string): void {
  const slate: Slate = { refreshedAt, source: "espn-scoreboard", games };
  kv.map.set(SLATE_KEY, JSON.stringify(slate));
}

describe("runTick", () => {
  it("idles with zero ESPN calls and zero GitHub calls when the slate has no live game", async () => {
    const kv = new MemoryKV();
    seedSlate(
      kv,
      [storedGame({ id: "1", kickoff: "2026-09-20T17:00:00.000Z", name: "CAR @ ATL" })],
      "2026-09-18T12:00:00.000Z",
    );
    const dispatches: unknown[] = [];
    const result = await runTick(
      {
        kv,
        config: testConfig(),
        fetchImpl: async () => {
          throw new Error("ESPN should not be called on a fresh idle tick");
        },
        github: {
          dispatch: async (input) => {
            dispatches.push(input);
          },
        },
      },
      Date.parse("2026-09-18T16:00:00.000Z"),
    );
    expect(result.action).toBe("idle");
    expect(result.espnCalls).toBe(0);
    expect(dispatches).toEqual([]);
  });

  it("dispatches repository_dispatch when a stored kickoff is in window", async () => {
    const kv = new MemoryKV();
    seedSlate(
      kv,
      [storedGame({ id: "thx-det", kickoff: "2026-11-26T18:00:00.000Z", name: "CHI @ DET" })],
      "2026-11-26T00:00:00.000Z",
    );
    const dispatches: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
    const result = await runTick(
      {
        kv,
        config: testConfig(),
        fetchImpl: async () => {
          throw new Error("ESPN should not be called when the slate is fresh");
        },
        github: {
          dispatch: async (input) => {
            dispatches.push({ eventType: input.eventType, payload: input.payload });
          },
        },
      },
      Date.parse("2026-11-26T18:05:00.000Z"),
    );
    expect(result.action).toBe("dispatched");
    expect(result.espnCalls).toBe(0);
    expect(dispatches[0]?.eventType).toBe("nfl-poll");
    expect(kv.map.get(LAST_DISPATCH_KEY)).toBe("2026-11-26T18:05:00.000Z");
  });

  it("returns no-token without calling GitHub when GITHUB_TOKEN is empty", async () => {
    const kv = new MemoryKV();
    seedSlate(
      kv,
      [storedGame({ id: "thx-det", kickoff: "2026-11-26T18:00:00.000Z", name: "CHI @ DET" })],
      "2026-11-26T00:00:00.000Z",
    );
    let calls = 0;
    const result = await runTick(
      {
        kv,
        config: testConfig({ githubToken: "" }),
        github: {
          dispatch: async () => {
            calls += 1;
          },
        },
      },
      Date.parse("2026-11-26T18:05:00.000Z"),
    );
    expect(result.action).toBe("no-token");
    expect(result.reason).toBe("missing-github-token");
    expect(calls).toBe(0);
    expect(kv.map.get(LAST_DISPATCH_KEY)).toBeUndefined();
  });

  it("returns dispatch-failed with the GitHub status instead of throwing", async () => {
    const kv = new MemoryKV();
    seedSlate(
      kv,
      [storedGame({ id: "thx-det", kickoff: "2026-11-26T18:00:00.000Z", name: "CHI @ DET" })],
      "2026-11-26T00:00:00.000Z",
    );
    const result = await runTick(
      {
        kv,
        config: testConfig(),
        github: {
          dispatch: async () => {
            throw new GitHubDispatchError(
              401,
              '{"message":"Bad credentials","documentation_url":"https://docs.github.com/rest","status":"401"}',
            );
          },
        },
      },
      Date.parse("2026-11-26T18:05:00.000Z"),
    );
    expect(result.action).toBe("dispatch-failed");
    expect(result.githubStatus).toBe(401);
    expect(result.reason).toContain("GitHub dispatch 401");
    expect(result.reason).toContain("Bad credentials");
    expect(kv.map.get(LAST_DISPATCH_KEY)).toBeUndefined();
    expect(kv.map.get(LAST_DISPATCH_ERROR_KEY)).toContain("Bad credentials");
  });

  it("skips a second wake inside the 5-minute cooldown", async () => {
    const kv = new MemoryKV();
    seedSlate(
      kv,
      [storedGame({ id: "thx-det", kickoff: "2026-11-26T18:00:00.000Z", name: "CHI @ DET" })],
      "2026-11-26T00:00:00.000Z",
    );
    kv.map.set(LAST_DISPATCH_KEY, "2026-11-26T18:03:00.000Z");
    let calls = 0;
    const result = await runTick(
      {
        kv,
        config: testConfig(),
        github: {
          dispatch: async () => {
            calls += 1;
          },
        },
      },
      Date.parse("2026-11-26T18:06:00.000Z"),
    );
    expect(result.action).toBe("cooldown");
    expect(calls).toBe(0);
  });

  it("refreshes from ESPN when KV is empty, then idles if those games are not live", async () => {
    const kv = new MemoryKV();
    let espnHits = 0;
    const result = await runTick(
      {
        kv,
        config: testConfig({ lookaheadMs: 0 }),
        fetchImpl: async () => {
          espnHits += 1;
          return new Response(JSON.stringify(week2), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
        github: {
          dispatch: async () => {
            throw new Error("should not dispatch");
          },
        },
      },
      Date.parse("2026-09-18T16:00:00.000Z"),
    );
    expect(result.refreshed).toBe(true);
    expect(result.espnCalls).toBeGreaterThan(0);
    expect(espnHits).toBeGreaterThan(0);
    expect(result.action).toBe("idle");
    expect(kv.map.get(SLATE_KEY)).toContain("DET @ BUF");
  });
});

describe("refresh-only cron", () => {
  it("refreshes a stale slate and never dispatches even if a game is live", async () => {
    const kv = new MemoryKV();
    seedSlate(
      kv,
      [storedGame({ id: "thx-det", kickoff: "2026-11-26T18:00:00.000Z", name: "CHI @ DET" })],
      "2026-11-18T00:00:00.000Z",
    );
    let espnHits = 0;
    let dispatches = 0;
    const result = await runRefreshOnly(
      {
        kv,
        config: testConfig(),
        fetchImpl: async () => {
          espnHits += 1;
          return new Response(
            scoreboard([{ id: "thx-det", kickoff: "2026-11-26T18:00:00.000Z", name: "CHI @ DET" }]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        },
        github: {
          dispatch: async () => {
            dispatches += 1;
          },
        },
      },
      Date.parse("2026-11-26T18:05:00.000Z"),
    );
    expect(result.action).toBe("idle");
    expect(result.reason.startsWith("refresh-cron;")).toBe(true);
    expect(result.live).toEqual([]);
    expect(result.refreshed).toBe(true);
    expect(espnHits).toBeGreaterThan(0);
    expect(dispatches).toBe(0);
  });

  it("refreshes a fresh slate that still has future kickoffs (Tue/Wed cron must not no-op)", async () => {
    const kv = new MemoryKV();
    // Live status on 2026-11-03T21:30Z still showed this Sunday refresh.
    seedSlate(
      kv,
      [storedGame({ id: "tnf", kickoff: "2026-11-06T01:15:00.000Z", name: "LV @ DEN" })],
      "2026-11-01T17:44:10.000Z",
    );
    let espnHits = 0;
    let dispatches = 0;
    const now = Date.parse("2026-11-03T15:00:00.000Z");
    const result = await handleScheduled(
      REFRESH_CRONS[0],
      {
        kv,
        config: testConfig(),
        fetchImpl: async () => {
          espnHits += 1;
          return new Response(
            scoreboard([{ id: "tnf", kickoff: "2026-11-06T01:15:00.000Z", name: "LV @ DEN" }]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        },
        github: {
          dispatch: async () => {
            dispatches += 1;
          },
        },
      },
      now,
    );
    expect(result.action).toBe("idle");
    expect(result.refreshed).toBe(true);
    expect(result.reason).toContain("refresh-cron;forced");
    expect(espnHits).toBeGreaterThan(0);
    expect(dispatches).toBe(0);
    const saved = JSON.parse(kv.map.get(SLATE_KEY) ?? "{}") as { refreshedAt?: string };
    expect(saved.refreshedAt).toBe("2026-11-03T15:00:00.000Z");
    expect(kv.map.get(LAST_REFRESH_ERROR_KEY) ?? "").toBe("");
  });

  it("keeps the previous slate when ESPN returns no games", async () => {
    const kv = new MemoryKV();
    seedSlate(
      kv,
      [storedGame({ id: "tnf", kickoff: "2026-11-06T01:15:00.000Z", name: "LV @ DEN" })],
      "2026-11-01T17:44:10.000Z",
    );
    const result = await runRefreshOnly(
      {
        kv,
        config: testConfig(),
        fetchImpl: async () =>
          new Response(JSON.stringify({ events: [], leagues: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        github: { dispatch: async () => undefined },
      },
      Date.parse("2026-11-03T15:00:00.000Z"),
    );
    expect(result.refreshed).toBe(false);
    expect(result.reason).toContain("refresh-failed");
    expect(kv.map.get(SLATE_KEY)).toContain("LV @ DEN");
    expect(kv.map.get(LAST_REFRESH_ERROR_KEY)).toMatch(/no games/i);
  });

  it("still dispatches from the old slate when a dense-tick refresh fails", async () => {
    const kv = new MemoryKV();
    seedSlate(
      kv,
      [storedGame({ id: "thx-det", kickoff: "2026-11-26T18:00:00.000Z", name: "CHI @ DET" })],
      "2026-11-18T00:00:00.000Z",
    );
    let dispatches = 0;
    const result = await runTick(
      {
        kv,
        config: testConfig(),
        fetchImpl: async () => {
          throw new Error("ESPN 503");
        },
        github: {
          dispatch: async () => {
            dispatches += 1;
          },
        },
      },
      Date.parse("2026-11-26T18:05:00.000Z"),
    );
    expect(result.action).toBe("dispatched");
    expect(dispatches).toBe(1);
    expect(result.reason).toContain("refresh-failed");
    expect(kv.map.get(SLATE_KEY)).toContain("CHI @ DET");
    expect(kv.map.get(LAST_REFRESH_ERROR_KEY)).toContain("ESPN 503");
  });

  it("does not call ESPN every tick after a failed refresh", async () => {
    const kv = new MemoryKV();
    seedSlate(
      kv,
      [storedGame({ id: "sun", kickoff: "2026-11-08T18:00:00.000Z", name: "NO @ CIN" })],
      "2026-11-01T17:44:10.000Z",
    );
    kv.map.set(LAST_REFRESH_ERROR_KEY, "ESPN 503");
    kv.map.set(LAST_REFRESH_ATTEMPT_KEY, "2026-11-05T15:00:00.000Z");
    let espnHits = 0;
    const result = await runTick(
      {
        kv,
        config: testConfig(),
        fetchImpl: async () => {
          espnHits += 1;
          throw new Error("ESPN should be in backoff");
        },
        github: { dispatch: async () => undefined },
      },
      Date.parse("2026-11-05T16:00:00.000Z"),
    );
    expect(result.action).toBe("idle");
    expect(result.reason).toBe("refresh-backoff");
    expect(espnHits).toBe(0);
  });

  it("routes handleScheduled by cron expression", async () => {
    const now = Date.parse("2026-11-26T18:05:00.000Z");
    const refreshKv = new MemoryKV();
    seedSlate(
      refreshKv,
      [storedGame({ id: "thx-det", kickoff: "2026-11-26T18:00:00.000Z", name: "CHI @ DET" })],
      "2026-11-26T00:00:00.000Z",
    );
    let refreshDispatches = 0;
    const refresh = await handleScheduled(
      REFRESH_CRONS[0],
      {
        kv: refreshKv,
        config: testConfig(),
        fetchImpl: async () =>
          new Response(
            scoreboard([{ id: "thx-det", kickoff: "2026-11-26T18:00:00.000Z", name: "CHI @ DET" }]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        github: {
          dispatch: async () => {
            refreshDispatches += 1;
          },
        },
      },
      now,
    );
    expect(refresh.action).toBe("idle");
    expect(refresh.refreshed).toBe(true);
    expect(refresh.reason.startsWith("refresh-cron;")).toBe(true);
    expect(refreshDispatches).toBe(0);

    const tickKv = new MemoryKV();
    seedSlate(
      tickKv,
      [storedGame({ id: "thx-det", kickoff: "2026-11-26T18:00:00.000Z", name: "CHI @ DET" })],
      "2026-11-26T00:00:00.000Z",
    );
    const tick = await handleScheduled(
      TICK_CRONS[0],
      {
        kv: tickKv,
        config: testConfig(),
        github: { dispatch: async () => undefined },
      },
      now,
    );
    expect(tick.action).toBe("dispatched");
  });
});
