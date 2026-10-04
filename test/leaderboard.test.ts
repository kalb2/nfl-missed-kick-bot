import { describe, expect, it } from "vitest";
import { EspnClient } from "../src/espn.js";
import { runSeasonLeaderboard } from "../src/leaderboard.js";
import type { GameSummary, Play, Scoreboard, ScoreboardEvent } from "../src/types.js";

interface KickerPlan {
  first: string;
  last: string;
  team: string;
  teamId: string;
  athleteId: string;
  fg: number;
  pat: number;
}

const PLANS: KickerPlan[] = [
  { first: "Carl", last: "Diaz", team: "DAL", teamId: "1", athleteId: "a1", fg: 0, pat: 5 },
  { first: "Amy", last: "Baker", team: "DEN", teamId: "2", athleteId: "a2", fg: 2, pat: 2 },
  { first: "Ben", last: "Cole", team: "KC", teamId: "3", athleteId: "a3", fg: 3, pat: 1 },
  { first: "Dee", last: "Evans", team: "GB", teamId: "4", athleteId: "a4", fg: 3, pat: 0 },
  { first: "Eve", last: "Frost", team: "MIA", teamId: "5", athleteId: "a5", fg: 2, pat: 0 },
  { first: "Fred", last: "Fox", team: "NE", teamId: "6", athleteId: "a6", fg: 2, pat: 0 },
  { first: "Gina", last: "Hart", team: "BUF", teamId: "7", athleteId: "a7", fg: 1, pat: 1 },
];

function missPlay(plan: KickerPlan, playId: string, kickType: "FG" | "PAT"): Play {
  const initial = `${plan.first[0]}.${plan.last}`;
  const text =
    kickType === "FG"
      ? `${initial} 40 yard field goal is No Good, Wide Left.`
      : `${initial} extra point is No Good, Wide Right.`;
  return {
    id: playId,
    type:
      kickType === "FG"
        ? { id: "60", text: "Field Goal Missed" }
        : { id: "62", text: "Extra Point Missed" },
    text,
    teamParticipants: [
      { id: "99", type: "defense" },
      { id: plan.teamId, type: "offense" },
    ],
    participants: [
      {
        type: "kicker",
        athlete: {
          id: plan.athleteId,
          firstName: plan.first,
          lastName: plan.last,
          displayName: `${plan.first} ${plan.last}`,
        },
      },
    ],
  };
}

function summaryFor(plan: KickerPlan): GameSummary {
  const plays: Play[] = [];
  for (let i = 0; i < plan.fg; i += 1) plays.push(missPlay(plan, `${plan.athleteId}-fg-${i}`, "FG"));
  for (let i = 0; i < plan.pat; i += 1) plays.push(missPlay(plan, `${plan.athleteId}-pat-${i}`, "PAT"));
  return {
    header: {
      competitions: [
        {
          competitors: [
            {
              id: plan.teamId,
              homeAway: "away",
              team: { id: plan.teamId, abbreviation: plan.team, displayName: plan.team },
            },
            {
              id: "99",
              homeAway: "home",
              team: { id: "99", abbreviation: "OPP", displayName: "Opp" },
            },
          ],
        },
      ],
    },
    drives: { previous: [{ plays }] },
  };
}

function startedEvent(id: string, date: string): ScoreboardEvent {
  return {
    id,
    shortName: `${id} @ OPP`,
    date,
    season: { year: 2026, type: 2 },
    week: { number: 3 },
    status: { type: { state: "post", completed: true } },
    competitions: [],
  };
}

/**
 * Tuesday morning: ESPN's current scoreboard is next week, all unplayed.
 * Completed misses live on earlier weekly scoreboards.
 */
function mockOffDayEspn(plans: KickerPlan[], kickoff: string): { espn: EspnClient; weeks: Array<number | undefined> } {
  const weeks: Array<number | undefined> = [];
  const events = plans.map((plan) => startedEvent(plan.athleteId, kickoff));
  const summaries: Record<string, GameSummary> = {};
  for (const plan of plans) summaries[plan.athleteId] = summaryFor(plan);

  const upcoming: Scoreboard = {
    season: { year: 2026, type: 2 },
    week: { number: 4 },
    events: [
      {
        id: "upcoming",
        shortName: "KC @ BUF",
        date: new Date(Date.parse(kickoff) + 5 * 86_400_000).toISOString(),
        season: { year: 2026, type: 2 },
        week: { number: 4 },
        status: { type: { state: "pre", completed: false } },
        competitions: [],
      },
    ],
  };

  const espn = {
    concurrency: 2,
    getScoreboard: async (query?: { week?: number }) => {
      weeks.push(query?.week);
      if (query?.week === undefined) return upcoming;
      if (query.week === 3) {
        return { season: { year: 2026, type: 2 }, week: { number: 3 }, events };
      }
      return { season: { year: 2026, type: 2 }, week: { number: query.week }, events: [] };
    },
    getSummary: async (eventId: string) => {
      const summary = summaries[eventId];
      if (!summary) throw new Error(`unexpected event ${eventId}`);
      return summary;
    },
  } as unknown as EspnClient;

  return { espn, weeks };
}

