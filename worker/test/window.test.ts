import { describe, expect, it } from "vitest";
import { testConfig } from "../src/config.js";
import type { Slate, StoredGame } from "../src/types.js";
import {
  gamesInWindow,
  hasRemainingKickoff,
  isInLiveWindow,
  nextKickoffIso,
  parseSlate,
  shouldDispatch,
  shouldRefreshSlate,
} from "../src/window.js";

const PRE = 30 * 60_000;
const POST = 285 * 60_000;

function game(id: string, kickoff: string, name = id): StoredGame {
  return { id, kickoff, name, week: 2, seasonType: 2 };
}

describe("isInLiveWindow", () => {
  const kickoff = Date.parse("2026-11-26T18:00:00.000Z");

  it("is false more than 30 minutes before kickoff", () => {
    expect(isInLiveWindow("2026-11-26T18:00:00.000Z", kickoff - 31 * 60_000, PRE, POST)).toBe(false);
  });

  it("is true 15–30 minutes before kickoff", () => {
    expect(isInLiveWindow("2026-11-26T18:00:00.000Z", kickoff - 30 * 60_000, PRE, POST)).toBe(true);
    expect(isInLiveWindow("2026-11-26T18:00:00.000Z", kickoff - 15 * 60_000, PRE, POST)).toBe(true);
  });

  it("is true through kickoff + 4h + 45m and false after", () => {
    expect(isInLiveWindow("2026-11-26T18:00:00.000Z", kickoff + 4 * 60 * 60_000, PRE, POST)).toBe(true);
    expect(isInLiveWindow("2026-11-26T18:00:00.000Z", kickoff + POST, PRE, POST)).toBe(true);
    expect(isInLiveWindow("2026-11-26T18:00:00.000Z", kickoff + POST + 1, PRE, POST)).toBe(false);
  });
});

describe("holiday and flex kickoffs (weekday crons cannot cover these)", () => {
  const config = testConfig();

  it("wakes for Thanksgiving Thursday 2026, not only Sunday", () => {
    const slate = [
      game("thx-det", "2026-11-26T18:00:00.000Z", "CHI @ DET"),
      game("thx-dal", "2026-11-26T21:30:00.000Z", "PHI @ DAL"),
      game("sun", "2026-11-29T18:00:00.000Z", "NO @ CIN"),
    ];
    const thanksgivingNoonUtc = Date.parse("2026-11-26T18:05:00.000Z");
    const live = gamesInWindow(slate, thanksgivingNoonUtc, config);
    expect(live.map((row) => row.name)).toEqual(["CHI @ DET"]);
    expect(new Date(thanksgivingNoonUtc).getUTCDay()).toBe(4);
  });

  it("wakes for Christmas Day 2026 Friday games", () => {
    const slate = [
      game("xmas-chi", "2026-12-25T18:00:00.000Z", "GB @ CHI"),
      game("xmas-den", "2026-12-25T21:30:00.000Z", "BUF @ DEN"),
    ];
    const christmas = Date.parse("2026-12-25T18:10:00.000Z");
    expect(new Date(christmas).getUTCDay()).toBe(5);
    expect(gamesInWindow(slate, christmas, config).map((row) => row.name)).toEqual(["GB @ CHI"]);
  });

  it("does nothing on a random Wednesday with no stored kickoff", () => {
    const slate = [game("sun", "2026-11-29T18:00:00.000Z", "NO @ CIN")];
    const wednesday = Date.parse("2026-11-25T18:00:00.000Z");
    expect(gamesInWindow(slate, wednesday, config)).toEqual([]);
  });
});

describe("shouldRefreshSlate", () => {
  const config = testConfig();
  const now = Date.parse("2026-09-18T16:00:00.000Z");

  function slate(partial: Partial<Slate> & Pick<Slate, "games">): Slate {
    return {
      refreshedAt: new Date(now - 60 * 60_000).toISOString(),
      source: "espn-scoreboard",
      ...partial,
    };
  }

  it("refreshes when KV is empty", () => {
    expect(shouldRefreshSlate(undefined, now, config)).toEqual({ refresh: true, reason: "slate-empty" });
  });

  it("refreshes when older than 7 days", () => {
    const stored = slate({
      refreshedAt: new Date(now - 8 * 24 * 3_600_000).toISOString(),
      games: [game("1", "2026-09-20T17:00:00.000Z")],
    });
    expect(shouldRefreshSlate(stored, now, config).reason).toBe("slate-stale");
  });

  it("refreshes when the next kickoff is gone and backoff elapsed", () => {
    const stored = slate({
      refreshedAt: new Date(now - 7 * 3_600_000).toISOString(),
      games: [game("old", "2026-09-14T17:00:00.000Z")],
    });
    expect(shouldRefreshSlate(stored, now, config)).toEqual({
      refresh: true,
      reason: "next-kickoff-missing",
    });
  });

  it("does not ESPN-refresh every idle tick when the next kickoff is only recently missing", () => {
    const stored = slate({
      refreshedAt: new Date(now - 30 * 60_000).toISOString(),
      games: [game("old", "2026-09-14T17:00:00.000Z")],
    });
    expect(shouldRefreshSlate(stored, now, config)).toEqual({
      refresh: false,
      reason: "next-kickoff-missing-backoff",
    });
  });

  it("leaves a fresh slate with a future kickoff alone", () => {
    const stored = slate({
      games: [game("1", "2026-09-20T17:00:00.000Z")],
    });
    expect(shouldRefreshSlate(stored, now, config)).toEqual({ refresh: false, reason: "slate-fresh" });
  });
});

describe("shouldDispatch", () => {
  const now = Date.parse("2026-09-18T16:00:00.000Z");
  const cooldown = 5 * 60_000;

  it("allows the first wake and then dedupes for 5 minutes", () => {
    expect(shouldDispatch(undefined, now, cooldown).dispatch).toBe(true);
    expect(shouldDispatch(new Date(now - 4 * 60_000).toISOString(), now, cooldown)).toEqual({
      dispatch: false,
      reason: "dispatch-cooldown",
    });
    expect(shouldDispatch(new Date(now - 5 * 60_000).toISOString(), now, cooldown).dispatch).toBe(true);
  });
});

describe("helpers", () => {
  it("parses a compact slate and finds the next kickoff", () => {
    const raw = JSON.stringify({
      refreshedAt: "2026-09-18T00:00:00.000Z",
      source: "espn-scoreboard",
      games: [
        { id: "1", kickoff: "2026-09-18T00:15:00.000Z", name: "DET @ BUF" },
        { id: "2", kickoff: "2026-09-20T17:00:00.000Z", name: "CAR @ ATL" },
      ],
    });
    const slate = parseSlate(raw);
    expect(slate?.games).toHaveLength(2);
    const now = Date.parse("2026-09-18T16:00:00.000Z");
    expect(nextKickoffIso(slate!.games, now)).toBe("2026-09-20T17:00:00.000Z");
    expect(hasRemainingKickoff(slate!.games, now, POST)).toBe(true);
  });
});
