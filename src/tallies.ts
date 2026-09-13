import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildGameContext, detectMissedKicks } from "./detect.js";
import {
  REGULAR_SEASON_TYPE,
  contextFromEvent,
  hasGameStarted,
  isCompletedGame,
  mapPool,
} from "./espn.js";
import type { EspnClient } from "./espn.js";
import type {
  GameSummary,
  KickType,
  MissedKick,
  Scoreboard,
  ScoreboardEvent,
  SeasonTallyRow,
} from "./types.js";

const REGULAR_SEASON_WEEKS = 18;

export interface TallyCounts {
  fg: number;
  pat: number;
}

export interface CachedGameMiss {
  playId: string;
  kickType: KickType;
  athleteId?: string;
  kicker: string;
  teamAbbr: string;
}

export interface CachedGameTallies {
  status: string;
  misses: CachedGameMiss[];
}

export interface TallyStoreFile {
  version: 1;
  seasonYear?: number;
  seasonType: typeof REGULAR_SEASON_TYPE;
  updatedAt: string;
  games: Record<string, CachedGameTallies>;
}

interface KickerBucket {
  fg: number;
  pat: number;
  playIds: Set<string>;
  kicker: string;
  teamAbbr: string;
}

export function tallyPathFromStatePath(statePath: string): string {
  return path.join(path.dirname(statePath), "tallies.json");
}

export function normalizeKickerName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/['’.]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
}

export function kickerKeys(miss: Pick<MissedKick, "athleteId" | "kicker" | "teamAbbr">): string[] {
  const keys: string[] = [];
  if (miss.athleteId) keys.push(`id:${miss.athleteId}`);
  const name = normalizeKickerName(miss.kicker);
  const team = (miss.teamAbbr || "UNK").trim().toUpperCase();
  if (name) keys.push(`name:${name}|${team}`);
  return keys;
}

export function formatSeasonLine(fg: number, pat: number): string {
  return `Season: ${fg} missed FG · ${pat} missed PAT`;
}

export function weeksToScan(board: Scoreboard): number[] {
  const type = board.season?.type;
  const week = board.week?.number ?? 1;
  if (type === REGULAR_SEASON_TYPE) {
    const current = Math.min(Math.max(week, 1), REGULAR_SEASON_WEEKS);
    return Array.from({ length: current }, (_, i) => i + 1);
  }
  if (type === 3 || type === 4) {
    return Array.from({ length: REGULAR_SEASON_WEEKS }, (_, i) => i + 1);
  }
  return [];
}

export function isRegularSeasonEvent(event: ScoreboardEvent, board: Scoreboard): boolean {
  const type = event.season?.type ?? board.season?.type;
  return type === undefined || type === REGULAR_SEASON_TYPE;
}

export async function collectStartedRegularSeasonEvents(
  espn: EspnClient,
  board: Scoreboard,
): Promise<ScoreboardEvent[]> {
  const byId = new Map<string, ScoreboardEvent>();
  const add = (event: ScoreboardEvent): void => {
    if (!event?.id || byId.has(event.id)) return;
    if (!isRegularSeasonEvent(event, board)) return;
    if (!hasGameStarted(event)) return;
    byId.set(event.id, event);
  };

  if (board.season?.type === undefined || board.season.type === REGULAR_SEASON_TYPE) {
    for (const event of board.events ?? []) add(event);
  }

  const year = board.season?.year;
  const currentWeek = board.week?.number;
  const currentType = board.season?.type;
  for (const week of weeksToScan(board)) {
    if (currentType === REGULAR_SEASON_TYPE && week === currentWeek) continue;
    const weekly = await espn.getScoreboard({
      seasonType: REGULAR_SEASON_TYPE,
      week,
      ...(year !== undefined ? { dates: String(year) } : {}),
    });
    for (const event of weekly.events ?? []) add(event);
  }

  return [...byId.values()];
}

export class SeasonTallyIndex {
  private games = new Map<string, CachedGameTallies>();
  private summaries = new Map<string, GameSummary>();
  private seasonYear: number | undefined;
  private fetchedThisRefresh = 0;

  constructor(private readonly filePath?: string) {}

  get size(): number {
    return this.games.size;
  }

  get fetchedLastRefresh(): number {
    return this.fetchedThisRefresh;
  }

  getSummary(eventId: string): GameSummary | undefined {
    return this.summaries.get(eventId);
  }

  hasGame(eventId: string): boolean {
    return this.games.has(eventId);
  }

