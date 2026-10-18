import type { IssueRef, MissNotifier, StateAlerter } from "./notify.js";
import type { MissedKick } from "./types.js";

export type AlertReason =
  | "needs_manual_post"
  | "posted_miss_erased"
  | "state_unavailable"
  | "state_recovered"
  | "tweet_failed";

/** Everything an alert issue shows. Every key is always present (null when it doesn't apply). */
export interface AlertPayload {
  reason: AlertReason;
  /** One plain-English sentence. */
  message: string;
  game: { matchup: string; url: string | null } | null;
  playId: string | null;
  kickType: string | null;
  result: string | null;
  kicker: string | null;
  team: string | null;
  quarter: string | null;
  clock: string | null;
  score: string | null;
  tweetUrl: string | null;
  rawTexts: string[];
}

/** Fields of a miss kept in bot-state so a later "posted miss erased" alert can describe it. */
export type MissSnapshot = Pick<
  MissedKick,
  "playId" | "eventId" | "kickType" | "result" | "kicker" | "teamAbbr" | "quarter" | "clock" | "awayAbbr" | "homeAbbr" | "awayScore" | "homeScore" | "matchup" | "playText" | "altPlayTexts"
>;

export function snapshotOf(miss: MissedKick): MissSnapshot {
  return {
    playId: miss.playId,
    eventId: miss.eventId,
    kickType: miss.kickType,
    result: miss.result,
    kicker: miss.kicker,
    teamAbbr: miss.teamAbbr,
    quarter: miss.quarter,
    clock: miss.clock,
    awayAbbr: miss.awayAbbr,
    homeAbbr: miss.homeAbbr,
    awayScore: miss.awayScore,
    homeScore: miss.homeScore,
    matchup: miss.matchup,
    playText: miss.playText,
    ...(miss.altPlayTexts?.length ? { altPlayTexts: miss.altPlayTexts } : {}),
  };
}

export function espnGameUrl(eventId?: string): string | null {
  return eventId ? `https://www.espn.com/nfl/game/_/gameId/${eventId}` : null;
}

export function tweetUrl(tweetId?: string): string | null {
  return tweetId && /^\d+$/.test(tweetId) ? `https://x.com/i/web/status/${tweetId}` : null;
}

export function missAlert(
  reason: Exclude<AlertReason, "state_unavailable" | "state_recovered">,
  miss: MissSnapshot,
  message: string,
  extra: { tweetId?: string; rawTexts?: string[] } = {},
): AlertPayload {
  const score =
    miss.awayScore !== undefined && miss.homeScore !== undefined
      ? `${miss.awayAbbr} ${miss.awayScore}-${miss.homeScore} ${miss.homeAbbr}`
      : null;
  const raw = extra.rawTexts ?? [miss.playText, ...(miss.altPlayTexts ?? [])];
  return {
    reason,
    message,
    game: { matchup: miss.matchup, url: espnGameUrl(miss.eventId) },
    playId: miss.playId,
    kickType: miss.kickType,
    result: miss.result,
    kicker: miss.kicker,
    team: miss.teamAbbr,
    quarter: miss.quarter,
    clock: miss.clock,
    score,
    tweetUrl: tweetUrl(extra.tweetId),
    rawTexts: [...new Set(raw.filter((t): t is string => Boolean(t)))],
  };
}

export function stateAlert(reason: "state_unavailable" | "state_recovered", message: string): AlertPayload {
  return {
    reason,
    message,
    game: null,
    playId: null,
    kickType: null,
    result: null,
    kicker: null,
    team: null,
    quarter: null,
    clock: null,
    score: null,
    tweetUrl: null,
    rawTexts: [],
  };
}

export type AlertVia = "issue" | "log";

export interface AlertDelivery {
  /** "failed" = the GitHub issue could not be opened; caller must not record it as sent (retried next poll). */
  via: AlertVia | "failed";
  issue?: IssueRef;
}

export interface AlertSink {
  send(payload: AlertPayload, ctx?: { miss?: MissedKick }): Promise<AlertDelivery>;
}

export interface AlertRouterOptions {
  /** Play-level alert issues (needs_manual_post, tweet_failed, posted_miss_erased). */
  issues: MissNotifier;
  /** bot-state-unavailable issue (opened on outage, closed on recovery). */
  stateIssues: StateAlerter;
}

/**
 * Every alert is one deduplicated GitHub issue labelled `bot-alert` (plus its
 * reason label). No webhook, no extra secret: poll.yml's GITHUB_TOKEN with
 * `issues: write` is enough. If the issue can't be opened, the alert is logged
 * as a red ::error:: annotation with the full payload and retried next poll.
 */
export class AlertRouter implements AlertSink {
  readonly sent: Array<{ payload: AlertPayload; via: AlertDelivery["via"] }> = [];
  constructor(private readonly opts: AlertRouterOptions) {}

  async send(payload: AlertPayload, ctx: { miss?: MissedKick } = {}): Promise<AlertDelivery> {
    let out: AlertDelivery;
    try {
      out = await this.deliver(payload, ctx);
      console.log("[alert] %s → %s%s: %s", payload.reason, out.via, out.issue ? ` #${out.issue.number}` : "", payload.message);
    } catch (err) {
      console.error(
        "::error title=Bot alert could not be opened::%s (%s). Payload: %s",
        payload.reason,
        (err as Error).message,
        JSON.stringify(payload),
      );
      out = { via: "failed" };
    }
    this.sent.push({ payload, via: out.via });
    return out;
  }

  private async deliver(payload: AlertPayload, ctx: { miss?: MissedKick }): Promise<AlertDelivery> {
    const via: AlertVia = this.opts.issues.isLogOnly ? "log" : "issue";
    switch (payload.reason) {
      case "state_unavailable":
        await this.opts.stateIssues.raise(payload.message);
        return { via };
      case "state_recovered":
        await this.opts.stateIssues.clear();
        return { via };
      case "needs_manual_post":
      case "tweet_failed":
        if (ctx.miss) {
          // One needs-manual-post issue per play (also matches PR #15 issues).
          const issue =
            (await this.opts.issues.find(ctx.miss.playId)) ??
            (await this.opts.issues.open(ctx.miss, payload.reason === "tweet_failed" ? payload.message : undefined, payload));
          return { via, issue };
        }
        break;
      default:
        break;
    }
    if (!this.opts.issues.openAlert) throw new Error("issue notifier cannot open generic alerts");
    const existing = this.opts.issues.findAlert ? await this.opts.issues.findAlert(payload) : undefined;
    const issue = existing ?? (await this.opts.issues.openAlert(payload));
    return { via, issue };
  }
}
