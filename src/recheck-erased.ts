/**
 * Re-evaluate a posted-miss-erased alert against current rules.
 * Read-only: fetches ESPN and (optionally) GitHub, and never writes to
 * X, GitHub issues, or bot-state.
 *
 *   npm run recheck-erased -- 4018729984351
 *   npm run recheck-erased -- --issue 17
 *   npm run recheck-erased -- --issue 17 --summary-file test/fixtures/recorded/pat-taunting-fitzgerald.json
 */
import { readFile } from "node:fs/promises";
import type { MissSnapshot } from "./alerts.js";
import { evaluateErasedPostedMiss, formatCorrectionReport } from "./correction.js";
import { EspnClient } from "./espn.js";
import { SeasonTallyIndex } from "./tallies.js";
import type { GameSummary } from "./types.js";

export interface RecheckArgs {
  playId?: string;
  issue?: number;
  eventId?: string;
  stateFile?: string;
  talliesFile?: string;
  summaryFile?: string;
  repo?: string;
}

export function parseRecheckArgs(argv: string[]): RecheckArgs {
  const out: RecheckArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (!value) {
        usage();
        process.exit(2);
      }
      return value;
    };
    if (arg === "--issue") out.issue = Number(next());
    else if (arg === "--event") out.eventId = next();
    else if (arg === "--state-file") out.stateFile = next();
    else if (arg === "--tallies-file") out.talliesFile = next();
    else if (arg === "--summary-file") out.summaryFile = next();
    else if (arg === "--repo") out.repo = next();
    else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else if (arg.startsWith("-")) {
      console.error("Unknown flag: %s", arg);
      usage();
      process.exit(2);
    } else {
      out.playId = arg;
    }
  }
  return out;
}

function usage(): void {
  console.error(`Usage: npm run recheck-erased -- <playId> [options]
       npm run recheck-erased -- --issue <n> [options]

Re-evaluates an erased-play alert against current detection rules.
Does not tweet, delete tweets, or write to GitHub.

Options:
  --issue <n>           Read issue n (GET only) for play id, tweet, and texts
  --event <eventId>     ESPN game id (default: inferred from the play id)
  --summary-file <path> Use a saved ESPN summary instead of fetching
  --state-file <path>   handled-plays.json (or any file with a handled map)
  --tallies-file <path> Local tallies.json cache to check season totals
  --repo owner/name     GitHub repo for issue / bot-state reads
`);
}

interface HandledFile {
  handled?: Record<string, { playId?: string; eventId?: string; tweetId?: string; snapshot?: MissSnapshot; status?: string }>;
}

export function findHandledPlay(
  data: HandledFile,
  playId: string,
): { tweetId?: string; snapshot?: MissSnapshot; eventId?: string; status?: string } | undefined {
  const handled = data.handled ?? {};
  for (const entry of Object.values(handled)) {
    if (entry?.playId === playId || entry?.snapshot?.playId === playId) return entry;
  }
  return undefined;
}

export function inferEventId(playId: string): string | undefined {
  const match = playId.match(/^(401\d{6})/);
  return match?.[1];
}

export function snapshotFromIssue(body: string, playId: string): Partial<MissSnapshot> & { tweetId?: string } {
  const field = (label: string): string | undefined => {
    const match = body.match(new RegExp(`\\*\\*${label}:\\*\\*\\s+(.+)`));
    return match?.[1]?.trim();
  };
  const tweet = body.match(/https:\/\/(?:x|twitter)\.com\/i\/web\/status\/(\d+)/);
  const event = body.match(/gameId\/(\d+)/);
  const raw = [...body.matchAll(/^\s+-\s+`([^`]+)`/gm)].map((match) => match[1]);
  const kick = field("Kick");
  const kickType = kick?.startsWith("PAT") ? "PAT" : kick?.startsWith("FG") ? "FG" : undefined;
  const result = kick?.match(/\((.+)\)/)?.[1];
  const score = field("Score");
  const scoreParts = score?.match(/^(\S+)\s+(\d+)-(\d+)\s+(\S+)/);
  const when = field("Quarter / clock");
  const whenParts = when?.split(/\s+/) ?? [];
  const game = field("Game")?.replace(/\s+\(ESPN:.*$/, "");
  return {
    playId,
    eventId: event?.[1],
    kicker: emptyToUndef(field("Kicker")),
    teamAbbr: emptyToUndef(field("Team")),
    kickType: kickType as MissSnapshot["kickType"],
    result,
    matchup: game,
    quarter: whenParts[0],
    clock: whenParts[1],
    awayAbbr: scoreParts?.[1],
    homeAbbr: scoreParts?.[4],
    awayScore: scoreParts ? Number(scoreParts[2]) : undefined,
    homeScore: scoreParts ? Number(scoreParts[3]) : undefined,
    playText: raw[0],
    altPlayTexts: raw.slice(1),
    tweetId: tweet?.[1],
  };
}

function emptyToUndef(value?: string): string | undefined {
  if (!value || value === "n/a") return undefined;
  return value;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function githubGet(repo: string, pathname: string): Promise<unknown> {
  const token = process.env.GITHUB_TOKEN;
  const res = await fetch(`https://api.github.com/repos/${repo}${pathname}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub GET ${pathname}: ${res.status}`);
  return res.json();
}

