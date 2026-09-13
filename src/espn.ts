import type { GameSummary, Scoreboard, ScoreboardEvent } from "./types.js";

const SCOREBOARD_URLS = [
  "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard",
  "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard",
];

const SUMMARY_URLS = [
  "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/summary?event={eventId}",
  "https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event={eventId}",
];

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

  async getScoreboard(): Promise<Scoreboard> {
    const json = await this.getFirstJson(SCOREBOARD_URLS);
    return normalizeScoreboard(json);
  }

  async getSummary(eventId: string, { bypassCache = false } = {}): Promise<GameSummary> {
    if (!bypassCache) {
      const hit = this.summaryCache.get(eventId);
      if (hit && Date.now() - hit.at < this.summaryTtlMs) return hit.data;
    }
    const urls = SUMMARY_URLS.map((u) => u.replace("{eventId}", encodeURIComponent(eventId)));
    const json = (await this.getFirstJson(urls)) as GameSummary;
    this.summaryCache.set(eventId, { at: Date.now(), data: json });
    return json;
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

export function normalizeScoreboard(raw: unknown): Scoreboard {
  if (!raw || typeof raw !== "object") return { events: [] };
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj.events)) return { events: obj.events as ScoreboardEvent[] };
  const content = obj.content as Record<string, unknown> | undefined;
  const sbData = content?.sbData as Record<string, unknown> | undefined;
  if (Array.isArray(sbData?.events)) return { events: sbData.events as ScoreboardEvent[] };
  return { events: [] };
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
