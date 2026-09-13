import { describe, expect, it } from "vitest";
import { composeTweet, isTweetLengthOk } from "../src/compose.js";
import type { MissedKick } from "../src/types.js";

const carlson: MissedKick = {
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
  playText: "D.Carlson 62 yard field goal is No Good, Wide Right, Center-Z.Wood, Holder-R.Wright.",
};

const sanders: MissedKick = {
  playId: "4018729241674",
  kickType: "FG",
  kicker: "J.Sanders",
  teamAbbr: "NYJ",
  teamName: "New York Jets",
  distance: 54,
  result: "Wide Left",
  quarter: "Q2",
  clock: "2:44",
  awayAbbr: "NYJ",
  homeAbbr: "TEN",
  awayScore: 10,
  homeScore: 3,
  matchup: "NYJ @ TEN",
  playText: "J.Sanders 54 yard field goal is No Good, Wide Left, Center-T.Hennessy, Holder-A.McNamara.",
};

const shrader: MissedKick = {
  playId: "401872659257",
  kickType: "PAT",
  kicker: "S.Shrader",
  teamAbbr: "IND",
  teamName: "Indianapolis Colts",
  result: "Wide Right",
  quarter: "Q1",
  clock: "10:33",
  awayAbbr: "BAL",
  homeAbbr: "IND",
  awayScore: 0,
  homeScore: 6,
  matchup: "BAL @ IND",
  playText: "J.Taylor right end for 1 yard, TOUCHDOWN. S.Shrader extra point is No Good, Wide Right.",
};

describe("composeTweet", () => {
  it("includes kicker, team, kick type, distance, result, clock, score, matchup for Carlson", () => {
    const tweet = composeTweet(carlson);
    expect(tweet).toBe(
      "❌ D.Carlson (NO) missed a 62-yard FG — Wide Right\nQ4 0:02 | NO 24-24 DET",
    );
    expect(isTweetLengthOk(tweet)).toBe(true);
  });

  it("formats Sanders 54 WL", () => {
    const tweet = composeTweet(sanders);
    expect(tweet).toBe(
      "❌ J.Sanders (NYJ) missed a 54-yard FG — Wide Left\nQ2 2:44 | NYJ 10-3 TEN",
    );
    expect(tweet.length).toBeLessThanOrEqual(280);
  });

  it("formats Shrader PAT without a distance", () => {
    const tweet = composeTweet(shrader);
    expect(tweet).toBe("❌ S.Shrader (IND) missed a PAT — Wide Right\nQ1 10:33 | BAL 0-6 IND");
    expect(tweet.length).toBeLessThanOrEqual(280);
  });

  it("truncates pathological input to 280 characters", () => {
    const tweet = composeTweet({
      ...carlson,
      kicker: "A".repeat(300),
      result: "Wide Right and then some extra commentary",
    });
    expect(tweet.length).toBeLessThanOrEqual(280);
  });
});
