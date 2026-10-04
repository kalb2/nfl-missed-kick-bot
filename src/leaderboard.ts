import { composeLeaderboardTweet } from "./compose.js";
import type { EspnClient } from "./espn.js";
import { SeasonTallyIndex } from "./tallies.js";
import type { TweetPoster } from "./twitter.js";
import type { SeasonTallyRow } from "./types.js";

/** Kickers shown on the weekly season-to-date post. */
export const SEASON_LEADERBOARD_LIMIT = 5;

/**
 * Scheduled runs skip the post when the newest started regular-season
 * game is older than this. Tuesday 9:17 AM Denver is a few hours after
 * Monday Night Football, and every regular-season week has a game inside
 * this window. The frozen board is not re-posted every Tuesday after that.
 */
export const RECENT_REGULAR_SEASON_MS = 6 * 24 * 60 * 60 * 1000;

export interface LeaderboardDeps {
  espn: EspnClient;
  poster: TweetPoster;
  tallies?: SeasonTallyIndex;
}

export interface LeaderboardOptions {
  persist: boolean;
  limit?: number;
  /**
   * When true, do not post if no regular-season game has started inside
   * `recentWindowMs`. The weekly cron sets this. Manual runs leave it off
   * so a dispatch can still print or post the current board.
   */
  requireRecentGame?: boolean;
  recentWindowMs?: number;
  now?: number;
}

export interface LeaderboardResult {
  seasonYear?: number;
  week?: number;
  rows: SeasonTallyRow[];
  tweets: string[];
  posted: number;
  skippedReason?: "no-misses" | "no-recent-game";
}

/**
 * Refresh regular-season tallies from ESPN and post one leaderboard tweet.
 * Unlike `pollOnce`, this does not look at the live watch window: Tuesday
 * morning has no kickoff in that window, but prior weeks still count.
 */
export async function runSeasonLeaderboard(
  deps: LeaderboardDeps,
  options: LeaderboardOptions,
): Promise<LeaderboardResult> {
  const board = await deps.espn.getScoreboard();
  const tallies = deps.tallies ?? new SeasonTallyIndex();
  await tallies.refresh(deps.espn, board);

  const seasonYear = board.season?.year;
  const week = tallies.latestStartedWeek;
  const limit = options.limit ?? SEASON_LEADERBOARD_LIMIT;
  const rows = tallies.leaderboard().slice(0, Math.max(0, limit));

  const finish = async (result: LeaderboardResult): Promise<LeaderboardResult> => {
    if (options.persist) await tallies.save();
    return result;
  };

  if (rows.length === 0) {
    console.log("No regular-season misses; season leaderboard not posted.");
    return finish({ seasonYear, week, rows, tweets: [], posted: 0, skippedReason: "no-misses" });
  }

  if (options.requireRecentGame && !hasRecentRegularSeasonGame(tallies, options)) {
    console.log(
      "No regular-season game in the last %d days; season leaderboard not posted.",
      Math.round((options.recentWindowMs ?? RECENT_REGULAR_SEASON_MS) / 86_400_000),
    );
    return finish({ seasonYear, week, rows, tweets: [], posted: 0, skippedReason: "no-recent-game" });
  }

  const tweet = composeLeaderboardTweet({ seasonYear, week, rows });
  const tweets = [tweet];
  let posted = 0;
  try {
    await deps.poster.post(tweet);
    posted = 1;
  } catch (err) {
    console.error("leaderboard tweet failed: %s", (err as Error).message);
  }

  return finish({ seasonYear, week, rows, tweets, posted });
}

export function summarizeLeaderboard(result: LeaderboardResult): void {
  if (result.skippedReason === "no-misses") {
    console.log("[leaderboard] no regular-season misses; not posting");
    return;
  }
  if (result.skippedReason === "no-recent-game") {
    console.log("[leaderboard] no recent regular-season game; not posting");
    return;
  }
  console.log(
    "[leaderboard] season %s · week %s — %d kicker(s), posted %d",
    result.seasonYear ?? "?",
    result.week ?? "?",
    result.rows.length,
    result.posted,
  );
}

function hasRecentRegularSeasonGame(tallies: SeasonTallyIndex, options: LeaderboardOptions): boolean {
  const kickoff = tallies.latestKickoffMs;
  if (kickoff === undefined) return true;
  const now = options.now ?? Date.now();
  const windowMs = options.recentWindowMs ?? RECENT_REGULAR_SEASON_MS;
  return now - kickoff <= windowMs;
}
