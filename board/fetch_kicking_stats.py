#!/usr/bin/env python3
"""Fetch ESPN official season kicking totals (FGA/FGM/XPA/XPM) per kicker.

Source: sports.core.api.espn.com athlete season statistics, kicking category.
Kickers are everyone in rescan-report.json allKickers who has an athlete id.

Usage: fetch_kicking_stats.py REPORT_JSON OUT_JSON
Exit 0 on full success, 2 if some kickers failed (file still written),
1 if nothing usable was fetched (no file written).
"""

from __future__ import annotations

import datetime as dt
import json
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

UA = "Mozilla/5.0 (compatible; NFLKickerMissesVerify/1.0)"
URL = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/{season}/types/2/athletes/{aid}/statistics"
WANT = ("fieldGoalAttempts", "fieldGoalsMade", "extraPointAttempts", "extraPointsMade")


def fetch(season: int, aid: str, retries: int = 3) -> list[int]:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(URL.format(season=season, aid=aid), headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=20) as resp:
                payload = json.loads(resp.read().decode())
            categories = {cat.get("name"): cat for cat in (payload.get("splits") or {}).get("categories") or []}
            kicking = {stat["name"]: stat.get("value") for stat in (categories.get("kicking") or {}).get("stats") or []}
            values = [kicking.get(name) for name in WANT]
            if any(value is None for value in values):
                raise ValueError("kicking stats missing in response")
            return [int(round(float(value))) for value in values]
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(0.7 * (attempt + 1))
    assert last is not None
    raise last


def main() -> int:
    report_path, out_path = Path(sys.argv[1]), Path(sys.argv[2])
    report = json.loads(report_path.read_text())
    season = report.get("seasonYear", 2026)
    kickers = [kicker for kicker in report["allKickers"] if kicker.get("athleteId")]
    rows: list[list] = []
    failed: list[str] = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {kicker["athleteId"]: pool.submit(fetch, season, kicker["athleteId"]) for kicker in kickers}
    for kicker in kickers:
        try:
            fga, fgm, xpa, xpm = futures[kicker["athleteId"]].result()
        except Exception as exc:  # noqa: BLE001
            failed.append(f"{kicker['kicker']} ({kicker['athleteId']}): {exc}")
            continue
        rows.append(
            [
                kicker["kicker"],
                kicker["teamAbbr"],
                str(kicker["athleteId"]),
                kicker["fg"],
                kicker["pat"],
                kicker["total"],
                fga - fgm,
                xpa - xpm,
                [fga, fgm, xpa, xpm],
            ]
        )
    for message in failed:
        print(f"WARN PCT_FETCH: ESPN kicking stats fetch failed for {message}")
    if not rows:
        print("WARN PCT_FETCH: ESPN kicking stats fetch failed for ALL kickers; no stats file written")
        return 1
    out = {
        "generated": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "source": URL.replace("{season}", str(season)),
        "reportWeek": report.get("week"),
        "columns": [
            "kicker",
            "team",
            "athleteId",
            "boardFG",
            "boardPAT",
            "boardTotal",
            "espnFGmiss",
            "espnXPmiss",
            "espn(FGA,FGM,XPA,XPM)",
        ],
        "rows": rows,
        "failed": failed,
    }
    tmp = out_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(out, indent=2) + "\n")
    tmp.replace(out_path)
    print(f"ESPN kicking stats: {len(rows)}/{len(kickers)} kickers -> {out_path}")
    return 2 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
