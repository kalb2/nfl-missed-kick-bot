import { espnGameUrl, tweetUrl, type MissSnapshot } from "./alerts.js";
import { buildGameContext, collectPlays, detectMissedKicks, nullifiedReason } from "./detect.js";
import type { GameSummary, Play } from "./types.js";

export const CORRECTION_ACTIONS = ["delete tweet", "post correction", "leave it"] as const;
export type CorrectionAction = (typeof CORRECTION_ACTIONS)[number];

export function playTexts(play?: Play): string[] {
  if (!play) return [];
  return [play.text, play.shortText, ...(play.altTexts ?? [])].filter((text): text is string => Boolean(text));
}

export function uniqueTexts(texts: Array<string | undefined>): string[] {
  return [...new Set(texts.filter((text): text is string => Boolean(text)))];
}

/** Why a play that used to be a miss isn't one in this summary. */
export function whyNotAMiss(summary: GameSummary, playId: string): { why: string; play?: Play } {
  const play = collectPlays(summary).find((item) => String(item.id) === playId);
  if (!play) return { why: "the play is no longer in ESPN's play-by-play" };
  const scoringIds = Array.isArray(summary.scoringPlays)
    ? new Set(summary.scoringPlays.map((item) => String(item?.id ?? "")).filter(Boolean))
    : undefined;
  const reason = nullifiedReason(play, scoringIds);
  return { why: reason ? `ESPN now shows it as ${reason}` : "ESPN no longer classifies it as a missed kick", play };
}

export interface EvaluateErasedInput {
  snapshot: MissSnapshot;
  tweetId?: string;
  summary?: GameSummary;
  tallyIncludesPlay?: boolean | null;
}

export interface CorrectionReport {
  playId: string;
  snapshot: MissSnapshot;
  tweetId?: string;
  tweetUrl: string | null;
  espnUrl: string | null;
  rawTexts: string[];
  flaggedWhy: string;
  currentRulesStillCount: boolean;
  currentRulesNote: string;
  tallyIncludesPlay: boolean | null;
  tallyNote: string;
  recommendation: CorrectionAction;
  recommendationWhy: string;
  correctionText: string;
  intentUrl: string | null;
}

export function evaluateErasedPostedMiss(input: EvaluateErasedInput): CorrectionReport {
  const { snapshot, tweetId, summary } = input;
  const playId = snapshot.playId;
  let flaggedWhy: string;
  let play: Play | undefined;
  let currentRulesStillCount = false;
  let currentRulesNote: string;

  if (!summary) {
    flaggedWhy = "could not load the ESPN game summary";
    currentRulesNote = "Current rules were not applied; no summary was available.";
  } else {
    const looked = whyNotAMiss(summary, playId);
    play = looked.play;
    const ctx = buildGameContext(snapshot.eventId ?? "", summary, { shortName: snapshot.matchup });
    const misses = detectMissedKicks(summary, ctx);
    currentRulesStillCount = misses.some((miss) => miss.playId === playId);
    flaggedWhy = currentRulesStillCount
      ? "current rules still treat this as a miss (it would not be flagged if posted today)"
      : looked.why;
    if (currentRulesStillCount) {
      currentRulesNote =
        "Current rules still count this as a miss. A flag enforced between downs or on the touchdown does not erase a recorded PAT, and this play is still detected as a miss.";
    } else if (!play) {
      currentRulesNote = "Current rules do not count it: the play is gone from ESPN play-by-play.";
    } else {
      const scoringIds = Array.isArray(summary.scoringPlays)
        ? new Set(summary.scoringPlays.map((item) => String(item?.id ?? "")).filter(Boolean))
        : undefined;
      const reason = nullifiedReason(play, scoringIds);
      currentRulesNote = reason
        ? `Current rules do not count it: ${reason}.`
        : "Current rules do not count it: ESPN no longer classifies the play as a missed kick.";
    }
  }

  const rawTexts = uniqueTexts([...playTexts(play), snapshot.playText, ...(snapshot.altPlayTexts ?? [])]);
  const tallyIncludesPlay = input.tallyIncludesPlay ?? null;
  const tallyNote =
    tallyIncludesPlay === true
      ? "The current season tally cache still includes this play."
      : tallyIncludesPlay === false
        ? "The current season tally cache does not include this play."
        : "Season tally cache was not checked (bot-state stores handled plays, not the tally cache).";

  const reversedToGood = isReversedToGood(flaggedWhy, rawTexts);
  let recommendation: CorrectionAction;
  let recommendationWhy: string;
  if (currentRulesStillCount) {
    recommendation = "leave it";
    recommendationWhy =
      "The tweet matches current rules, so it should stay up. This alert is likely from older rules that treated a touchdown penalty as wiping the PAT.";
  } else if (reversedToGood) {
    recommendation = "post correction";
    recommendationWhy =
      "ESPN reversed the miss to a made kick. A public correction keeps the record straight; the bot will not post it.";
  } else {
    recommendation = "delete tweet";
    recommendationWhy =
      "Current rules say this miss did not stand (erased, nullified, or no longer a miss). Deleting the tweet is the cleanest fix; the bot will not delete it.";
  }

  const correctionText = composeCorrectionText(snapshot, flaggedWhy);
  const intentUrl = tweetId
    ? `https://x.com/intent/post?text=${encodeURIComponent(correctionText)}&in_reply_to=${tweetId}`
    : null;

  return {
    playId,
    snapshot,
    tweetId,
    tweetUrl: tweetUrl(tweetId),
    espnUrl: espnGameUrl(snapshot.eventId),
    rawTexts,
    flaggedWhy,
    currentRulesStillCount,
    currentRulesNote,
    tallyIncludesPlay,
    tallyNote,
    recommendation,
    recommendationWhy,
    correctionText,
    intentUrl,
  };
}

