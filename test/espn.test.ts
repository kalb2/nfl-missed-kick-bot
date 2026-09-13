import { describe, expect, it } from "vitest";
import { isWatchableGame, normalizeScoreboard } from "../src/espn.js";
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
