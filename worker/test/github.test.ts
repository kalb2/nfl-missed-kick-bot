import { describe, expect, it } from "vitest";
import {
  dispatchRepositoryEvent,
  GitHubDispatchError,
  publicErrorMessage,
  sanitizePublicText,
} from "../src/github.js";

describe("sanitizePublicText", () => {
  it("redacts bearer tokens and GitHub PAT shapes", () => {
    expect(sanitizePublicText("Authorization: Bearer ghp_abc123secret")).toBe(
      "Authorization: Bearer [redacted]",
    );
    expect(sanitizePublicText("token github_pat_11AAAA_secretvalue")).toBe("token [redacted-token]");
  });
});

describe("dispatchRepositoryEvent", () => {
  it("resolves on HTTP 204", async () => {
    await dispatchRepositoryEvent(
      {
        owner: "kalb2",
        repo: "nfl-missed-kick-bot",
        eventType: "nfl-poll",
        token: "test-token",
        payload: { reason: "live-window" },
      },
      async () => new Response(null, { status: 204 }),
    );
  });

  it("throws GitHubDispatchError with status and body on 401", async () => {
    const body = '{"message":"Bad credentials","status":"401"}';
    try {
      await dispatchRepositoryEvent(
        {
          owner: "kalb2",
          repo: "nfl-missed-kick-bot",
          eventType: "nfl-poll",
          token: "bad-token",
          payload: {},
        },
        async () => new Response(body, { status: 401 }),
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubDispatchError);
      const typed = error as GitHubDispatchError;
      expect(typed.status).toBe(401);
      expect(typed.message).toContain("GitHub dispatch 401");
      expect(typed.message).toContain("Bad credentials");
      expect(publicErrorMessage(error)).toContain("401");
    }
  });
});
