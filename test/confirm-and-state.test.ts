import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildGameContext, detectMissedKicks, nullifiedReason } from "../src/detect.js";
import type { EspnClient } from "../src/espn.js";
import { GitHubStateAlerter, LogNotifier, LogStateAlerter } from "../src/notify.js";
import { Overrides } from "../src/overrides.js";
import { missFingerprint, pollOnce } from "../src/poll.js";
import { bootstrapState, runGuardedPoll } from "../src/run.js";
import { GitHubBranchStateBackend, type StateBackend } from "../src/state-backend.js";
import { SeenStore } from "../src/store.js";
import { SeasonTallyIndex } from "../src/tallies.js";
import type { GameSummary, MissedKick, Play, PollOptions, ScoreboardEvent } from "../src/types.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const load = (name: string): GameSummary =>
  JSON.parse(readFileSync(path.join(fixturesDir, name), "utf8")) as GameSummary;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

const MYERS_EVENT = "401872977";
const MYERS_PLAY = "4018729773227";
/** Real ESPN summary after the flag was applied: type 8 Penalty, "- No Play." */
const penaltyErased = load("fg-no-play-myers-penalty.json");

function playsOf(summary: GameSummary): Play[] {
  return (summary.drives?.previous ?? []).flatMap((d) => d.plays ?? []);
}

/** What ESPN shows for the first minute or so: a plain Field Goal Missed, no flag yet. */
function rawMiss(result = "Wide Right"): GameSummary {
  const s = clone(penaltyErased);
  const play = playsOf(s).find((p) => p.id === MYERS_PLAY)!;
  play.type = { id: "60", text: "Field Goal Missed", abbreviation: "FGM" };
  play.text = `J.Myers 53 yard field goal is No Good, ${result}, Center-C.Stoll, Holder-M.Dickson.`;
  delete play.isPenalty;
  delete play.penalty;
  return s;
}

/** Same kick, flag thrown, but ESPN left the type as Field Goal Missed. */
function noPlayButTypeKept(): GameSummary {
  const s = rawMiss();
  const play = playsOf(s).find((p) => p.id === MYERS_PLAY)!;
  play.text += "PENALTY on LAC-T.Tuipulotu, Leverage, 15 yards, enforced at LAC 35 - No Play.";
  return s;
}

function event(state: "in" | "post", kickoffAgoMin: number, nowMs: number): ScoreboardEvent {
  return {
    id: MYERS_EVENT,
    shortName: "LAC @ SEA",
    date: new Date(nowMs - kickoffAgoMin * 60_000).toISOString(),
    status: { type: { state, completed: state === "post" } },
    competitions: [],
  };
}

function espnSequence(next: () => GameSummary, ev: () => ScoreboardEvent, calls = { summary: 0, scoreboard: 0 }): EspnClient {
  return {
    concurrency: 1,
    getScoreboard: async () => {
      calls.scoreboard += 1;
      return { events: [ev()] };
    },
    getSummary: async () => {
      calls.summary += 1;
      return next();
    },
    getWinProbability: async () => [],
  } as unknown as EspnClient;
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function tmpFile(name = "handled.json"): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "confirm-"));
  dirs.push(dir);
  return path.join(dir, name);
}

function recorder() {
  const posted: string[] = [];
  return { posted, poster: { post: async (t: string) => (posted.push(t), { id: String(posted.length) }) } };
}

const live: PollOptions = {
  dryRun: false,
  seedSeen: false,
  allToday: false,
  persist: true,
  recentFinalWindowMin: 45,
};