  async load(): Promise<void> {
    if (!this.filePath) return;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const data = JSON.parse(raw) as TallyStoreFile;
      if (data.version !== 1 || !data.games || typeof data.games !== "object") return;
      this.seasonYear = data.seasonYear;
      this.games = new Map(Object.entries(data.games));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
  }

  async save(): Promise<void> {
    if (!this.filePath) return;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const payload: TallyStoreFile = {
      version: 1,
      seasonYear: this.seasonYear,
      seasonType: REGULAR_SEASON_TYPE,
      updatedAt: new Date().toISOString(),
      games: Object.fromEntries(this.games),
    };
    await writeFile(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  clear(): void {
    this.games.clear();
    this.summaries.clear();
    this.seasonYear = undefined;
  }

  async refresh(espn: EspnClient, board: Scoreboard): Promise<{ games: number; fetched: number }> {
    const year = board.season?.year;
    if (year !== undefined && this.seasonYear !== undefined && year !== this.seasonYear) {
      this.clear();
    }
    if (year !== undefined) this.seasonYear = year;

    const events = await collectStartedRegularSeasonEvents(espn, board);
    this.fetchedThisRefresh = 0;

    await mapPool(events, espn.concurrency, async (event) => {
      const cached = this.games.get(event.id);
      if (cached && cached.status === "post" && isCompletedGame(event)) {
        return;
      }
      try {
        const summary = await espn.getSummary(event.id);
        this.summaries.set(event.id, summary);
        const ctx = buildGameContext(event.id, summary, contextFromEvent(event));
        const misses = detectMissedKicks(summary, ctx);
        this.games.set(event.id, {
          status: event.status?.type?.state ?? ctx.statusState ?? "unknown",
          misses: misses.map((miss) => ({
            playId: miss.playId,
            kickType: miss.kickType,
            athleteId: miss.athleteId,
            kicker: miss.kicker,
            teamAbbr: miss.teamAbbr,
          })),
        });
        this.fetchedThisRefresh += 1;
      } catch (err) {
        console.warn("season tally summary failed for %s: %s", event.id, (err as Error).message);
      }
    });

    return { games: this.games.size, fetched: this.fetchedThisRefresh };
  }

  countsFor(miss: MissedKick): TallyCounts {
    const buckets = this.aggregate();
    const bucket = this.lookup(buckets, miss);
    const already = bucket?.playIds.has(miss.playId) ?? false;
    return {
      fg: (bucket?.fg ?? 0) + (!already && miss.kickType === "FG" ? 1 : 0),
      pat: (bucket?.pat ?? 0) + (!already && miss.kickType === "PAT" ? 1 : 0),
    };
  }

  attachTo(miss: MissedKick): MissedKick {
    const counts = this.countsFor(miss);
    miss.seasonFgMisses = counts.fg;
    miss.seasonPatMisses = counts.pat;
    return miss;
  }

  leaderboard(): SeasonTallyRow[] {
    const seen = new Set<KickerBucket>();
    const rows: SeasonTallyRow[] = [];
    for (const bucket of this.aggregate().values()) {
      if (seen.has(bucket)) continue;
      seen.add(bucket);
      if (bucket.fg === 0 && bucket.pat === 0) continue;
      rows.push({
        kicker: bucket.kicker,
        teamAbbr: bucket.teamAbbr,
        fg: bucket.fg,
        pat: bucket.pat,
      });
    }
    rows.sort((a, b) => b.fg + b.pat - (a.fg + a.pat) || a.kicker.localeCompare(b.kicker));
    return rows;
  }

  private aggregate(): Map<string, KickerBucket> {
    const map = new Map<string, KickerBucket>();
    for (const game of this.games.values()) {
      for (const miss of game.misses) {
        const keys = kickerKeys(miss);
        let bucket: KickerBucket | undefined;
        for (const key of keys) {
          bucket = map.get(key);
          if (bucket) break;
        }
        if (!bucket) {
          bucket = {
            fg: 0,
            pat: 0,
            playIds: new Set(),
            kicker: miss.kicker,
            teamAbbr: miss.teamAbbr,
          };
        }
        if (!bucket.playIds.has(miss.playId)) {
          bucket.playIds.add(miss.playId);
          if (miss.kickType === "FG") bucket.fg += 1;
          else bucket.pat += 1;
        }
        for (const key of keys) map.set(key, bucket);
      }
    }
    return map;
  }

  private lookup(map: Map<string, KickerBucket>, miss: MissedKick): KickerBucket | undefined {
    for (const key of kickerKeys(miss)) {
      const hit = map.get(key);
      if (hit) return hit;
    }
    return undefined;
  }
}
