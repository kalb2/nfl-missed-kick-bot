import { cronKind } from "./cron.js";
import { fetchNflSlate } from "./espn.js";
import { isGitHubDispatchError, publicErrorMessage } from "./github.js";
import type { GitHubDispatcher, SchedulerConfig, Slate, SlateStore, StoredGame, TickResult } from "./types.js";
import {
  LAST_DISPATCH_ERROR_KEY,
  LAST_DISPATCH_KEY,
  LAST_REFRESH_ATTEMPT_KEY,
  LAST_REFRESH_ERROR_KEY,
  SLATE_KEY,
} from "./types.js";
import {
  applySlateRefresh,
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
  return readKvText(kv, LAST_DISPATCH_KEY);
}

export async function loadLastRefreshError(kv: SlateStore): Promise<string | undefined> {
  return readKvText(kv, LAST_REFRESH_ERROR_KEY);
}

export async function loadLastDispatchError(kv: SlateStore): Promise<string | undefined> {
  return readKvText(kv, LAST_DISPATCH_ERROR_KEY);
}

async function readKvText(kv: SlateStore, key: string): Promise<string | undefined> {
  const raw = await kv.get(key);
  return raw || undefined;
}

async function putKvText(kv: SlateStore, key: string, value: string): Promise<void> {
  await kv.put(key, value);
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
): Promise<{ slate: Slate; espnCalls: number; kept: number }> {
  const previous = await loadSlate(deps.kv);
  const { slate, espnCalls } = await fetchNflSlate({
    fetchImpl: deps.fetchImpl,
    userAgent: deps.config.userAgent,
    nowMs,
    lookaheadMs: deps.config.lookaheadMs,
    lookbackMs: deps.config.postKickoffMs,
  });
  const applied = applySlateRefresh(previous, slate, nowMs, deps.config.postKickoffMs);
  if ("rejected" in applied) {
    throw new Error(applied.rejected);
  }
  await saveSlate(deps.kv, applied.slate);
  await putKvText(deps.kv, LAST_REFRESH_ERROR_KEY, "");
  return { slate: applied.slate, espnCalls, kept: applied.kept };
}

interface RefreshOutcome {
  slate: Slate | undefined;
  refreshed: boolean;
  espnCalls: number;
  reason: string;
  kept: number;
}

/**
 * Fetch ESPN when the policy says so. A failed fetch keeps the previous slate
 * and records the error. Dense ticks back off for REFRESH_MIN_INTERVAL_HOURS
 * after a failure so a dead ESPN does not get called every 2 minutes.
 * `always` is the Tue/Wed cron: it refreshes even when the slate still looks fresh.
 */
async function maybeRefresh(
  deps: SchedulerDeps,
  slate: Slate | undefined,
  nowMs: number,
  mode: "auto" | "always",
): Promise<RefreshOutcome> {
  let reason = "forced";
  if (mode === "auto") {
    let decision = shouldRefreshSlate(slate, nowMs, deps.config);
    if (decision.refresh) {
      const [attemptRaw, error] = await Promise.all([
        readKvText(deps.kv, LAST_REFRESH_ATTEMPT_KEY),
        readKvText(deps.kv, LAST_REFRESH_ERROR_KEY),
      ]);
      const attemptMs = attemptRaw ? Date.parse(attemptRaw) : NaN;
      if (
        error &&
        Number.isFinite(attemptMs) &&
        nowMs - attemptMs < deps.config.refreshMinIntervalMs
      ) {
        decision = { refresh: false, reason: "refresh-backoff" };
      }
    }
    if (!decision.refresh) {
      return { slate, refreshed: false, espnCalls: 0, reason: decision.reason, kept: 0 };
    }
    reason = decision.reason;
  }

  await putKvText(deps.kv, LAST_REFRESH_ATTEMPT_KEY, new Date(nowMs).toISOString());
  try {
    const result = await refreshStoredSlate(deps, nowMs);
    await putKvText(deps.kv, LAST_REFRESH_ERROR_KEY, "");
    const keptNote = result.kept > 0 ? `;kept-${result.kept}` : "";
    return {
      slate: result.slate,
      refreshed: true,
      espnCalls: result.espnCalls,
      reason: `${reason}${keptNote}`,
      kept: result.kept,
    };
  } catch (error) {
    const message = publicErrorMessage(error);
    await putKvText(deps.kv, LAST_REFRESH_ERROR_KEY, message);
    return {
      slate,
      refreshed: false,
      espnCalls: 0,
      reason: `${reason};refresh-failed`,
      kept: 0,
    };
  }
}

