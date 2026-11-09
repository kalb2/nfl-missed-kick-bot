import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { snapshotOf } from "../src/alerts.js";
import {
  evaluateErasedPostedMiss,
  formatCorrectionIssueSection,
  formatCorrectionReport,
} from "../src/correction.js";
import { buildGameContext, detectMissedKicks } from "../src/detect.js";
import { alertIssueBody } from "../src/notify.js";
import { missAlert } from "../src/alerts.js";
import {
  findHandledPlay,
  inferEventId,
  parseRecheckArgs,
  playIdFromIssueText,
  runRecheck,
  snapshotFromIssue,
} from "../src/recheck-erased.js";
import type { GameSummary, MissedKick } from "../src/types.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const load = (name: string): GameSummary =>
  JSON.parse(readFileSync(path.join(fixturesDir, name), "utf8")) as GameSummary;

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function detectOne(summary: GameSummary, eventId: string, shortName: string): MissedKick {
  const ctx = buildGameContext(eventId, summary, { shortName });
  const misses = detectMissedKicks(summary, ctx);
  if (misses.length !== 1) throw new Error(`expected 1 miss, got ${misses.length}`);
  return misses[0];
}

describe("evaluateErasedPostedMiss", () => {
  it("recommends leave it when current rules still count a TD-taunting PAT (Fitzgerald)", () => {
    const summary = load("recorded/pat-taunting-fitzgerald.json");
    const miss = detectOne(summary, "401872998", "CAR @ PHI");
    const report = evaluateErasedPostedMiss({
      snapshot: snapshotOf(miss),
      tweetId: "2111914206375162318",
      summary,
      tallyIncludesPlay: true,
    });
    expect(report.currentRulesStillCount).toBe(true);
    expect(report.recommendation).toBe("leave it");
    expect(report.tweetUrl).toBe("https://x.com/i/web/status/2111914206375162318");
    expect(report.intentUrl).toContain("https://x.com/intent/post?");
    expect(report.intentUrl).toContain("in_reply_to=2111914206375162318");
    expect(report.tallyNote).toMatch(/still includes/);
    const body = formatCorrectionIssueSection(report).join("\n");
    expect(body).toContain("`leave it`");
    expect(body).toContain("`delete tweet`");
    expect(body).toContain("`post correction`");
    expect(body).toContain("The bot will not delete or post anything itself.");
  });

  it("recommends delete tweet when ESPN erased the kick with No Play", () => {
    const summary = load("fg-no-play-myers-penalty.json");
    const report = evaluateErasedPostedMiss({
      snapshot: {
        playId: "4018729773227",
        eventId: "401872977",
        kickType: "FG",
        result: "Wide Right",
        kicker: "Jason Myers",
        teamAbbr: "SEA",
        quarter: "Q3",
        clock: "2:53",
        awayAbbr: "LAC",
        homeAbbr: "SEA",
        matchup: "LAC @ SEA",
        playText: "J.Myers 53 yard field goal is No Good, Wide Right.",
      },
      tweetId: "2106879266273046768",
      summary,
      tallyIncludesPlay: false,
    });
    expect(report.currentRulesStillCount).toBe(false);
    expect(report.recommendation).toBe("delete tweet");
    expect(report.flaggedWhy).toMatch(/No Play|penalty/i);
    expect(report.tallyNote).toMatch(/does not include/);
  });

  it("recommends post correction when a miss was reversed to good", () => {
    const summary = load("fg-no-play-myers-penalty.json");
    const play = summary.drives?.previous?.flatMap((drive) => drive.plays ?? []).find((item) => item.id === "4018729773227");
    if (!play) throw new Error("myers play missing");
    play.type = { id: "59", text: "Field Goal Good" };
    play.text =
      "J.Myers 53 yard field goal is No Good, Wide Right. The Replay Official reviewed the field goal ruling, and the play was REVERSED. J.Myers 53 yard field goal is GOOD.";
    delete play.isPenalty;
    delete play.penalty;
    const report = evaluateErasedPostedMiss({
      snapshot: {
        playId: "4018729773227",
        eventId: "401872977",
        kickType: "FG",
        result: "Wide Right",
        kicker: "Jason Myers",
        teamAbbr: "SEA",
        quarter: "Q3",
        clock: "2:53",
        awayAbbr: "LAC",
        homeAbbr: "SEA",
        matchup: "LAC @ SEA",
        playText: "J.Myers 53 yard field goal is No Good, Wide Right.",
      },
      tweetId: "99",
      summary,
    });
    expect(report.currentRulesStillCount).toBe(false);
    expect(report.recommendation).toBe("post correction");
    expect(report.flaggedWhy).toMatch(/reversed/i);
  });
});

