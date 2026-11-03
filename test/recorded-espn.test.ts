import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AlertRouter } from "../src/alerts.js";
import { composeTweet, formatWpDelta } from "../src/compose.js";
import { loadConfig } from "../src/config.js";
import { buildGameContext, detectMissedKicks, nullifiedReason } from "../src/detect.js";
import type { EspnClient } from "../src/espn.js";
import {
  GitHubStateAlerter,
  LogStateAlerter,
  STATE_ALERT_LABEL,
  STATE_ALERT_TITLE,
  UNKNOWN_KICKER,
  alertIssueTitle,
  type IssueRef,
  type MissNotifier,
} from "../src/notify.js";
import { pollOnce, DEFAULT_RECHECK_DELAY_MS } from "../src/poll.js";
import { runGuardedPoll } from "../src/run.js";
import type { StateBackend } from "../src/state-backend.js";
import { SeenStore } from "../src/store.js";
import { SeasonTallyIndex, formatSeasonLine } from "../src/tallies.js";
import { createPoster } from "../src/twitter.js";
import type { GameSummary, MissedKick, Play, PollOptions, ScoreboardEvent } from "../src/types.js";

const MINUS = "\u2212";
const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function load(name: string): GameSummary {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), "utf8")) as GameSummary;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function detect(summary: GameSummary): MissedKick[] {
  const eventId = String(summary.header?.id ?? "game");
  return detectMissedKicks(
    summary,
    buildGameContext(eventId, summary, {
      eventId,
      shortName: eventId,
      competitors: summary.header?.competitions?.[0]?.competitors ?? [],
    }),
  );
}

function only(summary: GameSummary): MissedKick {
  const misses = detect(summary);
  expect(misses, summary.header?.id).toHaveLength(1);
  return misses[0];
}

function drivePlay(summary: GameSummary): Play {
  const groups = summary.drives?.previous ?? [];
  const play = groups.flatMap((drive) => drive.plays ?? [])[0];
  if (!play) throw new Error("fixture has no drive play");
  return play;
}

function withSeason(miss: MissedKick, fg: number, pat: number): MissedKick {
  return { ...miss, seasonFgMisses: fg, seasonPatMisses: pat };
}

const live: PollOptions = {
  dryRun: false,
  seedSeen: false,
  allToday: false,
  persist: true,
  recentFinalWindowMin: 45,
  recheckDelayMs: 0,
};

function scoreboardEvent(summary: GameSummary, shortName: string): ScoreboardEvent {
  return {
    id: String(summary.header?.id),
    shortName,
    date: new Date().toISOString(),
    season: { type: 2, year: 2026 },
    status: { type: { state: "in", completed: false } },
    competitions: summary.header?.competitions,
  };
}

class MemoryBackend implements StateBackend {
  description = "memory bot-state/handled-plays.json";
  snap: { data: unknown; version?: string } | null = {
    data: { version: 2, handled: {}, pending: {} },
    version: "sha-1",
  };
  failWrites = false;
  writes: string[] = [];
  async read() {
    return this.snap;
  }
  async write(data: unknown, _version: string | undefined, message: string) {
    this.writes.push(message);
    if (this.failWrites) throw new Error("GitHub contents API 500");
    this.snap = { data, version: `sha-${this.writes.length + 1}` };
    return this.snap.version;
  }
}

class RecordingNotifier implements MissNotifier {
  opened: MissedKick[] = [];
  issues = new Map<string, IssueRef>();
  async find(playId: string) {
    return this.issues.get(playId);
  }
  async open(miss: MissedKick) {
    this.opened.push(miss);
    const ref: IssueRef = { number: 70 + this.opened.length, state: "open" };
    this.issues.set(miss.playId, ref);
    return ref;
  }
  async resolve(issue: IssueRef) {
    issue.state = "closed";
  }
}

function espnFor(summary: GameSummary, shortName: string, nextSummary?: () => GameSummary): EspnClient {
  const event = scoreboardEvent(summary, shortName);
  return {
    concurrency: 1,
    getScoreboard: async () => ({
      events: [event],
      season: { type: 2, year: 2026 },
      week: { number: 1 },
    }),
    getSummary: async () => (nextSummary ? nextSummary() : summary),
    getWinProbability: async () => [],
  } as unknown as EspnClient;
}

