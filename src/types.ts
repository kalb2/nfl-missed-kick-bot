export type KickType = "FG" | "PAT";

export interface PlayType {
  id?: string | number;
  text?: string;
  abbreviation?: string;
}

export interface PointAfterAttempt {
  id?: string | number;
  text?: string;
  abbreviation?: string;
  value?: number;
}

export interface TeamParticipant {
  id?: string;
  type?: string;
  order?: number;
}

export interface Play {
  id?: string;
  sequenceNumber?: string;
  type?: PlayType;
  text?: string;
  shortText?: string;
  awayScore?: number;
  homeScore?: number;
  period?: { number?: number };
  clock?: { displayValue?: string };
  scoringPlay?: boolean;
  wallclock?: string;
  modified?: string;
  teamParticipants?: TeamParticipant[];
  pointAfterAttempt?: PointAfterAttempt;
  statYardage?: number;
  start?: { team?: { id?: string }; yardsToEndzone?: number };
  team?: { id?: string; abbreviation?: string };
}

export interface Competitor {
  id?: string;
  homeAway?: string;
  score?: string | number;
  team?: {
    id?: string;
    abbreviation?: string;
    displayName?: string;
    name?: string;
    location?: string;
  };
}

export interface GameStatus {
  type?: {
    id?: string;
    name?: string;
    state?: string;
    completed?: boolean;
    description?: string;
    detail?: string;
    shortDetail?: string;
  };
}

export interface ScoreboardEvent {
  id: string;
  date?: string;
  shortName?: string;
  name?: string;
  status?: GameStatus;
  competitions?: Array<{
    id?: string;
    date?: string;
    status?: GameStatus;
    competitors?: Competitor[];
  }>;
}

export interface Scoreboard {
  events?: ScoreboardEvent[];
}

export interface GameSummary {
  drives?: {
    previous?: Array<{ plays?: Play[] }>;
    current?: { plays?: Play[] } | Array<{ plays?: Play[] }>;
  };
  header?: {
    id?: string;
    competitions?: Array<{
      competitors?: Competitor[];
      date?: string;
      status?: GameStatus;
    }>;
  };
  scoringPlays?: Play[];
  [key: string]: unknown;
}

export interface GameContext {
  eventId: string;
  shortName: string;
  date?: string;
  statusState?: string;
  competitors: Competitor[];
}

export interface MissedKick {
  playId: string;
  kickType: KickType;
  kicker: string;
  teamAbbr: string;
  teamName: string;
  distance?: number;
  result: string;
  quarter: string;
  clock: string;
  awayAbbr: string;
  homeAbbr: string;
  awayScore?: number;
  homeScore?: number;
  matchup: string;
  playText: string;
}

export interface PollOptions {
  dryRun: boolean;
  seedSeen: boolean;
  allToday: boolean;
  persist: boolean;
  recentFinalWindowMin: number;
}

export interface PollResult {
  gamesScanned: number;
  missesFound: number;
  newMisses: MissedKick[];
  posted: number;
  skippedSeen: number;
  tweets: string[];
}
