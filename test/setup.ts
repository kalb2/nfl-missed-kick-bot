import { afterEach, beforeEach, vi } from "vitest";

/**
 * Tests inject ESPN and GitHub clients. A real fetch here would either hit X,
 * open a GitHub issue, or depend on live ESPN. Both are refused.
 */
const BLOCKED = /api\.twitter\.com|api\.x\.com|upload\.twitter\.com|api\.github\.com/i;

beforeEach(() => {
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input && typeof input === "object" && "url" in input
            ? String(input.url)
            : String(input);
    if (BLOCKED.test(url)) {
      throw new Error(`Refusing networked call from tests: ${url}`);
    }
    throw new Error(`Unexpected fetch during tests (inject a fake client): ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
