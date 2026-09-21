import type { MissedKick, WinProbabilityPoint } from "./types.js";

const PLAY_ID_REF_RE = /\/(?:plays|probabilities)\/(\d+)/i;

export function playIdFromUnknown(raw: unknown): string | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const fromRef = trimmed.match(PLAY_ID_REF_RE);
  if (fromRef) return fromRef[1];
  return trimmed;
}

/** ESPN uses 0–1. A few payloads have already been scaled to 0–100. */
export function asUnitProbability(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value > 1 && value <= 100) return value / 100;
  if (value < 0 || value > 1) return undefined;
  return value;
}

export function normalizeWinProbabilityPoint(item: unknown): WinProbabilityPoint | undefined {
  if (!item || typeof item !== "object") return undefined;
  const obj = item as Record<string, unknown>;
  const play = obj.play;
  const playId =
    playIdFromUnknown(obj.playId) ||
    playIdFromUnknown(obj.id) ||
    (play && typeof play === "object"
      ? playIdFromUnknown((play as { $ref?: unknown }).$ref)
      : undefined) ||
    playIdFromUnknown(obj.$ref);
  const homeWinPercentage = asUnitProbability(obj.homeWinPercentage);
  if (!playId || homeWinPercentage === undefined) return undefined;
  return {
    playId,
    homeWinPercentage,
    tiePercentage: asUnitProbability(obj.tiePercentage) ?? 0,
  };
}

/**
 * Read `winprobability[]` off a site summary (or any wrapper that has one).
 * Each row is home WP *after* that `playId`.
 */
export function extractWinProbability(root: unknown): WinProbabilityPoint[] {
  if (!root || typeof root !== "object") return [];
  const obj = root as Record<string, unknown>;
  const raw = obj.winprobability ?? obj.winProbability;
  if (!Array.isArray(raw)) return [];
  const out: WinProbabilityPoint[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const point = normalizeWinProbabilityPoint(item);
    if (!point || seen.has(point.playId)) continue;
    seen.add(point.playId);
    out.push(point);
  }
  return out;
}

/** Core `/probabilities` list (`items[]`) or a single probability object. */
export function winProbabilityFromCorePayload(raw: unknown): WinProbabilityPoint[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj.items)) {
    return extractWinProbability({ winprobability: obj.items });
  }
  return extractWinProbability(raw);
}

export function kickTeamSide(
  miss: Pick<MissedKick, "teamAbbr" | "homeAbbr" | "awayAbbr">,
): "home" | "away" | undefined {
  const kick = miss.teamAbbr?.trim().toUpperCase();
  const home = miss.homeAbbr?.trim().toUpperCase();
  const away = miss.awayAbbr?.trim().toUpperCase();
  if (!kick || !home || !away || home === away) return undefined;
  if (kick === home) return "home";
  if (kick === away) return "away";
  return undefined;
}

export function sideWinPercentage(
  point: WinProbabilityPoint,
  side: "home" | "away",
): number {
  if (side === "home") return point.homeWinPercentage;
  return clamp01(1 - point.homeWinPercentage - (point.tiePercentage ?? 0));
}

export function kickTeamWinProbabilitySwing(
  miss: Pick<MissedKick, "playId" | "teamAbbr" | "homeAbbr" | "awayAbbr">,
  points: WinProbabilityPoint[],
): { before: number; after: number; delta: number } | undefined {
  if (!points.length) return undefined;
  const idx = points.findIndex((point) => point.playId === String(miss.playId));
  if (idx <= 0) return undefined;
  const side = kickTeamSide(miss);
  if (!side) return undefined;
  const before = sideWinPercentage(points[idx - 1], side);
  const after = sideWinPercentage(points[idx], side);
  if (!Number.isFinite(before) || !Number.isFinite(after)) return undefined;
  return { before, after, delta: after - before };
}

export function attachWinProbability(miss: MissedKick, points: WinProbabilityPoint[]): void {
  const swing = kickTeamWinProbabilitySwing(miss, points);
  if (!swing) return;
  miss.wpBefore = swing.before;
  miss.wpAfter = swing.after;
  miss.wpDelta = swing.delta;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
