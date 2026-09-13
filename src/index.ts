import { loadConfig } from "./config.js";
import { EspnClient } from "./espn.js";
import { pollOnce, summarizeResult } from "./poll.js";
import { SeenStore } from "./store.js";
import { SeasonTallyIndex, tallyPathFromStatePath } from "./tallies.js";
import { createPoster } from "./twitter.js";
import type { PollOptions } from "./types.js";

type Command = "once" | "loop" | "dry-run";

function parseArgs(argv: string[]): { command: Command; fresh: boolean; allToday: boolean; seed: boolean } {
  const flags = new Set(argv.filter((a) => a.startsWith("-")));
  const positional = argv.filter((a) => !a.startsWith("-"));
  const command = (positional[0] as Command | undefined) ?? "once";
  if (command !== "once" && command !== "loop" && command !== "dry-run") {
    console.error("Usage: nfl-missed-kick-bot <once|loop|dry-run> [--fresh] [--all-today] [--seed]");
    process.exit(2);
  }
  return {
    command,
    fresh: flags.has("--fresh"),
    allToday: flags.has("--all-today") || command === "dry-run",
    seed: flags.has("--seed"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig({
    dryRun: args.command === "dry-run" ? true : undefined,
    seedSeen: args.seed || undefined,
  });

  const store = new SeenStore(config.statePath);
  const tallies = new SeasonTallyIndex(tallyPathFromStatePath(config.statePath));
  if (!args.fresh) {
    await store.load();
    await tallies.load();
    console.log("Loaded %d seen play id(s) from %s", store.size, config.statePath);
    if (tallies.size) {
      console.log("Loaded season tally cache for %d game(s)", tallies.size);
    }
  } else {
    console.log("Starting with empty seen-play state (--fresh)");
  }

  const espn = new EspnClient({ userAgent: config.userAgent, concurrency: 2 });
  const forceDry = args.command === "dry-run";
  const poster = createPoster(config, forceDry);

  const options: PollOptions = {
    dryRun: forceDry || config.dryRun,
    seedSeen: args.seed || config.seedSeen,
    allToday: args.allToday,
    persist: true,
    recentFinalWindowMin: config.recentFinalWindowMin,
  };

  if (options.seedSeen) {
    console.log("SEED_SEEN is on: existing misses will be recorded, not tweeted.");
  }

  const run = async (): Promise<void> => {
    const result = await pollOnce({ espn, store, poster, tallies }, options);
    summarizeResult(result, args.command);
    if (result.tweets.length) {
      for (const tweet of result.tweets) {
        console.log("---\n%s", tweet);
      }
    }
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

  await run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
