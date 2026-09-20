import { describe, expect, it } from "vitest";
import { tickHttpResponse, unhandledErrorResponse } from "../src/index.js";
import { GitHubDispatchError } from "../src/github.js";
import type { TickResult } from "../src/types.js";

function baseTick(partial: Partial<TickResult>): TickResult {
  return {
    action: "idle",
    now: "2026-09-20T17:35:10.000Z",
    refreshed: false,
    espnCalls: 0,
    live: [{ id: "401872933", kickoff: "2026-09-20T17:00:00.000Z", name: "CAR @ ATL" }],
    reason: "slate-fresh",
    ...partial,
  };
}

describe("tickHttpResponse", () => {
  it("returns 200 for a successful dispatch", async () => {
    const res = tickHttpResponse(baseTick({ action: "dispatched", reason: "never-dispatched" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { action: string; error?: string };
    expect(body.action).toBe("dispatched");
    expect(body.error).toBeUndefined();
  });

  it("returns 502 with the GitHub error JSON instead of Internal server error", async () => {
    const reason =
      'GitHub dispatch 401: {"message":"Bad credentials","documentation_url":"https://docs.github.com/rest","status":"401"}';
    const res = tickHttpResponse(
      baseTick({ action: "dispatch-failed", reason, githubStatus: 401 }),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      error: string;
      action: string;
      githubStatus: number;
    };
    expect(body.error).toContain("Bad credentials");
    expect(body.action).toBe("dispatch-failed");
    expect(body.githubStatus).toBe(401);
  });
});

describe("unhandledErrorResponse", () => {
  it("surfaces the real message, not a generic Internal server error", async () => {
    const res = unhandledErrorResponse(new GitHubDispatchError(401, '{"message":"Bad credentials"}'));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("GitHub dispatch 401");
    expect(body.error).toContain("Bad credentials");
    expect(body.error).not.toBe("Internal server error");
  });
});
