import { describe, expect, it } from "vitest";
import {
  assessSchedulerHealth,
  checkSchedulerHealth,
  GitHubSchedulerAlerter,
  type SchedulerStatus,
} from "../src/scheduler-health.js";

const NOW = Date.parse("2026-11-03T21:30:49.000Z");

function status(partial: Partial<SchedulerStatus> = {}): SchedulerStatus {
  return {
    refreshedAt: "2026-11-03T15:00:00.000Z",
    live: [],
    lastDispatchAt: "2026-11-03T05:58:10.000Z",
    hasGithubToken: true,
    lastRefreshError: null,
    lastDispatchError: null,
    ...partial,
  };
}

describe("assessSchedulerHealth", () => {
  it("treats the 2026-11-03 status page as healthy until the slate is 72h old", () => {
    // Live page that afternoon: refreshed Sunday, 43 games, next kickoff set, no live game.
    const live: SchedulerStatus = status({
      refreshedAt: "2026-11-01T17:44:10.000Z",
      gameCount: 43,
      nextKickoff: "2026-11-06T01:15:00.000Z",
      lastDispatchAt: "2026-11-03T05:58:10.000Z",
    });
    expect(assessSchedulerHealth(live, NOW).healthy).toBe(true);
    const thursday = Date.parse("2026-11-05T18:00:00.000Z");
    const late = assessSchedulerHealth(live, thursday);
    expect(late.healthy).toBe(false);
    expect(late.reasons.join(" ")).toMatch(/72|hours ago|last refreshed/i);
  });

  it("pages when a live window has had no dispatch for 15 minutes", () => {
    const kickoff = "2026-11-03T21:00:00.000Z";
    const during = Date.parse("2026-11-03T21:10:00.000Z");
    const assessment = assessSchedulerHealth(
      status({
        live: [{ id: "1", name: "CHI @ DET", kickoff }],
        lastDispatchAt: "2026-11-02T01:00:00.000Z",
      }),
      during,
    );
    expect(assessment.healthy).toBe(false);
    expect(assessment.reasons.join(" ")).toMatch(/live window/);
  });

  it("waits out the first 15 minutes of a window", () => {
    const kickoff = "2026-11-03T21:30:00.000Z";
    const justOpened = Date.parse(kickoff) - 25 * 60_000;
    expect(
      assessSchedulerHealth(
        status({
          live: [{ id: "1", name: "CHI @ DET", kickoff }],
          lastDispatchAt: "2026-11-02T01:00:00.000Z",
        }),
        justOpened,
      ).healthy,
    ).toBe(true);
  });

  it("stays unhealthy while a dispatch or refresh error is recorded", () => {
    expect(assessSchedulerHealth(status({ lastDispatchError: "GitHub dispatch 401: Bad credentials" }), NOW).healthy).toBe(
      false,
    );
    expect(assessSchedulerHealth(status({ lastRefreshError: "ESPN 503" }), NOW).healthy).toBe(false);
  });
});

describe("checkSchedulerHealth", () => {
  it("does not fetch or alert on a dry run", async () => {
    let fetched = 0;
    const synced: boolean[] = [];
    await checkSchedulerHealth({
      dryRun: true,
      statusUrl: "https://example.test/status",
      fetchImpl: async () => {
        fetched += 1;
        return new Response("{}", { status: 200 });
      },
      alerter: {
        sync: async (assessment) => {
          synced.push(assessment.healthy);
        },
      },
    });
    expect(fetched).toBe(0);
    expect(synced).toEqual([]);
  });

  it("opens one bot-alert issue and closes it when status recovers", async () => {
    const calls: Array<{ path: string; method: string; body?: string }> = [];
    let open = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const path = url.replace("https://api.github.com/repos/kalb2/nfl-missed-kick-bot", "");
      const method = init?.method ?? "GET";
      calls.push({ path, method, body: typeof init?.body === "string" ? init.body : undefined });
      if (method === "GET" && path.startsWith("/issues?")) {
        return Response.json(open ? [{ number: 9 }] : []);
      }
      if (method === "POST" && path === "/issues") {
        open = true;
        return Response.json({ number: 9 });
      }
      if (method === "POST" && path === "/labels") return Response.json({});
      if (method === "PATCH") {
        open = false;
        return Response.json({});
      }
      if (method === "POST" && path.includes("/comments")) return Response.json({});
      return new Response("unexpected", { status: 500 });
    };
    const alerter = new GitHubSchedulerAlerter("kalb2/nfl-missed-kick-bot", "token", fetchImpl);
    const bad = assessSchedulerHealth(status({ lastRefreshError: "ESPN 503" }), NOW);
    await alerter.sync(bad, "body");
    await alerter.sync(bad, "body");
    expect(calls.filter((call) => call.method === "POST" && call.path === "/issues")).toHaveLength(1);
    const created = calls.find((call) => call.method === "POST" && call.path === "/issues");
    expect(created?.body).toContain("bot-alert");
    expect(created?.body).toContain("scheduler-unhealthy");

    await alerter.sync(assessSchedulerHealth(status(), NOW), "ok");
    expect(calls.some((call) => call.method === "PATCH" && call.path === "/issues/9")).toBe(true);
  });

  it("does not alert when the status page cannot be fetched", async () => {
    const synced: boolean[] = [];
    await checkSchedulerHealth({
      dryRun: false,
      statusUrl: "https://example.test/status",
      fetchImpl: async () => {
        throw new Error("network down");
      },
      alerter: {
        sync: async (assessment) => {
          synced.push(assessment.healthy);
        },
      },
    });
    expect(synced).toEqual([]);
  });
});