function recorder() {
  const posted: string[] = [];
  return {
    posted,
    poster: {
      post: async (text: string) => {
        posted.push(text);
        return { id: `local-${posted.length}` };
      },
    },
  };
}

describe("recorded 2026 ESPN plays", () => {
  it("covers FG wide right, wide left, short, both uprights, and a blocked kick", () => {
    const carlson = only(load("fg-missed-carlson.json"));
    const sanders = only(load("fg-missed-sanders.json"));
    const rightUpright = only(load("fg-missed-current-drive.json"));
    const fairbairn = only(load("recorded/fg-short-fairbairn.json"));
    const lutz = only(load("recorded/fg-hit-left-upright-lutz.json"));
    const santos = only(load("recorded/fg-blocked-santos.json"));

    expect(carlson).toMatchObject({ kickType: "FG", result: "Wide Right", distance: 62, kicker: "Daniel Carlson" });
    expect(sanders).toMatchObject({ kickType: "FG", result: "Wide Left", distance: 54, kicker: "Jason Sanders" });
    expect(rightUpright).toMatchObject({ kickType: "FG", result: "Hit Right Upright", distance: 52 });
    expect(fairbairn).toMatchObject({
      kickType: "FG",
      result: "Short",
      distance: 58,
      kicker: "Ka'imi Fairbairn",
      teamAbbr: "HOU",
      quarter: "Q3",
      clock: "7:33",
    });
    expect(lutz).toMatchObject({
      kickType: "FG",
      result: "Hit Left Upright",
      distance: 43,
      kicker: "Wil Lutz",
      teamAbbr: "DEN",
    });

    // Real ESPN shape: a blocked FG is type id 18 "Blocked Field Goal", not id 60.
    const santosPlay = drivePlay(load("recorded/fg-blocked-santos.json"));
    expect(String(santosPlay.type?.id)).toBe("18");
    expect(santosPlay.type?.text).toBe("Blocked Field Goal");
    expect(santos).toMatchObject({
      kickType: "FG",
      result: "Blocked",
      distance: 23,
      kicker: "Cairo Santos",
      teamAbbr: "CHI",
    });
    expect(santos.wpDelta).toBeTypeOf("number");
  });

  it("counts a blocked PAT (pointAfterAttempt id 43) and omits kick distance and WP", () => {
    const summary = load("recorded/pat-blocked-fitzgerald.json");
    const play = drivePlay(summary);
    expect(String(play.pointAfterAttempt?.id)).toBe("43");
    expect(play.pointAfterAttempt?.text).toBe("Blocked PAT");
    const miss = only(summary);
    expect(miss).toMatchObject({
      kickType: "PAT",
      result: "Blocked",
      kicker: "Ryan Fitzgerald",
      teamAbbr: "CAR",
      quarter: "Q4",
      clock: "4:00",
    });
    expect(miss.distance).toBeUndefined();
    expect(miss.wpDelta).toBeUndefined();

    const smack = only(load("recorded/pat-hit-left-upright-smack.json"));
    expect(smack).toMatchObject({ kickType: "PAT", result: "Hit Left Upright", kicker: "Trey Smack", teamAbbr: "GB" });
    expect(smack.distance).toBeUndefined();
  });

  it("skips nullified, No Play, and blocked-then-wiped kicks", () => {
    const myers = load("fg-no-play-myers-penalty.json");
    const smack = load("recorded/fg-nullified-good-smack.json");
    const szmyt = load("recorded/fg-blocked-no-play-szmyt.json");
    expect(detect(myers)).toEqual([]);
    expect(detect(smack)).toEqual([]);
    expect(detect(szmyt)).toEqual([]);
    expect(nullifiedReason(drivePlay(smack))).toBe("penalty play type");
    expect(drivePlay(smack).text).toMatch(/NULLIFIED/i);
    expect(drivePlay(smack).text).toMatch(/No Play/i);
    expect(drivePlay(szmyt).text).toMatch(/BLOCKED/);
    expect(drivePlay(szmyt).text).toMatch(/No Play/i);
  });

  it("still counts a PAT when the flag is enforced between downs or on the touchdown", () => {
    const aubrey = only(load("recorded/pat-miss-between-downs-aubrey.json"));
    expect(drivePlay(load("recorded/pat-miss-between-downs-aubrey.json")).text).toMatch(/enforced between downs/i);
    expect(aubrey).toMatchObject({
      kickType: "PAT",
      result: "Wide Right",
      kicker: "Brandon Aubrey",
      teamAbbr: "DAL",
    });
    expect(nullifiedReason(drivePlay(load("recorded/pat-miss-between-downs-aubrey.json")))).toBeUndefined();

    const stevensPlay = drivePlay(load("recorded/pat-miss-between-downs-stevens.json"));
    expect(stevensPlay.type?.text).toBe("Interception Return Touchdown");
    expect(stevensPlay.text).toMatch(/enforced between downs/i);
    const stevens = only(load("recorded/pat-miss-between-downs-stevens.json"));
    expect(stevens).toMatchObject({ kickType: "PAT", result: "Wide Left", kicker: "Drew Stevens" });
  });

  it("formats the tweet from the recorded plays", () => {
    const fairbairn = withSeason(only(load("recorded/fg-short-fairbairn.json")), 1, 0);
    expect(formatWpDelta(fairbairn.wpDelta!)).toBe(`${MINUS}5.0%`);
    expect(composeTweet(fairbairn)).toBe(
      [
        "❌ Missed FG",
        "Kicker: Ka'imi Fairbairn (HOU)",
        "Kick: 58 yards",
        "Result: Short",
        "When: Q3 7:33",
        "Score: CIN 10-3 HOU",
        `WP: ${MINUS}5.0%`,
        "Season: 1 missed FG · 0 missed PAT",
        "#HTownMade #WhoDey",
      ].join("\n"),
    );

    const santos = withSeason(only(load("recorded/fg-blocked-santos.json")), 2, 0);
    expect(composeTweet(santos)).toContain("Kick: 23 yards");
    expect(composeTweet(santos)).toContain("Result: Blocked");
    expect(composeTweet(santos)).toContain(`WP: ${MINUS}13.8%`);
    expect(composeTweet(santos)).toContain("Season: 2 missed FG · 0 missed PAT");
    expect(composeTweet(santos).endsWith("#DaBears #Skol")).toBe(true);

    const pat = withSeason(only(load("recorded/pat-blocked-fitzgerald.json")), 0, 1);
    const patTweet = composeTweet(pat);
    expect(patTweet.startsWith("❌ Missed PAT")).toBe(true);
    expect(patTweet).not.toMatch(/^Kick:/m);
    expect(patTweet).not.toContain("WP:");
    expect(patTweet).toContain("Result: Blocked");
    expect(patTweet).toContain("When: Q4 4:00");
    expect(patTweet).toContain("Score: CHI 52-37 CAR");
    expect(patTweet).toContain("Season: 0 missed FG · 1 missed PAT");
    expect(patTweet.endsWith("#KeepPounding #DaBears")).toBe(true);

    expect(formatWpDelta(0.004)).toBe("+0.4%");
    expect(formatWpDelta(0)).toBe("0.0%");
    expect(formatWpDelta(-0.044)).toBe(`${MINUS}4.4%`);
    expect(formatSeasonLine(2, 1)).toBe("Season: 2 missed FG · 1 missed PAT");
  });
});

