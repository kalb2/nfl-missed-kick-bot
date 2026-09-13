import { describe, expect, it } from "vitest";
import { composeTweet, isTweetLengthOk, stripUrls, teamHashtag } from "../src/compose.js";
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
  it("formats Carlson missed FG with labels and official season hashtags", () => {
    const tweet = composeTweet(carlson);
    expect(tweet).toBe(
      [
        "❌ Missed FG",
        "Kicker: D.Carlson (NO)",
        "Kick: 62 yards",
        "Result: Wide Right",
        "When: Q4 0:02",
        "Score: NO 24-24 DET",
        "#Saints #OnePride",
      ].join("\n"),
    );
    expect(isTweetLengthOk(tweet)).toBe(true);
  });

  it("formats Sanders 54 WL", () => {
    const tweet = composeTweet(sanders);
    expect(tweet).toBe(
      [
        "❌ Missed FG",
        "Kicker: J.Sanders (NYJ)",
        "Kick: 54 yards",
        "Result: Wide Left",
        "When: Q2 2:44",
        "Score: NYJ 10-3 TEN",
        "#TakeFlight #Titans",
      ].join("\n"),
    );
    expect(tweet.length).toBeLessThanOrEqual(280);
  });

  it("formats Shrader PAT without a distance line", () => {
    const tweet = composeTweet(shrader);
    expect(tweet).toBe(
      [
        "❌ Missed PAT",
        "Kicker: S.Shrader (IND)",
        "Result: Wide Right",
        "When: Q1 10:33",
        "Score: BAL 0-6 IND",
        "#ForTheShoe #RavensFlock",
      ].join("\n"),
    );
    expect(tweet.length).toBeLessThanOrEqual(280);
    expect(tweet).not.toMatch(/^Kick:/m);
  });

  it("falls back to matchup on the Score line when scores are missing", () => {
    const tweet = composeTweet({
      ...carlson,
      awayScore: undefined,
      homeScore: undefined,
    });
    expect(tweet).toContain("Score: NO @ DET");
    expect(tweet).toContain("#Saints #OnePride");
  });

  it("uses official season hashtags, never abbreviation tags", () => {
    const tweet = composeTweet(carlson);
    expect(tweet).toMatch(/#Saints #OnePride/);
    expect(tweet).not.toMatch(/#NO\b/);
    expect(tweet).not.toMatch(/#DET\b/);
    expect(tweet).not.toMatch(/#Lions\b/);
  });

  it("never includes URLs (X charges more for posts with links)", () => {
    for (const miss of [carlson, sanders, shrader]) {
      expect(composeTweet(miss)).not.toMatch(/https?:\/\//i);
    }
    const sneaky = composeTweet({
      ...carlson,
      kicker: "D.Carlson https://espn.com/play/1",
    });
    expect(sneaky).not.toMatch(/https?:\/\//i);
    expect(sneaky).toContain("Kicker: D.Carlson (NO)");
    expect(stripUrls("plain text")).toBe("plain text");
  });

  it("drops season hashtags before Score or When when slightly over length", () => {
    const tweet = composeTweet({
      ...carlson,
      result: "Wide Right " + "x".repeat(168),
    });
    expect(tweet.length).toBeLessThanOrEqual(280);
    expect(tweet).toContain("Score: NO 24-24 DET");
    expect(tweet).toContain("When: Q4 0:02");
    expect(tweet).not.toMatch(/#Saints|#OnePride|#NO\b|#DET\b/);
  });

  it("drops Score then When, and never exceeds 280", () => {
    const tweet = composeTweet({
      ...carlson,
      kicker: "A".repeat(300),
      result: "Wide Right and then some extra commentary",
    });
    expect(tweet.length).toBeLessThanOrEqual(280);
    expect(tweet.startsWith("❌ Missed FG")).toBe(true);
    expect(tweet).not.toMatch(/#Saints|#OnePride/);
  });
});

describe("teamHashtag", () => {
  it("maps all 32 teams and common ESPN abbreviations to official season tags", () => {
    const expected: Record<string, string> = {
      ARI: "#BirdGang",
      ATL: "#DirtyBirds",
      BAL: "#RavensFlock",
      BUF: "#BillsMafia",
      CAR: "#KeepPounding",
      CHI: "#DaBears",
      CIN: "#RuleTheJungle",
      CLE: "#DawgPound",
      DAL: "#DallasCowboys",
      DEN: "#BroncosCountry",
      DET: "#OnePride",
      GB: "#GoPackGo",
      HOU: "#WeAreTexans",
      IND: "#ForTheShoe",
      JAX: "#DUUUVAL",
      JAC: "#DUUUVAL",
      KC: "#ChiefsKingdom",
      LAC: "#BoltUp",
      SD: "#BoltUp",
      LAR: "#RamsHouse",
      LA: "#RamsHouse",
      LV: "#RaiderNation",
      OAK: "#RaiderNation",
      MIA: "#FinsUp",
      MIN: "#SKOL",
      NE: "#ForeverNE",
      NO: "#Saints",
      NYG: "#NYGiants",
      NYJ: "#TakeFlight",
      PHI: "#FlyEaglesFly",
      PIT: "#HereWeGo",
      SEA: "#Seahawks",
      SF: "#FTTB",
      TB: "#GoBucs",
      TEN: "#Titans",
      WSH: "#RaiseHail",
      WAS: "#RaiseHail",
    };

    for (const [abbr, tag] of Object.entries(expected)) {
      expect(teamHashtag(abbr)).toBe(tag);
    }
  });

  it("does not emit abbreviation-style tags for unknown codes", () => {
    expect(teamHashtag("NO")).toBe("#Saints");
    expect(teamHashtag("XYZ")).toBeUndefined();
  });
});
