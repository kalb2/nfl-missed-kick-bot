import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  athleteIdFromPlay,
  classifyMiss,
  collectPlays,
  detectMissedKicks,
  enrichKickerNames,
  fullNameFromAthlete,
  isExtraPointMiss,
  isFieldGoalMiss,
  parseDistance,
  parseKicker,
  parseResult,
  resolveKickerName,
  toMissedKick,
} from "../src/detect.js";
import type { GameContext, Play } from "../src/types.js";
import type { GameSummary } from "../src/types.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function loadFixture(name: string): GameSummary {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), "utf8")) as GameSummary;
}

function gameFromSummary(summary: GameSummary, shortName: string) {
  return {
    eventId: summary.header?.id || "test",
    shortName,
    competitors: summary.header?.competitions?.[0]?.competitors ?? [],
  };
}

describe("collectPlays", () => {
  it("reads plays from drives.previous", () => {
    const summary = loadFixture("fg-missed-carlson.json");
    const plays = collectPlays(summary);
    expect(plays.map((p) => p.id)).toContain("4018729234815");
  });

  it("reads plays from drives.current", () => {
    const summary = loadFixture("fg-missed-current-drive.json");
    const plays = collectPlays(summary);
    expect(plays).toHaveLength(1);
    expect(plays[0].id).toBe("4018726573620");
  });
});

describe("Field Goal Missed (type.id 60)", () => {
  it("detects Carlson 62 WR from live-shaped ESPN JSON", () => {
    const summary = loadFixture("fg-missed-carlson.json");
    const misses = detectMissedKicks(summary, gameFromSummary(summary, "NO @ DET"));
    expect(misses).toHaveLength(1);
    const miss = misses[0];
    expect(miss.playId).toBe("4018729234815");
    expect(miss.kickType).toBe("FG");
    expect(miss.kicker).toBe("Daniel Carlson");
    expect(miss.athleteId).toBe("3051909");
    expect(miss.teamAbbr).toBe("NO");
    expect(miss.distance).toBe(62);
    expect(miss.result).toBe("Wide Right");
    expect(miss.quarter).toBe("Q4");
    expect(miss.clock).toBe("0:02");
    expect(miss.awayScore).toBe(24);
    expect(miss.homeScore).toBe(24);
    expect(miss.matchup).toBe("NO @ DET");
  });

  it("detects Sanders 54 WL from live-shaped ESPN JSON", () => {
    const summary = loadFixture("fg-missed-sanders.json");
    const misses = detectMissedKicks(summary, gameFromSummary(summary, "NYJ @ TEN"));
    expect(misses).toHaveLength(1);
    const miss = misses[0];
    expect(miss.kicker).toBe("Jason Sanders");
    expect(miss.athleteId).toBe("3124679");
    expect(miss.teamAbbr).toBe("NYJ");
    expect(miss.distance).toBe(54);
    expect(miss.result).toBe("Wide Left");
    expect(miss.quarter).toBe("Q2");
    expect(miss.clock).toBe("2:44");
    expect(miss.awayScore).toBe(10);
    expect(miss.homeScore).toBe(3);
  });

  it("detects a miss sitting only on the current drive", () => {
    const summary = loadFixture("fg-missed-current-drive.json");
    const misses = detectMissedKicks(summary, gameFromSummary(summary, "SF VS LAR"));
    expect(misses).toHaveLength(1);
    expect(misses[0].kicker).toBe("Eddy Pineiro");
    expect(misses[0].athleteId).toBe("4034949");
    expect(misses[0].result).toBe("Hit Right Upright");
    expect(misses[0].teamAbbr).toBe("SF");
  });
});

