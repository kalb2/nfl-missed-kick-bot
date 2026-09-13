import type { MissedKick } from "./types.js";

const MAX_TWEET = 280;

/**
 * Official nickname hashtags (Title Case) for ESPN / common NFL abbreviations.
 * Never emit raw abbreviation tags like #NO or #DET.
 */
const NFL_NICKNAMES: Record<string, string> = {
  ARI: "Cardinals",
  ARZ: "Cardinals",
  ATL: "Falcons",
  BAL: "Ravens",
  BLT: "Ravens",
  BUF: "Bills",
  CAR: "Panthers",
  CHI: "Bears",
  CIN: "Bengals",
  CLE: "Browns",
  CLV: "Browns",
  DAL: "Cowboys",
  DEN: "Broncos",
  DET: "Lions",
  GB: "Packers",
  GNB: "Packers",
  HOU: "Texans",
  HST: "Texans",
  IND: "Colts",
  JAC: "Jaguars",
  JAX: "Jaguars",
  KC: "Chiefs",
  KAN: "Chiefs",
  LA: "Rams",
  LAR: "Rams",
  STL: "Rams",
  LAC: "Chargers",
  SD: "Chargers",
  SDG: "Chargers",
  LV: "Raiders",
  LVR: "Raiders",
  OAK: "Raiders",
  MIA: "Dolphins",
  MIN: "Vikings",
  NE: "Patriots",
  NWE: "Patriots",
  NO: "Saints",
  NOR: "Saints",
  NYG: "Giants",
  NYJ: "Jets",
  PHI: "Eagles",
  PIT: "Steelers",
  SEA: "Seahawks",
  SF: "49ers",
  SFO: "49ers",
  TB: "Buccaneers",
  TAM: "Buccaneers",
  TEN: "Titans",
  WAS: "Commanders",
  WSH: "Commanders",
  WFT: "Commanders",
};

export function composeTweet(miss: MissedKick): string {
  const header = miss.kickType === "FG" ? "❌ Missed FG" : "❌ Missed PAT";
  const kicker = `Kicker: ${miss.kicker} (${miss.teamAbbr})`;
  const kick =
    miss.kickType === "FG" ? `Kick: ${miss.distance ?? "?"} yards` : undefined;
  const result = `Result: ${miss.result}`;
  const when = whenLine(miss);
  const score = scoreLine(miss);
  const hashtags = hashtagLine(miss);

  const variants: Array<Array<string | undefined>> = [
    [header, kicker, kick, result, when, score, hashtags],
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
  const nick = NFL_NICKNAMES[abbr.trim().toUpperCase()];
  return nick ? `#${nick}` : undefined;
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
  const kicking = teamHashtag(miss.teamAbbr) ?? nicknameFromTeamName(miss.teamName);
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

function nicknameFromTeamName(teamName: string | undefined): string | undefined {
  if (!teamName) return undefined;
  const words = teamName.trim().split(/\s+/);
  const last = words[words.length - 1];
  if (!last || last.toLowerCase() === "unknown") return undefined;
  return `#${last.replace(/[^A-Za-z0-9]/g, "")}`;
}

/** X pay-per-use charges more for posts that include links — keep alerts plain text. */
export function stripUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, "").replace(/[ \t]{2,}/g, " ").trim();
}

export function isTweetLengthOk(text: string): boolean {
  return text.length > 0 && text.length <= MAX_TWEET;
}
