import { afterEach, beforeEach, vi } from "vitest";

/** Worker tests inject fetch. Never call GitHub, X, or live ESPN from the suite. */
const BLOCKED = /api\.twitter\.com|api\.x\.com|upload\.twitter\.com|api\.github\.com|site\.api\.espn\.com|site\.web\.api\.espn\.com/i;

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
    throw new Error(`Unexpected fetch during worker tests: ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
