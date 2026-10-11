import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyMiss, detectMissedKicks, parseKicker } from "../src/detect.js";
import { kickerKeys } from "../src/tallies.js";
import type { GameSummary } from "../src/types.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "pat-missed-patterson-scoring-text.json",
);
const summary = JSON.parse(readFileSync(fixture, "utf8")) as GameSummary;
const game = {
  eventId: "401872982",
  shortName: "CIN @ MIA",
  competitors: summary.header?.competitions?.[0]?.competitors ?? [],
};

describe("CIN @ MIA 2026-10-11 missed PAT (Riley Patterson)", () => {
  it("parses the full-name scoring-summary wording", () => {
    expect(parseKicker("Malik Willis 1 Yd Run (Riley Patterson PAT failed)", "PAT")).toBe(
      "Riley Patterson",
    );
    expect(parseKicker("Ollie Gordon II 1 Yd Rush (Riley Patterson Kick)", "PAT")).toBe(
      "Riley Patterson",
    );
    expect(parseKicker("Malik Willis 1 Yd Run (  PAT failed)", "PAT")).toBe("Unknown kicker");
  });

  it("resolves the kicker even though the drive PBP text drops the name", () => {
    const misses = detectMissedKicks(summary, game);
    expect(misses).toHaveLength(1);
    const [miss] = misses;
    expect(miss.playText).toBe("Malik Willis 1 Yd Run (  PAT failed)");
    expect(miss.kickType).toBe("PAT");
    expect(miss.kicker).toBe("Riley Patterson");
    expect(miss.athleteId).toBe("4243371");
    expect(miss.teamAbbr).toBe("MIA");
    expect(miss.quarter).toBe("Q4");
    expect(miss.clock).toBe("0:45");
  });

  it("stays Unknown kicker when no ESPN text names the kicker (no box-score guess)", () => {
    const stripped = JSON.parse(JSON.stringify(summary)) as GameSummary & {
      scoringPlays?: unknown[];
    };
    delete stripped.scoringPlays;
    const [miss] = detectMissedKicks(stripped, game);
    expect(miss.kicker).toBe("Unknown kicker");
    expect(miss.athleteId).toBeUndefined();
  });

  it("does not treat a two-point try as a missed PAT", () => {
    expect(
      classifyMiss({
        id: "1",
        text: "Kevin Coleman Jr. 3 Yd pass from Malik Willis (Malik Willis Pass to Greg Dulcich for Two-Point Conversion)",
        pointAfterAttempt: { id: 15, text: "Two Point Pass", abbreviation: "Two Point Pass", value: 2 },
      }),
    ).toBeNull();
  });

  it("never pools unresolved kickers into one tally bucket", () => {
    const a = kickerKeys({ kicker: "Unknown kicker", teamAbbr: "MIA", playId: "a" });
    const b = kickerKeys({ kicker: "Unknown kicker", teamAbbr: "MIA", playId: "b" });
    expect(a.some((k) => b.includes(k))).toBe(false);
  });
});
