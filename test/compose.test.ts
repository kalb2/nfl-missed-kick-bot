import { describe, expect, it } from "vitest";
import { composeTweet, isTweetLengthOk, stripUrls, teamHashtag } from "../src/compose.js";
import type { MissedKick } from "../src/types.js";

const carlson: MissedKick = {
  playId: "4018729234815",
  kickType: "FG",
  kicker: "Daniel Carlson",
  athleteId: "3051909",
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
  seasonFgMisses: 2,
  seasonPatMisses: 0,
};

const sanders: MissedKick = {
  playId: "4018729241674",
  kickType: "FG",
  kicker: "Jason Sanders",
  athleteId: "3124679",
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
  seasonFgMisses: 1,
  seasonPatMisses: 0,
};

const shrader: MissedKick = {
  playId: "401872659257",
  kickType: "PAT",
  kicker: "Spencer Shrader",
  athleteId: "4571557",
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
  seasonFgMisses: 0,
  seasonPatMisses: 1,
};

describe("composeTweet", () => {
  it("formats Carlson missed FG with labels and official season hashtags", () => {
    const tweet = composeTweet(carlson);
    expect(tweet).toBe(
      [
        "❌ Missed FG",
        "Kicker: Daniel Carlson (NO)",
        "Kick: 62 yards",
        "Result: Wide Right",
        "When: Q4 0:02",
        "Score: NO 24-24 DET",
        "Season: 2 missed FG · 0 missed PAT",
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
        "Kicker: Jason Sanders (NYJ)",
        "Kick: 54 yards",
        "Result: Wide Left",
        "When: Q2 2:44",
        "Score: NYJ 10-3 TEN",
        "Season: 1 missed FG · 0 missed PAT",
        "#JetUp #TitanUp",
      ].join("\n"),
    );
    expect(tweet.length).toBeLessThanOrEqual(280);
  });

  it("formats Shrader PAT without a distance line", () => {
    const tweet = composeTweet(shrader);
    expect(tweet).toBe(
      [
        "❌ Missed PAT",
        "Kicker: Spencer Shrader (IND)",
        "Result: Wide Right",
        "When: Q1 10:33",
        "Score: BAL 0-6 IND",
        "Season: 0 missed FG · 1 missed PAT",
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
      kicker: "Daniel Carlson https://espn.com/play/1",
    });
    expect(sneaky).not.toMatch(/https?:\/\//i);
    expect(sneaky).toContain("Kicker: Daniel Carlson (NO)");
    expect(stripUrls("plain text")).toBe("plain text");
  });

  it("omits the Season line when tallies are not attached", () => {
    const tweet = composeTweet({
      ...carlson,
      seasonFgMisses: undefined,
      seasonPatMisses: undefined,
    });
    expect(tweet).not.toMatch(/^Season:/m);
    expect(tweet).toContain("#Saints #OnePride");
  });

  it("drops official hashtags before the Season line when slightly over length", () => {
    const tweet = composeTweet({
      ...carlson,
      result: "Wide Right " + "x".repeat(130),
    });
    expect(tweet.length).toBeLessThanOrEqual(280);
    expect(tweet).toContain("Season: 2 missed FG · 0 missed PAT");
    expect(tweet).toContain("Score: NO 24-24 DET");
    expect(tweet).toContain("When: Q4 0:02");
    expect(tweet).not.toMatch(/#Saints|#OnePride|#NO\b|#DET\b/);
  });

  it("drops Season after Score/When when still over length", () => {
    const tweet = composeTweet({
      ...carlson,
      result: "Wide Right " + "x".repeat(168),
    });
    expect(tweet.length).toBeLessThanOrEqual(280);
    expect(tweet).toContain("Score: NO 24-24 DET");
    expect(tweet).toContain("When: Q4 0:02");
    expect(tweet).not.toMatch(/^Season:/m);
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

  it("prints a full first name for a known miss that has athleteId", () => {
    const tweet = composeTweet({
      playId: "lutz-miss",
      kickType: "FG",
      kicker: "Wil Lutz",
      athleteId: "2985659",
      teamAbbr: "DEN",
      teamName: "Denver Broncos",
      distance: 51,
      result: "Wide Right",
      quarter: "Q2",
      clock: "4:12",
      awayAbbr: "DEN",
      homeAbbr: "KC",
      awayScore: 10,
      homeScore: 13,
      matchup: "DEN @ KC",
      playText: "W. Lutz 51 yard field goal is No Good, Wide Right.",
      seasonFgMisses: 1,
      seasonPatMisses: 0,
    });
    expect(tweet).toBe(
      [
        "❌ Missed FG",
        "Kicker: Wil Lutz (DEN)",
        "Kick: 51 yards",
        "Result: Wide Right",
        "When: Q2 4:12",
        "Score: DEN 10-13 KC",
        "Season: 1 missed FG · 0 missed PAT",
        "#BroncosCountry #ChiefsKingdom",
      ].join("\n"),
    );
    expect(tweet).not.toMatch(/W\.\s*Lutz/);
  });
});

describe("teamHashtag", () => {
  it("maps all 32 teams and common ESPN abbreviations to official season tags", () => {
    const expected: Record<string, string> = {
      ARI: "#RiseUpRedSea",
      ARZ: "#RiseUpRedSea",
      ATL: "#DirtyBirds",
      BAL: "#RavensFlock",
      BLT: "#RavensFlock",
      BUF: "#BillsMafia",
      CAR: "#KeepPounding",
      CHI: "#DaBears",
      CIN: "#WhoDey",
      CLE: "#DawgPound",
      CLV: "#DawgPound",
      DAL: "#DallasCowboys",
      DEN: "#BroncosCountry",
      DET: "#OnePride",
      GB: "#GoPackGo",
      GNB: "#GoPackGo",
      HOU: "#HTownMade",
      HST: "#HTownMade",
      IND: "#ForTheShoe",
      JAX: "#DUUUVAL",
      JAC: "#DUUUVAL",
      KC: "#ChiefsKingdom",
      KAN: "#ChiefsKingdom",
      LAC: "#BoltUp",
      SD: "#BoltUp",
      SDG: "#BoltUp",
      LAR: "#RamsHouse",
      LA: "#RamsHouse",
      STL: "#RamsHouse",
      LV: "#RaiderNation",
      LVR: "#RaiderNation",
      OAK: "#RaiderNation",
      MIA: "#PhinsUp",
      MIN: "#Skol",
      NE: "#NEPats",
      NWE: "#NEPats",
      NO: "#Saints",
      NOR: "#Saints",
      NYG: "#BigBlue",
      NYJ: "#JetUp",
      PHI: "#FlyEaglesFly",
      PIT: "#HereWeGo",
      SEA: "#Seahawks",
      SF: "#FTTB",
      SFO: "#FTTB",
      TB: "#WeAreTheKrewe",
      TAM: "#WeAreTheKrewe",
      TEN: "#TitanUp",
      WSH: "#RaiseHail",
      WAS: "#RaiseHail",
      WFT: "#RaiseHail",
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
