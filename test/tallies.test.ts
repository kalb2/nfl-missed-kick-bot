import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { composeTweet } from "../src/compose.js";
import { EspnClient } from "../src/espn.js";
import {
  SeasonTallyIndex,
  collectStartedRegularSeasonEvents,
  formatSeasonLine,
  kickerKeys,
  normalizeKickerName,
  weeksToScan,
} from "../src/tallies.js";
import type { GameSummary, MissedKick, Scoreboard, ScoreboardEvent } from "../src/types.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function loadFixture(name: string): GameSummary {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), "utf8")) as GameSummary;
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function liveEvent(
  id: string,
  shortName: string,
  state: "in" | "post" | "pre" = "post",
): ScoreboardEvent {
  return {
    id,
    shortName,
    date: new Date().toISOString(),
    season: { year: 2026, type: 2 },
    status: { type: { state, completed: state === "post" } },
    competitions: [],
  };
}

function board(events: ScoreboardEvent[], week = 1): Scoreboard {
  return { events, season: { year: 2026, type: 2 }, week: { number: week } };
}

function mockEspn(
  summaries: Record<string, GameSummary>,
  events: ScoreboardEvent[],
  weekBoards: Record<number, ScoreboardEvent[]> = {},
): { espn: EspnClient; summaryCalls: string[] } {
  const summaryCalls: string[] = [];
  const espn = {
    concurrency: 2,
    getScoreboard: async (query?: { week?: number }) => {
      if (query?.week !== undefined && weekBoards[query.week]) {
        return board(weekBoards[query.week], query.week);
      }
      return board(events);
    },
    getSummary: async (eventId: string) => {
      summaryCalls.push(eventId);
      const summary = summaries[eventId];
      if (!summary) throw new Error(`unexpected event ${eventId}`);
      return summary;
    },
  } as unknown as EspnClient;
  return { espn, summaryCalls };
}

const carlsonMiss = {
  playId: "4018729234815",
  kickType: "FG" as const,
  kicker: "D.Carlson",
  teamAbbr: "NO",
};

describe("kicker identity", () => {
  it("normalizes dotted initials so D.Carlson and D Carlson match", () => {
    expect(normalizeKickerName("D.Carlson")).toBe("dcarlson");
    expect(normalizeKickerName("D. Carlson")).toBe("dcarlson");
  });

  it("prefers athlete id and still aliases name+team", () => {
    expect(kickerKeys({ ...carlsonMiss, athleteId: "3051909" })).toEqual([
      "id:3051909",
      "name:dcarlson|NO",
    ]);
    expect(kickerKeys(carlsonMiss)).toEqual(["name:dcarlson|NO"]);
  });
});

describe("weeksToScan", () => {
  it("scans regular-season weeks 1..current only", () => {
    expect(weeksToScan({ season: { type: 2, year: 2026 }, week: { number: 3 } })).toEqual([1, 2, 3]);
  });

  it("scans all 18 regular-season weeks once the postseason starts", () => {
    expect(weeksToScan({ season: { type: 3, year: 2026 }, week: { number: 2 } })).toHaveLength(18);
  });

  it("does not scan regular-season weeks during the preseason", () => {
    expect(weeksToScan({ season: { type: 1, year: 2026 }, week: { number: 3 } })).toEqual([]);
  });
});

describe("collectStartedRegularSeasonEvents", () => {
  it("reuses the current week board and fetches prior regular-season weeks", async () => {
    const week2 = [liveEvent("week2-a", "NO @ DET", "in")];
    const week1 = [liveEvent("week1-a", "NYJ @ TEN", "post"), liveEvent("week1-pre", "DAL @ NYG", "pre")];
    const queries: Array<number | undefined> = [];
    const espn = {
      concurrency: 2,
      getScoreboard: async (query?: { week?: number }) => {
        queries.push(query?.week);
        if (query?.week === 1) return board(week1, 1);
        return board(week2, 2);
      },
      getSummary: async () => ({}),
    } as unknown as EspnClient;

    const events = await collectStartedRegularSeasonEvents(espn, board(week2, 2));
    expect(queries).toEqual([1]);
    expect(events.map((e) => e.id).sort()).toEqual(["week1-a", "week2-a"]);
  });
});

