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

export interface AthleteRef {
  id?: string | number;
  $ref?: string;
  displayName?: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  shortName?: string;
}

export interface BoxscoreAthleteRow {
  athlete?: AthleteRef;
}

export interface BoxscoreStatGroup {
  name?: string;
  athletes?: BoxscoreAthleteRow[];
}

export interface BoxscorePlayers {
  team?: { id?: string; abbreviation?: string };
  statistics?: BoxscoreStatGroup[];
}

export interface PlayParticipant {
  type?: string;
  order?: number;
  athlete?: AthleteRef;
  position?: { $ref?: string; abbreviation?: string };
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
  participants?: PlayParticipant[];
  athletesInvolved?: AthleteRef[];
  athlete?: AthleteRef;
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

export interface SeasonRef {
  year?: number;
  type?: number;
  slug?: string;
}

export interface WeekRef {
  number?: number;
}

export interface ScoreboardEvent {
  id: string;
  date?: string;
  shortName?: string;
  name?: string;
  season?: SeasonRef;
  week?: WeekRef;
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
  season?: SeasonRef;
  week?: WeekRef;
}

export interface ScoreboardQuery {
  week?: number;
  seasonType?: number;
  dates?: string;
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
  boxscore?: {
    players?: BoxscorePlayers[];
    teams?: unknown;
  };
  [key: string]: unknown;
}

export interface GameContext {
  eventId: string;
  shortName: string;
  date?: string;
  statusState?: string;
  seasonType?: number;
  seasonYear?: number;
  competitors: Competitor[];
}

export interface MissedKick {
  playId: string;
  kickType: KickType;
  kicker: string;
  athleteId?: string;
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
  /** Regular-season FG misses for this kicker, inclusive of this play. */
  seasonFgMisses?: number;
  /** Regular-season PAT misses for this kicker, inclusive of this play. */
  seasonPatMisses?: number;
}

export interface PollOptions {
  dryRun: boolean;
  seedSeen: boolean;
  allToday: boolean;
  persist: boolean;
  recentFinalWindowMin: number;
}

export interface SeasonTallyRow {
  kicker: string;
  teamAbbr: string;
  fg: number;
  pat: number;
}

export interface PollResult {
  gamesScanned: number;
  missesFound: number;
  newMisses: MissedKick[];
  posted: number;
  skippedSeen: number;
  tweets: string[];
  seasonGamesScanned?: number;
  seasonTallies?: SeasonTallyRow[];
}
