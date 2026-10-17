import { missAlert, type AlertPayload, type AlertReason } from "./alerts.js";
import type { MissedKick } from "./types.js";

export const UNKNOWN_KICKER = "Unknown kicker";
export const MANUAL_POST_LABEL = "needs-manual-post";
/** Every bot alert issue carries this label, plus a reason label. */
export const BOT_ALERT_LABEL = "bot-alert";
export const POSTED_MISS_ERASED_LABEL = "posted-miss-erased";

export interface IssueRef {
  number: number;
  state: "open" | "closed";
  url?: string;
}

/** Opens / finds the GitHub issues that carry bot alerts. */
export interface MissNotifier {
  /** The needs-manual-post issue for a play (also matches PR #15-era issues). */
  find(playId: string): Promise<IssueRef | undefined>;
  /** Opens the needs-manual-post issue. `reason` replaces the default "no ESPN text names the kicker" explanation. */
  open(miss: MissedKick, reason?: string, payload?: AlertPayload): Promise<IssueRef>;
  /** Comment + close once the bot tweeted the miss itself. */
  resolve(issue: IssueRef, note: string): Promise<void>;
  /** Generic alert issue (e.g. posted_miss_erased). */
  openAlert?(payload: AlertPayload): Promise<IssueRef>;
  /** Existing issue (any state) for the same reason + play, so alerts stay one-per-play even if bot-state was rebuilt. */
  findAlert?(payload: AlertPayload): Promise<IssueRef | undefined>;
  /** True for the console-only notifier used in dry runs / local runs. */
  readonly isLogOnly?: boolean;
}

export function issueMarker(playId: string): string {
  return `[play ${playId}]`;
}

const REASON_HEADLINE: Record<AlertReason, (p: AlertPayload) => string> = {
  needs_manual_post: (p) => `Missed ${p.kickType ?? "kick"} needs manual post`,
  tweet_failed: (p) => `Missed ${p.kickType ?? "kick"} tweet failed, check and post by hand`,
  posted_miss_erased: (p) => `Posted missed ${p.kickType ?? "kick"} was erased or reversed`,
  state_unavailable: () => "Bot paused: handled-plays state unavailable",
  state_recovered: () => "Bot state recovered",
};

export function reasonLabel(reason: AlertReason): string {
  switch (reason) {
    case "needs_manual_post":
    case "tweet_failed":
      return MANUAL_POST_LABEL;
    case "posted_miss_erased":
      return POSTED_MISS_ERASED_LABEL;
    default:
      return STATE_ALERT_LABEL;
  }
}

export function alertIssueTitle(payload: AlertPayload): string {
  const where = [payload.game?.matchup, payload.quarter, payload.clock].filter(Boolean).join(" ");
  const marker = payload.playId ? ` ${issueMarker(payload.playId)}` : "";
  return `[bot-alert] ${REASON_HEADLINE[payload.reason](payload)}${where ? `: ${where}` : ""}${marker}`;
}

/** The fields every alert issue shows, in a fixed order. */
export function alertFieldLines(payload: AlertPayload): string[] {
  const na = "n/a";
  const game = payload.game
    ? `${payload.game.matchup}${payload.game.url ? ` (ESPN: ${payload.game.url})` : ""}`
    : na;
  const texts = payload.rawTexts.map((t) => `  - \`${t.replace(/`/g, "'")}\``);
  return [
    `- **Reason:** \`${payload.reason}\``,
    `- **Game:** ${game}`,
    `- **Kicker:** ${payload.kicker ?? na}`,
    `- **Team:** ${payload.team ?? na}`,
    `- **Kick:** ${payload.kickType ? `${payload.kickType}${payload.result ? ` (${payload.result})` : ""}` : na}`,
    `- **Quarter / clock:** ${payload.quarter || payload.clock ? `${payload.quarter ?? "?"} ${payload.clock ?? "?"}` : na}`,
    `- **Score:** ${payload.score ?? na}`,
    `- **Tweet:** ${payload.tweetUrl ?? "not posted"}`,
    `- **ESPN link:** ${payload.game?.url ?? na}`,
    `- **Play id:** ${payload.playId ?? na}`,
    ...(texts.length ? ["- **Raw ESPN text(s):**", ...texts] : []),
  ];
}

const NEXT_STEPS: Partial<Record<AlertReason, string[]>> = {
  needs_manual_post: [
    "- If a later poll finds the kicker's name in ESPN text **while this issue is open**, the bot tweets it, comments here, and closes the issue.",
    "- If you post it yourself, **close this issue** (and optionally add the play to `config/manual-overrides.json` with `alreadyPosted: true` and the kicker so the season tally credits them). The bot will never tweet a play whose issue is closed.",
  ],
  tweet_failed: [
    "- The bot does **not** retry: the request may have reached X. Check the account; if the tweet is missing, post it by hand and close this issue.",
  ],
  posted_miss_erased: [
    "- The bot did **not** delete the tweet. Decide whether to delete it or post a correction, then close this issue.",
    "- The play is no longer counted in season tallies.",
  ],
};

