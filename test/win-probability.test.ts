import { describe, expect, it } from "vitest";
import { canAttributeWinProbability, detectMissedKicks } from "../src/detect.js";
import type { GameContext, GameSummary, MissedKick, Play } from "../src/types.js";
import {
  asUnitProbability,
  attachWinProbability,
  extractWinProbability,
  kickTeamWinProbabilitySwing,
  normalizeWinProbabilityPoint,
  playIdFromUnknown,
  winProbabilityFromCorePayload,
} from "../src/win-probability.js";

const lutzMiss: MissedKick = {
  playId: "lutz-miss",
  kickType: "FG",
  kicker: "Wil Lutz",
  teamAbbr: "DEN",
  teamName: "Denver Broncos",
  result: "Wide Right",
  quarter: "Q2",
  clock: "4:12",
  awayAbbr: "DEN",
  homeAbbr: "KC",
  matchup: "DEN @ KC",
  playText: "W. Lutz 51 yard field goal is No Good, Wide Right.",
};

describe("extractWinProbability", () => {
  it("reads site-summary rows keyed by playId", () => {
    const points = extractWinProbability({
      winprobability: [
        { playId: "4018729241649", homeWinPercentage: 0.3163, tiePercentage: 0 },
        { playId: "4018729241674", homeWinPercentage: 0.3598, tiePercentage: 0 },
      ],
    });
    expect(points).toEqual([
      { playId: "4018729241649", homeWinPercentage: 0.3163, tiePercentage: 0 },
      { playId: "4018729241674", homeWinPercentage: 0.3598, tiePercentage: 0 },
    ]);
  });

  it("returns an empty list when the array is missing or junk", () => {
    expect(extractWinProbability({})).toEqual([]);
    expect(extractWinProbability({ winprobability: null })).toEqual([]);
    expect(extractWinProbability({ winprobability: [{ playId: "x" }] })).toEqual([]);
    expect(extractWinProbability(null)).toEqual([]);
  });

  it("accepts 0–100 percentages and core play $ref ids", () => {
    expect(asUnitProbability(51.27)).toBeCloseTo(0.5127, 4);
    expect(asUnitProbability(-1)).toBeUndefined();
    expect(playIdFromUnknown("http://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/1/competitions/1/plays/4018729234815?lang=en")).toBe(
      "4018729234815",
    );
    expect(
      normalizeWinProbabilityPoint({
        $ref: "http://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/1/competitions/1/probabilities/4018729234815",
        homeWinPercentage: 0.509,
        play: {
          $ref: "http://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/1/competitions/1/plays/4018729234815",
        },
      }),
    ).toMatchObject({ playId: "4018729234815", homeWinPercentage: 0.509 });
  });
});

describe("winProbabilityFromCorePayload", () => {
  it("unwraps items[] and play $ref", () => {
    const points = winProbabilityFromCorePayload({
      count: 2,
      items: [
        {
          homeWinPercentage: 0.5127,
          play: {
            $ref: "http://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/401872923/competitions/401872923/plays/4018729234782",
          },
        },
        {
          homeWinPercentage: 0.509,
          play: {
            $ref: "http://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/401872923/competitions/401872923/plays/4018729234815",
          },
        },
      ],
    });
    expect(points.map((p) => p.playId)).toEqual(["4018729234782", "4018729234815"]);
  });
});

describe("kickTeamWinProbabilitySwing", () => {
  const points = [
    { playId: "before", homeWinPercentage: 0.3163, tiePercentage: 0 },
    { playId: "lutz-miss", homeWinPercentage: 0.3598, tiePercentage: 0 },
  ];

  it("uses 1 − home WP for the away kicking team", () => {
    const swing = kickTeamWinProbabilitySwing(lutzMiss, points);
    expect(swing?.before).toBeCloseTo(0.6837, 4);
    expect(swing?.after).toBeCloseTo(0.6402, 4);
    expect(swing?.delta).toBeCloseTo(-0.0435, 4);
  });

  it("uses home WP for the home kicking team", () => {
    const swing = kickTeamWinProbabilitySwing({ ...lutzMiss, teamAbbr: "KC" }, points);
    expect(swing?.before).toBeCloseTo(0.3163, 4);
    expect(swing?.delta).toBeCloseTo(0.0435, 4);
  });

  it("omits when the miss play or previous row is missing", () => {
    expect(kickTeamWinProbabilitySwing(lutzMiss, [])).toBeUndefined();
    expect(kickTeamWinProbabilitySwing(lutzMiss, [points[1]])).toBeUndefined();
    expect(kickTeamWinProbabilitySwing({ ...lutzMiss, playId: "nope" }, points)).toBeUndefined();
    expect(kickTeamWinProbabilitySwing({ ...lutzMiss, teamAbbr: "UNK" }, points)).toBeUndefined();
  });
});