describe("SeasonTallyIndex", () => {
  it("aggregates FG and PAT misses per kicker, inclusive of the current play", async () => {
    const carlson = loadFixture("fg-missed-carlson.json");
    const shrader = loadFixture("pat-missed-shrader.json");
    const { espn } = mockEspn(
      { "401872923": carlson, "401872659": shrader },
      [liveEvent("401872923", "NO @ DET"), liveEvent("401872659", "BAL @ IND")],
    );
    const index = new SeasonTallyIndex();
    await index.refresh(espn, board([liveEvent("401872923", "NO @ DET"), liveEvent("401872659", "BAL @ IND")]));

    const carlsonCounts = index.countsFor({ ...carlsonMiss } as MissedKick);
    expect(carlsonCounts).toEqual({ fg: 1, pat: 0 });
    expect(formatSeasonLine(carlsonCounts.fg, carlsonCounts.pat)).toBe("Season: 1 missed FG · 0 missed PAT");

    const shraderCounts = index.countsFor({
      playId: "401872659257",
      kickType: "PAT",
      kicker: "S.Shrader",
      teamAbbr: "IND",
    } as MissedKick);
    expect(shraderCounts).toEqual({ fg: 0, pat: 1 });
    expect(formatSeasonLine(shraderCounts.fg, shraderCounts.pat)).toBe("Season: 0 missed FG · 1 missed PAT");
  });

  it("merges athlete-id and name+team keys so site and core feeds count as one kicker", async () => {
    const named = loadFixture("fg-missed-carlson.json");
    const withId: GameSummary = JSON.parse(JSON.stringify(named));
    const play = withId.drives?.previous?.[0]?.plays?.[0];
    if (play) {
      play.id = "401872923-second";
      play.participants = [{ type: "kicker", athlete: { id: "3051909" } }];
    }
    const { espn } = mockEspn(
      { "401872923": named, "401872999": withId },
      [liveEvent("401872923", "NO @ DET"), liveEvent("401872999", "NO @ ATL")],
    );
    const index = new SeasonTallyIndex();
    await index.refresh(
      espn,
      board([liveEvent("401872923", "NO @ DET"), liveEvent("401872999", "NO @ ATL")]),
    );

    expect(
      index.countsFor({
        playId: "401872923-second",
        kickType: "FG",
        kicker: "D.Carlson",
        teamAbbr: "NO",
        athleteId: "3051909",
      } as MissedKick),
    ).toEqual({ fg: 2, pat: 0 });
    expect(index.countsFor({ ...carlsonMiss } as MissedKick)).toEqual({ fg: 2, pat: 0 });
  });

  it("includes the current miss when that play is not yet in the index", () => {
    const index = new SeasonTallyIndex();
    expect(index.countsFor({ ...carlsonMiss } as MissedKick)).toEqual({ fg: 1, pat: 0 });
  });

  it("does not refetch completed games already parsed in this process", async () => {
    const carlson = loadFixture("fg-missed-carlson.json");
    const events = [liveEvent("401872923", "NO @ DET", "post")];
    const { espn, summaryCalls } = mockEspn({ "401872923": carlson }, events);
    const index = new SeasonTallyIndex();
    await index.refresh(espn, board(events));
    await index.refresh(espn, board(events));
    expect(summaryCalls).toEqual(["401872923"]);
  });

  it("refetches in-progress games so a new miss is counted", async () => {
    const empty: GameSummary = { header: { id: "401872923" }, drives: { previous: [] } };
    const carlson = loadFixture("fg-missed-carlson.json");
    const events = [liveEvent("401872923", "NO @ DET", "in")];
    let n = 0;
    const espn = {
      concurrency: 2,
      getScoreboard: async () => board(events),
      getSummary: async () => {
        n += 1;
        return n === 1 ? empty : carlson;
      },
    } as unknown as EspnClient;
    const index = new SeasonTallyIndex();
    await index.refresh(espn, board(events));
    expect(index.countsFor({ ...carlsonMiss } as MissedKick)).toEqual({ fg: 1, pat: 0 });
    await index.refresh(espn, board(events));
    expect(index.countsFor({ ...carlsonMiss } as MissedKick)).toEqual({ fg: 1, pat: 0 });
    expect(n).toBe(2);
  });

  it("persists completed-game parses and rebuilds from ESPN when the cache file is missing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tallies-"));
    dirs.push(dir);
    const file = path.join(dir, "tallies.json");
    const carlson = loadFixture("fg-missed-carlson.json");
    const events = [liveEvent("401872923", "NO @ DET", "post")];
    const { espn, summaryCalls } = mockEspn({ "401872923": carlson }, events);

    const first = new SeasonTallyIndex(file);
    await first.refresh(espn, board(events));
    await first.save();
    expect(first.leaderboard()).toEqual([{ kicker: "D.Carlson", teamAbbr: "NO", fg: 1, pat: 0 }]);

    const second = new SeasonTallyIndex(file);
    await second.load();
    await second.refresh(espn, board(events));
    expect(second.countsFor({ ...carlsonMiss } as MissedKick)).toEqual({ fg: 1, pat: 0 });
    expect(summaryCalls).toEqual(["401872923"]);

    const rebuilt = new SeasonTallyIndex(path.join(dir, "missing", "tallies.json"));
    await rebuilt.load();
    const { espn: espn2, summaryCalls: calls2 } = mockEspn({ "401872923": carlson }, events);
    await rebuilt.refresh(espn2, board(events));
    expect(calls2).toEqual(["401872923"]);
    expect(rebuilt.countsFor({ ...carlsonMiss } as MissedKick)).toEqual({ fg: 1, pat: 0 });
  });

  it("attaches inclusive season counts that composeTweet prints", async () => {
    const carlson = loadFixture("fg-missed-carlson.json");
    const { espn } = mockEspn({ "401872923": carlson }, [liveEvent("401872923", "NO @ DET")]);
    const index = new SeasonTallyIndex();
    await index.refresh(espn, board([liveEvent("401872923", "NO @ DET")]));
    const miss: MissedKick = {
      playId: "4018729234815",
      kickType: "FG",
      kicker: "D.Carlson",
      teamAbbr: "NO",
      teamName: "New Orleans Saints",
      distance: 62,
      result: "Wide Right",
      quarter: "Q4",
      clock: "0:02",
      awayAbbr: "NO",
      homeAbbr: "DET",
      awayScore: 24,
      homeScore: 24,
      matchup: "NO @ DET",
      playText: "D.Carlson 62 yard field goal is No Good, Wide Right.",
    };
    index.attachTo(miss);
    const tweet = composeTweet(miss);
    expect(tweet).toContain("Season: 1 missed FG · 0 missed PAT");
    expect(miss.seasonFgMisses).toBe(1);
    expect(miss.seasonPatMisses).toBe(0);
  });
});