describe("season tally from recorded Aubrey misses", () => {
  it("adds the blocked FG and the between-downs PAT into one season line", async () => {
    const fgSummary = load("recorded/fg-blocked-aubrey.json");
    const patSummary = load("recorded/pat-miss-between-downs-aubrey.json");
    const byId: Record<string, GameSummary> = {
      "401872960": fgSummary,
      "401872930": patSummary,
    };
    const espn = {
      concurrency: 2,
      getScoreboard: async () => ({ events: [], season: { type: 2, year: 2026 }, week: { number: 1 } }),
      getSummary: async (id: string) => {
        const summary = byId[id];
        if (!summary) throw new Error(`unexpected summary ${id}`);
        return summary;
      },
      getWinProbability: async () => [],
    } as unknown as EspnClient;
    const tallies = new SeasonTallyIndex();
    await tallies.refresh(espn, {
      season: { type: 2, year: 2026 },
      week: { number: 1 },
      events: [
        {
          id: "401872960",
          shortName: "BAL @ DAL",
          season: { type: 2, year: 2026 },
          status: { type: { state: "post", completed: true } },
        },
        {
          id: "401872930",
          shortName: "DAL @ NYG",
          season: { type: 2, year: 2026 },
          status: { type: { state: "post", completed: true } },
        },
      ],
    });

    const row = tallies.leaderboard().find((item) => item.kicker === "Brandon Aubrey");
    expect(row).toEqual({ kicker: "Brandon Aubrey", teamAbbr: "DAL", fg: 1, pat: 1 });

    const pat = only(patSummary);
    tallies.attachTo(pat);
    tallies.attachTo(pat);
    expect(formatSeasonLine(pat.seasonFgMisses!, pat.seasonPatMisses!)).toBe("Season: 1 missed FG · 1 missed PAT");
    expect(composeTweet(pat)).toContain("Season: 1 missed FG · 1 missed PAT");

    const notYetIndexed = only(fgSummary);
    notYetIndexed.playId = "not-in-the-index-yet";
    tallies.attachTo(notYetIndexed);
    expect(notYetIndexed.seasonFgMisses).toBe(2);
    expect(notYetIndexed.seasonPatMisses).toBe(1);
  });
});

