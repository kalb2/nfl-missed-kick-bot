/** Compact kickoff stored in KV. All times are UTC ISO-8601. */
export interface StoredGame {
  id: string;
  kickoff: string;
  name: string;
  week?: number;
  seasonType?: number;
}

export interface Slate {
  refreshedAt: string;
  source: "espn-scoreboard";
  seasonYear?: number;
  games: StoredGame[];
}

export interface CalendarWeek {
  seasonType: number;
  week: number;
  startMs: number;
  endMs: number;
  label: string;
}

export interface SchedulerConfig {
  githubOwner: string;
  githubRepo: string;
  githubEventType: string;
  githubToken: string;
  preKickoffMs: number;
  postKickoffMs: number;
  dispatchCooldownMs: number;
  slateMaxAgeMs: number;
  refreshMinIntervalMs: number;
  lookaheadMs: number;
  userAgent: string;
  adminSecret: string;
}

export type TickAction = "idle" | "dispatched" | "cooldown" | "no-token" | "dispatch-failed";

export interface TickResult {
  action: TickAction;
  now: string;
  refreshed: boolean;
  espnCalls: number;
  live: StoredGame[];
  nextKickoff?: string;
  lastDispatchAt?: string;
  reason: string;
  githubStatus?: number;
}

export interface SlateStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface GitHubDispatcher {
  dispatch(input: {
    owner: string;
    repo: string;
    eventType: string;
    token: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}

export const SLATE_KEY = "slate";
export const LAST_DISPATCH_KEY = "lastDispatchAt";
/** Set when an ESPN refresh throws or returns an empty board over a live slate. Cleared on success. */
export const LAST_REFRESH_ERROR_KEY = "lastRefreshError";
/** ISO time of the last refresh attempt (success or failure), used to back off dense ticks. */
export const LAST_REFRESH_ATTEMPT_KEY = "lastRefreshAttemptAt";
/** Set when repository_dispatch fails. Cleared on the next success. */
export const LAST_DISPATCH_ERROR_KEY = "lastDispatchError";
