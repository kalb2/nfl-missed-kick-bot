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
  open(miss: MissedKick): Promise<IssueRef>;
  /** Comment + close once the bot tweeted the miss itself. */
  resolve(issue: IssueRef, note: string): Promise<void>;
}

export function issueMarker(playId: string): string {
  return `[play ${playId}]`;
}

export function issueTitle(miss: MissedKick): string {
  return `Missed ${miss.kickType} needs manual post: ${miss.matchup} ${miss.quarter} ${miss.clock} ${issueMarker(miss.playId)}`;
}

export function issueBody(miss: MissedKick): string {
  const score =
    miss.awayScore !== undefined && miss.homeScore !== undefined
      ? `${miss.awayAbbr} ${miss.awayScore}-${miss.homeScore} ${miss.homeAbbr}`
      : "unknown";
  const texts = [miss.playText, ...(miss.altPlayTexts ?? [])]
    .filter(Boolean)
    .map((t) => `- \`${t.replace(/`/g, "'")}\``)
    .join("\n");
  return [
    "The bot detected a missed kick but **no ESPN text names the kicker**, so it did **not** tweet it.",
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

  async open(miss: MissedKick): Promise<IssueRef> {
    await this.api("/labels", {
      method: "POST",
      body: JSON.stringify({ name: MANUAL_POST_LABEL, color: "d93f0b", description: "Missed kick the bot could not attribute" }),
    }).catch(() => undefined); // 422 when it already exists
    const issue = (await this.api("/issues", {
      method: "POST",
      body: JSON.stringify({ title: issueTitle(miss), body: issueBody(miss), labels: [MANUAL_POST_LABEL] }),
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
  async open(miss: MissedKick): Promise<IssueRef> {
    this.opened.push(miss);
    const ref: IssueRef = { number: this.next++, state: "open" };
    this.issues.set(miss.playId, ref);
    console.log("[notify] would open issue: %s\n%s\n", issueTitle(miss), issueBody(miss));
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
