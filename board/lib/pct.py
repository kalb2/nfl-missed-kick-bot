"""Cross-check board miss counts against ESPN official season kicking totals.

A stat line is shown only when ESPN's misses (FGA−FGM and XPA−XPM) equal the
board's FG and PAT misses. Anything else is omitted and reported. The board
never prints a percentage that disagrees with the miss count.
"""

from __future__ import annotations


def pct_round(made: int, attempts: int) -> int:
    """Round half up to a whole percent. Attempts must be positive."""
    return int(100.0 * made / attempts + 0.5)


def index_stats(stats: dict) -> dict:
    """Map athlete id and lowercase name to {fga, fgm, xpa, xpm}."""
    columns = stats["columns"]
    index = {name: i for i, name in enumerate(columns)}
    stat_col = index["espn(FGA,FGM,XPA,XPM)"]
    out: dict = {}
    for row in stats.get("rows") or []:
        fga, fgm, xpa, xpm = (int(x) for x in row[stat_col])
        rec = {"fga": fga, "fgm": fgm, "xpa": xpa, "xpm": xpm}
        out[str(row[index["athleteId"]])] = rec
        out[str(row[index["kicker"]]).strip().lower()] = rec
    return out


def lookup_stats(stats_index: dict, kicker: dict) -> dict | None:
    athlete_id = kicker.get("athleteId")
    if athlete_id and str(athlete_id) in stats_index:
        return stats_index[str(athlete_id)]
    return stats_index.get((kicker.get("kicker") or "").strip().lower())


def stat_line(kicker: dict, stats_index: dict) -> tuple[str | None, str | None]:
    """Return (line, warning). `line` is None when the percentage must be omitted."""
    name = kicker.get("kicker") or "?"
    team = kicker.get("teamAbbr") or "?"
    rec = lookup_stats(stats_index, kicker)
    if not rec:
        return None, f"WARN PCT_MISSING: no ESPN kicking stats for {name} ({team}); stat line omitted"
    espn_fg = rec["fga"] - rec["fgm"]
    espn_pat = rec["xpa"] - rec["xpm"]
    if espn_fg != kicker["fg"] or espn_pat != kicker["pat"]:
        return None, (
            f"WARN PCT_MISMATCH: {name} ({team}) ESPN official misses "
            f"FG {espn_fg}/PAT {espn_pat} != board FG {kicker['fg']}/PAT {kicker['pat']}; stat line omitted"
        )
    fg = f"FG {rec['fgm']}/{rec['fga']} ({pct_round(rec['fgm'], rec['fga'])}%)" if rec["fga"] else "FG —"
    pat = f"PAT {rec['xpm']}/{rec['xpa']} ({pct_round(rec['xpm'], rec['xpa'])}%)" if rec["xpa"] else "PAT —"
    return f"{fg} · {pat}", None


def summarize_pct(lines: dict[int, str | None], kicker_names: dict[int, str]) -> tuple[bool, str]:
    """Return (show_lines, PCT_STATUS text).

    `show_lines` is false when every kicker failed and the old layout should be used.
    """
    ok = sum(1 for value in lines.values() if value)
    omitted = [kicker_names[rank] for rank, value in lines.items() if not value]
    total = len(lines)
    if ok == 0:
        return False, f"fallback - old layout, 0/{total} stat lines matched"
    if omitted:
        return True, f"partial - {ok}/{total} stat lines shown; omitted: {', '.join(omitted)}"
    return True, f"ok - {ok}/{total} stat lines shown"
