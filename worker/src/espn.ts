import type { CalendarWeek, Slate, StoredGame } from "./types.js";

const SCOREBOARD_URLS = [
  "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard",
  "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard",
];

const FETCH_TIMEOUT_MS = 15_000;
const OFFSEASON_TYPE = 4;
const MAX_WEEK_FETCHES = 3;

export interface EspnFetchOptions {
  fetchImpl?: typeof fetch;
  userAgent: string;
  nowMs: number;
  lookaheadMs: number;
  lookbackMs: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseMs(raw: unknown): number | undefined {
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const ms = Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : undefined;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function withScoreboardQuery(
  url: string,
  query?: { week?: number; seasonType?: number },
): string {
  if (!query) return url;
  const parsed = new URL(url);
  if (query.seasonType !== undefined) parsed.searchParams.set("seasontype", String(query.seasonType));
  if (query.week !== undefined) parsed.searchParams.set("week", String(query.week));
  return parsed.toString();
}

export function extractSeasonYear(raw: unknown): number | undefined {
  const obj = asRecord(raw);
  if (!obj) return undefined;
  const top = asRecord(obj.season);
  if (typeof top?.year === "number") return top.year;
  const leagues = asArray(obj.leagues);
  const leagueSeason = asRecord(asRecord(leagues[0])?.season);
  return typeof leagueSeason?.year === "number" ? leagueSeason.year : undefined;
}

export function extractBoardWeek(raw: unknown): { seasonType?: number; week?: number } {
  const obj = asRecord(raw);
  if (!obj) return {};
  const season = asRecord(obj.season);
  let seasonType: number | undefined;
  if (typeof season?.type === "number") seasonType = season.type;
  else if (asRecord(season?.type) && typeof asRecord(season?.type)?.type === "number") {
    seasonType = asRecord(season?.type)?.type as number;
  }
  const week = asRecord(obj.week);
  return {
    ...(seasonType !== undefined ? { seasonType } : {}),
    ...(typeof week?.number === "number" ? { week: week.number } : {}),
  };
}

export function extractCalendarWeeks(raw: unknown): CalendarWeek[] {
  const obj = asRecord(raw);
  const leagues = asArray(obj?.leagues);
  const calendar = asArray(asRecord(leagues[0])?.calendar);
  const weeks: CalendarWeek[] = [];
  for (const block of calendar) {
    const rec = asRecord(block);
    if (!rec) continue;
    const seasonType = Number.parseInt(String(rec.value ?? ""), 10);
    if (!Number.isFinite(seasonType) || seasonType === OFFSEASON_TYPE) continue;
    for (const entry of asArray(rec.entries)) {
      const week = asRecord(entry);
      if (!week) continue;
      const number = Number.parseInt(String(week.value ?? ""), 10);
      const startMs = parseMs(week.startDate);
      const endMs = parseMs(week.endDate);
      if (!Number.isFinite(number) || startMs === undefined || endMs === undefined) continue;
      weeks.push({
        seasonType,
        week: number,
        startMs,
        endMs,
        label: typeof week.label === "string" ? week.label : `Week ${number}`,
      });
    }
  }
  return weeks.sort((a, b) => a.startMs - b.startMs);
}

export function weeksOverlappingRange(
  weeks: CalendarWeek[],
  rangeStartMs: number,
  rangeEndMs: number,
  limit = MAX_WEEK_FETCHES,
): CalendarWeek[] {
  return weeks
    .filter((week) => week.endMs >= rangeStartMs && week.startMs <= rangeEndMs)
    .slice(0, limit);
}

export function extractGames(raw: unknown): StoredGame[] {
  const obj = asRecord(raw);
  const events = asArray(obj?.events);
  const board = extractBoardWeek(raw);
  const games: StoredGame[] = [];
  for (const item of events) {
    const event = asRecord(item);
    if (!event) continue;
    const id = event.id === undefined || event.id === null ? "" : String(event.id);
    if (!id) continue;
    const competitions = asArray(event.competitions);
    const competition = asRecord(competitions[0]);
    const kickoffMs = parseMs(event.date) ?? parseMs(competition?.date);
    if (kickoffMs === undefined) continue;
    const name =
      (typeof event.shortName === "string" && event.shortName) ||
      (typeof event.name === "string" && event.name) ||
      id;
    const season = asRecord(event.season);
    const week = asRecord(event.week);
    const seasonType = typeof season?.type === "number" ? season.type : board.seasonType;
    const weekNumber = typeof week?.number === "number" ? week.number : board.week;
    games.push({
      id,
      kickoff: toIso(kickoffMs),
      name,
      ...(weekNumber !== undefined ? { week: weekNumber } : {}),
      ...(seasonType !== undefined ? { seasonType } : {}),
    });
  }
  return games;
}

export function mergeGames(groups: StoredGame[][]): StoredGame[] {
  const byId = new Map<string, StoredGame>();
  for (const group of groups) {
    for (const game of group) {
      byId.set(game.id, game);
    }
  }
  return [...byId.values()].sort((a, b) => a.kickoff.localeCompare(b.kickoff));
}

/** Drop leftover current-board games that are outside the lookahead calendar weeks. */
export function gamesInHorizon(
  games: StoredGame[],
  weeks: CalendarWeek[],
  nowMs: number,
  lookaheadMs: number,
  lookbackMs: number,
): StoredGame[] {
  const keys = new Set(weeks.map((week) => `${week.seasonType}:${week.week}`));
  return games.filter((game) => {
    const kickoff = Date.parse(game.kickoff);
    if (!Number.isFinite(kickoff)) return false;
    if (
      keys.size > 0 &&
      game.seasonType !== undefined &&
      game.week !== undefined &&
      keys.has(`${game.seasonType}:${game.week}`)
    ) {
      return true;
    }
    return kickoff >= nowMs - lookbackMs && kickoff <= nowMs + lookaheadMs;
  });
}

async function getJson(
  fetchImpl: typeof fetch,
  url: string,
  userAgent: string,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": userAgent,
        Referer: "https://www.espn.com/nfl/",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`ESPN ${res.status} for ${url}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function getFirstJson(
  fetchImpl: typeof fetch,
  urls: string[],
  userAgent: string,
): Promise<unknown> {
  let lastErr: unknown;
  for (const url of urls) {
    try {
      return await getJson(fetchImpl, url, userAgent);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("All ESPN scoreboard endpoints failed");
}

export async function fetchScoreboard(
  fetchImpl: typeof fetch,
  userAgent: string,
  query?: { week?: number; seasonType?: number },
): Promise<unknown> {
  const urls = SCOREBOARD_URLS.map((url) => withScoreboardQuery(url, query));
  return getFirstJson(fetchImpl, urls, userAgent);
}

/**
 * Pull current + upcoming NFL weeks from ESPN scoreboard/calendar.
 * Idle ticks never call this — only refresh paths do.
 */
export async function fetchNflSlate(opts: EspnFetchOptions): Promise<{ slate: Slate; espnCalls: number }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let espnCalls = 0;

  const current = await fetchScoreboard(fetchImpl, opts.userAgent);
  espnCalls += 1;

  const groups = [extractGames(current)];
  const fetched = new Set(
    groups[0]
      .map((game) => `${game.seasonType ?? "?"}:${game.week ?? "?"}`)
      .filter((key) => !key.includes("?")),
  );
  const board = extractBoardWeek(current);
  if (board.seasonType !== undefined && board.week !== undefined) {
    fetched.add(`${board.seasonType}:${board.week}`);
  }

  const weeks = weeksOverlappingRange(
    extractCalendarWeeks(current),
    opts.nowMs - opts.lookbackMs,
    opts.nowMs + opts.lookaheadMs,
  );

  for (const week of weeks) {
    const key = `${week.seasonType}:${week.week}`;
    if (fetched.has(key)) continue;
    const boardJson = await fetchScoreboard(fetchImpl, opts.userAgent, {
      seasonType: week.seasonType,
      week: week.week,
    });
    espnCalls += 1;
    groups.push(extractGames(boardJson));
    fetched.add(key);
  }

  return {
    espnCalls,
    slate: {
      refreshedAt: toIso(opts.nowMs),
      source: "espn-scoreboard",
      ...(extractSeasonYear(current) !== undefined ? { seasonYear: extractSeasonYear(current) } : {}),
      games: gamesInHorizon(mergeGames(groups), weeks, opts.nowMs, opts.lookaheadMs, opts.lookbackMs),
    },
  };
}
