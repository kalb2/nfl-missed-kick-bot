import { describe, expect, it } from "vitest";
import {
  EspnClient,
  athleteFromPayload,
  hasGameStarted,
  isWatchableGame,
  mergeSummaries,
  normalizeGamePayload,
  normalizeScoreboard,
  summaryHasPlays,
  withScoreboardQuery,
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

  it("keeps season type/year and week from the top-level scoreboard", () => {
    const board = normalizeScoreboard({
      season: { type: 2, year: 2026 },
      week: { number: 1 },
      events: [{ id: "401872923" }],
    });
    expect(board.season).toEqual({ type: 2, year: 2026 });
    expect(board.week).toEqual({ number: 1 });
  });
});

describe("withScoreboardQuery", () => {
  it("adds seasontype, week, and dates for regular-season week scans", () => {
    expect(
      withScoreboardQuery("https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard", {
        seasonType: 2,
        week: 1,
        dates: "2026",
      }),
    ).toBe(
      "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=1&dates=2026",
    );
  });
});

describe("hasGameStarted", () => {
  it("includes in-progress and finished games, not scheduled ones", () => {
    expect(hasGameStarted(event({ id: "in", status: { type: { state: "in" } } }))).toBe(true);
    expect(hasGameStarted(event({ id: "post", status: { type: { state: "post" } } }))).toBe(true);
    expect(hasGameStarted(event({ id: "pre", status: { type: { state: "pre" } } }))).toBe(false);
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

describe("athlete profiles", () => {
  it("reads displayName from core and site-v3 payloads", () => {
    expect(
      athleteFromPayload({
        id: "2985659",
        firstName: "Wil",
        lastName: "Lutz",
        fullName: "Wil Lutz",
        displayName: "Wil Lutz",
        shortName: "W. Lutz",
      }),
    ).toMatchObject({
      id: "2985659",
      firstName: "Wil",
      lastName: "Lutz",
      displayName: "Wil Lutz",
      fullName: "Wil Lutz",
    });
    expect(
      athleteFromPayload({
        athlete: {
          id: "3051909",
          firstName: "Daniel",
          lastName: "Carlson",
          displayName: "Daniel Carlson",
          fullName: "Daniel Carlson",
        },
      }),
    ).toMatchObject({ id: "3051909", displayName: "Daniel Carlson" });
  });

  it("fetches and caches an athlete profile by id", async () => {
    const urls: string[] = [];
    let hits = 0;
    const fetchImpl = async (url: string | URL | Request) => {
      urls.push(String(url));
      hits += 1;
      return new Response(
        JSON.stringify({
          id: "2985659",
          firstName: "Wil",
          lastName: "Lutz",
          fullName: "Wil Lutz",
          displayName: "Wil Lutz",
          shortName: "W. Lutz",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const client = new EspnClient({
      userAgent: "test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const first = await client.getAthlete("2985659");
    const second = await client.getAthlete("2985659");
    expect(first?.displayName).toBe("Wil Lutz");
    expect(second?.displayName).toBe("Wil Lutz");
    expect(hits).toBe(1);
    expect(urls[0]).toContain("/athletes/2985659");
  });
});

describe("getScoreboard week query", () => {
  it("requests seasontype=2&week=N when scanning a prior week", async () => {
    const weekUrls: string[] = [];
    const weekFetch: typeof fetch = async (url) => {
      weekUrls.push(String(url));
      return new Response(
        JSON.stringify({ season: { type: 2, year: 2026 }, week: { number: 1 }, events: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const weekClient = new EspnClient({
      userAgent: "test",
      fetchImpl: weekFetch as unknown as typeof fetch,
    });
    const weekBoard = await weekClient.getScoreboard({ seasonType: 2, week: 1, dates: "2026" });
    expect(weekBoard.week?.number).toBe(1);
    expect(weekUrls[0]).toContain("seasontype=2");
    expect(weekUrls[0]).toContain("week=1");
    expect(weekUrls[0]).toContain("dates=2026");
  });
});