/** Midweek cron: always refresh KV from ESPN; never wake Actions. */
export async function runRefreshOnly(deps: SchedulerDeps, nowMs: number): Promise<TickResult> {
  const nowIso = new Date(nowMs).toISOString();
  const slate = await loadSlate(deps.kv);
  const lastDispatchAt = await loadLastDispatchAt(deps.kv);
  const refresh = await maybeRefresh(deps, slate, nowMs, "always");
  const games = refresh.slate?.games ?? [];
  const nextKickoff = nextKickoffIso(games, nowMs);
  return {
    action: "idle",
    now: nowIso,
    refreshed: refresh.refreshed,
    espnCalls: refresh.espnCalls,
    live: [],
    ...(nextKickoff ? { nextKickoff } : {}),
    ...(lastDispatchAt ? { lastDispatchAt } : {}),
    reason: `refresh-cron;${refresh.reason}`,
  };
}

export async function handleScheduled(
  cron: string,
  deps: SchedulerDeps,
  nowMs: number,
): Promise<TickResult> {
  if (cronKind(cron) === "refresh") {
    return runRefreshOnly(deps, nowMs);
  }
  return runTick(deps, nowMs);
}

export async function runTick(
  deps: SchedulerDeps,
  nowMs: number,
  { forceRefresh = false } = {},
): Promise<TickResult> {
  const nowIso = new Date(nowMs).toISOString();
  let slate = await loadSlate(deps.kv);
  const lastDispatchAt = await loadLastDispatchAt(deps.kv);

  const refresh = await maybeRefresh(deps, slate, nowMs, forceRefresh ? "always" : "auto");
  slate = refresh.slate;
  const espnCalls = refresh.espnCalls;
  const refreshed = refresh.refreshed;

  const games = slate?.games ?? [];
  const live = gamesInWindow(games, nowMs, deps.config);
  const nextKickoff = nextKickoffIso(games, nowMs);
  const note = (reason: string): string =>
    refresh.reason.includes("refresh-failed") && !reason.includes("refresh-failed")
      ? `${refresh.reason};${reason}`
      : reason;

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
      reason: note("missing-github-token"),
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
      reason: note(gate.reason),
    };
  }

  try {
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
  } catch (error) {
    const reason = publicErrorMessage(error);
    await putKvText(deps.kv, LAST_DISPATCH_ERROR_KEY, reason);
    return {
      action: "dispatch-failed",
      now: nowIso,
      refreshed,
      espnCalls,
      live,
      ...(nextKickoff ? { nextKickoff } : {}),
      ...(lastDispatchAt ? { lastDispatchAt } : {}),
      reason: note(reason),
      ...(isGitHubDispatchError(error) ? { githubStatus: error.status } : {}),
    };
  }
  await saveLastDispatchAt(deps.kv, nowIso);
  await putKvText(deps.kv, LAST_DISPATCH_ERROR_KEY, "");

  return {
    action: "dispatched",
    now: nowIso,
    refreshed,
    espnCalls,
    live,
    ...(nextKickoff ? { nextKickoff } : {}),
    lastDispatchAt: nowIso,
    reason: note(gate.reason),
  };
}

export function logTick(result: TickResult): void {
  const line = JSON.stringify({
    message: "scheduler-tick",
    action: result.action,
    reason: result.reason,
    refreshed: result.refreshed,
    espnCalls: result.espnCalls,
    liveCount: result.live.length,
    live: result.live.map((game) => game.name),
    nextKickoff: result.nextKickoff ?? null,
    githubStatus: result.githubStatus ?? null,
  });
  if (result.action === "dispatch-failed" || result.reason.includes("refresh-failed")) {
    console.error(line);
  } else {
    console.log(line);
  }
}
