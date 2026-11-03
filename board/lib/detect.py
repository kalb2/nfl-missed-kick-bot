"""Miss classification and erased-kick filter.

Ported from the on-box rescan. Blocked field goals (type id 18) and blocked
PATs (pointAfterAttempt id 43) count as misses. Kicks wiped out by a penalty
or a "No Play" ruling do not.
"""

from __future__ import annotations

import json
import re
from typing import Any

FG_KICKER_RE = re.compile(r"([A-Z]\.\s*[\w'’-]+)\s+(\d+)\s+yard field goal", re.U)
PAT_KICKER_RE = re.compile(r"([A-Z]\.\s*[\w'’-]+)\s+extra point", re.I | re.U)
# Scoring-summary wording "(Riley Patterson PAT failed)" / "(Riley Patterson Kick)".
# The drive PBP copy of the same play can be "(  PAT failed)" with no name.
PAT_FULLNAME_RE = re.compile(
    r"\(\s*([A-Z][\w'’.-]*(?:\s+[\w'’.-]+){1,3}?)\s+(?:PAT|Kick)\b[^)]*\)",
    re.U,
)

FG_MISS_TYPE = "60"
FG_BLOCKED_TYPE = "18"
PAT_MISS_PAA = "62"
PAT_BLOCKED_PAA = "43"
PAT_GOOD_PAA = "61"
PENALTY_TYPE_ID = "8"

NO_PLAY_RE = re.compile(r"\bno\s+play\b", re.I)
NULLIFIED_RE = re.compile(r"\bnullified\b", re.I)
REVERSED_RE = re.compile(r"\breversed\b\.?", re.I)
REPLAYED_DOWN_RE = re.compile(
    r"\breplay(?:ed)?\s+the\s+down\b|\bdown\s+(?:will\s+be\s+|was\s+|is\s+)?replayed\b",
    re.I,
)
MISS_PHRASE_RE = re.compile(
    r"(?:field goal|extra point)\s+is\s+(?:No Good|BLOCKED)|\bPAT\s+(?:failed|blocked)\b|\bblocked\b",
    re.I,
)
BETWEEN_DOWNS_RE = re.compile(r"enforced\s+between\s+downs", re.I)


def collect_plays(root: Any) -> list[dict]:
    """Every play-like object in a summary. Duplicate ids keep alternate texts."""
    out: list[dict] = []
    seen: set[str] = set()

    def add(play: dict) -> None:
        if not isinstance(play, dict):
            return
        pid = play.get("id")
        if pid is None:
            return
        if not (play.get("type") or play.get("text") or play.get("pointAfterAttempt")):
            return
        sid = str(pid)
        if sid in seen:
            first = next((p for p in out if str(p.get("id")) == sid), None)
            text = play.get("text")
            if first is not None and text and text != first.get("text") and text not in first.get("_altTexts", []):
                first.setdefault("_altTexts", []).append(text)
            return
        seen.add(sid)
        out.append(dict(play))

    def walk(node: Any) -> None:
        if node is None:
            return
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return
        plays = node.get("plays")
        if isinstance(plays, list):
            for play in plays:
                if isinstance(play, dict):
                    add(play)
        if node.get("id") is not None and (
            (isinstance(node.get("type"), dict) and (node["type"].get("text") or node["type"].get("id") is not None))
            or node.get("text")
            or node.get("pointAfterAttempt")
        ):
            add(node)
        for key, value in node.items():
            if key == "plays":
                continue
            walk(value)

    walk(root)
    return out


def is_blocked_fg(text: str, type_id: str, type_text: str) -> bool:
    if type_id == FG_BLOCKED_TYPE or type_text == "Blocked Field Goal":
        return True
    if re.search(r"field goal is BLOCKED", text, re.I):
        return True
    if re.search(r"blocked field goal", type_text, re.I):
        return True
    return False


def is_blocked_pat(text: str, paa: dict | None) -> bool:
    if paa:
        paa_id = str(paa.get("id") or "")
        paa_text = paa.get("text") or ""
        if paa_id == PAT_BLOCKED_PAA or re.search(r"blocked\s*pat|extra point blocked", paa_text, re.I):
            return True
    if re.search(r"extra point is Blocked", text, re.I):
        return True
    if re.search(r"Blocked PAT", text, re.I):
        return True
    return False


