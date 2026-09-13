import { composeTweet } from "./compose.js";
import { buildGameContext, detectMissedKicks } from "./detect.js";
import { EspnClient, isWatchableGame, mapPool } from "./espn.js";
import type { SeenStore } from "./store.js";
import type { TweetPoster } from "./twitter.js";
import type { GameContext, MissedKick, PollOptions, PollResult, ScoreboardEvent } from "./types.js";

export interface PollDeps {
  espn: EspnClient;
  store: SeenStore;
  poster: TweetPoster;
}

export async function pollOnce(deps: PollDeps, options: PollOptions): Promise<PollResult> {
  const board = await deps.espn.getScoreboard();
  const events = (board.events ?? []).filter((event) =>
    isWatchableGame(event, Date.now(), options.recentFinalWindowMin, {
      allToday: options.allToday,
    }),
  );

  const tweets: string[] = [];
  const newMisses: MissedKick[] = [];
  let skippedSeen = 0;
  let posted = 0;

  await mapPool(events, deps.espn.concurrency, async (event) => {
    const game = contextFromEvent(event);
    let summary;
    try {
      summary = await deps.espn.getSummary(event.id);
    } catch (err) {
      console.warn("summary failed for %s (%s): %s", event.id, game.shortName, (err as Error).message);
      return;
    }
    const ctx = buildGameContext(event.id, summary, game);
    const misses = detectMissedKicks(summary, ctx);
    for (const miss of misses) {
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
  }

  return {
    gamesScanned: events.length,
    missesFound: newMisses.length + skippedSeen,
    newMisses,
    posted,
    skippedSeen,
    tweets,
  };
}

export function contextFromEvent(event: ScoreboardEvent): GameContext {
  const competition = event.competitions?.[0];
  return {
    eventId: event.id,
    shortName: event.shortName || event.name || event.id,
    date: event.date || competition?.date,
    statusState: event.status?.type?.state || competition?.status?.type?.state,
    competitors: competition?.competitors ?? [],
  };
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
}
