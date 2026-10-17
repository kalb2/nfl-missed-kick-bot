import { AlertRouter } from "./alerts.js";
import { loadConfig, type AppConfig } from "./config.js";
import { EspnClient } from "./espn.js";
import { summarizeResult } from "./poll.js";
import { createNotifier, createStateAlerter } from "./notify.js";
import { Overrides } from "./overrides.js";
import { bootstrapState, runGuardedPoll } from "./run.js";
import { FileStateBackend, GitHubBranchStateBackend, type StateBackend } from "./state-backend.js";
import { SeenStore } from "./store.js";
import { SeasonTallyIndex, tallyPathFromStatePath } from "./tallies.js";
import { createPoster } from "./twitter.js";
import type { PollOptions } from "./types.js";

type Command = "once" | "loop" | "dry-run";

interface Args {
  command: Command;
  fresh: boolean;
  allToday: boolean;
  seed: boolean;
  bootstrapState: boolean;
}

function parseArgs(argv: string[]): Args {
  const flags = new Set(argv.filter((a) => a.startsWith("-")));
  const positional = argv.filter((a) => !a.startsWith("-"));
  const command = (positional[0] as Command | undefined) ?? "once";
  if (command !== "once" && command !== "loop" && command !== "dry-run") {
    console.error("Usage: nfl-missed-kick-bot <once|loop|dry-run> [--fresh] [--all-today] [--seed] [--bootstrap-state]");
    process.exit(2);
  }
  return {
    command,
    fresh: flags.has("--fresh"),
    allToday: flags.has("--all-today") || command === "dry-run",
    seed: flags.has("--seed"),
    bootstrapState: flags.has("--bootstrap-state"),
  };
}

function createStateBackend(config: AppConfig): StateBackend {
  if (config.stateBackend === "github") {
    if (!config.githubRepo || !config.githubToken) {
      // Surfaced by runGuardedPoll as "could not load" → posting paused + alert.
      return {
        description: `github ${config.githubRepo ?? "?"}@${config.stateBranch}:${config.stateFile}`,
        read: async () => {
          throw new Error("STATE_BACKEND=github but GITHUB_REPOSITORY / GITHUB_TOKEN is not set");
        },
        write: async () => {
          throw new Error("STATE_BACKEND=github but GITHUB_REPOSITORY / GITHUB_TOKEN is not set");
        },
      };
    }
    return new GitHubBranchStateBackend({
      repo: config.githubRepo,
      token: config.githubToken,
      branch: config.stateBranch,
      filePath: config.stateFile,
    });
  }
  return new FileStateBackend(config.statePath);
}

/** Starts from an empty list without touching any backend (only ever used dry). */
class EmptyStateBackend implements StateBackend {
  readonly description = "empty in-memory state (--fresh)";
  async read() {
    return { data: { version: 2, handled: {}, pending: {} } };
  }
  async write() {
    return undefined;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig({
    // --fresh forgets what was posted, so it is only ever allowed dry.
    dryRun: args.command === "dry-run" || args.fresh ? true : undefined,
    seedSeen: args.seed || undefined,
  });
  const dryRun = config.dryRun;

  const backend = args.fresh ? new EmptyStateBackend() : createStateBackend(config);
  const store = new SeenStore(backend);
  const overrides = Overrides.load();
  const tallies = new SeasonTallyIndex(tallyPathFromStatePath(config.statePath), overrides);
  if (!args.fresh) {
    await tallies.load();
    if (tallies.size) console.log("Loaded season tally cache for %d game(s)", tallies.size);
  } else {
    console.log("Starting with empty handled-play state (--fresh, forced dry-run)");
  }

  const espn = new EspnClient({ userAgent: config.userAgent, concurrency: 2 });

  if (args.bootstrapState) {
    const out = await bootstrapState({
      store,
      espn,
      tallies,
      overrides,
      legacyPath: config.statePath,
      recentFinalWindowMin: config.recentFinalWindowMin,
    });
    console.log("bootstrap: %s (%d handled play(s) at %s)", out.reason, out.handled, backend.description);
    return;
  }

  const poster = createPoster(config, dryRun);
  const notifier = createNotifier(dryRun);
  const alerter = createStateAlerter(dryRun);
  // All alerts are deduplicated GitHub issues labelled bot-alert (no extra secrets).
  const alerts = new AlertRouter({ issues: notifier, stateIssues: alerter });

  const options: PollOptions = {
    dryRun,
    seedSeen: config.seedSeen,
    allToday: args.allToday,
    // Dry runs never write the durable list, so a demo run can't swallow a live miss.
    persist: !(dryRun && config.stateBackend === "github") && !args.fresh,
    recentFinalWindowMin: config.recentFinalWindowMin,
  };

  if (options.seedSeen) {
    console.log("SEED_SEEN is on: existing misses will be recorded, not tweeted.");
  }

  const run = async (): Promise<boolean> => {
    const outcome = await runGuardedPoll(
      {
        espn,
        store,
        poster,
        tallies,
        notifier,
        alerts,
        overrides,
        alerter,
        // Only meaningful when the handled list lives elsewhere (github backend).
        legacyPath: config.stateBackend === "github" ? config.statePath : undefined,
      },
      options,
    );
    if (outcome.result) {
      const result = outcome.result;
      summarizeResult(result, args.command);
      for (const miss of result.heldForManualPost ?? []) {
        console.log("HELD (unknown kicker, needs manual post): play %s %s %s %s", miss.playId, miss.matchup, miss.quarter, miss.clock);
      }
      for (const miss of result.heldForRecheck ?? []) {
        console.log("HELD (changed or erased on recheck, re-evaluated next poll): play %s %s %s %s %s", miss.playId, miss.matchup, miss.quarter, miss.clock, miss.kicker);
      }
      for (const playId of result.erasedAfterPosting ?? []) {
        console.log("ALERTED: posted miss %s was later erased/reversed (tweet not deleted)", playId);
      }
      for (const tweet of result.tweets) console.log("---\n%s", tweet);
    }
    return !outcome.blocked;
  };

  if (args.command === "loop") {
    console.log("Polling every %d ms. Ctrl+C to stop.", config.pollIntervalMs);
    let stopped = false;
    const stop = (): void => {
      stopped = true;
      console.log("Stopping after this poll...");
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    while (!stopped) {
      try {
        await run();
      } catch (err) {
        console.error("poll error: %s", (err as Error).message);
      }
      if (stopped) break;
      await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    }
    console.log("Stopped.");
    return;
  }

  if (!(await run())) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
