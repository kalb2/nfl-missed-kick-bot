import "dotenv/config";
import path from "node:path";

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export interface AppConfig {
  dryRun: boolean;
  pollIntervalMs: number;
  statePath: string;
  recentFinalWindowMin: number;
  seedSeen: boolean;
  userAgent: string;
  twitter: {
    appKey?: string;
    appSecret?: string;
    accessToken?: string;
    accessSecret?: string;
  };
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const twitter = {
    appKey: process.env.X_API_KEY || undefined,
    appSecret: process.env.X_API_KEY_SECRET || undefined,
    accessToken: process.env.X_ACCESS_TOKEN || undefined,
    accessSecret: process.env.X_ACCESS_TOKEN_SECRET || undefined,
  };

  const definedOverrides = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ) as Partial<AppConfig>;

  return {
    dryRun: boolEnv("DRY_RUN", true),
    pollIntervalMs: intEnv("POLL_INTERVAL_MS", 30_000),
    statePath: process.env.STATE_PATH || path.join(process.cwd(), ".state", "seen.json"),
    recentFinalWindowMin: intEnv("RECENT_FINAL_WINDOW_MIN", 45),
    seedSeen: boolEnv("SEED_SEEN", false),
    userAgent:
      process.env.ESPN_USER_AGENT ||
      // site.api.espn.com is often 403 from cloud IPs; site.web.api accepts a normal browser UA.
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    twitter,
    ...definedOverrides,
  };
}

export function hasTwitterCredentials(config: AppConfig): boolean {
  const { appKey, appSecret, accessToken, accessSecret } = config.twitter;
  return Boolean(appKey && appSecret && accessToken && accessSecret);
}