describe("runSeasonLeaderboard", () => {
  it("ranks the season on an off day and posts one top-5 tweet with FG/PAT splits", async () => {
    const { espn, weeks } = mockOffDayEspn(PLANS, new Date().toISOString());
    const posted: string[] = [];
    const result = await runSeasonLeaderboard(
      {
        espn,
        poster: {
          post: async (text) => {
            posted.push(text);
            return { id: "1" };
          },
        },
      },
      { persist: false, requireRecentGame: true },
    );

    expect(weeks).toEqual([undefined, 1, 2, 3]);
    expect(result.week).toBe(3);
    expect(result.seasonYear).toBe(2026);
    expect(result.skippedReason).toBeUndefined();
    expect(result.rows).toEqual([
      { kicker: "Carl Diaz", teamAbbr: "DAL", fg: 0, pat: 5 },
      { kicker: "Amy Baker", teamAbbr: "DEN", fg: 2, pat: 2 },
      { kicker: "Ben Cole", teamAbbr: "KC", fg: 3, pat: 1 },
      { kicker: "Dee Evans", teamAbbr: "GB", fg: 3, pat: 0 },
      { kicker: "Eve Frost", teamAbbr: "MIA", fg: 2, pat: 0 },
    ]);
    expect(posted).toEqual([
      [
        "❌ Season miss leaders",
        "Season: 2026 · Week 3",
        "1. Carl Diaz (DAL): 5 (0 FG · 5 PAT)",
        "2. Amy Baker (DEN): 4 (2 FG · 2 PAT)",
        "3. Ben Cole (KC): 4 (3 FG · 1 PAT)",
        "4. Dee Evans (GB): 3 (3 FG · 0 PAT)",
        "5. Eve Frost (MIA): 2 (2 FG · 0 PAT)",
      ].join("\n"),
    ]);
    expect(posted[0]).not.toContain("Fred Fox");
    expect(posted[0]).not.toContain("Gina Hart");
    expect(posted[0]).not.toContain("Week 4");
  });

  it("posts fewer than five kickers when fewer than five have misses", async () => {
    const { espn } = mockOffDayEspn(PLANS.slice(0, 2), new Date().toISOString());
    const posted: string[] = [];
    const result = await runSeasonLeaderboard(
      { espn, poster: { post: async (text) => { posted.push(text); return {}; } } },
      { persist: false },
    );
    expect(result.rows).toHaveLength(2);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("1. Carl Diaz (DAL): 5 (0 FG · 5 PAT)");
    expect(posted[0]).toContain("2. Amy Baker (DEN): 4 (2 FG · 2 PAT)");
    expect(posted[0]).not.toMatch(/^5\./m);
  });

  it("does not post when nobody has missed", async () => {
    const { espn } = mockOffDayEspn([], new Date().toISOString());
    let calls = 0;
    const result = await runSeasonLeaderboard(
      {
        espn,
        poster: {
          post: async () => {
            calls += 1;
            return {};
          },
        },
      },
      { persist: false, requireRecentGame: true },
    );
    expect(result.skippedReason).toBe("no-misses");
    expect(result.tweets).toEqual([]);
    expect(result.posted).toBe(0);
    expect(calls).toBe(0);
  });

  it("skips a scheduled post when the last regular-season game is older than six days", async () => {
    const kickoff = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const { espn } = mockOffDayEspn(PLANS, kickoff);
    let calls = 0;
    const result = await runSeasonLeaderboard(
      {
        espn,
        poster: {
          post: async () => {
            calls += 1;
            return {};
          },
        },
      },
      { persist: false, requireRecentGame: true },
    );
    expect(result.skippedReason).toBe("no-recent-game");
    expect(result.rows).toHaveLength(5);
    expect(result.tweets).toEqual([]);
    expect(calls).toBe(0);
  });

  it("still posts a stale board when the run is not the weekly cron", async () => {
    const kickoff = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const { espn } = mockOffDayEspn(PLANS.slice(0, 1), kickoff);
    const posted: string[] = [];
    const result = await runSeasonLeaderboard(
      { espn, poster: { post: async (text) => { posted.push(text); return {}; } } },
      { persist: false, requireRecentGame: false },
    );
    expect(result.skippedReason).toBeUndefined();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("Carl Diaz (DAL): 5 (0 FG · 5 PAT)");
  });
});
