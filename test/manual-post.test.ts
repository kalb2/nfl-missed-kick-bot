import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { EspnClient } from "../src/espn.js";
import { issueBody, type IssueRef, type MissNotifier } from "../src/notify.js";
import { Overrides } from "../src/overrides.js";
import { pollOnce } from "../src/poll.js";
import { SeenStore } from "../src/store.js";
import { SeasonTallyIndex } from "../src/tallies.js";
import type { GameSummary, MissedKick, ScoreboardEvent } from "../src/types.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const full = JSON.parse(
  readFileSync(path.join(fixturesDir, "pat-missed-patterson-scoring-text.json"), "utf8"),
) as GameSummary;
const PLAY = "4018729824202";

function blank(): GameSummary {
  const s = JSON.parse(JSON.stringify(full)) as GameSummary & { scoringPlays?: unknown };
  delete s.scoringPlays;
  return s;
}

const event: ScoreboardEvent = {
  id: "401872982",
  shortName: "CIN @ MIA",
  date: new Date().toISOString(),
  season: { type: 2, year: 2026 },
  status: { type: { state: "in", name: "STATUS_IN_PROGRESS", completed: false } },
  competitions: [],
} as ScoreboardEvent;

function espn(getSummary: () => GameSummary): EspnClient {
  return {
    concurrency: 1,
    getScoreboard: async () => ({ events: [event], season: { type: 2, year: 2026 }, week: { number: 1 } }),
    getSummary: async () => getSummary(),
    getWinProbability: async () => [],
  } as unknown as EspnClient;
}

class FakeNotifier implements MissNotifier {
  opened: MissedKick[] = [];
  resolved: number[] = [];
  issues = new Map<string, IssueRef>();
  async find(playId: string) {
    return this.issues.get(playId);
  }
  async open(miss: MissedKick) {
    this.opened.push(miss);
    const ref: IssueRef = { number: 40 + this.opened.length, state: "open" };
    this.issues.set(miss.playId, ref);
    return ref;
  }
  async resolve(issue: IssueRef) {
    issue.state = "closed";
    this.resolved.push(issue.number);
  }
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manual-post-"));
  dirs.push(dir);
  const posted: string[] = [];
  return {
    dir,
    posted,
    store: new SeenStore(path.join(dir, "seen.json")),
    poster: { post: async (t: string) => (posted.push(t), { id: "x" }) },
    notifier: new FakeNotifier(),
  };
}

// These tests cover the issue flow, so a single sighting confirms (confirmation has its own tests).
const opts = { dryRun: false, seedSeen: false, allToday: true, persist: false, recentFinalWindowMin: 45, confirmPolls: 1 };

describe("unknown kicker → manual-post issue, never a tweet", () => {
  it("opens exactly one issue across polls and keeps the miss pending", async () => {
    const t = await setup();
    const deps = { espn: espn(blank), store: t.store, poster: t.poster, notifier: t.notifier };
    const r1 = await pollOnce(deps, opts);
    const r2 = await pollOnce(deps, opts);
    expect(t.posted).toHaveLength(0);
    expect(t.notifier.opened).toHaveLength(1);
    expect(r1.heldForManualPost?.[0]?.playId).toBe(PLAY);
    expect(r2.heldForManualPost).toHaveLength(1);
    expect(t.store.has(PLAY)).toBe(false);
    expect(t.store.notifiedIssue(PLAY)).toBe(41);
  });

  it("dedupes via the existing GitHub issue when local state was lost", async () => {
    const t = await setup();
    t.notifier.issues.set(PLAY, { number: 7, state: "open" });
    await pollOnce({ espn: espn(blank), store: t.store, poster: t.poster, notifier: t.notifier }, opts);
    expect(t.notifier.opened).toHaveLength(0);
    expect(t.store.notifiedIssue(PLAY)).toBe(7);
  });

  it("tweets and closes the issue if a later poll names the kicker while the issue is open", async () => {
    const t = await setup();
    let summary = blank();
    const deps = { espn: espn(() => summary), store: t.store, poster: t.poster, notifier: t.notifier };
    await pollOnce(deps, opts);
    summary = full;
    await pollOnce(deps, opts);
    expect(t.posted).toHaveLength(1);
    expect(t.posted[0]).toContain("Riley Patterson (MIA)");
    expect(t.notifier.resolved).toEqual([41]);
    expect(t.store.has(PLAY)).toBe(true);
  });

  it("does not tweet once Kaleb closed the issue (posted by hand)", async () => {
    const t = await setup();
    let summary = blank();
    const deps = { espn: espn(() => summary), store: t.store, poster: t.poster, notifier: t.notifier };
    await pollOnce(deps, opts);
    t.notifier.issues.get(PLAY)!.state = "closed";
    summary = full;
    await pollOnce(deps, opts);
    expect(t.posted).toHaveLength(0);
    expect(t.store.has(PLAY)).toBe(true);
  });

  it("issue body carries game, play id, clock, score, raw texts and the manual-post note", () => {
    const body = issueBody({
      playId: PLAY, eventId: "401872982", kickType: "PAT", kicker: "Unknown kicker", teamAbbr: "MIA",
      teamName: "Miami Dolphins", result: "No Good", quarter: "Q4", clock: "0:45", awayAbbr: "CIN",
      homeAbbr: "MIA", awayScore: 31, homeScore: 24, matchup: "CIN @ MIA",
      playText: "Malik Willis 1 Yd Run (  PAT failed)",
    } as MissedKick);
    for (const s of ["CIN @ MIA", PLAY, "Q4 0:45", "CIN 31-24 MIA", "(  PAT failed)", "needs a manual post"]) {
      expect(body).toContain(s);
    }
  });
});

describe("manual overrides (CIN @ MIA play already posted by hand)", () => {
  const overrides = Overrides.load();

  it("never re-tweets the overridden play, even with an empty seen store", async () => {
    const t = await setup();
    const tallies = new SeasonTallyIndex(undefined, overrides);
    const r = await pollOnce(
      { espn: espn(blank), store: t.store, poster: t.poster, notifier: t.notifier, overrides, tallies },
      opts,
    );
    expect(t.posted).toHaveLength(0);
    expect(t.notifier.opened).toHaveLength(0);
    expect(t.store.has(PLAY)).toBe(true);
    const row = r.seasonTallies?.find((x) => x.kicker === "Riley Patterson");
    expect(row).toMatchObject({ teamAbbr: "MIA", pat: 1 });
    expect(r.seasonTallies?.some((x) => x.kicker === "Unknown kicker")).toBe(false);
  });
});
