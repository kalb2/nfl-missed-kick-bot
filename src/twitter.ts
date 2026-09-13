import { TwitterApi } from "twitter-api-v2";
import type { AppConfig } from "./config.js";
import { hasTwitterCredentials } from "./config.js";

export interface TweetPoster {
  post(text: string): Promise<{ id?: string }>;
}

export class DryRunPoster implements TweetPoster {
  readonly posted: string[] = [];
  async post(text: string): Promise<{ id?: string }> {
    this.posted.push(text);
    console.log("[dry-run] would tweet:\n%s\n", text);
    return { id: "dry-run" };
  }
}

export class XPoster implements TweetPoster {
  private readonly client: TwitterApi;
  constructor(config: AppConfig) {
    if (!hasTwitterCredentials(config)) {
      throw new Error("Missing X API credentials");
    }
    this.client = new TwitterApi({
      appKey: config.twitter.appKey!,
      appSecret: config.twitter.appSecret!,
      accessToken: config.twitter.accessToken!,
      accessSecret: config.twitter.accessSecret!,
    });
  }

  async post(text: string): Promise<{ id?: string }> {
    const result = await this.client.v2.tweet(text);
    return { id: result.data?.id };
  }
}

export function createPoster(config: AppConfig, forceDryRun: boolean): TweetPoster {
  if (forceDryRun || config.dryRun || !hasTwitterCredentials(config)) {
    if (!forceDryRun && !config.dryRun && !hasTwitterCredentials(config)) {
      console.warn("X credentials missing; forcing dry-run.");
    }
    return new DryRunPoster();
  }
  return new XPoster(config);
}
