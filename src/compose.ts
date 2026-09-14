import { formatSeasonLine } from "./tallies.js";
import type { MissedKick } from "./types.js";

const MAX_TWEET = 280;

/**
 * Official primary season hashtags that trigger custom team emojis on X.
 * Never emit raw abbreviation tags like #NO or #DET.
 */
const NFL_SEASON_HASHTAGS: Record<string, string> = {
  ARI: "RiseUpRedSea",
  ARZ: "RiseUpRedSea",
  ATL: "DirtyBirds",
  BAL: "RavensFlock",
  BLT: "RavensFlock",
  BUF: "BillsMafia",
  CAR: "KeepPounding",
  CHI: "DaBears",
  CIN: "WhoDey",
  CLE: "DawgPound",
  CLV: "DawgPound",
  DAL: "DallasCowboys",
  DEN: "BroncosCountry",
  DET: "OnePride",
  GB: "GoPackGo",
  GNB: "GoPackGo",
  HOU: "HTownMade",
  HST: "HTownMade",
  IND: "ForTheShoe",
  JAC: "DUUUVAL",
  JAX: "DUUUVAL",
  KC: "ChiefsKingdom",
  KAN: "ChiefsKingdom",
  LA: "RamsHouse",
  LAR: "RamsHouse",
  STL: "RamsHouse",
  LAC: "BoltUp",
  SD: "BoltUp",
  SDG: "BoltUp",
  LV: "RaiderNation",
  LVR: "RaiderNation",
  OAK: "RaiderNation",
  MIA: "PhinsUp",
  MIN: "Skol",
  NE: "NEPats",
  NWE: "NEPats",
  NO: "Saints",
  NOR: "Saints",
  NYG: "BigBlue",
  NYJ: "JetUp",
  PHI: "FlyEaglesFly",
  PIT: "HereWeGo",
  SEA: "Seahawks",
  SF: "FTTB",
  SFO: "FTTB",
  TB: "WeAreTheKrewe",
  TAM: "WeAreTheKrewe",
  TEN: "TitanUp",
  WAS: "RaiseHail",
  WSH: "RaiseHail",
  WFT: "RaiseHail",
};

export function composeTweet(miss: MissedKick): string {
  const header = miss.kickType === "FG" ? "❌ Missed FG" : "❌ Missed PAT";
  const kicker = `Kicker: ${miss.kicker} (${miss.teamAbbr})`;
  const kick =
    miss.kickType === "FG" ? `Kick: ${miss.distance ?? "?"} yards` : undefined;
  const result = `Result: ${miss.result}`;
  const when = whenLine(miss);
  const score = scoreLine(miss);
  const season = seasonLine(miss);
  const hashtags = hashtagLine(miss);

  // Drop hashtags first, then Season (after Score/When), then Score, then When.
  const variants: Array<Array<string | undefined>> = [
    [header, kicker, kick, result, when, score, season, hashtags],
    [header, kicker, kick, result, when, score, season],
    [header, kicker, kick, result, when, score],
    [header, kicker, kick, result, when],
    [header, kicker, kick, result],
    [header, kicker, result],
    [header, kicker],
    [header],
  ];

  for (const lines of variants) {
    const tweet = stripUrls(lines.filter((line): line is string => Boolean(line)).join("\n"));
    if (tweet.length <= MAX_TWEET) return tweet;
  }

  return stripUrls(header).slice(0, MAX_TWEET);
}

export function teamHashtag(abbr: string): string | undefined {
  const tag = NFL_SEASON_HASHTAGS[abbr.trim().toUpperCase()];
  return tag ? `#${tag}` : undefined;
}

function seasonLine(miss: MissedKick): string | undefined {
  if (miss.seasonFgMisses === undefined || miss.seasonPatMisses === undefined) return undefined;
  return formatSeasonLine(miss.seasonFgMisses, miss.seasonPatMisses);
}

function scoreLine(miss: MissedKick): string | undefined {
  if (miss.awayScore !== undefined && miss.homeScore !== undefined) {
    return `Score: ${miss.awayAbbr} ${miss.awayScore}-${miss.homeScore} ${miss.homeAbbr}`;
  }
  if (miss.matchup) return `Score: ${miss.matchup}`;
  return undefined;
}

function whenLine(miss: MissedKick): string | undefined {
  const parts = [miss.quarter, miss.clock].filter((part) => part && part.length > 0);
  return parts.length ? `When: ${parts.join(" ")}` : undefined;
}

function hashtagLine(miss: MissedKick): string | undefined {
  const kicking = teamHashtag(miss.teamAbbr);
  const opponentAbbr = otherTeamAbbr(miss);
  const opponent = opponentAbbr ? teamHashtag(opponentAbbr) : undefined;

  const tags = [kicking, opponent].filter((tag): tag is string => Boolean(tag));
  if (tags.length === 0) return undefined;

  const unique: string[] = [];
  for (const tag of tags) {
    if (!unique.includes(tag)) unique.push(tag);
  }
  return unique.join(" ");
}

function otherTeamAbbr(miss: MissedKick): string | undefined {
  const kicking = miss.teamAbbr?.toUpperCase();
  const away = miss.awayAbbr?.toUpperCase();
  const home = miss.homeAbbr?.toUpperCase();

  if (kicking && away && home && away !== home) {
    if (kicking === away) return miss.homeAbbr;
    if (kicking === home) return miss.awayAbbr;
  }
  if (away && home && away !== home) return miss.awayAbbr;
  return parseOpponentFromMatchup(miss);
}

function parseOpponentFromMatchup(miss: MissedKick): string | undefined {
  const teams = matchupAbbrs(miss.matchup);
  if (teams.length < 2) return undefined;
  const kicking = miss.teamAbbr?.toUpperCase();
  const other = teams.find((abbr) => abbr.toUpperCase() !== kicking);
  return other;
}

function matchupAbbrs(matchup: string | undefined): string[] {
  if (!matchup) return [];
  return matchup
    .split(/\s+(?:@|vs\.?|v)\s+|\s+/i)
    .map((part) => part.replace(/[^A-Za-z]/g, ""))
    .filter((part) => part.length >= 2 && part.length <= 3);
}

/** X pay-per-use charges more for posts that include links — keep alerts plain text. */
export function stripUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, "").replace(/[ \t]{2,}/g, " ").trim();
}

export function isTweetLengthOk(text: string): boolean {
  return text.length > 0 && text.length <= MAX_TWEET;
}
