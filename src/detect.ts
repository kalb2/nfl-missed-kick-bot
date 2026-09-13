import type {
  AthleteRef,
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

const FG_KICKER_RE =
  /([A-Z]\.[\p{L}'’.\-]+)\s+(\d+)\s+yard field goal/u;
const PAT_KICKER_RE = /([A-Z]\.[\p{L}'’.\-]+)\s+extra point/iu;
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

export function parseKicker(text: string, kickType: KickType): string {
  if (kickType === "FG") {
    const m = text.match(FG_KICKER_RE);
    if (m) return m[1];
  }
  const pat = text.match(PAT_KICKER_RE);
  if (pat) return pat[1];
  const fg = text.match(FG_KICKER_RE);
  if (fg) return fg[1];
  return "Unknown kicker";
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

export function toMissedKick(play: Play, game: GameContext): MissedKick | null {
  const kickType = classifyMiss(play);
  if (!kickType || !play.id) return null;

  const text = play.text || play.shortText || "";
  const team = teamFromPlay(play, game.competitors);
  const home = game.competitors.find((c) => c.homeAway === "home");
  const away = game.competitors.find((c) => c.homeAway === "away");
  const athleteId = athleteIdFromPlay(play);

  return {
    playId: String(play.id),
    kickType,
    kicker: parseKicker(text, kickType),
    ...(athleteId ? { athleteId } : {}),
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
  const misses: MissedKick[] = [];
  for (const play of plays) {
    const miss = toMissedKick(play, game);
    if (miss) misses.push(miss);
  }
  return misses;
}