function harness(start = Date.parse("2026-10-04T22:46:00Z")) {
  let clock = start;
  return {
    now: () => clock,
    advance: (min: number) => {
      clock += min * 60_000;
    },
    get clock() {
      return clock;
    },
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
}

describe("penalty / No Play / nullified / reversed plays are never misses", () => {
  const ctx = (s: GameSummary) =>
    buildGameContext(MYERS_EVENT, s, { eventId: MYERS_EVENT, shortName: "LAC @ SEA", competitors: [] });

  it("drops the real Myers 53-yarder wiped by a Leverage penalty (ESPN type 8, '- No Play.')", () => {
    expect(detectMissedKicks(penaltyErased, ctx(penaltyErased))).toEqual([]);
    const before = detectMissedKicks(rawMiss(), ctx(rawMiss()));
    expect(before.map((m) => m.kicker)).toEqual(["Jason Myers"]);
  });

  it("drops 'No Play' text even if ESPN kept the Field Goal Missed type", () => {
    const s = noPlayButTypeKept();
    expect(detectMissedKicks(s, ctx(s))).toEqual([]);
  });

  it("classifies the edge cases", () => {
    const fg = (text: string, extra: Partial<Play> = {}): Play => ({
      id: "1",
      type: { id: "60", text: "Field Goal Missed" },
      text,
      ...extra,
    });
    expect(nullifiedReason(fg("X.Kicker 40 yard field goal is No Good, Wide Left."))).toBeUndefined();
    expect(nullifiedReason(fg("... field goal is No Good ... TOUCHDOWN NULLIFIED by penalty"))).toBe("nullified");
    expect(nullifiedReason(fg("X.Kicker 40 yard field goal is No Good. Replay the down."))).toBe("down replayed");
    // Ruled no good on the field, reversed to good: the standing ruling is not a miss.
    expect(
      nullifiedReason(fg("X.Kicker 50 yard field goal is No Good. The Replay Official reviewed the field goal ruling, and the play was REVERSED. X.Kicker 50 yard field goal is GOOD.")),
    ).toBe("ruling reversed");
    // Ruled good, reversed to no good: the miss stands.
    expect(
      nullifiedReason(fg("X.Kicker 50 yard field goal is GOOD. The play was REVERSED. X.Kicker 50 yard field goal is No Good, Wide Right.")),
    ).toBeUndefined();
    // Accepted flag on the kick itself (not carried to the kickoff) replays the try.
    expect(
      nullifiedReason(fg("X.Kicker 40 yard field goal is No Good.", { isPenalty: true, penalty: { status: { slug: "accepted" } } })),
    ).toBe("accepted penalty on the kick");
    // Butker 2025: TD + unsportsmanlike "enforced between downs" + PAT No Good → real miss.
    const butker: Play = {
      id: "4017729203761",
      type: { id: "68", text: "Rushing Touchdown" },
      scoringPlay: true,
      isPenalty: true,
      penalty: { status: { slug: "accepted", text: "Accepted" } },
      pointAfterAttempt: { id: 62, text: "Extra Point Missed" },
      text: "K.Hunt right guard for 1 yard, TOUCHDOWN.PENALTY on KC-K.Hunt, Unsportsmanlike Conduct, 15 yards, enforced between downs. H.Butker extra point is No Good, Wide Left.",
    };
    expect(nullifiedReason(butker, new Set(["4017729203761"]))).toBeUndefined();
    // Same TD removed from scoringPlays (overturned) → its PAT no longer counts.
    expect(nullifiedReason(butker, new Set(["other"]))).toBe("touchdown no longer in scoringPlays");
  });
});

describe("two identical sightings before posting", () => {
  it("never posts a miss that a penalty erases between polls", async () => {
    const h = harness();
    const store = new SeenStore(await tmpFile());
    const { posted, poster } = recorder();
    let summary = rawMiss();
    const espn = espnSequence(() => summary, () => event("in", 150, h.clock));
    const deps = { espn, store, poster, now: h.now, sleep: h.sleep };

    const r1 = await pollOnce(deps, live);
    expect(r1.awaitingConfirmation?.map((m) => m.playId)).toEqual([MYERS_PLAY]);
    expect(posted).toEqual([]);

    summary = penaltyErased; // ESPN applies the flag: type 8, "- No Play."
    h.advance(6);
    const r2 = await pollOnce(deps, live);
    h.advance(6);
    await pollOnce(deps, live);
    expect(posted).toEqual([]);
    expect(r2.awaitingConfirmation).toEqual([]);
    expect(store.getPending(MYERS_PLAY)).toBeUndefined();
  });

  it("never posts a 'No Play' even when it looks the same on both polls", async () => {
    const h = harness();
    const store = new SeenStore(await tmpFile());
    const { posted, poster } = recorder();
    const espn = espnSequence(noPlayButTypeKept, () => event("in", 150, h.clock));
    for (let i = 0; i < 3; i++) {
      await pollOnce({ espn, store, poster, now: h.now }, live);
      h.advance(6);
    }
    expect(posted).toEqual([]);
  });

  it("restarts confirmation when the play is corrected between polls, then posts the corrected version once", async () => {
    const h = harness();
    const store = new SeenStore(await tmpFile());
    const { posted, poster } = recorder();
    let summary = rawMiss("Wide Right");
    const espn = espnSequence(() => summary, () => event("in", 150, h.clock));
    const deps = { espn, store, poster, now: h.now };

    await pollOnce(deps, live);
    summary = rawMiss("Wide Left"); // ESPN corrects the result
    h.advance(6);
    const r2 = await pollOnce(deps, live);
    expect(posted).toEqual([]);
    expect(r2.awaitingConfirmation?.[0]?.result).toBe("Wide Left");

    h.advance(6);
    await pollOnce(deps, live);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("Result: Wide Left");
    expect(posted[0]).toContain("Jason Myers");

    h.advance(6);
    await pollOnce(deps, live);
    expect(posted).toHaveLength(1);
    expect(store.handledEntry(MYERS_PLAY, MYERS_EVENT)?.status).toBe("posted");
  });

  it("does not count two back-to-back runs seconds apart as two polls", async () => {
    const h = harness();
    const store = new SeenStore(await tmpFile());
    const { posted, poster } = recorder();
    const espn = espnSequence(() => rawMiss(), () => event("in", 150, h.clock));
    await pollOnce({ espn, store, poster, now: h.now }, live);
    h.advance(0.25);
    await pollOnce({ espn, store, poster, now: h.now }, live);
    expect(posted).toEqual([]);
    h.advance(6);
    await pollOnce({ espn, store, poster, now: h.now }, live);
    expect(posted).toHaveLength(1);
  });

  it("fingerprint ignores initial-vs-full kicker name but not result or type", () => {
    const base = { playId: "1", kickType: "FG", playType: "60/", result: "Wide Right", kicker: "Jason Myers" } as MissedKick;
    expect(missFingerprint(base)).toBe(missFingerprint({ ...base, kicker: "J.Myers" }));
    expect(missFingerprint(base)).not.toBe(missFingerprint({ ...base, result: "Wide Left" }));
    expect(missFingerprint(base)).not.toBe(missFingerprint({ ...base, playType: "8/" }));
    expect(missFingerprint(base)).not.toBe(missFingerprint({ ...base, kicker: "Jason Sanders" }));
  });

  it("last poll of a game: confirms with an in-run re-fetch so a last-second miss still posts", async () => {
    const h = harness();
    const store = new SeenStore(await tmpFile());
    const { posted, poster } = recorder();
    const calls = { summary: 0, scoreboard: 0 };
    // Final, 4h40m after kickoff: the Worker stops dispatching at 4h45m.
    const espn = espnSequence(() => rawMiss(), () => event("post", 280, h.clock), calls);
    const slept: number[] = [];
    const r = await pollOnce(
      { espn, store, poster, now: h.now, sleep: async (ms) => (slept.push(ms), h.sleep(ms)) },
      live,
    );
    expect(slept).toEqual([90_000]);
    expect(calls.summary).toBeGreaterThanOrEqual(2);
    expect(posted).toHaveLength(1);
    expect(r.posted).toBe(1);
  });

  it("last poll of a game: the re-fetch still blocks a miss the penalty erased", async () => {
    const h = harness();
    const store = new SeenStore(await tmpFile());
    const { posted, poster } = recorder();
    let n = 0;
    const espn = espnSequence(
      () => (n++ === 0 ? rawMiss() : penaltyErased),
      () => event("post", 280, h.clock),
    );
    await pollOnce({ espn, store, poster, now: h.now, sleep: h.sleep }, live);
    expect(posted).toEqual([]);
    expect(store.getPending(MYERS_PLAY)).toBeUndefined();
  });

  it("mid-game polls do not wait for an in-run re-fetch", async () => {
    const h = harness();
    const store = new SeenStore(await tmpFile());
    const { poster } = recorder();
    const slept: number[] = [];
    const espn = espnSequence(() => rawMiss(), () => event("in", 120, h.clock));
    await pollOnce({ espn, store, poster, now: h.now, sleep: async (ms) => void slept.push(ms) }, live);
    expect(slept).toEqual([]);
  });
});

class MemoryBackend implements StateBackend {
  readonly description = "memory";
  data: unknown = null;
  failRead?: Error;
  failWrite?: Error;
  writes = 0;
  async read() {
    if (this.failRead) throw this.failRead;
    return this.data === null ? null : { data: clone(this.data), version: "v" };
  }
  async write(data: unknown) {
    if (this.failWrite) throw this.failWrite;
    this.writes += 1;
    this.data = clone(data);
    return "v";
  }
}

describe("durable handled-plays list", () => {
  it("restart with lost state: posts nothing, fetches nothing, alerts once", async () => {
    const backend = new MemoryBackend(); // read() → null: the state file is gone
    const calls = { summary: 0, scoreboard: 0 };
    const h = harness();
    const espn = espnSequence(() => rawMiss(), () => event("in", 150, h.clock), calls);
    const { posted, poster } = recorder();
    const alerter = new LogStateAlerter();

    for (let i = 0; i < 3; i++) {
      const out = await runGuardedPoll({ espn, store: new SeenStore(backend), poster, alerter, now: h.now }, live);
      expect(out.blocked).toBe(true);
      h.advance(6);
    }
    expect(posted).toEqual([]);
    expect(calls).toEqual({ summary: 0, scoreboard: 0 });
    expect(alerter.raised[0]).toMatch(/not found/);
    expect(backend.writes).toBe(0); // never "repairs" itself with an empty list
  });

  it("an unreadable state backend (API error) blocks posting too", async () => {
    const backend = new MemoryBackend();
    backend.failRead = new Error("GitHub GET state: HTTP 500");
    const { posted, poster } = recorder();
    const alerter = new LogStateAlerter();
    const h = harness();
    const out = await runGuardedPoll(
      { espn: espnSequence(() => rawMiss(), () => event("in", 150, h.clock)), store: new SeenStore(backend), poster, alerter },
      live,
    );
    expect(out.blocked).toBe(true);
    expect(posted).toEqual([]);
    expect(alerter.raised[0]).toMatch(/HTTP 500/);
  });

  it("survives a restart (new process, Actions cache gone) without re-posting", async () => {
    const backend = new MemoryBackend();
    backend.data = { version: 2, handled: {}, pending: {} };
    const h = harness();
    const espn = espnSequence(() => rawMiss(), () => event("in", 150, h.clock));
    const { posted, poster } = recorder();
    const alerter = new LogStateAlerter();
    for (let i = 0; i < 4; i++) {
      // A fresh SeenStore each time = a fresh runner with no local files.
      await runGuardedPoll({ espn, store: new SeenStore(backend), poster, alerter, now: h.now }, live);
      h.advance(6);
    }
    expect(posted).toHaveLength(1);
    expect(alerter.raised).toEqual([]);
    const saved = backend.data as { handled: Record<string, { status: string }> };
    expect(saved.handled[`${MYERS_EVENT}:${MYERS_PLAY}`]?.status).toBe("posted");
  });

  it("if the claim can't be saved, nothing is posted and the run alerts", async () => {
    const backend = new MemoryBackend();
    backend.data = { version: 2, handled: {}, pending: {} };
    const h = harness();
    const espn = espnSequence(() => rawMiss(), () => event("in", 150, h.clock));
    const { posted, poster } = recorder();
    const alerter = new LogStateAlerter();
    await runGuardedPoll({ espn, store: new SeenStore(backend), poster, alerter, now: h.now }, live);
    h.advance(6);
    backend.failWrite = new Error("GitHub PUT state: HTTP 409");
    const out = await runGuardedPoll({ espn, store: new SeenStore(backend), poster, alerter, now: h.now }, live);
    expect(out.blocked).toBe(true);
    expect(posted).toEqual([]);
    expect(alerter.raised[0]).toMatch(/409/);
  });

  it("a failed tweet is not retried (it may have gone out); it opens a manual-post issue", async () => {
    const store = new SeenStore(await tmpFile());
    const h = harness();
    const espn = espnSequence(() => rawMiss(), () => event("in", 150, h.clock));
    let attempts = 0;
    const poster = {
      post: async () => {
        attempts += 1;
        throw new Error("socket hang up");
      },
    };
    const notifier = new LogNotifier();
    const deps = { espn, store, poster, notifier, now: h.now };
    await pollOnce(deps, live);
    h.advance(6);
    await pollOnce(deps, live);
    h.advance(6);
    await pollOnce(deps, live);
    expect(attempts).toBe(1);
    expect(notifier.opened.map((m) => m.playId)).toEqual([MYERS_PLAY]);
    expect(store.handledEntry(MYERS_PLAY)?.status).toBe("failed");
  });

  it("bootstrap marks every current miss + legacy cache ids handled, posts nothing, and refuses to overwrite", async () => {
    const file = await tmpFile("handled.json");
    const legacy = await tmpFile("seen.json");
    await writeFile(legacy, JSON.stringify({ version: 1, seenPlayIds: ["4018729231111"] }));
    const h = harness();
    const espn = espnSequence(() => rawMiss(), () => event("post", 600, h.clock));
    const tallies = new SeasonTallyIndex(undefined, new Overrides());
    const out = await bootstrapState({ store: new SeenStore(file), espn, tallies, legacyPath: legacy, recentFinalWindowMin: 45 });
    expect(out.created).toBe(true);
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.version).toBe(2);
    expect(Object.keys(saved.handled).sort()).toEqual([`401872923:4018729231111`, `${MYERS_EVENT}:${MYERS_PLAY}`].sort());

    const again = await bootstrapState({ store: new SeenStore(file), espn, tallies, recentFinalWindowMin: 45 });
    expect(again.created).toBe(false);

    // And the live poll afterwards never posts the seeded miss.
    const { posted, poster } = recorder();
    for (let i = 0; i < 3; i++) {
      await runGuardedPoll({ espn: espnSequence(() => rawMiss(), () => event("in", 150, h.clock)), store: new SeenStore(file), poster, alerter: new LogStateAlerter(), now: h.now }, live);
      h.advance(6);
    }
    expect(posted).toEqual([]);
  });
});