describe("poll behavior on recorded plays (no X, no GitHub)", () => {
  it("rechecks for 60s and posts once, then a later run does not post again", async () => {
    const summary = load("recorded/fg-short-fairbairn.json");
    const backend = new MemoryBackend();
    const store = new SeenStore(backend);
    const { posted, poster } = recorder();
    const slept: number[] = [];
    const first = await pollOnce(
      {
        espn: espnFor(summary, "CIN @ HOU"),
        store,
        poster,
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
      { ...live, recheckDelayMs: DEFAULT_RECHECK_DELAY_MS },
    );
    expect(slept).toEqual([60_000]);
    expect(DEFAULT_RECHECK_DELAY_MS).toBe(60_000);
    expect(first.posted).toBe(1);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("Ka'imi Fairbairn (HOU)");
    expect(posted[0]).toContain("Result: Short");

    const again = await pollOnce(
      { espn: espnFor(summary, "CIN @ HOU"), store, poster, sleep: async () => undefined },
      live,
    );
    expect(again.posted).toBe(0);
    expect(again.skippedSeen).toBe(1);
    expect(posted).toHaveLength(1);

    const restarted = new SeenStore(backend);
    expect(await restarted.load()).toBe("loaded");
    const third = await pollOnce(
      { espn: espnFor(summary, "CIN @ HOU"), store: restarted, poster, sleep: async () => undefined },
      live,
    );
    expect(third.posted).toBe(0);
    expect(posted).toHaveLength(1);
  });

  it("does not post a miss ESPN erases during the same-run recheck", async () => {
    const summary = load("recorded/fg-short-fairbairn.json");
    const erased = clone(summary);
    const play = drivePlay(erased);
    play.type = { id: "8", text: "Penalty", abbreviation: "PEN" };
    play.isPenalty = true;
    play.penalty = { status: { slug: "accepted", text: "Accepted" }, type: { text: "Leverage" } };
    play.text = `${play.text} PENALTY on CIN-D.Risner, Leverage, 15 yards, enforced at CIN 40 - No Play.`;
    let fetches = 0;
    const { posted, poster } = recorder();
    const slept: number[] = [];
    const result = await pollOnce(
      {
        espn: espnFor(summary, "CIN @ HOU", () => {
          fetches += 1;
          return fetches === 1 ? summary : erased;
        }),
        store: new SeenStore(new MemoryBackend()),
        poster,
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
      { ...live, recheckDelayMs: 60_000 },
    );
    expect(slept).toEqual([60_000]);
    expect(fetches).toBe(2);
    expect(posted).toEqual([]);
    expect(result.posted).toBe(0);
    expect(result.heldForRecheck?.map((miss) => miss.playId)).toEqual([drivePlay(summary).id]);
  });

  it("does not guess an unnamed kicker, does not tweet, and opens one bot-alert issue", async () => {
    const summary = clone(load("recorded/fg-short-fairbairn.json"));
    const play = drivePlay(summary);
    play.text = "58 yard field goal is No Good, Short, Center-A.Brinkman, Holder-K.Kroeger.";
    const notifier = new RecordingNotifier();
    const alerts = new AlertRouter({ issues: notifier, stateIssues: new LogStateAlerter() });
    const { posted, poster } = recorder();
    const store = new SeenStore(new MemoryBackend());
    const deps = {
      espn: espnFor(summary, "CIN @ HOU"),
      store,
      poster,
      notifier,
      alerts,
      sleep: async () => undefined,
    };
    const first = await pollOnce(deps, live);
    const second = await pollOnce(deps, live);

    expect(posted).toEqual([]);
    expect(first.heldForManualPost).toHaveLength(1);
    expect(first.heldForManualPost?.[0].kicker).toBe(UNKNOWN_KICKER);
    expect(JSON.stringify(first.heldForManualPost)).not.toMatch(/Fairbairn|McPherson/);
    expect(notifier.opened).toHaveLength(1);
    expect(second.posted).toBe(0);
    expect(notifier.opened).toHaveLength(1);
    const title = alertIssueTitle(alerts.sent[0].payload);
    expect(title.startsWith("[bot-alert] Missed FG needs manual post:")).toBe(true);
    expect(title).toContain(`[play ${play.id}]`);
    expect(alerts.sent[0].payload.reason).toBe("needs_manual_post");
    expect(store.has(String(play.id))).toBe(false);
  });

  it("pauses posting and opens one bot-state-unavailable issue when state cannot be loaded or saved", async () => {
    const summary = load("recorded/fg-blocked-santos.json");
    const { posted, poster } = recorder();
    const calls: Array<{ url: string; method: string; body?: { title?: string; labels?: string[] } }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as { title?: string; labels?: string[] }) : undefined;
      calls.push({ url, method, body });
      if (method === "GET" && url.includes("/issues?")) return Response.json([]);
      if (method === "POST" && url.endsWith("/labels")) return Response.json({ name: body?.title ?? "label" });
      if (method === "POST" && url.endsWith("/issues")) return Response.json({ number: 9, state: "open", html_url: "https://example.test/9" });
      return new Response("unexpected github call", { status: 500 });
    };
    const alerter = new GitHubStateAlerter("kalb2/nfl-missed-kick-bot", "test-token", fetchImpl as typeof fetch);
    let summaries = 0;
    const missing = new MemoryBackend();
    missing.snap = null;
    const countingEspn = {
      concurrency: 1,
      getScoreboard: async () => ({
        events: [scoreboardEvent(summary, "MIN @ CHI")],
        season: { type: 2, year: 2026 },
        week: { number: 1 },
      }),
      getSummary: async () => {
        summaries += 1;
        return summary;
      },
      getWinProbability: async () => [],
    } as unknown as EspnClient;
    const blocked = await runGuardedPoll(
      {
        espn: countingEspn,
        store: new SeenStore(missing),
        poster,
        alerter,
        sleep: async () => undefined,
      },
      live,
    );
    expect(blocked.blocked).toBe(true);
    expect(summaries).toBe(0);
    expect(posted).toEqual([]);
    const opened = calls.filter((call) => call.method === "POST" && call.url.endsWith("/issues"));
    expect(opened).toHaveLength(1);
    expect(opened[0].body?.title).toBe(STATE_ALERT_TITLE);
    expect(opened[0].body?.labels).toEqual([STATE_ALERT_LABEL, "bot-alert"]);
    expect(calls.every((call) => call.url.startsWith("https://api.github.com/repos/kalb2/nfl-missed-kick-bot"))).toBe(true);

    const saveBackend = new MemoryBackend();
    saveBackend.failWrites = true;
    const saveBlocked = await runGuardedPoll(
      {
        espn: espnFor(summary, "MIN @ CHI"),
        store: new SeenStore(saveBackend),
        poster,
        alerter,
        sleep: async () => undefined,
      },
      live,
    );
    expect(saveBlocked.blocked).toBe(true);
    if (!saveBlocked.blocked) return;
    expect(saveBlocked.reason).toMatch(/GitHub contents API 500/);
    expect(posted).toEqual([]);
    const issuePosts = calls.filter((call) => call.method === "POST" && call.url.endsWith("/issues"));
    expect(issuePosts).toHaveLength(2);
    expect(issuePosts.every((call) => call.body?.labels?.includes(STATE_ALERT_LABEL))).toBe(true);
  });

  it("dry-run posting never calls X, even when credentials are present", async () => {
    const poster = createPoster(
      loadConfig({
        dryRun: true,
        twitter: { appKey: "k", appSecret: "s", accessToken: "t", accessSecret: "ts" },
      }),
      false,
    );
    const result = await poster.post("❌ Missed FG\nKicker: Test (HOU)");
    expect(result.id).toBe("dry-run");
  });
});

