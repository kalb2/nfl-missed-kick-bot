import { readFile } from "node:fs/promises";
import type { EspnClient } from "./espn.js";
import type { StateAlerter } from "./notify.js";
import { Overrides } from "./overrides.js";
import { pollOnce, type PollDeps } from "./poll.js";
import type { SeenStore } from "./store.js";
import type { SeasonTallyIndex } from "./tallies.js";
import { DryRunPoster } from "./twitter.js";
import type { PollOptions, PollResult } from "./types.js";

export type GuardedPollOutcome =
  | { blocked: true; reason: string; result?: PollResult }
  | { blocked: false; result: PollResult };

async function alert(alerter: StateAlerter, reason: string): Promise<void> {
  // GitHub Actions turns ::error:: into a red annotation on the run.
  console.error("::error title=Bot state unavailable::%s", reason);
  try {
    await alerter.raise(reason);
  } catch (err) {
    console.error("could not open the state alert issue: %s", (err as Error).message);
  }
}

/**
 * Loads the handled-plays list, then polls. If the list can't be loaded (or
 * doesn't exist), nothing is fetched or posted: a missing list must never look
 * like "nothing handled yet", which is how old misses get re-posted.
 */
export async function runGuardedPoll(
  deps: PollDeps & { alerter: StateAlerter; legacyPath?: string },
  options: PollOptions,
): Promise<GuardedPollOutcome> {
  const where = deps.store.backend.description;
  let reason: string | undefined;
  try {
    const status = await deps.store.load();
    if (status === "missing") {
      reason = `Handled-plays state not found at ${where} (deleted, or never bootstrapped). Posting is paused until it is restored with poll.yml bootstrap_state.`;
    }
  } catch (err) {
    reason = `Could not load handled-plays state from ${where}: ${(err as Error).message}. Posting is paused.`;
  }
  if (reason) {
    await alert(deps.alerter, reason);
    return { blocked: true, reason };
  }
  console.log("Loaded %d handled play(s) from %s", deps.store.size, where);
  // Transition safety: union in the old Actions-cache seen.json when the runner
  // still has it. This can only ever suppress a post (never cause one), and it
  // covers misses the pre-upgrade code posted after bootstrap ran.
  if (deps.legacyPath) await importLegacyFile(deps.store, deps.legacyPath);
  await deps.alerter.clear().catch((err) => console.warn("closing state alert failed: %s", (err as Error).message));

  const result = await pollOnce(deps, options);
  if (result.stateWriteError) {
    const msg = `Could not save handled-plays state to ${where}: ${result.stateWriteError}. Nothing was posted after the failure.`;
    await alert(deps.alerter, msg);
    return { blocked: true, reason: msg, result };
  }
  return { blocked: false, result };
}

async function importLegacyFile(store: SeenStore, file: string): Promise<number> {
  try {
    const n = store.importLegacy(JSON.parse(await readFile(file, "utf8")) as unknown);
    if (n) console.log("imported %d play id(s) from legacy %s", n, file);
    return n;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("legacy %s unreadable: %s", file, (err as Error).message);
    }
    return 0;
  }
}

export interface BootstrapDeps {
  store: SeenStore;
  espn: EspnClient;
  tallies: SeasonTallyIndex;
  overrides?: Overrides;
  /** Old Actions-cache seen.json, imported if present. */
  legacyPath?: string;
  recentFinalWindowMin: number;
}

/**
 * One-time (or disaster-recovery) creation of the durable handled-plays list.
 * Marks as handled: the legacy cache list, override alreadyPosted plays, every
 * miss ESPN shows in this regular season, and every miss in games from the
 * last ~36h. Posts nothing. Refuses to touch an existing state document.
 */
export async function bootstrapState(deps: BootstrapDeps): Promise<{ created: boolean; handled: number; reason: string }> {
  const status = await deps.store.load(); // throws on real errors — never bootstrap over an unknown state
  if (status === "loaded") {
    return { created: false, handled: deps.store.size, reason: "state already exists; nothing to bootstrap" };
  }
  const overrides = deps.overrides ?? new Overrides();
  if (deps.legacyPath) await importLegacyFile(deps.store, deps.legacyPath);
  for (const o of overrides.alreadyPostedPlays()) deps.store.markHandled(o.playId, o.eventId, "manual");

  // Season-wide: every regular-season miss ESPN currently shows.
  const board = await deps.espn.getScoreboard();
  await deps.tallies.refresh(deps.espn, board);
  for (const game of deps.tallies.cachedGames()) {
    for (const miss of game.misses) {
      if (!deps.store.has(miss.playId)) deps.store.markHandled(miss.playId, game.eventId, "seeded");
    }
  }
  // Anything in the current window (also covers postseason games).
  await pollOnce(
    { espn: deps.espn, store: deps.store, poster: new DryRunPoster(), tallies: deps.tallies, overrides },
    {
      dryRun: true,
      seedSeen: true,
      allToday: true,
      persist: false,
      recentFinalWindowMin: deps.recentFinalWindowMin,
    },
  );
  await deps.store.save({ force: true, message: "Bootstrap bot state" });
  await deps.tallies.save();
  return { created: true, handled: deps.store.size, reason: "created" };
}
