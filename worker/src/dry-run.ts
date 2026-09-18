/**
 * Local / CI-friendly path: fetch ESPN, print the compact slate and live window.
 * Does not write KV, call GitHub, or tweet.
 *
 *   npm run dry-run
 *   npm run dry-run -- --at 2026-11-26T18:05:00Z
 */
import { testConfig } from "./config.js";
import { fetchNflSlate } from "./espn.js";
import { gamesInWindow, nextKickoffIso } from "./window.js";

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function denver(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Denver",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

async function main(): Promise<void> {
  const at = argValue("--at");
  const nowMs = at ? Date.parse(at) : Date.now();
  if (!Number.isFinite(nowMs)) {
    throw new Error(`Invalid --at timestamp: ${at}`);
  }

  const config = testConfig();
  const { slate, espnCalls } = await fetchNflSlate({
    userAgent: config.userAgent,
    nowMs,
    lookaheadMs: config.lookaheadMs,
    lookbackMs: config.postKickoffMs,
  });
  const live = gamesInWindow(slate.games, nowMs, config);
  const next = nextKickoffIso(slate.games, nowMs);

  console.log(
    JSON.stringify(
      {
        now: new Date(nowMs).toISOString(),
        espnCalls,
        refreshedAt: slate.refreshedAt,
        gameCount: slate.games.length,
        nextKickoff: next ?? null,
        nextKickoffDenver: next ? denver(next) : null,
        liveCount: live.length,
        wouldDispatch: live.length > 0,
        live: live.map((game) => ({
          name: game.name,
          kickoff: game.kickoff,
          kickoffDenver: denver(game.kickoff),
        })),
        slate: slate.games.map((game) => ({
          name: game.name,
          kickoff: game.kickoff,
          kickoffDenver: denver(game.kickoff),
          week: game.week,
        })),
      },
      null,
      2,
    ),
  );
}

await main();