describe("correction issue body and CLI helpers", () => {
  it("embeds the correction report in a posted_miss_erased issue body", () => {
    const summary = load("recorded/pat-taunting-fitzgerald.json");
    const miss = detectOne(summary, "401872998", "CAR @ PHI");
    const report = evaluateErasedPostedMiss({
      snapshot: snapshotOf(miss),
      tweetId: "2111914206375162318",
      summary,
    });
    const payload = missAlert(
      "posted_miss_erased",
      snapshotOf(miss),
      "The tweeted PAT miss may have been erased.",
      { tweetId: "2111914206375162318", rawTexts: report.rawTexts },
    );
    payload.correction = report;
    const body = alertIssueBody(payload);
    expect(body).toContain("## Correction report");
    expect(body).toContain("`leave it`");
    expect(body).toContain("https://x.com/intent/post?");
    expect(formatCorrectionReport(report)).toContain("Correction report for play");
  });

  it("parses CLI flags, issue play ids, and handled-plays entries", () => {
    expect(parseRecheckArgs(["4018729984351", "--issue", "17", "--summary-file", "fix.json"])).toEqual({
      playId: "4018729984351",
      issue: 17,
      summaryFile: "fix.json",
    });
    expect(inferEventId("4018729984351")).toBe("401872998");
    expect(playIdFromIssueText("[bot-alert] Posted missed PAT was erased: CAR @ PHI [play 4018729984351]")).toBe(
      "4018729984351",
    );
    const fromIssue = snapshotFromIssue(
      [
        "- **Kicker:** Ryan Fitzgerald",
        "- **Team:** CAR",
        "- **Kick:** PAT (Wide Right)",
        "- **Quarter / clock:** Q4 6:38",
        "- **Score:** CAR 26-14 PHI",
        "- **Tweet:** https://x.com/i/web/status/2111914206375162318",
        "- **ESPN link:** https://www.espn.com/nfl/game/_/gameId/401872998",
        "- **Raw ESPN text(s):**",
        "  - `Tommy Tremble 19 Yd pass from Bryce Young (Ryan Fitzgerald PAT failed)`",
      ].join("\n"),
      "4018729984351",
    );
    expect(fromIssue).toMatchObject({
      kicker: "Ryan Fitzgerald",
      teamAbbr: "CAR",
      kickType: "PAT",
      result: "Wide Right",
      tweetId: "2111914206375162318",
      eventId: "401872998",
    });
    expect(
      findHandledPlay(
        { handled: { "401872998:4018729984351": { playId: "4018729984351", status: "posted", tweetId: "1" } } },
        "4018729984351",
      )?.status,
    ).toBe("posted");
  });

  it("prints a report from local files without writing to X or GitHub", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "recheck-"));
    dirs.push(dir);
    const stateFile = path.join(dir, "handled-plays.json");
    await writeFile(
      stateFile,
      JSON.stringify({
        handled: {
          "401872998:4018729984351": {
            playId: "4018729984351",
            eventId: "401872998",
            status: "posted",
            tweetId: "2111914206375162318",
            snapshot: {
              playId: "4018729984351",
              eventId: "401872998",
              kickType: "PAT",
              result: "Wide Right",
              kicker: "Ryan Fitzgerald",
              teamAbbr: "CAR",
              quarter: "Q4",
              clock: "6:38",
              awayAbbr: "CAR",
              homeAbbr: "PHI",
              matchup: "CAR @ PHI",
              playText: "Tommy Tremble 19 Yd pass from Bryce Young (Ryan Fitzgerald PAT failed)",
            },
          },
        },
      }),
      "utf8",
    );
    const printed = await runRecheck({
      playId: "4018729984351",
      summaryFile: path.join(fixturesDir, "recorded/pat-taunting-fitzgerald.json"),
      stateFile,
    });
    expect(printed).toContain("Recommended reply:** `leave it`");
    expect(printed).toContain("Handled-plays status: posted");
    expect(printed).toContain("This command did not write to X or GitHub.");
  });
});
