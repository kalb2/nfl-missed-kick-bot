import { composeTweet } from "./compose.js";
import {
  attachAvailableWinProbability,
  buildGameContext,
  collectPlays,
  compactKickerName,
  detectMissedKicks,
  enrichKickerNames,
  initialLastCompact,
  missesNeedWinProbability,
} from "./detect.js";
import { REGULAR_SEASON_TYPE, contextFromEvent, isWatchableGame, mapPool, type EspnClient } from "./espn.js";
import { UNKNOWN_KICKER, type MissNotifier, LogNotifier } from "./notify.js";
import { Overrides } from "./overrides.js";
import type { SeenStore } from "./store.js";
import { SeasonTallyIndex } from "./tallies.js";
import type { TweetPoster } from "./twitter.js";
import type { GameContext, GameSummary, MissedKick, PollOptions, PollResult, ScoreboardEvent } from "./types.js";

export interface PollDeps {
  espn: EspnClient;
  store: SeenStore;
  poster: TweetPoster;
  tallies?: SeasonTallyIndex;
  notifier?: MissNotifier;
  overrides?: Overrides;
  /** Injectable clock / sleep for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_CONFIRM_POLLS = 2;
export const DEFAULT_MIN_CONFIRM_GAP_MS = 60_000;
export const DEFAULT_FINAL_REFETCH_DELAY_MS = 90_000;
export const DEFAULT_FINAL_CONFIRM_WINDOW_MIN = 12;

/**
 * What must stay identical between the two sightings. Kicker is compared by
 * first-initial + last name so "J.Myers" vs "Jason Myers" (profile lookup
 * flakiness) doesn't reset the clock; text is not compared because ESPN
 * appends injury notes etc. without changing the ruling.
 */
export function missFingerprint(miss: MissedKick): string {
  const kicker =
    miss.kicker === UNKNOWN_KICKER
      ? "unknown"
      : initialLastCompact(miss.kicker) ?? compactKickerName(miss.kicker);
  return [miss.playId, miss.kickType, miss.playType ?? "", miss.result, kicker].join("|");
}

/**
 * True when the Worker / bot watch window for this game closes soon, so the
 * next scheduled poll may never come. The Worker dispatches until kickoff +
 * POST_KICKOFF_MIN (285 = 4h + 45m) and the bot watches finals for the same span.
 */
export function nearWatchWindowEnd(
  event: ScoreboardEvent,
  now: number,
  recentFinalWindowMin: number,
  finalConfirmWindowMin = DEFAULT_FINAL_CONFIRM_WINDOW_MIN,
): boolean {
  const start = Date.parse(event.date || event.competitions?.[0]?.date || "");
  if (!Number.isFinite(start)) return false;
  const watchUntil = start + (4 * 60 + recentFinalWindowMin) * 60_000;
  return now >= watchUntil - finalConfirmWindowMin * 60_000;
}

interface QueuedMiss {
  miss: MissedKick;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function pollOnce(deps: PollDeps, options: PollOptions): Promise<PollResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const confirmPolls = options.confirmPolls ?? DEFAULT_CONFIRM_POLLS;
  const minGapMs = options.minConfirmGapMs ?? DEFAULT_MIN_CONFIRM_GAP_MS;

