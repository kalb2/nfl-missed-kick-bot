import type { MissedKick } from "./types.js";

const MAX_TWEET = 280;

export function composeTweet(miss: MissedKick): string {
  const kick =
    miss.kickType === "FG"
      ? `${miss.distance ?? "?"}-yard FG`
      : "PAT";

  const score =
    miss.awayScore !== undefined && miss.homeScore !== undefined
      ? `${miss.awayAbbr} ${miss.awayScore}-${miss.homeScore} ${miss.homeAbbr}`
      : miss.matchup;

  const lines = [
    `❌ ${miss.kicker} (${miss.teamAbbr}) missed a ${kick} — ${miss.result}`,
    `${miss.quarter} ${miss.clock} | ${score}`,
  ];

  let tweet = stripUrls(lines.join("\n"));
  if (tweet.length <= MAX_TWEET) return tweet;

  tweet = stripUrls(
    `❌ ${miss.kicker} (${miss.teamAbbr}) missed ${kick} — ${miss.result}\n${miss.quarter} ${miss.clock}`,
  );
  if (tweet.length <= MAX_TWEET) return tweet;

  return tweet.slice(0, MAX_TWEET);
}

/** X pay-per-use charges more for posts that include links — keep alerts plain text. */
export function stripUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, "").replace(/[ \t]{2,}/g, " ").trim();
}

export function isTweetLengthOk(text: string): boolean {
  return text.length > 0 && text.length <= MAX_TWEET;
}