export function alertIssueBody(payload: AlertPayload): string {
  const steps = NEXT_STEPS[payload.reason];
  return [
    payload.message,
    "",
    ...alertFieldLines(payload),
    ...(steps ? ["", "What happens next:", ...steps] : []),
    "",
    `<!-- missed-kick-bot ${payload.reason}${payload.playId ? ` ${issueMarker(payload.playId)}` : ""} -->`,
  ].join("\n");
}

function manualPostPayload(miss: MissedKick, reason?: string): AlertPayload {
  return reason
    ? missAlert("tweet_failed", miss, `The bot detected a missed kick and did not tweet it. ${reason} This miss needs a manual post.`)
    : missAlert(
        "needs_manual_post",
        miss,
        "The bot detected a missed kick but no ESPN text names the kicker, so it did not tweet it. This miss needs a manual post.",
      );
}

export function issueTitle(miss: MissedKick, reason?: string): string {
  return alertIssueTitle(manualPostPayload(miss, reason));
}

export function issueBody(miss: MissedKick, reason?: string): string {
  return alertIssueBody(manualPostPayload(miss, reason));
}

export class GitHubIssueNotifier implements MissNotifier {
  constructor(
    private readonly repo: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async api(pathname: string, init: RequestInit = {}): Promise<unknown> {
    const res = await this.fetchImpl(`https://api.github.com/repos/${this.repo}${pathname}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${pathname}: ${res.status}`);
    return res.json();
  }

  async find(playId: string): Promise<IssueRef | undefined> {
    const marker = issueMarker(playId);
    const issues = (await this.api(
      `/issues?state=all&labels=${MANUAL_POST_LABEL}&per_page=100`,
    )) as Array<{ number: number; state: string; title: string; html_url?: string; pull_request?: unknown }>;
    const hit = issues.find((i) => !i.pull_request && i.title.includes(marker));
    return hit ? { number: hit.number, state: hit.state === "closed" ? "closed" : "open", url: hit.html_url } : undefined;
  }

  private async ensureLabels(labels: string[]): Promise<void> {
    const meta: Record<string, { color: string; description: string }> = {
      [BOT_ALERT_LABEL]: { color: "fbca04", description: "Missed-kick bot alert" },
      [MANUAL_POST_LABEL]: { color: "d93f0b", description: "Missed kick the bot did not tweet; needs a manual post" },
      [POSTED_MISS_ERASED_LABEL]: { color: "5319e7", description: "A tweeted miss was later erased or reversed by ESPN" },
      [STATE_ALERT_LABEL]: { color: "b60205", description: "Bot cannot load its handled-plays state; posting paused" },
    };
    for (const name of labels) {
      await this.api("/labels", { method: "POST", body: JSON.stringify({ name, ...meta[name] }) }).catch(
        () => undefined, // 422 when it already exists
      );
    }
  }

  async open(miss: MissedKick, reason?: string, payload?: AlertPayload): Promise<IssueRef> {
    const p = payload ?? manualPostPayload(miss, reason);
    const labels = [BOT_ALERT_LABEL, MANUAL_POST_LABEL];
    await this.ensureLabels(labels);
    const issue = (await this.api("/issues", {
      method: "POST",
      body: JSON.stringify({ title: alertIssueTitle(p), body: alertIssueBody(p), labels }),
    })) as { number: number; html_url?: string };
    return { number: issue.number, state: "open", url: issue.html_url };
  }

  async findAlert(payload: AlertPayload): Promise<IssueRef | undefined> {
    if (!payload.playId) return undefined;
    const marker = issueMarker(payload.playId);
    const headline = REASON_HEADLINE[payload.reason](payload);
    const issues = (await this.api(
      `/issues?state=all&labels=${reasonLabel(payload.reason)}&per_page=100`,
    )) as Array<{ number: number; state: string; title: string; html_url?: string; pull_request?: unknown }>;
    const hit = issues.find((i) => !i.pull_request && i.title.includes(marker) && i.title.includes(headline));
    return hit ? { number: hit.number, state: hit.state === "closed" ? "closed" : "open", url: hit.html_url } : undefined;
  }

  async openAlert(payload: AlertPayload): Promise<IssueRef> {
    const labels = [BOT_ALERT_LABEL, reasonLabel(payload.reason)];
    await this.ensureLabels(labels);
    const issue = (await this.api("/issues", {
      method: "POST",
      body: JSON.stringify({ title: alertIssueTitle(payload), body: alertIssueBody(payload), labels }),
    })) as { number: number; html_url?: string };
    return { number: issue.number, state: "open", url: issue.html_url };
  }

  async resolve(issue: IssueRef, note: string): Promise<void> {
    await this.api(`/issues/${issue.number}/comments`, { method: "POST", body: JSON.stringify({ body: note }) });
    await this.api(`/issues/${issue.number}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed", state_reason: "completed" }),
    });
  }
}

/** Used when no token / repo is configured (local runs, dry runs). */
export class LogNotifier implements MissNotifier {
  readonly isLogOnly = true;
  readonly opened: MissedKick[] = [];
  readonly alerts: AlertPayload[] = [];
  async openAlert(payload: AlertPayload): Promise<IssueRef> {
    this.alerts.push(payload);
    console.log("[notify] would open issue: %s\n%s\n", alertIssueTitle(payload), alertIssueBody(payload));
    return { number: this.next++, state: "open" };
  }
  private next = 1;
  private readonly issues = new Map<string, IssueRef>();
  async find(playId: string): Promise<IssueRef | undefined> {
    return this.issues.get(playId);
  }
  async open(miss: MissedKick, reason?: string): Promise<IssueRef> {
    this.opened.push(miss);
    const ref: IssueRef = { number: this.next++, state: "open" };
    this.issues.set(miss.playId, ref);
    console.log("[notify] would open issue: %s\n%s\n", issueTitle(miss), issueBody(miss, reason));
    return ref;
  }
  async resolve(issue: IssueRef, note: string): Promise<void> {
    issue.state = "closed";
    console.log("[notify] would close issue #%d: %s", issue.number, note);
  }
}

export function createNotifier(dryRun: boolean): MissNotifier {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!dryRun && repo && token) return new GitHubIssueNotifier(repo, token);
  return new LogNotifier();
}

export const STATE_ALERT_LABEL = "bot-state-unavailable";
export const STATE_ALERT_TITLE = "[bot-alert] Bot paused: handled-plays state unavailable";

/** Loud, deduplicated alert when the handled-plays list can't be loaded or saved. */
export interface StateAlerter {
  raise(detail: string): Promise<void>;
  /** Close any open alert once state loads again. */
  clear(): Promise<void>;
}

export function stateAlertBody(detail: string): string {
  return [
    "The bot could not load or save its handled-plays list, so it is **posting nothing** until this is fixed.",
    "",
    "- **Reason:** `state_unavailable`",
    `- **Since:** ${new Date().toISOString()}`,
    "It will not re-post old misses: without the list it refuses to tweet at all.",
    "",
    "Error:",
    "```",
    detail.replace(/`/g, "'"),
    "```",
    "",
    "To fix:",
    "- If the `bot-state` branch or its `handled-plays.json` was deleted, run **Actions → Poll ESPN and tweet misses → Run workflow** with `bootstrap_state` checked (and `dry_run` unchecked). Bootstrap marks every miss ESPN currently shows this season as handled, then normal polling resumes. Misses that happened while the bot was paused are **not** posted; post those by hand.",
    "- If it's an auth/permission error, check that poll.yml still grants `contents: write`.",
    "- If GitHub's API was down, the next poll retries automatically and this issue closes itself.",
    "",
    "<!-- missed-kick-bot state-alert -->",
  ].join("\n");
}

export class GitHubStateAlerter implements StateAlerter {
  constructor(
    private readonly repo: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async api(pathname: string, init: RequestInit = {}): Promise<unknown> {
    const res = await this.fetchImpl(`https://api.github.com/repos/${this.repo}${pathname}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${pathname}: ${res.status}`);
    return res.json();
  }

  private async openAlerts(): Promise<Array<{ number: number }>> {
    const issues = (await this.api(`/issues?state=open&labels=${STATE_ALERT_LABEL}&per_page=20`)) as Array<{
      number: number;
      pull_request?: unknown;
    }>;
    return issues.filter((i) => !i.pull_request);
  }

  async raise(detail: string): Promise<void> {
    if ((await this.openAlerts()).length) return; // already alerted; don't spam every poll
    for (const label of [
      { name: STATE_ALERT_LABEL, color: "b60205", description: "Bot cannot load its handled-plays state; posting paused" },
      { name: BOT_ALERT_LABEL, color: "fbca04", description: "Missed-kick bot alert" },
    ]) {
      await this.api("/labels", { method: "POST", body: JSON.stringify(label) }).catch(() => undefined);
    }
    await this.api("/issues", {
      method: "POST",
      body: JSON.stringify({ title: STATE_ALERT_TITLE, body: stateAlertBody(detail), labels: [STATE_ALERT_LABEL, BOT_ALERT_LABEL] }),
    });
  }

  async clear(): Promise<void> {
    for (const issue of await this.openAlerts()) {
      await this.api(`/issues/${issue.number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: "`state_recovered`: handled-plays state loaded again; posting resumed." }),
      });
      await this.api(`/issues/${issue.number}`, {
        method: "PATCH",
        body: JSON.stringify({ state: "closed", state_reason: "completed" }),
      });
    }
  }
}

export class LogStateAlerter implements StateAlerter {
  readonly raised: string[] = [];
  async raise(detail: string): Promise<void> {
    this.raised.push(detail);
    console.error("[alert] would open issue: %s\n%s", STATE_ALERT_TITLE, stateAlertBody(detail));
  }
  async clear(): Promise<void> {}
}

export function createStateAlerter(dryRun: boolean): StateAlerter {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!dryRun && repo && token) return new GitHubStateAlerter(repo, token);
  return new LogStateAlerter();
}
