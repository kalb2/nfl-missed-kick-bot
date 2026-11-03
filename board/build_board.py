#!/usr/bin/env python3
"""Turn a rescan report into the leaders HTML, JSON summary, and suggested post.

Does not talk to ESPN and does not post anywhere. regenerate.sh is the
single command that runs the scan, this builder, and the screenshot.

Environment:
  REPORT_JSON   rescan-report.json (required)
  HTML_OUT      leaders HTML path (required)
  LEADERS_JSON  season-miss-leaders.json (required)
  ALL_JSON      season-miss-all.json (required)
  POST_OUT      suggested-post.txt (required)
  LOGO_DIR      directory of {abbr}.png logos (required)
  SHOW_PCT      1 (default) or 0
  PCT_STATS     espn kicking stats JSON; empty means percentages fall back
  ALL_MISSES_JSON  optional rescan-all-misses.json, for week fallback
  NOTES_JSON    optional kicker-notes.json
  EXCLUDE_JSON  optional kicker-exclude.json
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# Script directory is board/, so `import lib` works when invoked as a file.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib.aggregate import load_exclusions
from lib.render import build_board, write_json


def _read(path: str | None) -> dict | list | None:
    if not path:
        return None
    file = Path(path)
    if not file.is_file():
        return None
    return json.loads(file.read_text())


def main() -> int:
    report = json.loads(Path(os.environ["REPORT_JSON"]).read_text())
    show_pct = os.environ.get("SHOW_PCT", "1") == "1"
    stats_doc = _read(os.environ.get("PCT_STATS") or "")
    notes = _read(os.environ.get("NOTES_JSON") or "") or {}
    if not isinstance(notes, dict):
        notes = {}
    exclude_doc = _read(os.environ.get("EXCLUDE_JSON") or "") or {}
    exclusions = load_exclusions(exclude_doc if isinstance(exclude_doc, dict) else {})
    all_misses = _read(os.environ.get("ALL_MISSES_JSON") or "")
    if not isinstance(all_misses, list):
        all_misses = None

    built = build_board(
        report,
        exclusions=exclusions,
        notes=notes,
        stats=stats_doc if isinstance(stats_doc, dict) else None,
        show_pct=show_pct,
        logo_dir=Path(os.environ["LOGO_DIR"]),
        all_misses=all_misses,
    )
    for warning in built["warnings"]:
        print(warning)
    print("Excluded from board:", built["excluded"] or "none")
    Path(os.environ["HTML_OUT"]).write_text(built["html"])
    write_json(Path(os.environ["LEADERS_JSON"]), built["leaders"])
    write_json(Path(os.environ["ALL_JSON"]), built["all"])
    Path(os.environ["POST_OUT"]).write_text(built["post"])
    print(f"Exported week {report['week']}, top10={len(built['rows'])}")
    for row in built["rows"]:
        print(f"  {row['rank']:2}  {row['kicker']:<22} {row['teamAbbr']:<4} FG {row['fg']} PAT {row['pat']} tot {row['total']}")
    # Machine-readable trailer for regenerate.sh. Not a /tmp file.
    print(f"CANVAS_H {built['canvas_h']}")
    print(f"PNG_W {built['png_size'][0]}")
    print(f"PNG_H {built['png_size'][1]}")
    print(f"PCT_STATUS: {built['pct_status']}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001 — surface a single ERROR line for the shell
        print(f"ERROR BOARD: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