def classify_miss(play: dict) -> tuple[str | None, str | None, str]:
    """Return (kickType FG|PAT|None, outcome miss|blocked|None, detection)."""
    text = f"{play.get('text') or ''} {play.get('shortText') or ''}"
    type_obj = play.get("type") or {}
    type_id = str(type_obj.get("id") or "")
    type_text = type_obj.get("text") or ""
    paa = play.get("pointAfterAttempt")

    if paa:
        paa_id = str(paa.get("id") or "")
        paa_text = paa.get("text") or ""
        if paa_id == PAT_GOOD_PAA or paa_text == "Extra Point Good":
            pass
        elif paa_id == PAT_MISS_PAA or paa_text == "Extra Point Missed":
            return "PAT", "miss", "paa-on-td"
        elif paa_id == PAT_BLOCKED_PAA or re.search(r"blocked\s*pat|extra point blocked", paa_text, re.I):
            return "PAT", "blocked", "paa-blocked"
        elif paa_id and paa_id not in (PAT_GOOD_PAA,):
            if is_blocked_pat(text, paa):
                return "PAT", "blocked", "paa-blocked-text"
            if re.search(r"extra point is No Good", text, re.I):
                return "PAT", "miss", "paa-text"

    if type_id == PAT_MISS_PAA or type_text == "Extra Point Missed":
        return "PAT", "miss", "pat-type"
    if re.search(r"extra point is No Good", text, re.I):
        return "PAT", "miss", "text-pat-miss"
    if is_blocked_pat(text, paa if isinstance(paa, dict) else None):
        return "PAT", "blocked", "text-pat-block"

    if is_blocked_fg(text, type_id, type_text):
        return "FG", "blocked", "fg-block"
    if type_id == FG_MISS_TYPE or type_text == "Field Goal Missed" or re.search(r"field goal missed", type_text, re.I):
        return "FG", "miss", "fg"
    if re.search(r"field goal is No Good", text, re.I):
        return "FG", "miss", "text-fg-miss"

    return None, None, ""


def play_texts(play: dict) -> list[str]:
    texts: list[str] = []
    for text in [play.get("text"), play.get("shortText"), *(play.get("_altTexts") or [])]:
        if isinstance(text, str) and text and text not in texts:
            texts.append(text)
    return texts


def nullified_reason(copies: list[dict], scoring_ids: set[str]) -> str | None:
    """Why a miss-looking play must not count, checked across every ESPN copy, else None.

    A bare PENALTY is not disqualifying. A PAT missed after a touchdown with a
    flag enforced between downs, or a declined flag, still counts. A try that
    is still listed in scoringPlays is not erased by a flag on the touchdown.
    """
    texts: list[str] = []
    for play in copies:
        type_obj = play.get("type") or {}
        if str(type_obj.get("id") or "") == PENALTY_TYPE_ID or re.fullmatch(
            r"penalty", type_obj.get("text") or "", re.I
        ):
            return "penalty play type"
        for text in play_texts(play):
            if text not in texts:
                texts.append(text)
    joined = "\n".join(texts)
    if NO_PLAY_RE.search(joined):
        return "No Play"
    if NULLIFIED_RE.search(joined):
        return "nullified"
    if REPLAYED_DOWN_RE.search(joined):
        return "down replayed"
    for text in texts:
        reversed_hits = list(REVERSED_RE.finditer(text))
        if reversed_hits and not MISS_PHRASE_RE.search(text[reversed_hits[-1].end() :]):
            return "ruling reversed"
    td_pat_stands = any(play.get("pointAfterAttempt") for play in copies) and str(copies[0].get("id")) in scoring_ids
    for play in [] if td_pat_stands else copies:
        penalty = play.get("penalty") or {}
        status = f"{(penalty.get('status') or {}).get('slug') or ''} {(penalty.get('status') or {}).get('text') or ''}"
        if play.get("isPenalty") and re.search(r"accepted", status, re.I) and not BETWEEN_DOWNS_RE.search(joined):
            return "accepted penalty on the kick"
    if scoring_ids and any(play.get("scoringPlay") is True for play in copies):
        if str(copies[0].get("id")) not in scoring_ids:
            return "touchdown no longer in scoringPlays"
    return None


def full_name(athlete: dict | None) -> str | None:
    if not athlete:
        return None
    for cand in [
        athlete.get("displayName"),
        athlete.get("fullName"),
        " ".join(filter(None, [athlete.get("firstName"), athlete.get("lastName")])),
    ]:
        if cand and isinstance(cand, str) and cand.strip():
            name = re.sub(r"\s+", " ", cand).strip()
            if re.match(r"^[A-Za-z]\.\s*", name):
                continue
            if len(name.split()) < 2:
                continue
            return name
    return None


def athlete_id(athlete: dict | None) -> str | None:
    if not athlete:
        return None
    if athlete.get("id") is not None:
        return str(athlete["id"])
    ref = athlete.get("$ref") or ""
    match = re.search(r"/athletes/(\d+)", ref)
    return match.group(1) if match else None


def parse_kicker_text(text: str, kick_type: str) -> str:
    if kick_type == "FG":
        match = FG_KICKER_RE.search(text)
        if match:
            return match.group(1)
    matches = list(PAT_KICKER_RE.finditer(text))
    if matches:
        return matches[-1].group(1)
    match = FG_KICKER_RE.search(text)
    if match:
        return match.group(1)
    match = PAT_FULLNAME_RE.search(text)
    if match and not re.search(r"two[- ]point", match.group(0), re.I):
        return match.group(1).strip()
    return "Unknown kicker"


