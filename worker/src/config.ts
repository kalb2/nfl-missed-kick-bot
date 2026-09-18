import type { SchedulerConfig } from "./types.js";

const DEFAULTS = {
  githubOwner: "kalb2",
  githubRepo: "nfl-missed-kick-bot",
  githubEventType: "nfl-poll",
  preKickoffMin: 30,
  postKickoffMin: 285,
  dispatchCooldownMin: 5,
  slateMaxAgeHours: 168,
  refreshMinIntervalHours: 6,
  lookaheadDays: 16,
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
};

function readString(env: Env, key: keyof Env, fallback = ""): string {
  const value = env[key];
  return typeof value === "string" ? value : fallback;
}

function readNumber(env: Env, key: keyof Env, fallback: number): number {
  const raw = env[key];
  if (typeof raw !== "string" || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function configFromEnv(env: Env): SchedulerConfig {
  return {
    githubOwner: readString(env, "GITHUB_OWNER", DEFAULTS.githubOwner),
    githubRepo: readString(env, "GITHUB_REPO", DEFAULTS.githubRepo),
    githubEventType: readString(env, "GITHUB_EVENT_TYPE", DEFAULTS.githubEventType),
    githubToken: readString(env, "GITHUB_TOKEN"),
    preKickoffMs: readNumber(env, "PRE_KICKOFF_MIN", DEFAULTS.preKickoffMin) * 60_000,
    postKickoffMs: readNumber(env, "POST_KICKOFF_MIN", DEFAULTS.postKickoffMin) * 60_000,
    dispatchCooldownMs: readNumber(env, "DISPATCH_COOLDOWN_MIN", DEFAULTS.dispatchCooldownMin) * 60_000,
    slateMaxAgeMs: readNumber(env, "SLATE_MAX_AGE_HOURS", DEFAULTS.slateMaxAgeHours) * 3_600_000,
    refreshMinIntervalMs:
      readNumber(env, "REFRESH_MIN_INTERVAL_HOURS", DEFAULTS.refreshMinIntervalHours) * 3_600_000,
    lookaheadMs: readNumber(env, "LOOKAHEAD_DAYS", DEFAULTS.lookaheadDays) * 24 * 3_600_000,
    userAgent: readString(env, "ESPN_USER_AGENT", DEFAULTS.userAgent),
    adminSecret: readString(env, "SCHEDULER_ADMIN_SECRET"),
  };
}

export function testConfig(overrides: Partial<SchedulerConfig> = {}): SchedulerConfig {
  return {
    githubOwner: DEFAULTS.githubOwner,
    githubRepo: DEFAULTS.githubRepo,
    githubEventType: DEFAULTS.githubEventType,
    githubToken: "test-token",
    preKickoffMs: DEFAULTS.preKickoffMin * 60_000,
    postKickoffMs: DEFAULTS.postKickoffMin * 60_000,
    dispatchCooldownMs: DEFAULTS.dispatchCooldownMin * 60_000,
    slateMaxAgeMs: DEFAULTS.slateMaxAgeHours * 3_600_000,
    refreshMinIntervalMs: DEFAULTS.refreshMinIntervalHours * 3_600_000,
    lookaheadMs: DEFAULTS.lookaheadDays * 24 * 3_600_000,
    userAgent: DEFAULTS.userAgent,
    adminSecret: "",
    ...overrides,
  };
}