describe("Extra Point Missed (pointAfterAttempt.id 62)", () => {
  it("detects Shrader PAT WR attached to a rushing TD play", () => {
    const summary = loadFixture("pat-missed-shrader.json");
    const misses = detectMissedKicks(summary, gameFromSummary(summary, "BAL @ IND"));
    expect(misses).toHaveLength(1);
    const miss = misses[0];
    expect(miss.playId).toBe("401872659257");
    expect(miss.kickType).toBe("PAT");
    expect(miss.kicker).toBe("Spencer Shrader");
    expect(miss.athleteId).toBe("4571557");
    expect(miss.teamAbbr).toBe("IND");
    expect(miss.distance).toBeUndefined();
    expect(miss.result).toBe("Wide Right");
    expect(miss.quarter).toBe("Q1");
    expect(miss.clock).toBe("10:33");
    expect(miss.awayScore).toBe(0);
    expect(miss.homeScore).toBe(6);
  });

  it("falls back to play text when pointAfterAttempt is missing", () => {
    const play = {
      id: "text-only-pat",
      type: { id: "67", text: "Passing Touchdown" },
      text: "J.Love pass deep middle to C.Watson for 81 yards, TOUCHDOWN. T.Smack extra point is No Good, Wide Right.",
    };
    expect(isExtraPointMiss(play)).toBe(true);
    expect(classifyMiss(play)).toBe("PAT");
  });

  it("treats Extra Point Missed even when ESPN sets pointAfterAttempt.value to 1", () => {
    const play = {
      id: "401872927531",
      type: { id: "67", text: "Passing Touchdown" },
      text: "J.Love pass deep middle to C.Watson for 81 yards, TOUCHDOWN. T.Smack extra point is No Good, Wide Right.",
      pointAfterAttempt: {
        id: 62,
        text: "Extra Point Missed",
        abbreviation: "Extra Point Missed",
        value: 1,
      },
    };
    expect(isExtraPointMiss(play)).toBe(true);
    expect(classifyMiss(play)).toBe("PAT");
  });

  it("does not treat Extra Point Good or Field Goal Good as misses", () => {
    const summary = loadFixture("extra-point-good.json");
    const plays = collectPlays(summary);
    expect(plays.length).toBeGreaterThanOrEqual(2);
    for (const play of plays) {
      expect(isExtraPointMiss(play)).toBe(false);
      expect(isFieldGoalMiss(play)).toBe(false);
      expect(classifyMiss(play)).toBeNull();
    }
    const misses = detectMissedKicks(summary, gameFromSummary(summary, "TB @ CIN"));
    expect(misses).toEqual([]);
  });
});

describe("athleteIdFromPlay", () => {
  it("reads a kicker athlete id from a core-API $ref", () => {
    expect(
      athleteIdFromPlay({
        id: "4018729234815",
        type: { id: "60", text: "Field Goal Missed" },
        text: "D.Carlson 62 yard field goal is No Good, Wide Right.",
        participants: [
          {
            type: "kicker",
            athlete: {
              $ref: "http://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/2026/athletes/3051909?lang=en&region=us",
            },
          },
        ],
      }),
    ).toBe("3051909");
  });

  it("ignores non-kicker participants on a PAT-on-TD play", () => {
    expect(
      athleteIdFromPlay({
        id: "401872659257",
        type: { id: "68", text: "Rushing Touchdown" },
        text: "J.Taylor right end for 1 yard, TOUCHDOWN. S.Shrader extra point is No Good, Wide Right.",
        participants: [
          { type: "rusher", athlete: { id: "4242335" } },
          { type: "kicker", athlete: { id: 4360236 } },
        ],
      }),
    ).toBe("4360236");
  });
});

describe("parsers", () => {
  it("reads kicker + distance from FG text", () => {
    const text = "D.Carlson 62 yard field goal is No Good, Wide Right, Center-Z.Wood, Holder-R.Wright.";
    expect(parseKicker(text, "FG")).toBe("D.Carlson");
    expect(parseDistance({ text, type: { id: "60" }, statYardage: 62 }, "FG")).toBe(62);
    expect(parseResult(text)).toBe("Wide Right");
  });

  it("reads a spaced initial form from play text as a fallback", () => {
    expect(parseKicker("W. Lutz 51 yard field goal is No Good, Wide Right.", "FG")).toBe("W. Lutz");
  });

  it("reads kicker from PAT text and ignores TD yardage", () => {
    const text = "J.Taylor right end for 1 yard, TOUCHDOWN. S.Shrader extra point is No Good, Wide Right.";
    expect(parseKicker(text, "PAT")).toBe("S.Shrader");
    expect(parseKicker(text, "PAT")).not.toMatch(/TOUCHDOWN|N\.\s*S/);
    expect(parseDistance({ text, statYardage: 1, type: { id: "68" } }, "PAT")).toBeUndefined();
    expect(parseResult(text)).toBe("Wide Right");
  });
});