  const board = await deps.espn.getScoreboard();
  const events = (board.events ?? []).filter((event) =>
    isWatchableGame(event, now(), options.recentFinalWindowMin, {
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
      awaitingConfirmation: [],
      seasonGamesScanned: 0,
      seasonTallies: [],
    };
  }

  const overrides = deps.overrides ?? new Overrides();
  const notifier = deps.notifier ?? new LogNotifier();
  for (const o of overrides.alreadyPostedPlays()) {
    if (!deps.store.has(o.playId)) deps.store.markHandled(o.playId, o.eventId, "manual");
  }
  const tallies = deps.tallies ?? new SeasonTallyIndex(undefined, overrides);
  await tallies.refresh(deps.espn, board);

  const tweets: string[] = [];
  const newMisses: MissedKick[] = [];
  let skippedSeen = 0;
  let posted = 0;
  const held: MissedKick[] = [];
  const awaiting = new Map<string, MissedKick>();
  const confirmed: QueuedMiss[] = [];
  const finalRecheck: Array<{ event: ScoreboardEvent; playIds: Set<string> }> = [];

  const analyze = async (event: ScoreboardEvent, summary: GameSummary): Promise<MissedKick[]> => {
    const game = contextFromEvent(event);
    const ctx = buildGameContext(event.id, summary, game);
    const misses = detectMissedKicks(summary, ctx);
    await enrichKickerNames(deps.espn, misses);
    const plays = collectPlays(summary);
    if (missesNeedWinProbability(misses, plays)) {
      try {
        const extra = await deps.espn.getWinProbability(event.id);
        attachAvailableWinProbability(misses, plays, extra);
      } catch (err) {
        console.warn("win probability failed for %s (%s): %s", event.id, game.shortName, (err as Error).message);
      }
    }
    for (const miss of misses) {
      overrides.apply(miss);
      if (shouldAttachSeason(ctx, board.season?.type)) tallies.attachTo(miss);
    }
    return misses;
  };

  /** Records one sighting. Returns true when this sighting confirms the miss. */
  const observe = (miss: MissedKick): boolean => {
    if (confirmPolls <= 1) return true;
    const fp = missFingerprint(miss);
    const pending = deps.store.getPending(miss.playId, miss.eventId);
    const t = now();
    if (pending && pending.fingerprint === fp) {
      const age = t - Date.parse(pending.firstSeenAt);
      if (age >= minGapMs) return true;
      return false; // same run or back-to-back runs: wait for a genuinely later poll
    }
    if (pending) {
      console.log("play %s changed between polls (%s → %s); restarting confirmation", miss.playId, pending.fingerprint, fp);
    }
    deps.store.setPending({
      playId: miss.playId,
      ...(miss.eventId ? { eventId: miss.eventId } : {}),
      fingerprint: fp,
      firstSeenAt: new Date(t).toISOString(),
    });
    return false;
  };

  await mapPool(events, deps.espn.concurrency, async (event) => {
    const game = contextFromEvent(event);
    let summary = tallies.getSummary(event.id);
    if (!summary) {
      try {
        summary = await deps.espn.getSummary(event.id);
      } catch (err) {
        // Leave this game's pending sightings alone: no observation happened.
        console.warn("summary failed for %s (%s): %s", event.id, game.shortName, (err as Error).message);
        return;
      }
    }
    const misses = await analyze(event, summary);
    const present = new Set<string>();
    const waiting = new Set<string>();
    for (const miss of misses) {
      present.add(miss.playId);
      if (deps.store.has(miss.playId)) {
        skippedSeen += 1;
        continue;
      }
      if (options.seedSeen) {
        newMisses.push(miss);
        tweets.push(composeTweet(miss));
        deps.store.markHandled(miss.playId, miss.eventId, "seeded");
        continue;
      }
      if (observe(miss)) {
        // Pending stays until the play is marked handled, so an unknown-kicker
        // miss that stays unchanged doesn't rewrite state every poll.
        confirmed.push({ miss });
      } else {
        awaiting.set(miss.playId, miss);
        waiting.add(miss.playId);
      }
    }
    // A miss seen last poll that is gone now (penalty enforced, play deleted,
    // reclassified) is dropped; if it ever comes back it starts over.
    for (const p of deps.store.pendingForEvent(event.id)) {
      if (!present.has(p.playId)) {
        console.log("play %s (%s) no longer a miss on this poll; dropping pending sighting", p.playId, game.shortName);
        deps.store.deletePending(p.playId, p.eventId);
      }
    }
    if (
      waiting.size &&
      confirmPolls > 1 &&
      !options.allToday &&
      nearWatchWindowEnd(event, now(), options.recentFinalWindowMin, options.finalConfirmWindowMin)
    ) {
      finalRecheck.push({ event, playIds: waiting });
    }
  });

  // Last poll for a game: there may be no next dispatch, so the second sighting
  // comes from a fresh re-fetch inside this run.
  if (finalRecheck.length) {
    const delay = options.finalRefetchDelayMs ?? DEFAULT_FINAL_REFETCH_DELAY_MS;
    console.log("watch window closing for %d game(s); re-fetching in %d ms to confirm", finalRecheck.length, delay);
    await sleep(delay);
    for (const { event, playIds } of finalRecheck) {
      let summary: GameSummary;
      try {
        summary = await deps.espn.getSummary(event.id, { bypassCache: true });
      } catch (err) {
        console.warn("final re-fetch failed for %s: %s", event.id, (err as Error).message);
        continue;
      }
      const again = new Map((await analyze(event, summary)).map((m) => [m.playId, m]));
      for (const playId of playIds) {
        const first = awaiting.get(playId)!;
        const second = again.get(playId);
        if (!second) {
          deps.store.deletePending(playId, first.eventId);
          awaiting.delete(playId);
          continue;
        }
        if (missFingerprint(second) === missFingerprint(first)) {
          awaiting.delete(playId);
          confirmed.push({ miss: second });
        } else {
          observe(second); // record the newer version; a later poll (if any) can confirm it
          awaiting.set(playId, second);
        }
      }
    }
  }

  // Confirmed misses → manual-post issue (unknown kicker) or the post queue.
  const toPost: Array<{ miss: MissedKick; tweet: string; issueRef?: Awaited<ReturnType<MissNotifier["find"]>>; pendingIssue?: number }> = [];
  for (const { miss } of confirmed) {
    // Never guess the kicker: hold the miss and ask Kaleb to post it by hand.
    if (miss.kicker === UNKNOWN_KICKER) {
      held.push(miss);
      if (deps.store.notifiedIssue(miss.playId) !== undefined) continue;
      try {
        const issue = (await notifier.find(miss.playId)) ?? (await notifier.open(miss));
        deps.store.setNotified(miss.playId, issue.number);
        if (issue.state === "closed") deps.store.markHandled(miss.playId, miss.eventId, "manual");
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
        deps.store.markHandled(miss.playId, miss.eventId, "manual");
        deps.store.clearNotified(miss.playId);
        skippedSeen += 1;
        continue;
      }
    }
    toPost.push({ miss, tweet: composeTweet(miss), issueRef, pendingIssue });
  }

  let stateWriteError: string | undefined;
  if (toPost.length) {
    // Write-ahead: durably claim every play BEFORE posting. If this save fails
    // nothing is posted; if the run dies after posting, the claim is already
    // stored, so the miss can never be posted twice.
    for (const { miss } of toPost) deps.store.markHandled(miss.playId, miss.eventId, "posting");
    if (options.persist) {
      try {
        await deps.store.save({ message: `Claim ${toPost.length} miss(es) before posting` });
      } catch (err) {
        stateWriteError = (err as Error).message;
        console.error("STATE WRITE FAILED before posting; posting nothing: %s", stateWriteError);
      }
    }
    if (!stateWriteError) {
      for (const item of toPost) {
        const { miss, tweet } = item;
        newMisses.push(miss);
        tweets.push(tweet);
        try {
          const res = await deps.poster.post(tweet);
          posted += 1;
          deps.store.markHandled(miss.playId, miss.eventId, options.dryRun ? "dry-run" : "posted", res?.id);
          if (item.pendingIssue !== undefined) {
            deps.store.clearNotified(miss.playId);
            if (item.issueRef) {
              await notifier
                .resolve(item.issueRef, `Kicker resolved to ${miss.kicker} on a later poll; the bot tweeted it:\n\n${tweet}`)
                .catch((e) => console.warn("closing issue failed: %s", (e as Error).message));
            }
          }
        } catch (err) {
          // Don't retry: the request may have reached X. Ask for a manual check instead.
          console.error("tweet failed for play %s: %s", miss.playId, (err as Error).message);
          deps.store.markHandled(miss.playId, miss.eventId, "failed");
          try {
            const issue =
              (await notifier.find(miss.playId)) ??
              (await notifier.open(miss, `The tweet failed (${(err as Error).message}). Check @NFLKickerMisses; if it is not there, post it by hand.`));
            deps.store.setNotified(miss.playId, issue.number);
          } catch (e) {
            console.error("manual-post notification failed for play %s: %s", miss.playId, (e as Error).message);
          }
        }
      }
    }
  }

  if (options.persist && !stateWriteError) {
    try {
      await deps.store.save({ message: posted ? `Record ${posted} posted miss(es)` : "Update pending sightings" });
    } catch (err) {
      stateWriteError = (err as Error).message;
      console.error("STATE WRITE FAILED after poll: %s", stateWriteError);
    }
  }
  if (options.persist) await tallies.save();

  return {
    gamesScanned: events.length,
    missesFound: newMisses.length + skippedSeen + awaiting.size + held.length,
    newMisses,
    posted,
    skippedSeen,
    tweets,
    heldForManualPost: held,
    awaitingConfirmation: [...awaiting.values()],
    ...(stateWriteError ? { stateWriteError } : {}),
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
    "[%s] scanned %d game(s), %d miss(es) total, %d new, %d posted, %d already seen, %d awaiting confirmation",
    mode,
    result.gamesScanned,
    result.missesFound,
    result.newMisses.length,
    result.posted,
    result.skippedSeen,
    result.awaitingConfirmation?.length ?? 0,
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
