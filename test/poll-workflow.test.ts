import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pollYml = readFileSync(path.join(repoRoot, ".github/workflows/poll.yml"), "utf8");

describe("poll.yml wake sources", () => {
  it("dense-polls Thu–Mon plus early Tuesday UTC without Cloudflare", () => {
    expect(pollYml).toMatch(/schedule:/);
    expect(pollYml).toMatch(/cron:\s*"\*\/5 \* \* \* 4,5,6,0,1"/);
    expect(pollYml).toMatch(/cron:\s*"\*\/5 0-7 \* \* 2"/);
  });

  it("keeps repository_dispatch nfl-poll and workflow_dispatch", () => {
    expect(pollYml).toMatch(/repository_dispatch:/);
    expect(pollYml).toMatch(/types:\s*\[nfl-poll\]/);
    expect(pollYml).toMatch(/workflow_dispatch:/);
  });
});