export function formatCorrectionIssueSection(report: CorrectionReport): string[] {
  return [
    "## Correction report",
    `- **Tweet:** ${report.tweetUrl ?? "not posted"}`,
    `- **Why the bot flagged this:** ${report.flaggedWhy}`,
    `- **Current rules:** ${report.currentRulesNote}`,
    `- **Season tally:** ${report.tallyNote}`,
    `- **Recommended reply:** \`${report.recommendation}\``,
    `- **Why:** ${report.recommendationWhy}`,
    "",
    "Reply with exactly one of these:",
    "- `leave it` — keep the tweet; current rules still treat this as a miss, or you want no change.",
    "- `delete tweet` — you will delete the tweet by hand. The bot will not delete it.",
    "- `post correction` — you will reply with the text below. The bot will not post it.",
    "",
    "Suggested correction (ready to post):",
    "",
    "```",
    report.correctionText,
    "```",
    ...(report.intentUrl ? ["", `Compose on X: ${report.intentUrl}`] : []),
    "",
    "The bot will not delete or post anything itself.",
  ];
}

export function formatCorrectionReport(report: CorrectionReport): string {
  return [
    `Correction report for play ${report.playId}`,
    report.snapshot.matchup
      ? `${report.snapshot.kicker} (${report.snapshot.teamAbbr}) ${report.snapshot.kickType} · ${report.snapshot.matchup} ${report.snapshot.quarter} ${report.snapshot.clock}`
      : "",
    "",
    ...formatCorrectionIssueSection(report),
    ...(report.rawTexts.length
      ? ["", "Raw ESPN text(s):", ...report.rawTexts.map((text) => `  - ${text}`)]
      : []),
  ]
    .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
    .join("\n");
}

function composeCorrectionText(snapshot: MissSnapshot, flaggedWhy: string): string {
  const kick = snapshot.kickType === "PAT" ? "PAT" : "field goal";
  const who = snapshot.kicker ? `${snapshot.kicker} (${snapshot.teamAbbr})` : snapshot.teamAbbr;
  const when = [snapshot.quarter, snapshot.clock].filter(Boolean).join(" ");
  const where = snapshot.matchup;
  const place = [when && `at ${when}`, where && `in ${where}`].filter(Boolean).join(" ");
  const why = flaggedWhy ? flaggedWhy[0].toUpperCase() + flaggedWhy.slice(1) : flaggedWhy;
  const sentence = why.endsWith(".") ? why : `${why}.`;
  return `Correction: the missed ${kick} by ${who}${place ? ` ${place}` : ""} no longer counts. ${sentence}`;
}

function isReversedToGood(flaggedWhy: string, rawTexts: string[]): boolean {
  if (!/reversed/i.test(flaggedWhy) && !rawTexts.some((text) => /reversed/i.test(text))) return false;
  const after = rawTexts
    .map((text) => {
      const matches = [...text.matchAll(/reversed\b\.?/gi)];
      if (!matches.length) return "";
      const last = matches[matches.length - 1];
      return text.slice((last.index ?? 0) + last[0].length);
    })
    .join("\n");
  if (!after) return /ruling reversed/i.test(flaggedWhy);
  const made = /\b(?:field goal is GOOD|extra point is Good|PAT(?: is)? Good)\b/i.test(after);
  const missed = /\b(?:No Good|BLOCKED|PAT failed)\b/i.test(after);
  return made && !missed;
}
