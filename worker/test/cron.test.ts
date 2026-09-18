import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALL_CRONS, cronKind, isDenseTickUtc, REFRESH_CRONS, TICK_CRONS } from "../src/cron.js";

const workerRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseWranglerJsonc(): { triggers: { crons: string[] } } {
  const raw = readFileSync(join(workerRoot, "wrangler.jsonc"), "utf8");
  const stripped = raw.replace(/\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(stripped) as { triggers: { crons: string[] } };
}

describe("cronKind", () => {
  it("treats the midweek expressions as refresh-only", () => {
    expect(cronKind(REFRESH_CRONS[0])).toBe("refresh");
  });

  it("treats dense expressions (and unknown local test crons) as ticks", () => {
    expect(cronKind(TICK_CRONS[0])).toBe("tick");
    expect(cronKind(TICK_CRONS[1])).toBe("tick");
    expect(cronKind("* * * * *")).toBe("tick");
  });
});

describe("isDenseTickUtc (Thu–Mon Denver games + late MNF)", () => {
  it("covers Thanksgiving Thursday and Christmas Friday 2026", () => {
    expect(isDenseTickUtc(new Date("2026-11-26T18:05:00.000Z"))).toBe(true);
    expect(isDenseTickUtc(new Date("2026-12-25T18:10:00.000Z"))).toBe(true);
  });

  it("covers Sunday slates and Monday MNF into early Tuesday UTC", () => {
    expect(isDenseTickUtc(new Date("2026-09-20T17:00:00.000Z"))).toBe(true);
    expect(isDenseTickUtc(new Date("2026-09-22T01:20:00.000Z"))).toBe(true);
    expect(isDenseTickUtc(new Date("2026-09-22T06:30:00.000Z"))).toBe(true);
  });

  it("does not run a 2-minute tick late Tuesday or any Wednesday", () => {
    expect(isDenseTickUtc(new Date("2026-09-22T15:00:00.000Z"))).toBe(false);
    expect(isDenseTickUtc(new Date("2026-09-23T18:00:00.000Z"))).toBe(false);
  });
});

describe("wrangler.jsonc", () => {
  it("has no every-2-minute cron on all weekdays", () => {
    const crons = parseWranglerJsonc().triggers.crons;
    expect(crons).toEqual([...ALL_CRONS]);
    expect(crons).not.toContain("*/2 * * * *");
    expect(crons.some((cron) => cron.startsWith("*/2") && cron.includes("TUE,WED"))).toBe(false);
  });
});