describe("full kicker names", () => {
  const lutzGame: GameContext = {
    eventId: "lutz",
    shortName: "DEN @ KC",
    competitors: [
      { homeAway: "away", team: { id: "7", abbreviation: "DEN", displayName: "Denver Broncos" } },
      { homeAway: "home", team: { id: "12", abbreviation: "KC", displayName: "Kansas City Chiefs" } },
    ],
  };

  const lutzPlay: Play = {
    id: "lutz-miss",
    type: { id: "60", text: "Field Goal Missed" },
    text: "W. Lutz 51 yard field goal is No Good, Wide Right.",
    teamParticipants: [{ id: "7", type: "offense" }],
    participants: [
      {
        type: "kicker",
        athlete: {
          id: "2985659",
          displayName: "Wil Lutz",
          fullName: "Wil Lutz",
          firstName: "Wil",
          lastName: "Lutz",
        },
      },
    ],
    period: { number: 2 },
    clock: { displayValue: "4:12" },
    statYardage: 51,
  };

  it("prefers participant displayName over play-text initials", () => {
    expect(resolveKickerName(lutzPlay, "FG")).toEqual({
      kicker: "Wil Lutz",
      athleteId: "2985659",
    });
    const miss = toMissedKick(lutzPlay, lutzGame);
    expect(miss?.kicker).toBe("Wil Lutz");
    expect(miss?.athleteId).toBe("2985659");
  });

  it("uses boxscore kicking athletes when the play only has initials", () => {
    const play: Play = {
      id: "text-only",
      type: { id: "60", text: "Field Goal Missed" },
      text: "W. Lutz 51 yard field goal is No Good, Wide Right.",
      teamParticipants: [{ id: "7", type: "offense" }],
    };
    const resolved = resolveKickerName(play, "FG", [
      { id: "2985659", firstName: "Wil", lastName: "Lutz", displayName: "Wil Lutz", fullName: "Wil Lutz" },
    ]);
    expect(resolved).toEqual({ kicker: "Wil Lutz", athleteId: "2985659" });
  });

  it("falls back to play-text initials when no athlete profile is present", () => {
    const play: Play = {
      id: "initials-only",
      type: { id: "60", text: "Field Goal Missed" },
      text: "W. Lutz 51 yard field goal is No Good, Wide Right.",
    };
    expect(resolveKickerName(play, "FG")).toEqual({ kicker: "W. Lutz" });
  });

  it("reads displayName / fullName / first+last from an athlete object", () => {
    expect(fullNameFromAthlete({ displayName: "Wil Lutz" })).toBe("Wil Lutz");
    expect(fullNameFromAthlete({ fullName: "Daniel Carlson" })).toBe("Daniel Carlson");
    expect(fullNameFromAthlete({ firstName: "Spencer", lastName: "Shrader" })).toBe("Spencer Shrader");
    expect(fullNameFromAthlete({ displayName: "W. Lutz", firstName: "Wil", lastName: "Lutz" })).toBe(
      "Wil Lutz",
    );
    expect(fullNameFromAthlete({ displayName: "W. Lutz" })).toBeUndefined();
  });

  it("enriches an initial-style name from the ESPN athlete profile", async () => {
    const miss = toMissedKick(
      {
        id: "core-lutz",
        type: { id: "60", text: "Field Goal Missed" },
        text: "W. Lutz 51 yard field goal is No Good, Wide Right.",
        participants: [{ type: "kicker", athlete: { $ref: "http://sports.core.api.espn.com/v2/sports/football/leagues/nfl/athletes/2985659" } }],
        teamParticipants: [{ id: "7", type: "offense" }],
      },
      lutzGame,
    )!;
    expect(miss.kicker).toBe("W. Lutz");
    expect(miss.athleteId).toBe("2985659");
    await enrichKickerNames(
      {
        getAthlete: async (id: string) => {
          expect(id).toBe("2985659");
          return { id: "2985659", firstName: "Wil", lastName: "Lutz", displayName: "Wil Lutz", fullName: "Wil Lutz" };
        },
      },
      [miss],
    );
    expect(miss.kicker).toBe("Wil Lutz");
  });
});
