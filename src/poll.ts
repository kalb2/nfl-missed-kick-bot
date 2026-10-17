import { missAlert, snapshotOf, type AlertSink } from "./alerts.js";
import { AlertRouter } from "./alerts.js";
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
  nullifiedReason,
} from "./detect.js";
import { REGULAR_SEASON_TYPE, contextFromEvent, isWatchableGame, mapPool, type EspnClient } from "./espn.js";
import { UNKNOWN_KICKER, type IssueRef, type MissNotifier, LogNotifier, LogStateAlerter } from "./notify.js";
import { Overrides } from "./overrides.js";
import type { HandledEntry, SeenStore } from "./store.js";
import { SeasonTallyIndex } from "./tallies.js";
import type { TweetPoster } from "./twitter.js";
import type { GameContext, GameSummary, MissedKick, Play, PollOptions, PollResult, ScoreboardEvent } from "./types.js";

export interface PollDeps {
  espn: EspnClient;
  store: SeenStore;
  poster: TweetPoster;
  tallies?: SeasonTallyIndex;
  /** GitHub issue operations (find / open / resolve / openAlert). */
  notifier?: MissNotifier;
  /** Where alerts go. Defaults to GitHub issues through `notifier`. */
  alerts?: AlertSink;
  overrides?: Overrides;
  /** Injectable clock / sleep for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Same-run recheck: wait this long, re-fetch, post only if the play still matches. */
export const DEFAULT_RECHECK_DELAY_MS = 60_000;

/**
 * What must stay identical between detection and the recheck. Kicker is
 * compared by first-initial + last name so "J.Myers" vs "Jason Myers" (profile
 * lookup flakiness) doesn't count as a change; text is not compared because
 * ESPN appends injury notes etc. without changing the ruling.
 */
export function missFingerprint(miss: MissedKick): string {
  const kicker =
    miss.kicker === UNKNOWN_KICKER
      ? "unknown"
      : initialLastCompact(miss.kicker) ?? compactKickerName(miss.kicker);
  return [miss.playId, miss.kickType, miss.playType ?? "", miss.result, kicker].join("|");
}

interface GameWork {
  event: ScoreboardEvent;
  /** New misses waiting for the recheck. */
  candidates: Map<string, MissedKick>;
  /** Posted misses that no longer look like misses on this fetch. */
  suspects: HandledEntry[];
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function playTexts(play?: Play): string[] {
  if (!play) return [];
  return [play.text, play.shortText, ...(play.altTexts ?? [])].filter((t): t is string => Boolean(t));
}

/** Why a play that used to be a miss isn't one in this summary. */
function whyNotAMiss(summary: GameSummary, playId: string): { why: string; play?: Play } {
  const play = collectPlays(summary).find((p) => String(p.id) === playId);
  if (!play) return { why: "the play is no longer in ESPN's play-by-play" };
  const scoringIds = Array.isArray(summary.scoringPlays)
    ? new Set(summary.scoringPlays.map((p) => String(p?.id ?? "")).filter(Boolean))
    : undefined;
  const reason = nullifiedReason(play, scoringIds);
  return { why: reason ? `ESPN now shows it as ${reason}` : "ESPN no longer classifies it as a missed kick", play };
}

export async function pollOnce(deps: PollDeps, options: PollOptions): Promise<PollResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const recheckDelayMs = options.recheckDelayMs ?? DEFAULT_RECHECK_DELAY_MS;

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
      heldForRecheck: [],
      erasedAfterPosting: [],
      seasonGamesScanned: 0,
      seasonTallies: [],
    };
  }

  const overrides = deps.overrides ?? new Overrides();
  const notifier = deps.notifier ?? new LogNotifier();
  const alerts = deps.alerts ?? new AlertRouter({ issues: notifier, stateIssues: new LogStateAlerter() });
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
  const heldForRecheck: MissedKick[] = [];
  const erasedAfterPosting: string[] = [];
  const confirmed: MissedKick[] = [];
  const work: GameWork[] = [];

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

  // Pass 1: detect. New misses and posted-but-now-missing plays queue for the recheck.
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
    const misses = await analyze(event, summary);
    const present = new Set(misses.map((m) => m.playId));
    const item: GameWork = { event, candidates: new Map(), suspects: [] };
    for (const miss of misses) {
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
      // Already reported as needing a manual post and still unnamed: nothing new to check.
      if (
        miss.kicker === UNKNOWN_KICKER &&
        (deps.store.notifiedIssue(miss.playId) !== undefined || deps.store.alertRecord("needs_manual_post", miss.playId, miss.eventId))
      ) {
        held.push(miss);
        continue;
      }
      item.candidates.set(miss.playId, miss);
    }
    // Keep watching what we posted until the game's window closes.
    for (const entry of deps.store.postedForEvent(event.id)) {
      if (present.has(entry.playId)) continue;
      if (deps.store.alertRecord("posted_miss_erased", entry.playId, entry.eventId)) continue;
      item.suspects.push(entry);
    }
    if (item.candidates.size || item.suspects.length) work.push(item);
  });

  // Pass 2: one shared wait, then re-fetch every game that has something to verify.
  if (work.length) {
    const count = work.reduce((n, w) => n + w.candidates.size + w.suspects.length, 0);
    console.log("rechecking %d play(s) in %d game(s) after %d ms", count, work.length, recheckDelayMs);
    if (recheckDelayMs > 0) await sleep(recheckDelayMs);
    for (const { event, candidates, suspects } of work) {
      let summary: GameSummary;
      try {
        summary = await deps.espn.getSummary(event.id, { bypassCache: true });
      } catch (err) {
        console.warn("recheck fetch failed for %s: %s; holding %d miss(es) for next poll", event.id, (err as Error).message, candidates.size);
        heldForRecheck.push(...candidates.values());
        continue;
      }
      const again = new Map((await analyze(event, summary)).map((m) => [m.playId, m]));

      for (const [playId, first] of candidates) {
        const second = again.get(playId);
        if (second && missFingerprint(second) === missFingerprint(first)) {
          confirmed.push(second);
          continue;
        }
        const why = second
          ? `changed on recheck (${missFingerprint(first)} → ${missFingerprint(second)})`
          : whyNotAMiss(summary, playId).why;
        console.log("HOLD play %s (%s): %s; re-evaluating next poll", playId, first.matchup, why);
        heldForRecheck.push(second ?? first);
      }

      for (const entry of suspects) {
        if (again.has(entry.playId)) continue; // transient: it's a miss again
        const snap = entry.snapshot!;
        const { why, play } = whyNotAMiss(summary, entry.playId);
        const payload = missAlert(
          "posted_miss_erased",
          snap,
          `The tweeted ${snap.kickType} miss by ${snap.kicker} (${snap.teamAbbr}) at ${snap.quarter} ${snap.clock} in ${snap.matchup} is no longer a miss: ${why}. The tweet was not deleted.`,
          { tweetId: entry.tweetId, rawTexts: [...playTexts(play), snap.playText, ...(snap.altPlayTexts ?? [])] },
        );
        const delivery = await alerts.send(payload);
        if (delivery.via !== "failed") {
          deps.store.recordAlert("posted_miss_erased", entry.playId, entry.eventId, {
            at: new Date(now()).toISOString(),
            via: delivery.via,
            ...(delivery.issue ? { issue: delivery.issue.number } : {}),
          });
          erasedAfterPosting.push(entry.playId);
        }
      }
    }
  }

  // Confirmed misses → needs-manual-post alert (unknown kicker) or the post queue.
  const toPost: Array<{ miss: MissedKick; tweet: string; issueRef?: IssueRef; pendingIssue?: number }> = [];
  for (const miss of confirmed) {
    // Never guess the kicker: hold the miss and ask Kaleb to post it by hand.
    if (miss.kicker === UNKNOWN_KICKER) {
      held.push(miss);
      const delivery = await alerts.send(
        missAlert(
          "needs_manual_post",
          miss,
          `The bot detected a missed ${miss.kickType} in ${miss.matchup} (${miss.quarter} ${miss.clock}) but no ESPN text names the kicker, so it did not tweet it.`,
        ),
        { miss },
      );
      if (delivery.via === "failed") continue; // retried next poll
      deps.store.recordAlert("needs_manual_post", miss.playId, miss.eventId, {
        at: new Date(now()).toISOString(),
        via: delivery.via,
        ...(delivery.issue ? { issue: delivery.issue.number } : {}),
      });
      if (delivery.issue) {
        deps.store.setNotified(miss.playId, delivery.issue.number);
        if (delivery.issue.state === "closed") deps.store.markHandled(miss.playId, miss.eventId, "manual");
      }
      continue;
    }

    // Name resolved on a later poll: only tweet if Kaleb hasn't handled the issue.
    const pendingIssue = deps.store.notifiedIssue(miss.playId);
    let issueRef: IssueRef | undefined;
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
    for (const { miss } of toPost) deps.store.markHandled(miss.playId, miss.eventId, "posting", undefined, snapshotOf(miss));
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
          const msg = (err as Error).message;
          console.error("tweet failed for play %s: %s", miss.playId, msg);
          deps.store.markHandled(miss.playId, miss.eventId, "failed");
          if (deps.store.alertRecord("tweet_failed", miss.playId, miss.eventId)) continue;
          const delivery = await alerts.send(
            missAlert(
              "tweet_failed",
              miss,
              `The tweet for ${miss.kicker}'s missed ${miss.kickType} in ${miss.matchup} (${miss.quarter} ${miss.clock}) failed (${msg}); check the account and post it by hand if it is missing.`,
            ),
            { miss },
          );
          if (delivery.via !== "failed") {
            deps.store.recordAlert("tweet_failed", miss.playId, miss.eventId, {
              at: new Date(now()).toISOString(),
              via: delivery.via,
              ...(delivery.issue ? { issue: delivery.issue.number } : {}),
            });
            if (delivery.issue) deps.store.setNotified(miss.playId, delivery.issue.number);
          }
        }
      }
    }
  }

  if (options.persist && !stateWriteError) {
    try {
      await deps.store.save({ message: posted ? `Record ${posted} posted miss(es)` : "Update bot state" });
    } catch (err) {
      stateWriteError = (err as Error).message;
      console.error("STATE WRITE FAILED after poll: %s", stateWriteError);
    }
  }
  if (options.persist) await tallies.save();

  return {
    gamesScanned: events.length,
    missesFound: newMisses.length + skippedSeen + heldForRecheck.length + held.length,
    newMisses,
    posted,
    skippedSeen,
    tweets,
    heldForManualPost: held,
    heldForRecheck,
    erasedAfterPosting,
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
    "[%s] scanned %d game(s), %d miss(es) total, %d new, %d posted, %d already seen, %d held for recheck",
    mode,
    result.gamesScanned,
    result.missesFound,
    result.newMisses.length,
    result.posted,
    result.skippedSeen,
    result.heldForRecheck?.length ?? 0,
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