def last_token(name: str) -> str:
    tokens = re.sub(r"[.'’]", " ", name).split()
    return tokens[-1].lower() if tokens else ""


def first_initial(name: str) -> str:
    tokens = re.sub(r"[.'’]", " ", name).split()
    return tokens[0][0].lower() if tokens and tokens[0] else ""


def match_roster(parsed: str, roster: list[dict], aid: str | None) -> dict | None:
    if aid:
        for athlete in roster:
            if athlete_id(athlete) == aid:
                return athlete
    matches = []
    parsed_last = last_token(parsed)
    parsed_initial = first_initial(parsed)
    for athlete in roster:
        athlete_last = last_token(athlete.get("lastName") or full_name(athlete) or athlete.get("displayName") or "")
        if not parsed_last or not athlete_last or parsed_last != athlete_last:
            continue
        athlete_initial = first_initial(athlete.get("firstName") or full_name(athlete) or athlete.get("displayName") or "")
        if parsed_initial and athlete_initial and parsed_initial != athlete_initial:
            continue
        matches.append(athlete)
    if len(matches) == 1:
        return matches[0]
    return None


def resolve_kicker(play: dict, kick_type: str, roster: list[dict]) -> tuple[str, str | None, str | None]:
    """Return (displayName, athleteId, teamAbbr from the boxscore when known)."""
    parsed = "Unknown kicker"
    for text in [play.get("text"), play.get("shortText"), *(play.get("_altTexts") or [])]:
        if not text:
            continue
        parsed = parse_kicker_text(text, kick_type)
        if parsed != "Unknown kicker":
            break
    athletes = [row["athlete"] for row in roster]
    team_by_id = {athlete_id(row["athlete"]): row["teamAbbr"] for row in roster if athlete_id(row["athlete"])}
    play_athlete = None
    for participant in play.get("participants") or []:
        if (participant.get("type") or "").lower() == "kicker":
            play_athlete = participant.get("athlete")
            break
    if not play_athlete and play.get("athletesInvolved"):
        play_athlete = (play["athletesInvolved"] or [None])[0]
    if not play_athlete:
        play_athlete = play.get("athlete")
    aid = athlete_id(play_athlete)
    name = full_name(play_athlete)
    if name:
        return name, aid, team_by_id.get(aid) if aid else None
    matched = match_roster(parsed, athletes, aid)
    if matched:
        mid = athlete_id(matched) or aid
        return full_name(matched) or parsed, mid, team_by_id.get(mid) if mid else None
    matched = match_roster(parsed, athletes, None)
    if matched:
        mid = athlete_id(matched)
        return full_name(matched) or parsed, mid or aid, team_by_id.get(mid) if mid else None
    return parsed, aid, team_by_id.get(aid) if aid else None


def kicking_roster(summary: dict) -> list[dict]:
    roster = []
    for team in (summary.get("boxscore") or {}).get("players") or []:
        team_abbr = ((team.get("team") or {}).get("abbreviation")) or "?"
        for group in team.get("statistics") or []:
            if (group.get("name") or "").lower() != "kicking":
                continue
            for row in group.get("athletes") or []:
                athlete = row.get("athlete") or {}
                if athlete:
                    roster.append({"athlete": athlete, "teamAbbr": team_abbr})
    return roster


def catalog_play(row: dict) -> dict:
    """Turn a flat all-miss-plays.json row into the play shape classify/nullified expect."""
    play: dict = {
        "id": row.get("playId"),
        "text": row.get("playText") or "",
        "type": {"id": row.get("typeId"), "text": row.get("typeText")},
    }
    if row.get("paaId"):
        play["pointAfterAttempt"] = {"id": row["paaId"], "text": row.get("paaText")}
    return play


def miss_from_catalog_row(row: dict) -> tuple[dict | None, str | None]:
    """Classify one catalog row. Returns (miss, None) or (None, skip reason)."""
    play = catalog_play(row)
    reason = nullified_reason([play], set())
    if reason:
        return None, reason
    kick_type, outcome, detection = classify_miss(play)
    if not kick_type or not outcome:
        return None, "not a miss"
    return {
        "eventId": row.get("eventId"),
        "week": row.get("week"),
        "shortName": row.get("shortName"),
        "date": row.get("date"),
        "playId": str(row.get("playId")),
        "kickType": kick_type,
        "outcome": outcome,
        "blocked": outcome == "blocked",
        "kicker": row.get("kicker") or "Unknown kicker",
        "athleteId": str(row["athleteId"]) if row.get("athleteId") else None,
        "teamAbbr": row.get("teamAbbr") or "UNK",
        "playText": row.get("playText") or "",
        "typeId": str(row.get("typeId") or "") or None,
        "typeText": row.get("typeText"),
        "paaId": str(row["paaId"]) if row.get("paaId") is not None else None,
        "paaText": row.get("paaText"),
        "detection": detection,
    }, None


def dumps_athlete(athlete: dict) -> str:
    return json.dumps(athlete, sort_keys=True)