async function loadIssue(repo: string, number: number): Promise<{ body: string; title: string }> {
  const issue = (await githubGet(repo, `/issues/${number}`)) as { body?: string; title?: string; pull_request?: unknown };
  if (issue.pull_request) throw new Error(`#${number} is a pull request, not an issue`);
  return { body: issue.body ?? "", title: issue.title ?? "" };
}

export function playIdFromIssueText(text: string): string | undefined {
  return text.match(/\[play (\d+)\]/)?.[1];
}

async function loadBotStateHandled(repo: string): Promise<HandledFile | undefined> {
  try {
    const file = (await githubGet(repo, "/contents/handled-plays.json?ref=bot-state")) as { content?: string; encoding?: string };
    if (!file.content) return undefined;
    const decoded = Buffer.from(file.content, (file.encoding as BufferEncoding) || "base64").toString("utf8");
    return JSON.parse(decoded) as HandledFile;
  } catch (err) {
    console.error("note: could not read bot-state handled-plays.json (%s)", (err as Error).message);
    return undefined;
  }
}

function fillSnapshot(partial: Partial<MissSnapshot>, playId: string, eventId?: string): MissSnapshot {
  return {
    playId,
    eventId: partial.eventId ?? eventId,
    kickType: partial.kickType ?? "FG",
    result: partial.result ?? "",
    kicker: partial.kicker ?? "",
    teamAbbr: partial.teamAbbr ?? "",
    quarter: partial.quarter ?? "",
    clock: partial.clock ?? "",
    awayAbbr: partial.awayAbbr ?? "",
    homeAbbr: partial.homeAbbr ?? "",
    matchup: partial.matchup ?? "",
    playText: partial.playText ?? "",
    ...(partial.altPlayTexts?.length ? { altPlayTexts: partial.altPlayTexts } : {}),
    ...(partial.awayScore !== undefined ? { awayScore: partial.awayScore } : {}),
    ...(partial.homeScore !== undefined ? { homeScore: partial.homeScore } : {}),
  };
}

export async function runRecheck(args: RecheckArgs): Promise<string> {
  const repo = args.repo ?? process.env.GITHUB_REPOSITORY ?? "kalb2/nfl-missed-kick-bot";
  let playId = args.playId;
  let issueBody = "";
  if (args.issue !== undefined) {
    if (!Number.isFinite(args.issue)) throw new Error("--issue needs a number");
    const issue = await loadIssue(repo, args.issue);
    issueBody = issue.body;
    playId = playId ?? playIdFromIssueText(`${issue.title}\n${issue.body}`);
  }
  if (!playId) throw new Error("Need a play id or --issue <n>");

  const fromIssue = issueBody ? snapshotFromIssue(issueBody, playId) : {};
  let handled = args.stateFile ? await readJson<HandledFile>(args.stateFile) : undefined;
  if (!handled && !args.stateFile) handled = await loadBotStateHandled(repo);
  const stored = handled ? findHandledPlay(handled, playId) : undefined;
  const eventId = args.eventId ?? stored?.eventId ?? stored?.snapshot?.eventId ?? fromIssue.eventId ?? inferEventId(playId);

  let summary: GameSummary | undefined;
  if (args.summaryFile) {
    summary = await readJson<GameSummary>(args.summaryFile);
  } else if (eventId) {
    const espn = new EspnClient({
      userAgent: process.env.ESPN_USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      concurrency: 1,
    });
    summary = await espn.getSummary(eventId, { bypassCache: true });
  }

  const snapshot = fillSnapshot({ ...fromIssue, ...stored?.snapshot }, playId, eventId);
  const tweetId = stored?.tweetId ?? fromIssue.tweetId;

  let tallyIncludesPlay: boolean | null = null;
  if (args.talliesFile) {
    const tallies = new SeasonTallyIndex(args.talliesFile);
    await tallies.load();
    tallyIncludesPlay = tallies.hasPlayId(playId);
  }

  const report = evaluateErasedPostedMiss({ snapshot, tweetId, summary, tallyIncludesPlay });
  const extra = [
    stored ? `Handled-plays status: ${stored.status ?? "present"}` : "Handled-plays status: not found",
    summary ? "ESPN summary: loaded" : "ESPN summary: not loaded",
    "This command did not write to X or GitHub.",
  ];
  return `${formatCorrectionReport(report)}\n\n${extra.join("\n")}\n`;
}

async function main(): Promise<void> {
  const args = parseRecheckArgs(process.argv.slice(2));
  if (!args.playId && args.issue === undefined) {
    usage();
    process.exit(2);
  }
  process.stdout.write(await runRecheck(args));
}

if (process.argv[1]?.includes("recheck-erased")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

