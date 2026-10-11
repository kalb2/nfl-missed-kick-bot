import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MissedKick } from "./types.js";

export interface PlayOverride {
  playId: string;
  eventId?: string;
  kickType?: "FG" | "PAT";
  kicker?: string;
  athleteId?: string;
  teamAbbr?: string;
  /** A tweet for this play already exists (posted by hand); never post it. */
  alreadyPosted?: boolean;
}

export interface OverridesFile {
  version: 1;
  plays: PlayOverride[];
}

export const DEFAULT_OVERRIDES_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "config",
  "manual-overrides.json",
);

export class Overrides {
  private readonly byId: Map<string, PlayOverride>;
  constructor(plays: PlayOverride[] = []) {
    this.byId = new Map(plays.map((p) => [String(p.playId), p]));
  }

  static load(filePath = process.env.OVERRIDES_PATH || DEFAULT_OVERRIDES_PATH): Overrides {
    try {
      const data = JSON.parse(readFileSync(filePath, "utf8")) as OverridesFile;
      return new Overrides(Array.isArray(data.plays) ? data.plays : []);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Overrides();
      throw err;
    }
  }

  get(playId: string): PlayOverride | undefined {
    return this.byId.get(String(playId));
  }

  alreadyPostedIds(): string[] {
    return [...this.byId.values()].filter((p) => p.alreadyPosted).map((p) => String(p.playId));
  }

  /** Apply kicker/team corrections in place. */
  apply<T extends Pick<MissedKick, "playId" | "kicker" | "athleteId" | "teamAbbr">>(miss: T): T {
    const o = this.byId.get(String(miss.playId));
    if (!o) return miss;
    if (o.kicker) miss.kicker = o.kicker;
    if (o.athleteId) miss.athleteId = o.athleteId;
    if (o.teamAbbr) miss.teamAbbr = o.teamAbbr;
    return miss;
  }
}
