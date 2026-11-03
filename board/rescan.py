#!/usr/bin/env python3
"""Rescan one NFL regular season of ESPN play-by-play for missed kicks.

Counts missed field goals (including blocked, type id 18) and missed PATs
(including blocked, pointAfterAttempt id 43). Penalty / "No Play" kicks are
skipped and listed on the report as skippedErasedPlays.

Writes rescan-report.json and rescan-all-misses.json under RESCAN_OUT_DIR
(default board/out). RESCAN_MAX_WEEK overrides the Tuesday auto week.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import sys
import time
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from lib.aggregate import load_exclusions, public_kicker, rank_kickers, select_board, tally_misses
from lib.detect import (
    athlete_id,
    classify_miss,
    collect_plays,
    dumps_athlete,
    kicking_roster,
    nullified_reason,
    resolve_kicker,
)
from lib.paths import DEFAULT_OUT, EXCLUDE_PATH

UA = "Mozilla/5.0 (compatible; NFLKickerMissesVerify/1.0)"
SEASON = int(os.environ.get("RESCAN_SEASON", "2026"))
SEASON_TYPE = 2
OUT_DIR = Path(os.environ.get("RESCAN_OUT_DIR", str(DEFAULT_OUT)))
EXCLUDE_FILE = Path(os.environ.get("KICKER_EXCLUDE", str(EXCLUDE_PATH)))

# Completed weeks since the Tuesday after Week 1 (2026-09-08 is the anchor
# Tuesday). 2026-10-06 → 4. 2026-11-03 → 8. Capped at 18.
_AUTO_WEEK = max(1, min(18, (dt.date.today() - dt.date(2026, 9, 8)).days // 7))
MAX_WEEK = int(os.environ.get("RESCAN_MAX_WEEK", str(_AUTO_WEEK)))

SUMMARY_URLS = [
    "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/summary?event={event_id}",
    "https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event={event_id}",
]


def fetch_json(url: str, retries: int = 3) -> Any:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode())
        except Exception as exc:  # noqa: BLE001 — ESPN hosts flake; retry then raise
            last = exc
            time.sleep(0.5 * (attempt + 1))
    assert last is not None
    raise last


def scoreboard(week: int) -> dict:
    url = (
        "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"
        f"?dates={SEASON}&seasontype={SEASON_TYPE}&week={week}"
    )
    return fetch_json(url)


def competitors(summary: dict, event: dict) -> list[dict]:
    header = summary.get("header") or {}
    comps = (header.get("competitions") or [{}])[0].get("competitors")
    if comps:
        return comps
    return ((event.get("competitions") or [{}])[0].get("competitors")) or []


def abbr(comp: dict) -> str:
    return ((comp.get("team") or {}).get("abbreviation")) or comp.get("id") or "?"


def team_from_play(play: dict, comps: list[dict]) -> dict | None:
    offense = None
    for participant in play.get("teamParticipants") or []:
        if participant.get("type") == "offense":
            offense = participant.get("id")
            break
    if not offense:
        offense = ((play.get("start") or {}).get("team") or {}).get("id") or ((play.get("team") or {}).get("id"))
    if offense:
        for comp in comps:
            if comp.get("id") == offense or (comp.get("team") or {}).get("id") == offense:
                return comp
    return None


def process_game(week: int, event: dict) -> dict:
    """Fetch both summary hosts and union misses. Returns misses, skipped, errors."""
    event_id = str(event["id"])
    short = event.get("shortName") or event.get("name") or ""
    date = event.get("date")
    payloads = []
    last_err: Exception | None = None
    for url in SUMMARY_URLS:
        try:
            payloads.append(fetch_json(url.format(event_id=event_id)))
        except Exception as exc:  # noqa: BLE001
            last_err = exc
    if not payloads:
        return {"misses": [], "skipped": [], "errors": [{"_error": str(last_err), "eventId": event_id, "week": week}]}

    roster = []
    seen_roster: set[str] = set()
    for payload in payloads:
        for row in kicking_roster(payload):
            rid = athlete_id(row["athlete"]) or dumps_athlete(row["athlete"])
            if rid in seen_roster:
                continue
            seen_roster.add(rid)
            roster.append(row)
    comps = competitors(payloads[0], event)
    copies_by_id: dict[str, list[dict]] = {}
    scoring_ids: set[str] = set()
    for payload in payloads:
        for scoring in payload.get("scoringPlays") or []:
            if isinstance(scoring, dict) and scoring.get("id") is not None:
                scoring_ids.add(str(scoring["id"]))
        for play in collect_plays(payload):
            copies_by_id.setdefault(str(play.get("id")), []).append(play)

    misses: list[dict] = []
    skipped: list[dict] = []
    for play_id, copies in copies_by_id.items():
        hit = next((copy for copy in copies if classify_miss(copy)[0]), None)
        if hit is None:
            continue
        reason = nullified_reason(copies, scoring_ids)
        if reason:
            skipped.append(
                {
                    "eventId": event_id,
                    "week": week,
                    "shortName": short,
                    "playId": play_id,
                    "reason": reason,
                    "period": (hit.get("period") or {}).get("number"),
                    "playText": hit.get("text") or hit.get("shortText") or "",
                }
            )
            print(f"  skip play {play_id} ({short}): {reason}", flush=True)
            continue
        kick_type, outcome, detection = classify_miss(hit)
        if not kick_type or not outcome:
            continue
        text = hit.get("text") or hit.get("shortText") or ""
        type_obj = hit.get("type") or {}
        paa = hit.get("pointAfterAttempt")
        kicker, aid, roster_team = resolve_kicker(hit, kick_type, roster)
        team = team_from_play(hit, comps)
        play_team = abbr(team) if team else "UNK"
        misses.append(
            {
                "eventId": event_id,
                "week": week,
                "shortName": short,
                "date": date,
                "playId": str(hit.get("id")),
                "kickType": kick_type,
                "outcome": outcome,
                "blocked": outcome == "blocked",
                "kicker": kicker,
                "athleteId": aid,
                "teamAbbr": roster_team or play_team,
                "playText": text,
                "typeId": str(type_obj.get("id") or "") or None,
                "typeText": type_obj.get("text"),
                "paaId": str(paa.get("id")) if paa and paa.get("id") is not None else None,
                "paaText": paa.get("text") if paa else None,
                "detection": detection,
                "period": (hit.get("period") or {}).get("number"),
                "clock": (hit.get("clock") or {}).get("displayValue"),
            }
        )
    return {"misses": misses, "skipped": skipped, "errors": []}


def read_exclusions() -> list[dict]:
    if not EXCLUDE_FILE.is_file():
        return []
    return load_exclusions(json.loads(EXCLUDE_FILE.read_text()))


def build_report(
    all_misses: list[dict],
    skipped: list[dict],
    errors: list[dict],
    games_scanned: int,
    exclusions: list[dict],
) -> dict:
    kickers = tally_misses(all_misses)
    for kicker in kickers:
        kicker["week"] = kicker["maxWeek"]
    ranked = rank_kickers(kickers, exclusions)
    board = select_board(ranked, 10)
    top10 = []
    for i, kicker in enumerate(board, 1):
        top10.append(
            {
                "rank": i,
                "kicker": kicker["kicker"],
                "teamAbbr": kicker["teamAbbr"],
                "fg": kicker["fg"],
                "pat": kicker["pat"],
                "total": kicker["total"],
                "fgMiss": kicker["fgMiss"],
                "fgBlock": kicker["fgBlock"],
                "patMiss": kicker["patMiss"],
                "patBlock": kicker["patBlock"],
                "week": kicker["maxWeek"],
            }
        )
    blocked = [miss for miss in all_misses if miss["blocked"]]
    fitz = [kicker for kicker in kickers if "Fitzgerald" in kicker["kicker"] and kicker["teamAbbr"] == "CAR"]
    if not fitz:
        fitz = [kicker for kicker in kickers if "Fitzgerald" in kicker["kicker"]]

    def examples(pred, limit: int | None = None) -> list[dict]:
        rows = []
        for miss in blocked:
            if not pred(miss):
                continue
            rows.append(
                {
                    "typeId": miss.get("typeId"),
                    "typeText": miss.get("typeText"),
                    "paaId": miss.get("paaId"),
                    "paaText": miss.get("paaText"),
                    "playText": (miss.get("playText") or "")[:160],
                    "kicker": miss["kicker"],
                    "week": miss["week"],
                }
            )
            if limit is not None and len(rows) >= limit:
                break
        return rows

    return {
        "seasonYear": SEASON,
        "week": MAX_WEEK,
        "gamesScanned": games_scanned,
        "errors": errors,
        "totalMissPlays": len(all_misses),
        "uniqueKickers": len(kickers),
        "detectionBreakdown": dict(Counter(miss["detection"] for miss in all_misses)),
        "typeIdCounts": dict(Counter(str(miss.get("typeId")) for miss in all_misses)),
        "paaIdCounts": dict(Counter(str(miss.get("paaId")) for miss in all_misses if miss.get("paaId"))),
        "kickTypeCounts": dict(Counter(miss["kickType"] for miss in all_misses)),
        "blockedCounts": {
            "total": len(blocked),
            "fg": sum(1 for miss in blocked if miss["kickType"] == "FG"),
            "pat": sum(1 for miss in blocked if miss["kickType"] == "PAT"),
        },
        "viewA_top10": top10,
        "viewB_threeWay": {
            "feasible": True,
            "reason": (
                "ESPN cleanly separates blocked vs non-blocked for both FG and PAT via "
                "type id 18 (Blocked Field Goal) vs 60 (Field Goal Missed), and "
                "paa id 43 (Blocked PAT) vs 62 (Extra Point Missed), plus consistent play text."
            ),
            "segments": {
                "missedFG_nonBlock": sum(1 for miss in all_misses if miss["kickType"] == "FG" and not miss["blocked"]),
                "missedPAT_nonBlock": sum(1 for miss in all_misses if miss["kickType"] == "PAT" and not miss["blocked"]),
                "blockedFG": sum(1 for miss in all_misses if miss["kickType"] == "FG" and miss["blocked"]),
                "blockedPAT": sum(1 for miss in all_misses if miss["kickType"] == "PAT" and miss["blocked"]),
                "blockedCombined": len(blocked),
            },
        },
        "labelEvidence": {
            "blockedFG": {
                "typeId": "18",
                "typeText": "Blocked Field Goal",
                "playTextPattern": "field goal is BLOCKED (...)",
                "examples": [
                    {k: row[k] for k in ("typeId", "typeText", "playText", "kicker", "week")}
                    for row in examples(lambda m: m["kickType"] == "FG", 3)
                ],
            },
            "missedFG": {
                "typeId": "60",
                "typeText": "Field Goal Missed",
                "playTextPattern": "field goal is No Good, ...",
            },
            "blockedPAT": {
                "paaId": "43",
                "paaText": "Blocked PAT",
                "playTextPattern": "extra point is Blocked (...)",
                "note": "Usually attached to the touchdown play; not a standalone play type.",
                "examples": examples(lambda m: m["kickType"] == "PAT"),
            },
            "missedPAT": {
                "paaId": "62",
                "paaText": "Extra Point Missed",
                "playTextPattern": "extra point is No Good, ...",
                "note": "Usually attached to the touchdown play via pointAfterAttempt.",
            },
        },
        "fitzgerald": fitz,
        "allBlocked": blocked,
        "allKickers": [public_kicker(kicker) for kicker in ranked],
        "excludedKickers": [kicker["kicker"] for kicker in ranked if kicker.get("excluded")],
        "tiebreak": "total desc → FG desc → name A–Z",
        "skippedErasedPlays": sorted(skipped, key=lambda row: (row["week"], row["playId"])),
    }


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    events: list[tuple[int, dict]] = []
    for week in range(1, MAX_WEEK + 1):
        board = scoreboard(week)
        week_events = board.get("events") or []
        print(f"Week {week}: {len(week_events)} games", flush=True)
        for event in week_events:
            events.append((week, event))

    all_misses: list[dict] = []
    skipped: list[dict] = []
    errors: list[dict] = []
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = {pool.submit(process_game, week, event): (week, event) for week, event in events}
        done = 0
        for future in as_completed(futures):
            done += 1
            result = future.result()
            errors.extend(result["errors"])
            all_misses.extend(result["misses"])
            skipped.extend(result["skipped"])
            if done % 8 == 0 or done == len(futures):
                print(f"  scanned {done}/{len(futures)} games, misses={len(all_misses)}", flush=True)

    by_id = {miss["playId"]: miss for miss in all_misses}
    all_misses = sorted(by_id.values(), key=lambda miss: (miss["week"], miss["date"] or "", miss["playId"]))
    # A play skipped on one host and counted on the other stays counted.
    counted_ids = set(by_id)
    skipped = [row for row in skipped if row["playId"] not in counted_ids]
    skipped_by_id = {row["playId"]: row for row in skipped}
    skipped = sorted(skipped_by_id.values(), key=lambda row: (row["week"], row["playId"]))

    exclusions = read_exclusions()
    report = build_report(all_misses, skipped, errors, len(events), exclusions)
    (OUT_DIR / "rescan-report.json").write_text(json.dumps(report, indent=2) + "\n")
    (OUT_DIR / "rescan-all-misses.json").write_text(json.dumps(all_misses, indent=2) + "\n")
    print(
        json.dumps(
            {
                "games": len(events),
                "misses": len(all_misses),
                "blocked": report["blockedCounts"]["total"],
                "skipped": len(skipped),
                "errors": len(errors),
                "excluded": report["excludedKickers"],
                "top10": [
                    {"rank": row["rank"], "kicker": row["kicker"], "total": row["total"], "fg": row["fg"], "pat": row["pat"]}
                    for row in report["viewA_top10"]
                ],
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
