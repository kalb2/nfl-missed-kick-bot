import { describe, expect, it } from "vitest";
import { testConfig } from "../src/config.js";
import { REFRESH_CRONS, TICK_CRONS } from "../src/cron.js";
import { handleScheduled, runRefreshOnly, runTick } from "../src/scheduler.js";
import type { Slate, SlateStore, StoredGame } from "../src/types.js";
import { LAST_DISPATCH_KEY, SLATE_KEY } from "../src/types.js";
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
          return new Response(JSON.stringify(week2), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
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

  it("routes handleScheduled by cron expression", async () => {
    const kv = new MemoryKV();
    seedSlate(
      kv,
      [storedGame({ id: "thx-det", kickoff: "2026-11-26T18:00:00.000Z", name: "CHI @ DET" })],
      "2026-11-26T00:00:00.000Z",
    );
    const now = Date.parse("2026-11-26T18:05:00.000Z");
    const deps = {
      kv,
      config: testConfig(),
      github: {
        dispatch: async () => undefined,
      },
    };
    const refresh = await handleScheduled(REFRESH_CRONS[0], deps, now);
    expect(refresh.action).toBe("idle");
    expect(refresh.reason.startsWith("refresh-cron;")).toBe(true);

    const tick = await handleScheduled(TICK_CRONS[0], deps, now);
    expect(tick.action).toBe("dispatched");
  });
});
