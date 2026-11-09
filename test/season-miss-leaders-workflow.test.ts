import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(path.join(repoRoot, ".github/workflows/season-miss-leaders.yml"), "utf8");

describe("season-miss-leaders.yml", () => {
  it("runs Tuesday at 9:17 AM America/Denver on both UTC offsets", () => {
    expect(workflow).toMatch(/cron:\s*"17 15 \* \* 2"/);
    expect(workflow).toMatch(/cron:\s*"17 16 \* \* 2"/);
    expect(workflow).toContain('offset=$(TZ=America/Denver date +%z)');
    expect(workflow).toContain('"$offset" = "-0600"');
    expect(workflow).toContain('"$schedule" = "17 15 * * 2"');
    expect(workflow).toContain('"$offset" = "-0700"');
    expect(workflow).toContain('"$schedule" = "17 16 * * 2"');
  });

  it("keeps manual Run workflow and uses the board/ generator", () => {
    expect(workflow).toMatch(/workflow_dispatch:/);
    expect(workflow).toContain("bash board/regenerate.sh");
    expect(workflow).toContain("actions/upload-artifact@v4");
    expect(workflow).toContain("board/out/season-miss-leaders-top10.png");
    expect(workflow).toContain("board/out/suggested-post.txt");
    expect(workflow).toContain("group: season-miss-leaders");
  });

  it("never posts to X or reads tweet secrets", () => {
    expect(workflow).not.toMatch(/X_API_KEY/);
    expect(workflow).not.toMatch(/twitter/i);
    expect(workflow).not.toContain("src/index.ts leaderboard");
    expect(workflow).not.toContain("npx tsx src/index.ts");
    expect(workflow).not.toMatch(/DRY_RUN:/);
    expect(workflow).not.toMatch(/secrets\./);
    expect(workflow).not.toContain(".github/workflows/leaderboard.yml");
  });
});