describe("known bugs against recorded 2026 plays (expected failures)", () => {
  // Week 6 CAR @ PHI, play 4018729984351. ESPN's only text is the scoring summary
  // "Tommy Tremble 19 Yd pass from Bryce Young (Ryan Fitzgerald PAT failed)" plus a
  // structured accepted taunting penalty (15 yards). The TD stayed in scoringPlays
  // and the try result is recorded, but the text never says "enforced between downs",
  // so nullifiedReason treats it as an accepted penalty on the kick and the bot
  // drops a real PAT miss. Not fixed here.
  it.fails("counts Fitzgerald's PAT failed when taunting on the TD has no between-downs phrase", () => {
    const summary = load("recorded/pat-taunting-fitzgerald.json");
    const play = drivePlay(summary);
    expect(play.text).toBe("Tommy Tremble 19 Yd pass from Bryce Young (Ryan Fitzgerald PAT failed)");
    expect(play.penalty?.type?.text).toBe("Taunting");
    expect(String(play.pointAfterAttempt?.id)).toBe("62");
    const misses = detect(summary);
    expect(misses).toHaveLength(1);
    expect(misses[0]).toMatchObject({ kickType: "PAT", kicker: "Ryan Fitzgerald", teamAbbr: "CAR" });
  });

  // Return touchdowns keep teamParticipants type "offense" as the team that snapped
  // the ball. The bot tweets that team. Drew Stevens kicked for WSH after a pick-six
  // (SEA @ WSH, play 4018729554262) and Daniel Carlson kicked for NO after a fumble
  // return (MIN @ NO, play 4018729872643). Both tweets name the right kicker and the
  // wrong team. Not fixed here.
  it.fails("attributes Drew Stevens's pick-six PAT to WSH, the team that kicked", () => {
    const miss = withSeason(only(load("recorded/pat-miss-between-downs-stevens.json")), 0, 1);
    expect(miss.kicker).toBe("Drew Stevens");
    expect(miss.teamAbbr).toBe("WSH");
    const tweet = composeTweet(miss);
    expect(tweet).toContain("Kicker: Drew Stevens (WSH)");
    expect(tweet).toContain("#RaiseHail");
    expect(tweet).not.toContain("(SEA)");
  });

  it.fails("attributes Daniel Carlson's fumble-return PAT to NO, the team that kicked", () => {
    const miss = withSeason(only(load("recorded/pat-fumble-return-carlson.json")), 0, 1);
    expect(miss.kicker).toBe("Daniel Carlson");
    expect(miss.teamAbbr).toBe("NO");
    const tweet = composeTweet(miss);
    expect(tweet).toContain("Kicker: Daniel Carlson (NO)");
    expect(tweet).toContain("#Saints");
    expect(tweet).not.toContain("(MIN)");
  });
});
