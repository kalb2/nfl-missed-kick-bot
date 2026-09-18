import type { SchedulerConfig, Slate, StoredGame } from "./types.js";

export function parseKickoffMs(iso: string): number | undefined {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Live window: PRE_KICKOFF_MIN before kickoff through POST_KICKOFF_MIN after. */
export function isInLiveWindow(
  kickoffIso: string,
  nowMs: number,
  preKickoffMs: number,
  postKickoffMs: number,
): boolean {
  const kickoff = parseKickoffMs(kickoffIso);
  if (kickoff === undefined) return false;
  return nowMs >= kickoff - preKickoffMs && nowMs <= kickoff + postKickoffMs;
}

export function gamesInWindow(games: StoredGame[], nowMs: number, config: SchedulerConfig): StoredGame[] {
  return games.filter((game) =>
    isInLiveWindow(game.kickoff, nowMs, config.preKickoffMs, config.postKickoffMs),
  );
}

/** True if any stored kickoff is still upcoming or inside the post-game window. */
export function hasRemainingKickoff(games: StoredGame[], nowMs: number, postKickoffMs: number): boolean {
  return games.some((game) => {
    const kickoff = parseKickoffMs(game.kickoff);
    return kickoff !== undefined && kickoff + postKickoffMs >= nowMs;
  });
}

export function nextKickoffIso(games: StoredGame[], nowMs: number): string | undefined {
  const upcoming = games
    .map((game) => ({ game, ms: parseKickoffMs(game.kickoff) }))
    .filter((row): row is { game: StoredGame; ms: number } => row.ms !== undefined && row.ms >= nowMs)
    .sort((a, b) => a.ms - b.ms);
  return upcoming[0]?.game.kickoff;
}

export function parseSlate(raw: string | null): Slate | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.games) || typeof obj.refreshedAt !== "string") return undefined;
    const games: StoredGame[] = [];
    for (const item of obj.games) {
      if (!item || typeof item !== "object") continue;
      const game = item as Record<string, unknown>;
      if (typeof game.id !== "string" || typeof game.kickoff !== "string" || typeof game.name !== "string") {
        continue;
      }
      games.push({
        id: game.id,
        kickoff: game.kickoff,
        name: game.name,
        ...(typeof game.week === "number" ? { week: game.week } : {}),
        ...(typeof game.seasonType === "number" ? { seasonType: game.seasonType } : {}),
      });
    }
    return {
      refreshedAt: obj.refreshedAt,
      source: "espn-scoreboard",
      ...(typeof obj.seasonYear === "number" ? { seasonYear: obj.seasonYear } : {}),
      games,
    };
  } catch {
    return undefined;
  }
}

export function shouldRefreshSlate(
  slate: Slate | undefined,
  nowMs: number,
  config: SchedulerConfig,
  { force = false } = {},
): { refresh: boolean; reason: string } {
  if (!slate || slate.games.length === 0) {
    return { refresh: true, reason: "slate-empty" };
  }

  const refreshedAt = parseKickoffMs(slate.refreshedAt) ?? 0;
  const age = nowMs - refreshedAt;

  if (force && age >= 60 * 60_000) {
    return { refresh: true, reason: "forced" };
  }

  if (age >= config.slateMaxAgeMs) {
    return { refresh: true, reason: "slate-stale" };
  }

  if (!hasRemainingKickoff(slate.games, nowMs, config.postKickoffMs)) {
    if (age >= config.refreshMinIntervalMs) {
      return { refresh: true, reason: "next-kickoff-missing" };
    }
    return { refresh: false, reason: "next-kickoff-missing-backoff" };
  }

  return { refresh: false, reason: "slate-fresh" };
}

export function shouldDispatch(
  lastDispatchAt: string | undefined,
  nowMs: number,
  cooldownMs: number,
): { dispatch: boolean; reason: string } {
  if (!lastDispatchAt) return { dispatch: true, reason: "never-dispatched" };
  const last = parseKickoffMs(lastDispatchAt);
  if (last === undefined) return { dispatch: true, reason: "never-dispatched" };
  if (nowMs - last < cooldownMs) {
    return { dispatch: false, reason: "dispatch-cooldown" };
  }
  return { dispatch: true, reason: "cooldown-elapsed" };
}
