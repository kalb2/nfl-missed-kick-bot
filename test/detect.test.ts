import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  classifyMiss,
  collectPlays,
  detectMissedKicks,
  isExtraPointMiss,
  isFieldGoalMiss,
  parseDistance,
  parseKicker,
  parseResult,
} from "../src/detect.js";
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
    expect(miss.kicker).toBe("D.Carlson");
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
    expect(miss.kicker).toBe("J.Sanders");
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
    expect(misses[0].kicker).toBe("E.Pineiro");
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
    expect(miss.kicker).toBe("S.Shrader");
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

describe("parsers", () => {
  it("reads kicker + distance from FG text", () => {
    const text = "D.Carlson 62 yard field goal is No Good, Wide Right, Center-Z.Wood, Holder-R.Wright.";
    expect(parseKicker(text, "FG")).toBe("D.Carlson");
    expect(parseDistance({ text, type: { id: "60" }, statYardage: 62 }, "FG")).toBe(62);
    expect(parseResult(text)).toBe("Wide Right");
  });

  it("reads kicker from PAT text and ignores TD yardage", () => {
    const text = "J.Taylor right end for 1 yard, TOUCHDOWN. S.Shrader extra point is No Good, Wide Right.";
    expect(parseKicker(text, "PAT")).toBe("S.Shrader");
    expect(parseDistance({ text, statYardage: 1, type: { id: "68" } }, "PAT")).toBeUndefined();
    expect(parseResult(text)).toBe("Wide Right");
  });
});
