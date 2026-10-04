import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(path.join(repoRoot, ".github/workflows/leaderboard.yml"), "utf8");

describe("leaderboard.yml", () => {
  it("runs Tuesday at 9:17 AM America/Denver on both UTC offsets", () => {
    expect(workflow).toMatch(/cron:\s*"17 15 \* \* 2"/);
    expect(workflow).toMatch(/cron:\s*"17 16 \* \* 2"/);
    expect(workflow).toContain('offset=$(TZ=America/Denver date +%z)');
    expect(workflow).toContain('"$offset" = "-0600"');
    expect(workflow).toContain('"$schedule" = "17 15 * * 2"');
    expect(workflow).toContain('"$offset" = "-0700"');
    expect(workflow).toContain('"$schedule" = "17 16 * * 2"');
  });

  it("dry-runs from workflow_dispatch and follows DRY_RUN on the schedule", () => {
    expect(workflow).toMatch(/workflow_dispatch:/);
    expect(workflow).toMatch(/dry_run:[\s\S]*default:\s*true/);
    expect(workflow).toContain("dry_run=${{ github.event.inputs.dry_run }}");
    expect(workflow).toContain("dry_run=${{ vars.DRY_RUN || 'true' }}");
    expect(workflow).toContain("DRY_RUN: ${{ steps.flags.outputs.dry_run }}");
    expect(workflow).toContain('LEADERBOARD_REQUIRE_RECENT: ${{ github.event_name == \'schedule\' && \'true\' || \'false\' }}');
  });

  it("posts with the leaderboard command and does not rewrite the seen-play cache", () => {
    expect(workflow).toContain("npx tsx src/index.ts leaderboard");
    expect(workflow).toContain("actions/cache/restore@v4");
    expect(workflow).not.toContain("actions/cache/save@");
    expect(workflow).not.toContain("actions/cache@v4");
    expect(workflow).toContain("group: missed-kick-leaderboard");
  });
});
