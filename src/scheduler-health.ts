import { BOT_ALERT_LABEL } from "./notify.js";

/** Public status page. Override with SCHEDULER_STATUS_URL=off to skip the check. */
export const DEFAULT_SCHEDULER_STATUS_URL = "https://nfl-missed-kick-scheduler.k24corp.workers.dev/status";

export const SCHEDULER_ALERT_LABEL = "scheduler-unhealthy";
export const SCHEDULER_ALERT_TITLE = "[bot-alert] Worker scheduler needs attention";

/** Page when the slate is older than this. Healthy refreshes stay under ~48h, with 6h backoff after a failed attempt. */
export const SLATE_STALE_ALERT_MS = 72 * 3_600_000;
/** How long a live window may be open before a missing dispatch is treated as a failure. */
export const DISPATCH_GRACE_MS = 15 * 60_000;
const PRE_KICKOFF_MS = 30 * 60_000;
const STATUS_TIMEOUT_MS = 10_000;

export interface SchedulerStatus {
  refreshedAt?: string | null;
  live?: Array<{ id?: string; name?: string; kickoff?: string }>;
  lastDispatchAt?: string | null;
  hasGithubToken?: boolean;
  lastRefreshError?: string | null;
  lastDispatchError?: string | null;
  gameCount?: number;
  nextKickoff?: string | null;
}

export interface SchedulerAssessment {
  healthy: boolean;
  reasons: string[];
}

export interface SchedulerAlerter {
  sync(assessment: SchedulerAssessment, body: string): Promise<void>;
}

export function assessSchedulerHealth(status: SchedulerStatus, nowMs: number): SchedulerAssessment {
  const reasons: string[] = [];
  const refreshedAt = status.refreshedAt ? Date.parse(status.refreshedAt) : NaN;
  if (!status.refreshedAt || !Number.isFinite(refreshedAt)) {
    reasons.push("The worker has no slate (refreshedAt is missing). It cannot wake polls for kickoffs it has not stored.");
  } else if (nowMs - refreshedAt >= SLATE_STALE_ALERT_MS) {
    const hours = Math.round((nowMs - refreshedAt) / 3_600_000);
    reasons.push(
      `The slate was last refreshed at ${status.refreshedAt} (${hours}h ago). Flexed or rescheduled kickoffs may be wrong, so the worker can miss a game window.`,
    );
  }
  if (status.lastRefreshError) {
    reasons.push(`The last ESPN slate refresh failed and the previous slate was kept: ${status.lastRefreshError}`);
  }
  if (status.lastDispatchError) {
    reasons.push(`The last GitHub repository_dispatch failed: ${status.lastDispatchError}`);
  }

  const windowOpenLongEnough = (status.live ?? []).some((game) => {
    const kickoff = game.kickoff ? Date.parse(game.kickoff) : NaN;
    if (!Number.isFinite(kickoff)) return false;
    return nowMs >= kickoff - PRE_KICKOFF_MS + DISPATCH_GRACE_MS;
  });
  if (windowOpenLongEnough) {
    if (!status.hasGithubToken) {
      reasons.push("A game is in the live window and the worker has no GitHub token, so it cannot wake polls.");
    }
    const last = status.lastDispatchAt ? Date.parse(status.lastDispatchAt) : NaN;
    if (!Number.isFinite(last) || nowMs - last >= DISPATCH_GRACE_MS) {
      reasons.push(
        `A game is in the live window but the last successful dispatch was ${status.lastDispatchAt ?? "never"}. The Actions cron is not a 5-minute backup, so misses in that gap are easy to skip.`,
      );
    }
  }

  return { healthy: reasons.length === 0, reasons };
}