describe("GitHub branch backend + alert issue", () => {
  function fakeGitHub(routes: Record<string, (init?: RequestInit) => Response>) {
    const seen: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      seen.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const key = Object.keys(routes).find((k) => `${method} ${url}`.includes(k));
      return key ? routes[key](init) : new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    return { seen, fetchImpl };
  }
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

  it("reads base64 content with its sha and writes back with that sha", async () => {
    const doc = { version: 2, handled: {}, pending: {} };
    const gh = fakeGitHub({
      "GET https://api.github.com/repos/kalb2/bot/contents/handled-plays.json?ref=bot-state": () =>
        json({ encoding: "base64", content: Buffer.from(JSON.stringify(doc)).toString("base64"), sha: "abc" }),
      "PUT https://api.github.com/repos/kalb2/bot/contents/handled-plays.json": () => json({ content: { sha: "def" } }),
    });
    const backend = new GitHubBranchStateBackend({ repo: "kalb2/bot", token: "t", branch: "bot-state", filePath: "handled-plays.json", fetchImpl: gh.fetchImpl });
    const store = new SeenStore(backend);
    expect(await store.load()).toBe("loaded");
    store.markHandled("4018729773227", "401872977", "posted");
    await store.save();
    const put = gh.seen.find((r) => r.method === "PUT")!;
    expect(put.body).toMatchObject({ branch: "bot-state", sha: "abc" });
  });

  it("404 is 'missing', 5xx throws, conflicting write throws", async () => {
    const missing = new GitHubBranchStateBackend({ repo: "kalb2/bot", token: "t", branch: "bot-state", filePath: "handled-plays.json", fetchImpl: fakeGitHub({}).fetchImpl });
    expect(await missing.read()).toBeNull();
    const down = new GitHubBranchStateBackend({
      repo: "kalb2/bot", token: "t", branch: "bot-state", filePath: "handled-plays.json",
      fetchImpl: fakeGitHub({ "GET ": () => new Response("", { status: 503 }), "PUT ": () => new Response("", { status: 409 }) }).fetchImpl,
    });
    await expect(down.read()).rejects.toThrow(/503/);
    await expect(down.write({}, "abc", "m")).rejects.toThrow(/409/);
  });

  it("raises one alert issue (not one per poll) and closes it when state is back", async () => {
    let open: Array<{ number: number }> = [];
    const gh = fakeGitHub({
      "GET https://api.github.com/repos/kalb2/bot/issues?state=open&labels=bot-state-unavailable": () => json(open),
      "POST https://api.github.com/repos/kalb2/bot/labels": () => json({}),
      "POST https://api.github.com/repos/kalb2/bot/issues/9/comments": () => json({}),
      "PATCH https://api.github.com/repos/kalb2/bot/issues/9": () => json({}),
      "POST https://api.github.com/repos/kalb2/bot/issues": () => {
        open = [{ number: 9 }];
        return json({ number: 9 });
      },
    });
    const alerter = new GitHubStateAlerter("kalb2/bot", "t", gh.fetchImpl);
    await alerter.raise("boom");
    await alerter.raise("boom again");
    const created = gh.seen.filter((r) => r.method === "POST" && r.url.endsWith("/issues"));
    expect(created).toHaveLength(1);
    expect(created[0].body).toMatchObject({ labels: ["bot-state-unavailable"] });
    await alerter.clear();
    expect(gh.seen.some((r) => r.method === "PATCH" && r.url.endsWith("/issues/9"))).toBe(true);
  });
});

describe("upgrade transition", () => {
  it("never posts a play the pre-upgrade code recorded in the old Actions-cache seen.json", async () => {
    const legacy = await tmpFile("seen.json");
    await writeFile(legacy, JSON.stringify({ version: 1, seenPlayIds: [MYERS_PLAY] }));
    const backend = new MemoryBackend();
    backend.data = { version: 2, handled: {}, pending: {} };
    const h = harness();
    const { posted, poster } = recorder();
    for (let i = 0; i < 3; i++) {
      await runGuardedPoll(
        { espn: espnSequence(() => rawMiss(), () => event("in", 150, h.clock)), store: new SeenStore(backend), poster, alerter: new LogStateAlerter(), legacyPath: legacy, now: h.now },
        live,
      );
      h.advance(6);
    }
    expect(posted).toEqual([]);
  });
});
