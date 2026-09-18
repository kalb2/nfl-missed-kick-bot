import { fetchNflSlate } from "./espn.js";
import type { GitHubDispatcher, SchedulerConfig, Slate, SlateStore, StoredGame, TickResult } from "./types.js";
import { LAST_DISPATCH_KEY, SLATE_KEY } from "./types.js";
import {
  gamesInWindow,
  nextKickoffIso,
  parseSlate,
  shouldDispatch,
  shouldRefreshSlate,
} from "./window.js";

export interface SchedulerDeps {
  kv: SlateStore;
  config: SchedulerConfig;
  fetchImpl?: typeof fetch;
  github: GitHubDispatcher;
}

export async function loadSlate(kv: SlateStore): Promise<Slate | undefined> {
  return parseSlate(await kv.get(SLATE_KEY));
}

export async function loadLastDispatchAt(kv: SlateStore): Promise<string | undefined> {
  const raw = await kv.get(LAST_DISPATCH_KEY);
  return raw || undefined;
}

export async function saveSlate(kv: SlateStore, slate: Slate): Promise<void> {
  await kv.put(SLATE_KEY, JSON.stringify(slate));
}

export async function saveLastDispatchAt(kv: SlateStore, iso: string): Promise<void> {
  await kv.put(LAST_DISPATCH_KEY, iso);
}

export async function refreshStoredSlate(
  deps: SchedulerDeps,
  nowMs: number,
): Promise<{ slate: Slate; espnCalls: number }> {
  const { slate, espnCalls } = await fetchNflSlate({
    fetchImpl: deps.fetchImpl,
    userAgent: deps.config.userAgent,
    nowMs,
    lookaheadMs: deps.config.lookaheadMs,
    lookbackMs: deps.config.postKickoffMs,
  });
  await saveSlate(deps.kv, slate);
  return { slate, espnCalls };
}

export async function runTick(
  deps: SchedulerDeps,
  nowMs: number,
  { forceRefresh = false } = {},
): Promise<TickResult> {
  const nowIso = new Date(nowMs).toISOString();
  let slate = await loadSlate(deps.kv);
  const lastDispatchAt = await loadLastDispatchAt(deps.kv);
  let espnCalls = 0;
  let refreshed = false;

  const refresh = shouldRefreshSlate(slate, nowMs, deps.config, { force: forceRefresh });
  if (refresh.refresh) {
    const result = await refreshStoredSlate(deps, nowMs);
    slate = result.slate;
    espnCalls = result.espnCalls;
    refreshed = true;
  }

  const games = slate?.games ?? [];
  const live = gamesInWindow(games, nowMs, deps.config);
  const nextKickoff = nextKickoffIso(games, nowMs);

  if (live.length === 0) {
    return {
      action: "idle",
      now: nowIso,
      refreshed,
      espnCalls,
      live,
      ...(nextKickoff ? { nextKickoff } : {}),
      ...(lastDispatchAt ? { lastDispatchAt } : {}),
      reason: refreshed ? `${refresh.reason};no-live-window` : refresh.reason,
    };
  }

  if (!deps.config.githubToken) {
    return {
      action: "no-token",
      now: nowIso,
      refreshed,
      espnCalls,
      live,
      ...(nextKickoff ? { nextKickoff } : {}),
      ...(lastDispatchAt ? { lastDispatchAt } : {}),
      reason: "missing-github-token",
    };
  }

  const gate = shouldDispatch(lastDispatchAt, nowMs, deps.config.dispatchCooldownMs);
  if (!gate.dispatch) {
    return {
      action: "cooldown",
      now: nowIso,
      refreshed,
      espnCalls,
      live,
      ...(nextKickoff ? { nextKickoff } : {}),
      ...(lastDispatchAt ? { lastDispatchAt } : {}),
      reason: gate.reason,
    };
  }

  await deps.github.dispatch({
    owner: deps.config.githubOwner,
    repo: deps.config.githubRepo,
    eventType: deps.config.githubEventType,
    token: deps.config.githubToken,
    payload: {
      reason: "live-window",
      dispatchedAt: nowIso,
      games: live.map((game: StoredGame) => ({
        id: game.id,
        name: game.name,
        kickoff: game.kickoff,
      })),
    },
  });
  await saveLastDispatchAt(deps.kv, nowIso);

  return {
    action: "dispatched",
    now: nowIso,
    refreshed,
    espnCalls,
    live,
    ...(nextKickoff ? { nextKickoff } : {}),
    lastDispatchAt: nowIso,
    reason: gate.reason,
  };
}

export function logTick(result: TickResult): void {
  console.log(
    JSON.stringify({
      message: "scheduler-tick",
      action: result.action,
      reason: result.reason,
      refreshed: result.refreshed,
      espnCalls: result.espnCalls,
      liveCount: result.live.length,
      live: result.live.map((game) => game.name),
      nextKickoff: result.nextKickoff ?? null,
    }),
  );
}