export function schedulerAlertBody(reasons: string[]): string {
  return [
    "The Cloudflare Worker scheduler needs attention. Polls during games come from its repository_dispatch, not from the Actions cron (that cron often runs hours apart).",
    "",
    ...reasons.map((reason) => `- ${reason}`),
    "",
    "What to do:",
    "- Open the worker status page and check `refreshedAt`, `lastDispatchAt`, `lastRefreshError`, and `lastDispatchError`.",
    "- If dispatch is `401` / `Bad credentials`, the `WORKER_GITHUB_PAT` secret expired or was replaced. Update that secret, then run **Actions → Deploy Cloudflare Worker**. That is the existing deploy button; it copies the PAT into the worker. Do not invent a token.",
    "- If the slate is old or the refresh failed, the same deploy picks up the scheduler fix. Until it is deployed, the Tue/Wed refresh cron does not update a slate that still has future games.",
    "- This issue closes itself on a later poll once status looks healthy. It does not tweet.",
    "",
    "<!-- missed-kick-bot scheduler-alert -->",
  ].join("\n");
}

export async function checkSchedulerHealth(opts: {
  dryRun: boolean;
  nowMs?: number;
  statusUrl?: string;
  fetchImpl?: typeof fetch;
  alerter: SchedulerAlerter;
}): Promise<void> {
  if (opts.dryRun) return;
  const url = opts.statusUrl ?? process.env.SCHEDULER_STATUS_URL ?? DEFAULT_SCHEDULER_STATUS_URL;
  if (!url || url === "off") return;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: "application/json", "User-Agent": "nfl-missed-kick-bot" },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn("scheduler status HTTP %s from %s; not opening an alert", res.status, url);
      return;
    }
    const status = (await res.json()) as SchedulerStatus;
    const assessment = assessSchedulerHealth(status, opts.nowMs ?? Date.now());
    await opts.alerter.sync(assessment, schedulerAlertBody(assessment.reasons));
  } catch (err) {
    console.warn("scheduler status check failed (%s); not opening an alert", (err as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

interface IssueHit {
  number: number;
  pull_request?: unknown;
}

/** One open bot-alert issue, closed when the status page looks healthy again. */
export class GitHubSchedulerAlerter implements SchedulerAlerter {
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
    if (res.status === 204) return undefined;
    return res.json();
  }

  private async openIssues(): Promise<IssueHit[]> {
    const issues = (await this.api(`/issues?state=open&labels=${encodeURIComponent(SCHEDULER_ALERT_LABEL)}&per_page=20`)) as IssueHit[];
    return issues.filter((issue) => !issue.pull_request);
  }

  async sync(assessment: SchedulerAssessment, body: string): Promise<void> {
    const open = await this.openIssues();
    if (assessment.healthy) {
      for (const issue of open) {
        await this.api(`/issues/${issue.number}/comments`, {
          method: "POST",
          body: JSON.stringify({
            body: "Worker status looks healthy again (slate fresh enough, no refresh/dispatch error, and any live window has a recent dispatch). Closing.",
          }),
        });
        await this.api(`/issues/${issue.number}`, {
          method: "PATCH",
          body: JSON.stringify({ state: "closed", state_reason: "completed" }),
        });
      }
      return;
    }
    if (open.length) return;
    for (const label of [
      { name: SCHEDULER_ALERT_LABEL, color: "b60205", description: "Worker slate or GitHub dispatch needs attention" },
      { name: BOT_ALERT_LABEL, color: "fbca04", description: "Missed-kick bot alert" },
    ]) {
      await this.api("/labels", { method: "POST", body: JSON.stringify(label) }).catch(() => undefined);
    }
    await this.api("/issues", {
      method: "POST",
      body: JSON.stringify({ title: SCHEDULER_ALERT_TITLE, body, labels: [SCHEDULER_ALERT_LABEL, BOT_ALERT_LABEL] }),
    });
  }
}

export class LogSchedulerAlerter implements SchedulerAlerter {
  readonly synced: SchedulerAssessment[] = [];
  async sync(assessment: SchedulerAssessment, body: string): Promise<void> {
    this.synced.push(assessment);
    if (!assessment.healthy) {
      console.error("[alert] would open issue: %s\n%s", SCHEDULER_ALERT_TITLE, body);
    }
  }
}

export function createSchedulerAlerter(dryRun: boolean, fetchImpl?: typeof fetch): SchedulerAlerter {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!dryRun && repo && token) return new GitHubSchedulerAlerter(repo, token, fetchImpl);
  return new LogSchedulerAlerter();
}
