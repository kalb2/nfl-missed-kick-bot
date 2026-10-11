import { composeTweet } from "./compose.js";
import {
  attachAvailableWinProbability,
  buildGameContext,
  collectPlays,
  detectMissedKicks,
  enrichKickerNames,
  missesNeedWinProbability,
} from "./detect.js";
import { REGULAR_SEASON_TYPE, contextFromEvent, isWatchableGame, mapPool, type EspnClient } from "./espn.js";
import { UNKNOWN_KICKER, type MissNotifier, LogNotifier } from "./notify.js";
import { Overrides } from "./overrides.js";
import type { SeenStore } from "./store.js";
import { SeasonTallyIndex } from "./tallies.js";
import type { TweetPoster } from "./twitter.js";
import type { GameContext, MissedKick, PollOptions, PollResult } from "./types.js";

export interface PollDeps {
  espn: EspnClient;
  store: SeenStore;
  poster: TweetPoster;
  tallies?: SeasonTallyIndex;
  notifier?: MissNotifier;
  overrides?: Overrides;
}

export async function pollOnce(deps: PollDeps, options: PollOptions): Promise<PollResult> {
  const board = await deps.espn.getScoreboard();
  const events = (board.events ?? []).filter((event) =>
    isWatchableGame(event, Date.now(), options.recentFinalWindowMin, {
      allToday: options.allToday,
    }),
  );

  // Cheap idle-cron exit: skip season-wide tally refreshes and per-game
  // summaries when the scoreboard has nothing in the watch window.
  if (events.length === 0) {
    console.log("No in-progress or recently finished games; exiting after scoreboard.");
    return {
      gamesScanned: 0,
      missesFound: 0,
      newMisses: [],
      posted: 0,
      skippedSeen: 0,
      tweets: [],
      seasonGamesScanned: 0,
      seasonTallies: [],
    };
  }

  const overrides = deps.overrides ?? new Overrides();
  const notifier = deps.notifier ?? new LogNotifier();
  for (const id of overrides.alreadyPostedIds()) deps.store.add(id);
  const tallies = deps.tallies ?? new SeasonTallyIndex(undefined, overrides);
  await tallies.refresh(deps.espn, board);

  const tweets: string[] = [];
  const newMisses: MissedKick[] = [];
  let skippedSeen = 0;
  let posted = 0;
  const held: MissedKick[] = [];

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
    await enrichKickerNames(deps.espn, misses);
    const plays = collectPlays(summary);
    if (missesNeedWinProbability(misses, plays)) {
      try {
        const extra = await deps.espn.getWinProbability(event.id);
        attachAvailableWinProbability(misses, plays, extra);
      } catch (err) {
        console.warn(
          "win probability failed for %s (%s): %s",
          event.id,
          game.shortName,
          (err as Error).message,
        );
      }
    }
    for (const miss of misses) {
      overrides.apply(miss);
      if (shouldAttachSeason(ctx, board.season?.type)) {
        tallies.attachTo(miss);
      }
      if (deps.store.has(miss.playId)) {
        skippedSeen += 1;
        continue;
      }
      if (options.seedSeen) {
        newMisses.push(miss);
        tweets.push(composeTweet(miss));
        deps.store.add(miss.playId);
        continue;
      }

      // Never guess the kicker: hold the miss and ask Kaleb to post it by hand.
      if (miss.kicker === UNKNOWN_KICKER) {
        held.push(miss);
        if (deps.store.notifiedIssue(miss.playId) !== undefined) continue;
        try {
          const issue = (await notifier.find(miss.playId)) ?? (await notifier.open(miss));
          deps.store.setNotified(miss.playId, issue.number);
          if (issue.state === "closed") deps.store.add(miss.playId);
        } catch (err) {
          console.error("manual-post notification failed for play %s: %s", miss.playId, (err as Error).message);
        }
        continue;
      }

      // Name resolved on a later poll: only tweet if Kaleb hasn't handled the issue.
      const pendingIssue = deps.store.notifiedIssue(miss.playId);
      let issueRef: Awaited<ReturnType<MissNotifier["find"]>>;
      if (pendingIssue !== undefined) {
        try {
          issueRef = await notifier.find(miss.playId);
        } catch (err) {
          console.error("issue lookup failed for play %s: %s", miss.playId, (err as Error).message);
          continue; // fail closed: don't risk a duplicate of a manual post
        }
        if (issueRef?.state === "closed") {
          deps.store.add(miss.playId);
          deps.store.clearNotified(miss.playId);
          skippedSeen += 1;
          continue;
        }
      }

      newMisses.push(miss);
      const tweet = composeTweet(miss);
      tweets.push(tweet);
      try {
        await deps.poster.post(tweet);
        posted += 1;
        deps.store.add(miss.playId);
        if (pendingIssue !== undefined) {
          deps.store.clearNotified(miss.playId);
          if (issueRef) {
            await notifier
              .resolve(issueRef, `Kicker resolved to ${miss.kicker} on a later poll; the bot tweeted it:\n\n${tweet}`)
              .catch((err) => console.warn("closing issue failed: %s", (err as Error).message));
          }
        }
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
    heldForManualPost: held,
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
