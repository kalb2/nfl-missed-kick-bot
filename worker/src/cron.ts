/**
 * Cloudflare cron weekday names (SUN=1 … SAT=7). Do not use THU-MON as a
 * range — it does not wrap past Saturday.
 *
 * Dense ticks cover America/Denver game days (Thu–Mon) in UTC, plus early
 * Tuesday UTC so late MNF (still Monday evening in Denver) stays in window.
 *
 *   Thu 00:00 UTC → Wed 5–6 PM Denver: early enough for Thursday slates
 *   Tue 00:00–07:59 UTC → Mon 5–6 PM through ~1 AM Tue Denver (MNF + OT)
 *   Tue 08:00 UTC onward and all Wednesday: no 2-minute tick
 */
export const TICK_CRONS = ["*/2 * * * THU,FRI,SAT,SUN,MON", "*/2 0-7 * * TUE"] as const;

/** Midweek ESPN/KV refresh only — never repository_dispatch. */
export const REFRESH_CRONS = ["0 15 * * TUE,WED"] as const;

export const ALL_CRONS = [...TICK_CRONS, ...REFRESH_CRONS];

export type CronKind = "tick" | "refresh";

export function cronKind(cron: string): CronKind {
  if ((REFRESH_CRONS as readonly string[]).includes(cron)) return "refresh";
  return "tick";
}

/** Whether a UTC instant falls in the dense-tick schedule (for docs/tests). */
export function isDenseTickUtc(at: Date): boolean {
  const day = at.getUTCDay();
  const hour = at.getUTCHours();
  if (day === 0 || day === 1 || day === 4 || day === 5 || day === 6) return true;
  return day === 2 && hour <= 7;
}
