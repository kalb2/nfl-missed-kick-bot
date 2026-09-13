import { composeTweet } from "./compose.js";
import { buildGameContext, detectMissedKicks } from "./detect.js";
import { REGULAR_SEASON_TYPE, contextFromEvent, isWatchableGame, mapPool, type EspnClient } from "./espn.js";
import type { SeenStore } from "./store.js";
import { SeasonTallyIndex } from "./tallies.js";
import type { TweetPoster } from "./twitter.js";
import type { GameContext, MissedKick, PollOptions, PollResult } from "./types.js";

export interface PollDeps {
  espn: EspnClient;
  store: SeenStore;
  poster: TweetPoster;
  tallies?: SeasonTallyIndex;
}

export async function pollOnce(deps: PollDeps, options: PollOptions): Promise<PollResult> {
  const board = await deps.espn.getScoreboard();
  const events = (board.events ?? []).filter((event) =>
    isWatchableGame(event, Date.now(), options.recentFinalWindowMin, {
      allToday: options.allToday,
    }),
  );

  const tallies = deps.tallies ?? new SeasonTallyIndex();
  await tallies.refresh(deps.espn, board);

  const tweets: string[] = [];
  const newMisses: MissedKick[] = [];
  let skippedSeen = 0;
  let posted = 0;

  await mapPool(events, deps.espn.concurrency, async (event) => {
    const game = contextFromEvent(event);
    let summary = tallies.getSummary(event.id);
    if (!summary) {
      try {
        summary = await deps.espn.getSummary(event.id);
      } catch (err) {
        console.warn("summary failed for %s (%s): %s", event.id, game.shortName, (err as Error).message);
        return;
      }
    }
    const ctx = buildGameContext(event.id, summary, game);
    const misses = detectMissedKicks(summary, ctx);
    for (const miss of misses) {
      if (shouldAttachSeason(ctx, board.season?.type)) {
        tallies.attachTo(miss);
      }
      if (deps.store.has(miss.playId)) {
        skippedSeen += 1;
        continue;
      }
      newMisses.push(miss);
      const tweet = composeTweet(miss);
      tweets.push(tweet);
      if (options.seedSeen) {
        deps.store.add(miss.playId);
        continue;
      }
      try {
        await deps.poster.post(tweet);
        posted += 1;
        deps.store.add(miss.playId);
      } catch (err) {
        console.error("tweet failed for play %s: %s", miss.playId, (err as Error).message);
      }
    }
  });

  if (options.persist) {
    await deps.store.save();
    await tallies.save();
  }

  return {
    gamesScanned: events.length,
    missesFound: newMisses.length + skippedSeen,
    newMisses,
    posted,
    skippedSeen,
    tweets,
    seasonGamesScanned: tallies.size,
    seasonTallies: tallies.leaderboard(),
  };
}

export { contextFromEvent };

function shouldAttachSeason(game: GameContext, boardSeasonType?: number): boolean {
  const type = game.seasonType ?? boardSeasonType;
  return type === undefined || type === REGULAR_SEASON_TYPE;
}

export function summarizeResult(result: PollResult, mode: string): void {
  console.log(
    "[%s] scanned %d game(s), %d miss(es) total, %d new, %d posted, %d already seen",
    mode,
    result.gamesScanned,
    result.missesFound,
    result.newMisses.length,
    result.posted,
    result.skippedSeen,
  );
  if (result.seasonGamesScanned !== undefined) {
    console.log(
      "[%s] season tallies from %d regular-season game(s)",
      mode,
      result.seasonGamesScanned,
    );
  }
  if (mode === "dry-run" && result.seasonTallies?.length) {
    for (const row of result.seasonTallies) {
      console.log(
        "[season] %s (%s): %d missed FG · %d missed PAT",
        row.kicker,
        row.teamAbbr,
        row.fg,
        row.pat,
      );
    }
  }
}
