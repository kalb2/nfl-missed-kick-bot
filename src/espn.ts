import type { AthleteRef, GameContext, GameSummary, Play, Scoreboard, ScoreboardEvent, ScoreboardQuery, SeasonRef, WeekRef } from "./types.js";

/** ESPN regular season. Preseason=1, regular=2, postseason=3. */
export const REGULAR_SEASON_TYPE = 2;

const SCOREBOARD_URLS = [
  "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard",
  "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard",
];

const SUMMARY_URLS = [
  "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/summary?event={eventId}",
  "https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event={eventId}",
];

function playFeedUrls(eventId: string): string[] {
  const id = encodeURIComponent(eventId);
  return [
    `https://cdn.espn.com/core/nfl/playbyplay?xhr=1&gameId=${id}`,
    `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${id}/competitions/${id}/plays?limit=400`,
  ];
}

function athleteProfileUrls(athleteId: string): string[] {
  const id = encodeURIComponent(athleteId);
  return [
    `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/athletes/${id}`,
    `https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${id}`,
    `https://site.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${id}`,
  ];
}

const DEFAULT_TTL_MS = 20_000;
const FETCH_TIMEOUT_MS = 15_000;

export interface EspnClientOptions {
  userAgent: string;
  summaryTtlMs?: number;
  concurrency?: number;
  fetchImpl?: typeof fetch;
}

