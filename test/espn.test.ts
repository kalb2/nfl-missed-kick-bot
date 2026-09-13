import { describe, expect, it } from "vitest";
import {
  EspnClient,
  isWatchableGame,
  mergeSummaries,
  normalizeGamePayload,
  normalizeScoreboard,
  summaryHasPlays,
} from "../src/espn.js";
import type { ScoreboardEvent } from "../src/types.js";

function event(partial: Partial<ScoreboardEvent> & Pick<ScoreboardEvent, "id">): ScoreboardEvent {
  return {
    shortName: "TEST",
    ...partial,
  };
}

describe("isWatchableGame", () => {
  it("always watches in-progress games", () => {
    expect(
      isWatchableGame(
        event({
          id: "1",
          date: "2020-01-01T00:00:00Z",
          status: { type: { state: "in" } },
        }),
      ),
    ).toBe(true);
  });

  it("skips scheduled games", () => {
    expect(
      isWatchableGame(
        event({
          id: "2",
          date: new Date().toISOString(),
          status: { type: { state: "pre" } },
        }),
      ),
    ).toBe(false);
  });

  it("watches a final only within kickoff + 4h + window", () => {
    const start = Date.now() - 3 * 60 * 60 * 1000;
    const ev = event({
      id: "3",
      date: new Date(start).toISOString(),
      status: { type: { state: "post", completed: true } },
    });
    expect(isWatchableGame(ev, Date.now(), 45)).toBe(true);
    expect(isWatchableGame(ev, start + (5 * 60 + 30) * 60 * 1000, 45)).toBe(false);
  });

  it("allToday includes today's finals and skips upcoming", () => {
    const started = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    expect(
      isWatchableGame(
        event({ id: "4", date: started, status: { type: { state: "post", completed: true } } }),
        Date.now(),
        45,
        { allToday: true },
      ),
    ).toBe(true);
    expect(
      isWatchableGame(
        event({
          id: "5",
          date: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
          status: { type: { state: "pre" } },
        }),
        Date.now(),
        45,
        { allToday: true },
      ),
    ).toBe(false);
  });
});

describe("normalizeScoreboard", () => {
  it("accepts site API shape and cdn wrapper shape", () => {
    expect(normalizeScoreboard({ events: [{ id: "a" }] }).events).toEqual([{ id: "a" }]);
    expect(
      normalizeScoreboard({ content: { sbData: { events: [{ id: "b" }] } } }).events,
    ).toEqual([{ id: "b" }]);
    expect(normalizeScoreboard(null).events).toEqual([]);
  });
});

describe("alternate play feeds", () => {
  const missPlay = {
    id: "4018729234815",
    type: { id: "60", text: "Field Goal Missed" },
    text: "D.Carlson 62 yard field goal is No Good, Wide Right.",
  };

  it("unwraps cdn.espn.com gamepackageJSON.drives", () => {
    const summary = normalizeGamePayload({
      gameId: "401872923",
      gamepackageJSON: {
        header: { id: "401872923" },
        drives: { previous: [{ plays: [missPlay] }] },
      },
    });
    expect(summaryHasPlays(summary)).toBe(true);
    expect(summary.header?.id).toBe("401872923");
    expect(summary.drives?.previous?.[0]?.plays?.[0]?.id).toBe("4018729234815");
  });

  it("wraps core /plays items as a drive", () => {
    const summary = normalizeGamePayload({
      count: 1,
      items: [missPlay],
    });
    expect(summaryHasPlays(summary)).toBe(true);
    expect(summary.drives?.previous?.[0]?.plays?.[0]?.text).toMatch(/Carlson/);
  });

  it("keeps summary header when merging an alternate feed", () => {
    const merged = mergeSummaries(
      { header: { id: "1", competitions: [] }, drives: { previous: [] } },
      { drives: { previous: [{ plays: [missPlay] }] } },
    );
    expect(merged.header?.id).toBe("1");
    expect(summaryHasPlays(merged)).toBe(true);
  });

  it("falls back to CDN play-by-play when the site summary has no drives", async () => {
    const urls: string[] = [];
    const fetchImpl = async (url: string | URL | Request) => {
      const href = String(url);
      urls.push(href);
      if (href.includes("/summary")) {
        return new Response(JSON.stringify({ header: { id: "401872923" }, drives: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (href.includes("cdn.espn.com")) {
        return new Response(
          JSON.stringify({
            gamepackageJSON: { drives: { previous: [{ plays: [missPlay] }] } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("nope", { status: 500 });
    };
    const client = new EspnClient({
      userAgent: "test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const summary = await client.getSummary("401872923");
    expect(summaryHasPlays(summary)).toBe(true);
    expect(urls.some((u) => u.includes("cdn.espn.com/core/nfl/playbyplay"))).toBe(true);
  });
});
