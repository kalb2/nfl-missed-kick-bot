"""Per-kicker tallies, exclusion, and the board sort.

Ranking is total misses descending, then field-goal misses descending, then
the kicker's display name A–Z (first name, then last name).
"""

from __future__ import annotations


def is_excluded(kicker: dict, exclusions: list[dict]) -> bool:
    """Match on athlete id when both sides have one. Otherwise match the full name.

    Two different athlete ids never fall through to a name match, so a new
    player who shares a name with someone on the list stays on the board.
    """
    for entry in exclusions:
        if entry.get("athleteId") and kicker.get("athleteId"):
            if str(entry["athleteId"]) == str(kicker["athleteId"]):
                return True
            continue
        if (entry.get("kicker") or "").strip().lower() == (kicker.get("kicker") or "").strip().lower():
            return True
    return False


def load_exclusions(data: dict | None) -> list[dict]:
    if not data:
        return []
    return list(data.get("exclude") or [])


def sort_key(kicker: dict) -> tuple:
    return (-kicker["total"], -kicker["fg"], (kicker.get("kicker") or "").lower())


def tally_misses(misses: list[dict]) -> list[dict]:
    """Aggregate counted misses. One bucket per athlete id, else name + team.

    Unknown kickers are never pooled together. Team is a weighted vote
    (a field goal weighs more than a PAT) so an interception-return extra
    point does not steal the kicker's team.
    """

    def kicker_key(miss: dict) -> str:
        if miss.get("athleteId"):
            return f"id:{miss['athleteId']}"
        if miss.get("kicker") == "Unknown kicker":
            return f"unknown:{miss.get('playId')}"
        return f"name:{miss.get('kicker')}|{miss.get('teamAbbr')}"

    tallies: dict[str, dict] = {}
    for miss in misses:
        key = kicker_key(miss)
        bucket = tallies.setdefault(
            key,
            {
                "kicker": miss.get("kicker") or "Unknown kicker",
                "teamAbbr": miss.get("teamAbbr") or "UNK",
                "athleteId": miss.get("athleteId"),
                "fg": 0,
                "pat": 0,
                "fgMiss": 0,
                "fgBlock": 0,
                "patMiss": 0,
                "patBlock": 0,
                "total": 0,
                "misses": [],
                "maxWeek": miss.get("week") or 0,
            },
        )
        name = miss.get("kicker") or ""
        if name and "." not in name.split()[0] and len(name) > len(bucket["kicker"] or ""):
            bucket["kicker"] = name
        if miss.get("teamAbbr") and miss["teamAbbr"] != "UNK":
            bucket.setdefault("_teams", [])
            bucket["_teams"].append((miss["teamAbbr"], 2 if miss.get("kickType") == "FG" else 1))
        if miss.get("athleteId"):
            bucket["athleteId"] = miss["athleteId"]
        bucket["maxWeek"] = max(bucket["maxWeek"], miss.get("week") or 0)
        blocked = bool(miss.get("blocked"))
        if miss.get("kickType") == "FG":
            bucket["fg"] += 1
            if blocked:
                bucket["fgBlock"] += 1
            else:
                bucket["fgMiss"] += 1
        else:
            bucket["pat"] += 1
            if blocked:
                bucket["patBlock"] += 1
            else:
                bucket["patMiss"] += 1
        bucket["total"] = bucket["fg"] + bucket["pat"]
        bucket["misses"].append(miss)

    for bucket in tallies.values():
        votes = bucket.pop("_teams", None)
        if votes:
            counts: dict[str, int] = {}
            for abbr, weight in votes:
                counts[abbr] = counts.get(abbr, 0) + weight
            bucket["teamAbbr"] = max(counts.items(), key=lambda item: item[1])[0]
    return list(tallies.values())


def rank_kickers(kickers: list[dict], exclusions: list[dict] | None = None) -> list[dict]:
    """Sort a copy and set `excluded`. Does not drop anyone."""
    ranked = sorted(kickers, key=sort_key)
    excl = exclusions or []
    for kicker in ranked:
        kicker["excluded"] = is_excluded(kicker, excl)
    return ranked


def select_board(ranked: list[dict], limit: int = 10) -> list[dict]:
    """Top `limit` kickers who are not excluded. Rank numbers are 1-based."""
    board = []
    for kicker in ranked:
        if kicker.get("excluded"):
            continue
        board.append(kicker)
        if len(board) >= limit:
            break
    return board


def public_kicker(kicker: dict) -> dict:
    return {
        "kicker": kicker["kicker"],
        "teamAbbr": kicker["teamAbbr"],
        "athleteId": kicker.get("athleteId"),
        "fg": kicker["fg"],
        "pat": kicker["pat"],
        "total": kicker["total"],
        "fgMiss": kicker["fgMiss"],
        "fgBlock": kicker["fgBlock"],
        "patMiss": kicker["patMiss"],
        "patBlock": kicker["patBlock"],
        "week": kicker.get("week") or kicker.get("maxWeek"),
        "excluded": bool(kicker.get("excluded")),
    }