describe("attachWinProbability", () => {
  it("writes before/after/delta together", () => {
    const miss = { ...lutzMiss };
    attachWinProbability(miss, [
      { playId: "before", homeWinPercentage: 0.85, tiePercentage: 0 },
      { playId: "lutz-miss", homeWinPercentage: 0.9, tiePercentage: 0 },
    ]);
    expect(miss.wpBefore).toBeCloseTo(0.15, 4);
    expect(miss.wpAfter).toBeCloseTo(0.1, 4);
    expect(miss.wpDelta).toBeCloseTo(-0.05, 4);
  });

  it("leaves the miss unchanged when WP cannot be computed", () => {
    const miss = { ...lutzMiss };
    attachWinProbability(miss, []);
    expect(miss.wpDelta).toBeUndefined();
  });
});

describe("canAttributeWinProbability", () => {
  it("allows FG misses and standalone Extra Point Missed plays", () => {
    expect(canAttributeWinProbability({ type: { id: "60", text: "Field Goal Missed" } }, "FG")).toBe(true);
    expect(canAttributeWinProbability({ type: { id: "62", text: "Extra Point Missed" } }, "PAT")).toBe(true);
  });

  it("rejects PAT misses attached to a touchdown play", () => {
    const play: Play = {
      type: { id: "68", text: "Rushing Touchdown" },
      pointAfterAttempt: { id: 62, text: "Extra Point Missed" },
    };
    expect(canAttributeWinProbability(play, "PAT")).toBe(false);
  });

  it("rejects a blocked PAT attached to a touchdown play", () => {
    const play: Play = {
      type: { id: "67", text: "Passing Touchdown" },
      text: "B.Young pass short left to J.Coker for 8 yards, TOUCHDOWN. R.Fitzgerald extra point is Blocked (D.Odeyingbo).",
      pointAfterAttempt: { id: 43, text: "Blocked PAT", abbreviation: "Blocked PAT", value: 0 },
    };
    expect(canAttributeWinProbability(play, "PAT")).toBe(false);
  });
});

describe("detectMissedKicks win probability", () => {
  const game: GameContext = {
    eventId: "1",
    shortName: "DEN @ KC",
    competitors: [
      { homeAway: "away", team: { id: "7", abbreviation: "DEN" } },
      { homeAway: "home", team: { id: "12", abbreviation: "KC" } },
    ],
  };

  it("omits WP when the summary has no winprobability array", () => {
    const summary: GameSummary = {
      header: { competitions: [{ competitors: game.competitors }] },
      drives: {
        previous: [
          {
            plays: [
              {
                id: "bare-fg",
                type: { id: "60", text: "Field Goal Missed" },
                text: "W. Lutz 51 yard field goal is No Good, Wide Right.",
                teamParticipants: [{ id: "7", type: "offense" }],
              },
            ],
          },
        ],
      },
    };
    const misses = detectMissedKicks(summary, game);
    expect(misses).toHaveLength(1);
    expect(misses[0].wpDelta).toBeUndefined();
  });

  it("attaches a standalone PAT miss swing", () => {
    const summary: GameSummary = {
      header: { competitions: [{ competitors: game.competitors }] },
      drives: {
        previous: [
          {
            plays: [
              {
                id: "pat-only",
                type: { id: "62", text: "Extra Point Missed" },
                text: "W. Lutz extra point is No Good, Wide Right.",
                teamParticipants: [{ id: "7", type: "offense" }],
              },
            ],
          },
        ],
      },
      winprobability: [
        { playId: "prev", homeWinPercentage: 0.4, tiePercentage: 0 },
        { playId: "pat-only", homeWinPercentage: 0.43, tiePercentage: 0 },
      ],
    };
    const misses = detectMissedKicks(summary, game);
    expect(misses[0].kickType).toBe("PAT");
    expect(misses[0].wpDelta).toBeCloseTo(-0.03, 4);
  });
});
