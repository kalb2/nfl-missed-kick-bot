import type { EspnClient } from "./espn.js";
import type {
  AthleteRef,
  BoxscorePlayers,
  Competitor,
  GameContext,
  GameSummary,
  KickType,
  MissedKick,
  Play,
} from "./types.js";

const FG_MISS_TYPE_ID = "60";
const PAT_MISS_TYPE_ID = "62";
const PAT_GOOD_TYPE_ID = "61";

/** ESPN PBP uses "W.Lutz" or "W. Lutz". Last name cannot include another "X." */
const FG_KICKER_RE =
  /([A-Z]\.\s*[\p{L}'’-]+)\s+(\d+)\s+yard field goal/u;
const PAT_KICKER_RE = /([A-Z]\.\s*[\p{L}'’-]+)\s+extra point/giu;
const INITIAL_NAME_RE = /^[A-Za-z]\.\s*[\p{L}'’.\-]+$/u;
const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);
const RESULT_RE =
  /(?:is\s+)?No Good(?:,\s*)?([^.,]+)?|field goal is BLOCKED|extra point is BLOCKED|BLOCKED/i;
const PAT_NO_GOOD_RE = /extra point is No Good/i;

/**
 * Walk a summary (or any ESPN JSON blob) and collect play-like objects.
 * ESPN puts plays on `drives.previous[]` / `drives.current` and sometimes
 * other arrays; we take every `plays[]` plus objects that look like plays.
 */
export function collectPlays(root: unknown): Play[] {
  const out: Play[] = [];
  const seen = new Set<string>();

  const add = (play: Play): void => {
    if (!play || typeof play !== "object") return;
    if (!play.id || (!play.type && !play.text && !play.pointAfterAttempt)) return;
    const id = String(play.id);
    if (seen.has(id)) return;
    seen.add(id);
    out.push(play);
  };

  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.plays)) {
      for (const item of obj.plays) add(item as Play);
    }
    if (looksLikePlay(obj)) add(obj as Play);
    for (const [key, value] of Object.entries(obj)) {
      if (key === "plays") continue;
      walk(value);
    }
  };

  walk(root);
  return out;
}

function looksLikePlay(obj: Record<string, unknown>): boolean {
  if (obj.id === undefined || obj.id === null) return false;
  const type = obj.type as { text?: string; id?: unknown } | undefined;
  return Boolean(type?.text || obj.text || obj.pointAfterAttempt);
}

export function isFieldGoalMiss(play: Play): boolean {
  const typeId = String(play.type?.id ?? "");
  const typeText = play.type?.text ?? "";
  if (typeId === FG_MISS_TYPE_ID || typeText === "Field Goal Missed") return true;
  if (/field goal missed/i.test(typeText)) return true;
  if (/field goal is No Good/i.test(play.text ?? "")) return true;
  if (/field goal is BLOCKED/i.test(play.text ?? "")) return true;
  return false;
}

export function isExtraPointMiss(play: Play): boolean {
  const paa = play.pointAfterAttempt;
  if (paa) {
    const paaId = String(paa.id ?? "");
    if (paaId === PAT_GOOD_TYPE_ID || paa.text === "Extra Point Good") return false;
    if (paaId === PAT_MISS_TYPE_ID || paa.text === "Extra Point Missed") return true;
  }
  const typeId = String(play.type?.id ?? "");
  const typeText = play.type?.text ?? "";
  if (typeId === PAT_MISS_TYPE_ID || typeText === "Extra Point Missed") return true;
  // Structured PAA is preferred; text is a backup when ESPN omits pointAfterAttempt.
  const text = `${play.text ?? ""} ${play.shortText ?? ""}`;
  if (PAT_NO_GOOD_RE.test(text)) return true;
  return false;
}

export function classifyMiss(play: Play): KickType | null {
  // PAT miss is often attached to the TD play, so check it first.
  if (isExtraPointMiss(play)) return "PAT";
  if (isFieldGoalMiss(play)) return "FG";
  return null;
}

function lastCapture(text: string, re: RegExp): string | undefined {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const copy = new RegExp(re.source, flags);
  let last: string | undefined;
  for (const match of text.matchAll(copy)) last = match[1];
  return last;
}

export function parseKicker(text: string, kickType: KickType): string {
  if (kickType === "FG") {
    const m = text.match(FG_KICKER_RE);
    if (m) return m[1];
  }
  const pat = lastCapture(text, PAT_KICKER_RE);
  if (pat) return pat;
  const fg = text.match(FG_KICKER_RE);
  if (fg) return fg[1];
  return "Unknown kicker";
}

export function isInitialStyleName(name: string): boolean {
  return INITIAL_NAME_RE.test(name.trim());
}

export function kickerNameTokens(name: string): string[] {
  const tokens = name
    .normalize("NFKD")
    .replace(/['’]/g, "")
    .replace(/[.]/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  while (tokens.length > 1 && NAME_SUFFIXES.has(tokens[tokens.length - 1].toLowerCase())) {
    tokens.pop();
  }
  return tokens;
}

export function compactKickerName(name: string): string {
  return kickerNameTokens(name).join("").toLowerCase();
}

/** First initial + last name, e.g. Wil Lutz / W. Lutz → wlutz. */
export function initialLastCompact(name: string): string | undefined {
  const tokens = kickerNameTokens(name);
  if (tokens.length < 2) return undefined;
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  if (!first || !last) return undefined;
  return `${first[0]}${last}`.toLowerCase();
}

export function fullNameFromAthlete(athlete?: AthleteRef): string | undefined {
  if (!athlete) return undefined;
  const firstLast = [athlete.firstName, athlete.lastName]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join(" ");
  const candidates = [athlete.displayName, athlete.fullName, firstLast].filter(
    (part): part is string => Boolean(part && part.trim()),
  );
  for (const raw of candidates) {
    const name = raw.replace(/\s+/g, " ").trim();
    if (isInitialStyleName(name)) continue;
    if (kickerNameTokens(name).length < 2) continue;
    if (name.split(/\s+/)[0]?.replace(/[.]/g, "").length < 2) continue;
    return name;
  }
  return undefined;
}

export function kickingAthletesFromSummary(summary: GameSummary): AthleteRef[] {
  const out: AthleteRef[] = [];
  const seen = new Set<string>();
  const players = summary.boxscore?.players;
  if (!Array.isArray(players)) return out;

  const add = (athlete?: AthleteRef): void => {
    if (!athlete) return;
    const id = athleteIdFromRef(athlete);
    const key = id || fullNameFromAthlete(athlete) || athlete.displayName;
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(athlete);
  };

  for (const team of players as BoxscorePlayers[]) {
    for (const group of team.statistics ?? []) {
      if ((group.name ?? "").toLowerCase() !== "kicking") continue;
      for (const row of group.athletes ?? []) add(row.athlete);
    }
  }
  return out;
}

export function kickerAthleteFromPlay(play: Play): AthleteRef | undefined {
  const participants = play.participants;
  if (Array.isArray(participants)) {
    const kicker = participants.find((p) => (p.type ?? "").toLowerCase() === "kicker");
    if (kicker?.athlete) return kicker.athlete;
  }
  if (Array.isArray(play.athletesInvolved) && play.athletesInvolved.length > 0) {
    const text = play.text || play.shortText || "";
    const parsed = parseKicker(text, classifyMiss(play) ?? "FG");
    const parsedLast = initialLastCompact(parsed) ?? compactKickerName(parsed);
    const named = play.athletesInvolved.find((athlete) => {
      const full = fullNameFromAthlete(athlete);
      if (!full || parsed === "Unknown kicker") return Boolean(full);
      const key = initialLastCompact(full) ?? compactKickerName(full);
      return Boolean(parsedLast && key && (key === parsedLast || compactKickerName(full) === compactKickerName(parsed)));
    });
    if (named) return named;
    const anyNamed = play.athletesInvolved.find((athlete) => fullNameFromAthlete(athlete));
    if (anyNamed && play.athletesInvolved.length === 1) return anyNamed;
  }
  if (play.athlete && fullNameFromAthlete(play.athlete)) return play.athlete;
  return play.athlete;
}

function athleteNameMatches(parsed: string, athlete: AthleteRef): boolean {
  if (parsed === "Unknown kicker") return false;
  const parsedLast = lastToken(parsed);
  const athleteLast = athlete.lastName
    ? lastToken(athlete.lastName)
    : lastToken(fullNameFromAthlete(athlete) || athlete.displayName || athlete.fullName || "");
  if (!parsedLast || !athleteLast || parsedLast !== athleteLast) return false;
  const parsedInitial = firstInitial(parsed);
  const athleteInitial = firstInitial(
    athlete.firstName || fullNameFromAthlete(athlete) || athlete.displayName || "",
  );
  if (parsedInitial && athleteInitial) return parsedInitial === athleteInitial;
  return true;
}

function lastToken(name: string): string | undefined {
  const tokens = kickerNameTokens(name);
  return tokens[tokens.length - 1]?.toLowerCase();
}

function firstInitial(name: string): string | undefined {
  const tokens = kickerNameTokens(name);
  return tokens[0]?.[0]?.toLowerCase();
}

export function matchKickerAthlete(
  parsed: string,
  athleteId: string | undefined,
  roster: AthleteRef[],
): AthleteRef | undefined {
  if (athleteId) {
    const byId = roster.find((athlete) => athleteIdFromRef(athlete) === athleteId);
    if (byId) return byId;
  }
  const matches = roster.filter((athlete) => athleteNameMatches(parsed, athlete));
  if (matches.length === 1) return matches[0];
  return undefined;
}

export function resolveKickerName(
  play: Play,
  kickType: KickType,
  roster: AthleteRef[] = [],
): { kicker: string; athleteId?: string } {
  const text = play.text || play.shortText || "";
  const parsed = parseKicker(text, kickType);
  const playAthlete = kickerAthleteFromPlay(play);
  const playId = athleteIdFromPlay(play) ?? athleteIdFromRef(playAthlete);
  const fromPlay = fullNameFromAthlete(playAthlete);
  if (fromPlay) {
    return { kicker: fromPlay, ...(playId ? { athleteId: playId } : {}) };
  }

  const rosterMatch = matchKickerAthlete(parsed, playId, roster);
  const fromRoster = fullNameFromAthlete(rosterMatch);
  const rosterId = athleteIdFromRef(rosterMatch);
  const athleteId = playId ?? rosterId;
  if (fromRoster) {
    return { kicker: fromRoster, ...(athleteId ? { athleteId } : {}) };
  }

  return { kicker: parsed, ...(athleteId ? { athleteId } : {}) };
}

export async function enrichKickerNames(
  espn: Pick<EspnClient, "getAthlete"> | { getAthlete?: EspnClient["getAthlete"] },
  misses: MissedKick[],
): Promise<void> {
  const getAthlete = espn.getAthlete?.bind(espn);
  if (!getAthlete) return;

  const needed = misses.filter(
    (miss) =>
      miss.athleteId && (isInitialStyleName(miss.kicker) || miss.kicker === "Unknown kicker"),
  );
  if (needed.length === 0) return;

  const ids = [...new Set(needed.map((miss) => miss.athleteId!))];
  const names = new Map<string, string>();
  await Promise.all(
    ids.map(async (id) => {
      try {
        const athlete = await getAthlete(id);
        const name = fullNameFromAthlete(athlete);
        if (name) names.set(id, name);
      } catch (err) {
        console.warn("athlete profile failed for %s: %s", id, (err as Error).message);
      }
    }),
  );

  for (const miss of needed) {
    const name = miss.athleteId ? names.get(miss.athleteId) : undefined;
    if (name) miss.kicker = name;
  }
}

export function parseDistance(play: Play, kickType: KickType): number | undefined {
  if (kickType !== "FG") return undefined;
  const fromText = play.text?.match(/(\d+)\s+yard field goal/i);
  if (fromText) return Number.parseInt(fromText[1], 10);
  const typeId = String(play.type?.id ?? "");
  if (typeId === FG_MISS_TYPE_ID && typeof play.statYardage === "number" && play.statYardage > 0) {
    return play.statYardage;
  }
  return undefined;
}

export function parseResult(text: string): string {
  const blocked = /blocked/i.test(text);
  const match = text.match(RESULT_RE);
  const detail = match?.[1]?.trim();
  if (detail) {
    const cleaned = detail.replace(/\s+/g, " ").replace(/,$/, "");
    if (cleaned) return cleaned;
  }
  if (blocked) return "Blocked";
  if (/no good/i.test(text)) return "No Good";
  return "No Good";
}

export function formatQuarter(period?: number): string {
  if (!period || period < 1) return "Q?";
  if (period <= 4) return `Q${period}`;
  if (period === 5) return "OT";
  return `OT${period - 4}`;
}

function competitorAbbr(c: Competitor): string {
  return c.team?.abbreviation || c.id || "?";
}

function competitorName(c: Competitor): string {
  return c.team?.displayName || c.team?.name || competitorAbbr(c);
}

export function teamFromPlay(play: Play, competitors: Competitor[]): Competitor | undefined {
  const offenseId =
    play.teamParticipants?.find((p) => p.type === "offense")?.id ||
    play.start?.team?.id ||
    play.team?.id;
  if (offenseId) {
    const match = competitors.find(
      (c) => c.id === offenseId || c.team?.id === offenseId,
    );
    if (match) return match;
  }
  return undefined;
}

export function buildGameContext(
  eventId: string,
  summary: GameSummary,
  fallback?: Partial<GameContext>,
): GameContext {
  const headerComp = summary.header?.competitions?.[0];
  const competitors = headerComp?.competitors ?? fallback?.competitors ?? [];
  return {
    eventId,
    shortName: fallback?.shortName || "",
    date: fallback?.date,
    statusState: fallback?.statusState,
    competitors,
  };
}

export function matchupLabel(competitors: Competitor[], shortName?: string): string {
  if (shortName) return shortName;
  const home = competitors.find((c) => c.homeAway === "home");
  const away = competitors.find((c) => c.homeAway === "away");
  if (away && home) return `${competitorAbbr(away)} @ ${competitorAbbr(home)}`;
  return competitors.map(competitorAbbr).join(" vs ");
}

const ATHLETE_REF_RE = /\/athletes\/(\d+)/i;

export function athleteIdFromRef(athlete?: AthleteRef): string | undefined {
  if (!athlete) return undefined;
  if (athlete.id !== undefined && athlete.id !== null && String(athlete.id).length > 0) {
    return String(athlete.id);
  }
  const match = athlete.$ref?.match(ATHLETE_REF_RE);
  return match?.[1];
}

/** Prefer a participant marked as the kicker; ignore rushers/receivers on PAT-on-TD plays. */
export function athleteIdFromPlay(play: Play): string | undefined {
  const participants = play.participants;
  if (Array.isArray(participants)) {
    const kicker = participants.find((p) => (p.type ?? "").toLowerCase() === "kicker");
    const fromKicker = athleteIdFromRef(kicker?.athlete);
    if (fromKicker) return fromKicker;
  }
  if (Array.isArray(play.athletesInvolved)) {
    for (const athlete of play.athletesInvolved) {
      const id = athleteIdFromRef(athlete);
      if (id) return id;
    }
  }
  return athleteIdFromRef(play.athlete);
}

export function toMissedKick(
  play: Play,
  game: GameContext,
  roster: AthleteRef[] = [],
): MissedKick | null {
  const kickType = classifyMiss(play);
  if (!kickType || !play.id) return null;

  const text = play.text || play.shortText || "";
  const team = teamFromPlay(play, game.competitors);
  const home = game.competitors.find((c) => c.homeAway === "home");
  const away = game.competitors.find((c) => c.homeAway === "away");
  const resolved = resolveKickerName(play, kickType, roster);

  return {
    playId: String(play.id),
    kickType,
    kicker: resolved.kicker,
    ...(resolved.athleteId ? { athleteId: resolved.athleteId } : {}),
    teamAbbr: team ? competitorAbbr(team) : "UNK",
    teamName: team ? competitorName(team) : "Unknown team",
    distance: parseDistance(play, kickType),
    result: parseResult(text),
    quarter: formatQuarter(play.period?.number),
    clock: play.clock?.displayValue || "?:??",
    awayAbbr: away ? competitorAbbr(away) : "AWAY",
    homeAbbr: home ? competitorAbbr(home) : "HOME",
    awayScore: play.awayScore,
    homeScore: play.homeScore,
    matchup: matchupLabel(game.competitors, game.shortName),
    playText: text,
  };
}

export function detectMissedKicks(summary: GameSummary, game: GameContext): MissedKick[] {
  const plays = collectPlays(summary);
  const roster = kickingAthletesFromSummary(summary);
  const misses: MissedKick[] = [];
  for (const play of plays) {
    const miss = toMissedKick(play, game, roster);
    if (miss) misses.push(miss);
  }
  return misses;
}
