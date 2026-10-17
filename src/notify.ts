import type { MissedKick } from "./types.js";

export const UNKNOWN_KICKER = "Unknown kicker";
export const MANUAL_POST_LABEL = "needs-manual-post";

export interface IssueRef {
  number: number;
  state: "open" | "closed";
  url?: string;
}

/** Tells Kaleb about a miss the bot could not attribute (and therefore did not tweet). */
export interface MissNotifier {
  find(playId: string): Promise<IssueRef | undefined>;
  /** `reason` replaces the default "no ESPN text names the kicker" explanation. */
  open(miss: MissedKick, reason?: string): Promise<IssueRef>;
  /** Comment + close once the bot tweeted the miss itself. */
  resolve(issue: IssueRef, note: string): Promise<void>;
}

export function issueMarker(playId: string): string {
  return `[play ${playId}]`;
}

export function issueTitle(miss: MissedKick): string {
  return `Missed ${miss.kickType} needs manual post: ${miss.matchup} ${miss.quarter} ${miss.clock} ${issueMarker(miss.playId)}`;
}

export function issueBody(miss: MissedKick, reason?: string): string {
  const score =
    miss.awayScore !== undefined && miss.homeScore !== undefined
      ? `${miss.awayAbbr} ${miss.awayScore}-${miss.homeScore} ${miss.homeAbbr}`
      : "unknown";
  const texts = [miss.playText, ...(miss.altPlayTexts ?? [])]
    .filter(Boolean)
    .map((t) => `- \`${t.replace(/`/g, "'")}\``)
    .join("\n");
  return [
    reason
      ? `The bot detected a missed kick and did **not** tweet it. ${reason}`
      : "The bot detected a missed kick but **no ESPN text names the kicker**, so it did **not** tweet it.",
    "**This miss needs a manual post.**",
    "",
    `- Game: ${miss.matchup} (ESPN event ${miss.eventId ?? "?"})`,
    `- Play id: ${miss.playId}`,
    `- Kick: ${miss.kickType} (${miss.result})`,
    `- Kicking team: ${miss.teamAbbr}`,
    `- When: ${miss.quarter} ${miss.clock}`,
    `- Score after play: ${score}`,
    miss.eventId ? `- ESPN: https://www.espn.com/nfl/game/_/gameId/${miss.eventId}` : "",
    "",
    "Raw ESPN play text(s):",
    texts || "- (none)",
    "",
    "What happens next:",
    "- If a later poll finds the kicker's name in ESPN text **while this issue is open**, the bot tweets it, comments here, and closes the issue.",
    "- If you post it yourself, **close this issue** (and optionally add the play to `config/manual-overrides.json` with `alreadyPosted: true` and the kicker so the season tally credits them). The bot will never tweet a play whose issue is closed.",
    "",
    `<!-- missed-kick-bot ${issueMarker(miss.playId)} -->`,
  ]
    .filter((line) => line !== "")
    .join("\n")
    .replace("Raw ESPN", "\nRaw ESPN")
    .replace("What happens next:", "\nWhat happens next:");
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

  async open(miss: MissedKick, reason?: string): Promise<IssueRef> {
    await this.api("/labels", {
      method: "POST",
      body: JSON.stringify({ name: MANUAL_POST_LABEL, color: "d93f0b", description: "Missed kick the bot could not attribute" }),
    }).catch(() => undefined); // 422 when it already exists
    const issue = (await this.api("/issues", {
      method: "POST",
      body: JSON.stringify({ title: issueTitle(miss), body: issueBody(miss, reason), labels: [MANUAL_POST_LABEL] }),
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
  readonly opened: MissedKick[] = [];
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
export const STATE_ALERT_TITLE = "Missed-kick bot paused: handled-plays state unavailable";

/** Loud, deduplicated alert when the handled-plays list can't be loaded or saved. */
export interface StateAlerter {
  raise(detail: string): Promise<void>;
  /** Close any open alert once state loads again. */
  clear(): Promise<void>;
}

export function stateAlertBody(detail: string): string {
  return [
    "The bot could not load or save its handled-plays list, so it is **posting nothing** until this is fixed.",
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
    await this.api("/labels", {
      method: "POST",
      body: JSON.stringify({ name: STATE_ALERT_LABEL, color: "b60205", description: "Bot cannot load its handled-plays state; posting paused" }),
    }).catch(() => undefined);
    await this.api("/issues", {
      method: "POST",
      body: JSON.stringify({ title: STATE_ALERT_TITLE, body: stateAlertBody(detail), labels: [STATE_ALERT_LABEL] }),
    });
  }

  async clear(): Promise<void> {
    for (const issue of await this.openAlerts()) {
      await this.api(`/issues/${issue.number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: "Handled-plays state loaded again; posting resumed." }),
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