export class EspnClient {
  private readonly summaryCache = new Map<string, { at: number; data: GameSummary }>();
  private readonly athleteCache = new Map<string, AthleteRef>();
  private readonly userAgent: string;
  private readonly summaryTtlMs: number;
  readonly concurrency: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: EspnClientOptions) {
    this.userAgent = opts.userAgent;
    this.summaryTtlMs = opts.summaryTtlMs ?? DEFAULT_TTL_MS;
    this.concurrency = opts.concurrency ?? 2;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async getScoreboard(query?: ScoreboardQuery): Promise<Scoreboard> {
    const urls = SCOREBOARD_URLS.map((url) => withScoreboardQuery(url, query));
    const json = await this.getFirstJson(urls);
    return normalizeScoreboard(json);
  }

  async getSummary(eventId: string, { bypassCache = false } = {}): Promise<GameSummary> {
    if (!bypassCache) {
      const hit = this.summaryCache.get(eventId);
      if (hit && Date.now() - hit.at < this.summaryTtlMs) return hit.data;
    }

    const summaryUrls = SUMMARY_URLS.map((u) => u.replace("{eventId}", encodeURIComponent(eventId)));
    let primary: GameSummary | undefined;
    let lastErr: unknown;
    for (const url of summaryUrls) {
      try {
        primary = normalizeGamePayload(await this.getJson(url));
        break;
      } catch (err) {
        lastErr = err;
      }
    }

    if (primary && summaryHasPlays(primary)) {
      this.summaryCache.set(eventId, { at: Date.now(), data: primary });
      return primary;
    }

    for (const url of playFeedUrls(eventId)) {
      try {
        const alt = normalizeGamePayload(await this.getJson(url));
        const merged = mergeSummaries(primary, alt);
        if (summaryHasPlays(merged) || primary) {
          this.summaryCache.set(eventId, { at: Date.now(), data: merged });
          return merged;
        }
      } catch (err) {
        lastErr = err;
      }
    }

    if (primary) {
      this.summaryCache.set(eventId, { at: Date.now(), data: primary });
      return primary;
    }
    throw lastErr instanceof Error ? lastErr : new Error(`No ESPN play feed for event ${eventId}`);
  }

  async getAthlete(athleteId: string): Promise<AthleteRef | undefined> {
    const id = String(athleteId);
    const cached = this.athleteCache.get(id);
    if (cached) return cached;

    let lastErr: unknown;
    for (const url of athleteProfileUrls(id)) {
      try {
        const athlete = athleteFromPayload(await this.getJson(url));
        if (athlete) {
          this.athleteCache.set(id, athlete);
          return athlete;
        }
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) {
      console.warn("athlete profile failed for %s: %s", id, (lastErr as Error).message);
    }
    return undefined;
  }

  private async getFirstJson(urls: string[]): Promise<unknown> {
    let lastErr: unknown;
    for (const url of urls) {
      try {
        return await this.getJson(url);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("All ESPN endpoints failed");
  }

  private async getJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": this.userAgent,
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
}

/** CDN play-by-play wraps the package; core /plays is a flat `items` list. */
export function athleteFromPayload(raw: unknown): AthleteRef | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const nested = obj.athlete;
  const athlete = (
    nested && typeof nested === "object" ? nested : obj
  ) as Record<string, unknown>;

  const id = athlete.id;
  const displayName = typeof athlete.displayName === "string" ? athlete.displayName : undefined;
  const fullName = typeof athlete.fullName === "string" ? athlete.fullName : undefined;
  const firstName = typeof athlete.firstName === "string" ? athlete.firstName : undefined;
  const lastName = typeof athlete.lastName === "string" ? athlete.lastName : undefined;
  const shortName = typeof athlete.shortName === "string" ? athlete.shortName : undefined;
  if (
    (id === undefined || id === null || String(id).length === 0) &&
    !displayName &&
    !fullName &&
    !firstName &&
    !lastName
  ) {
    return undefined;
  }

  return {
    ...(id !== undefined && id !== null ? { id } : {}),
    ...(displayName ? { displayName } : {}),
    ...(fullName ? { fullName } : {}),
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
    ...(shortName ? { shortName } : {}),
  };
}

export function normalizeGamePayload(raw: unknown): GameSummary {
  if (!raw || typeof raw !== "object") return {};
  const obj = raw as Record<string, unknown>;
  if (obj.gamepackageJSON && typeof obj.gamepackageJSON === "object") {
    return obj.gamepackageJSON as GameSummary;
  }
  if (Array.isArray(obj.items) && !obj.drives) {
    return { drives: { previous: [{ plays: obj.items as Play[] }] } };
  }
  return obj as GameSummary;
}

export function summaryHasPlays(summary: GameSummary): boolean {
  const drives = summary.drives;
  if (!drives) return false;
  const lists: Array<{ plays?: Play[] } | undefined> = [];
  if (Array.isArray(drives.previous)) lists.push(...drives.previous);
  if (Array.isArray(drives.current)) lists.push(...drives.current);
  else if (drives.current) lists.push(drives.current);
  return lists.some((drive) => Array.isArray(drive?.plays) && drive.plays.length > 0);
}

export function mergeSummaries(primary: GameSummary | undefined, alt: GameSummary | undefined): GameSummary {
  const primaryHas = primary ? summaryHasPlays(primary) : false;
  const altHas = alt ? summaryHasPlays(alt) : false;
  return {
    ...(alt ?? {}),
    ...(primary ?? {}),
    drives: primaryHas ? primary!.drives : altHas ? alt!.drives : primary?.drives ?? alt?.drives,
    header: primary?.header ?? alt?.header,
  };
}

export function withScoreboardQuery(url: string, query?: ScoreboardQuery): string {
  if (!query) return url;
  const parsed = new URL(url);
  if (query.seasonType !== undefined) parsed.searchParams.set("seasontype", String(query.seasonType));
  if (query.week !== undefined) parsed.searchParams.set("week", String(query.week));
  if (query.dates) parsed.searchParams.set("dates", query.dates);
  return parsed.toString();
}

export function normalizeScoreboard(raw: unknown): Scoreboard {
  if (!raw || typeof raw !== "object") return { events: [] };
  const obj = raw as Record<string, unknown>;
  const events = scoreboardEvents(obj);
  return {
    events,
    season: extractSeason(obj),
    week: extractWeek(obj),
  };
}

function scoreboardEvents(obj: Record<string, unknown>): ScoreboardEvent[] {
  if (Array.isArray(obj.events)) return obj.events as ScoreboardEvent[];
  const content = obj.content as Record<string, unknown> | undefined;
  const sbData = content?.sbData as Record<string, unknown> | undefined;
  if (Array.isArray(sbData?.events)) return sbData.events as ScoreboardEvent[];
  return [];
}

export function extractSeason(obj: Record<string, unknown>): SeasonRef | undefined {
  const direct = seasonFromUnknown(obj.season);
  if (direct) return direct;
  const leagues = obj.leagues;
  if (Array.isArray(leagues) && leagues[0] && typeof leagues[0] === "object") {
    return seasonFromUnknown((leagues[0] as Record<string, unknown>).season);
  }
  return undefined;
}

function seasonFromUnknown(raw: unknown): SeasonRef | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const year = typeof obj.year === "number" ? obj.year : undefined;
  let type: number | undefined;
  if (typeof obj.type === "number") type = obj.type;
  else if (obj.type && typeof obj.type === "object") {
    const nested = obj.type as Record<string, unknown>;
    if (typeof nested.type === "number") type = nested.type;
    else if (typeof nested.id === "string" || typeof nested.id === "number") {
      const parsed = Number.parseInt(String(nested.id), 10);
      if (Number.isFinite(parsed)) type = parsed;
    }
  }
  const slug = typeof obj.slug === "string" ? obj.slug : undefined;
  if (year === undefined && type === undefined && !slug) return undefined;
  return { year, type, slug };
}

export function extractWeek(obj: Record<string, unknown>): WeekRef | undefined {
  const raw = obj.week;
  if (!raw || typeof raw !== "object") return undefined;
  const number = (raw as { number?: unknown }).number;
  return typeof number === "number" ? { number } : undefined;
}

export function eventStatusState(event: ScoreboardEvent): string | undefined {
  return event.status?.type?.state || event.competitions?.[0]?.status?.type?.state;
}

/** Games that have kicked off or finished — used for season-wide tally scans. */
export function hasGameStarted(event: ScoreboardEvent, now = Date.now()): boolean {
  const state = eventStatusState(event);
  if (state === "pre") return false;
  if (state === "in" || state === "post") return true;
  const start = Date.parse(event.date || event.competitions?.[0]?.date || "");
  return Number.isFinite(start) && start <= now;
}

export function isCompletedGame(event: ScoreboardEvent): boolean {
  const status = event.status?.type ?? event.competitions?.[0]?.status?.type;
  return status?.state === "post" || Boolean(status?.completed);
}

export function contextFromEvent(event: ScoreboardEvent): GameContext {
  const competition = event.competitions?.[0];
  return {
    eventId: event.id,
    shortName: event.shortName || event.name || event.id,
    date: event.date || competition?.date,
    statusState: eventStatusState(event),
    seasonType: event.season?.type,
    seasonYear: event.season?.year,
    competitors: competition?.competitors ?? [],
  };
}

/** Typical NFL game length (~4h) plus a short post-game window. */
export function isWatchableGame(
  event: ScoreboardEvent,
  now = Date.now(),
  recentFinalWindowMin = 45,
  { allToday = false } = {},
): boolean {
  const status = event.status?.type ?? event.competitions?.[0]?.status?.type;
  const state = status?.state;
  const start = Date.parse(event.date || event.competitions?.[0]?.date || "");

  if (allToday) {
    if (state === "pre") return false;
    if (Number.isFinite(start)) {
      const ageMs = now - start;
      return ageMs >= -30 * 60_000 && ageMs <= 36 * 60 * 60_000;
    }
    return state === "in" || state === "post";
  }

  if (state === "in") return true;
  if (state === "pre") return false;
  if (state === "post" || status?.completed) {
    if (!Number.isFinite(start)) return false;
    const watchUntil = start + (4 * 60 + recentFinalWindowMin) * 60_000;
    return now <= watchUntil;
  }
  return false;
}

export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) || 0 }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
