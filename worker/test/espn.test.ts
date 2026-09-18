import { describe, expect, it } from "vitest";
import christmas from "./fixtures/christmas-week16.json";
import week2 from "./fixtures/scoreboard-week2.json";
import thanksgiving from "./fixtures/thanksgiving-week12.json";
import {
  extractCalendarWeeks,
  extractGames,
  gamesInHorizon,
  mergeGames,
  weeksOverlappingRange,
  withScoreboardQuery,
} from "../src/espn.js";

describe("extractGames", () => {
  it("normalizes week-2 kickoffs to UTC ISO", () => {
    const games = extractGames(week2);
    expect(games.length).toBeGreaterThan(0);
    expect(games[0]).toMatchObject({
      id: "401872932",
      name: "DET @ BUF",
      kickoff: "2026-09-18T00:15:00.000Z",
      week: 2,
      seasonType: 2,
    });
  });

  it("keeps Thanksgiving Thursday and Christmas Friday kickoffs", () => {
    const thx = extractGames(thanksgiving);
    expect(thx.map((game) => game.name)).toContain("CHI @ DET");
    expect(thx.find((game) => game.name === "CHI @ DET")?.kickoff).toBe("2026-11-26T18:00:00.000Z");

    const xmas = extractGames(christmas);
    expect(xmas.map((game) => game.name)).toEqual(["HOU @ PHI", "GB @ CHI", "BUF @ DEN"]);
  });
});

describe("calendar weeks", () => {
  it("reads ESPN leagues[].calendar and selects overlapping weeks", () => {
    const weeks = extractCalendarWeeks(week2);
    expect(weeks.some((week) => week.label === "Week 2" && week.seasonType === 2)).toBe(true);
    expect(weeks.some((week) => week.label === "Wild Card")).toBe(true);
    expect(weeks.every((week) => week.seasonType !== 4)).toBe(true);

    const now = Date.parse("2026-09-18T16:00:00.000Z");
    const overlap = weeksOverlappingRange(weeks, now, now + 16 * 24 * 3_600_000);
    expect(overlap.map((week) => week.week)).toEqual([2, 3, 4]);
  });
});

describe("merge + query", () => {
  it("dedupes by event id and adds scoreboard query params", () => {
    const merged = mergeGames([extractGames(thanksgiving), extractGames(thanksgiving)]);
    expect(merged.filter((game) => game.id === "thx-det")).toHaveLength(1);
    expect(
      withScoreboardQuery("https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard", {
        seasonType: 2,
        week: 12,
      }),
    ).toContain("seasontype=2");
  });

  it("drops current-board leftovers that are outside overlapping calendar weeks", () => {
    const now = Date.parse("2026-11-26T18:05:00.000Z");
    const weeks = weeksOverlappingRange(extractCalendarWeeks(week2), now, now + 16 * 24 * 3_600_000);
    const merged = mergeGames([extractGames(week2), extractGames(thanksgiving)]);
    const horizon = gamesInHorizon(merged, weeks, now, 16 * 24 * 3_600_000, 285 * 60_000);
    expect(horizon.some((game) => game.name === "CHI @ DET")).toBe(true);
    expect(horizon.some((game) => game.name === "DET @ BUF")).toBe(false);
  });
});
