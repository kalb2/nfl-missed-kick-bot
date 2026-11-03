#!/usr/bin/env bash
# Rebuild the season miss-leaders board.
#
# One command, from anywhere:
#   bash board/regenerate.sh
#
# Writes into board/out/ (override with BOARD_OUT):
#   season-miss-leaders-top10.png   2160×3920 graphic (2160×3360 if SHOW_PCT=0)
#   season-miss-leaders.json        top 10, percentages, suggested post
#   season-miss-all.json            full board, Fitzgerald, skipped kicks
#   suggested-post.txt              caption for the owner to paste
#   leaders.html                    the page the PNG is shot from
#   rescan-report.json              raw scan (unless SKIP_RESCAN=1)
#   espn-kicking-stats.json         official FGA/FGM/XPA/XPM
#
# This script never posts to X or anywhere else. The owner uploads the PNG.
#
# SHOW_PCT=0          old layout, no percentage line
# SKIP_RESCAN=1       reuse rescan-report.json (kicking stats still fetched)
# PCT_STATS=path.json use a fixed stats file instead of fetching
# RESCAN_MAX_WEEK=N   stop the scan at this regular-season week
# REPORT_JSON=path    with SKIP_RESCAN, read this report instead of board/out
# CHROME_BIN=path     headless Chrome binary
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${BOARD_OUT:-$ROOT/out}"
mkdir -p "$OUT"

if ! compgen -G "$ROOT/logos/*.png" > /dev/null; then
  echo "ERROR: $ROOT/logos has no PNGs. Run: python3 $ROOT/fetch_logos.py" >&2
  exit 1
fi

export RESCAN_OUT_DIR="$OUT"
export KICKER_EXCLUDE="${KICKER_EXCLUDE:-$ROOT/kicker-exclude.json}"
SHOW_PCT="${SHOW_PCT:-1}"
PCT_STATS="${PCT_STATS:-}"
PCT_STATS_OUT="${PCT_STATS_OUT:-$OUT/espn-kicking-stats.json}"
OUT_PNG="${OUT_PNG:-$OUT/season-miss-leaders-top10.png}"
HTML_OUT="${HTML_OUT:-$OUT/leaders.html}"
LEADERS_JSON="${LEADERS_JSON:-$OUT/season-miss-leaders.json}"
ALL_JSON="${ALL_JSON:-$OUT/season-miss-all.json}"
POST_OUT="${POST_OUT:-$OUT/suggested-post.txt}"
LOGO_DIR="${LOGO_DIR:-$ROOT/logos}"
NOTES_JSON="${NOTES_JSON:-$ROOT/kicker-notes.json}"
REPORT_JSON="${REPORT_JSON:-$OUT/rescan-report.json}"

if [[ "${SKIP_RESCAN:-0}" != "1" ]]; then
  python3 "$ROOT/rescan.py"
  REPORT_JSON="$OUT/rescan-report.json"
else
  echo "SKIP_RESCAN=1: reusing $REPORT_JSON"
  if [[ ! -f "$REPORT_JSON" ]]; then
    echo "ERROR: missing $REPORT_JSON" >&2
    exit 1
  fi
fi

if [[ "$SHOW_PCT" == "1" ]]; then
  if [[ -n "$PCT_STATS" ]]; then
    echo "PCT_STATS set: using fixed stats file $PCT_STATS (no ESPN stats fetch)"
  else
    rm -f "$PCT_STATS_OUT"
    _frc=0
    python3 "$ROOT/fetch_kicking_stats.py" "$REPORT_JSON" "$PCT_STATS_OUT" || _frc=$?
    if [[ -s "$PCT_STATS_OUT" ]]; then
      PCT_STATS="$PCT_STATS_OUT"
      [[ "$_frc" != "0" ]] && echo "WARN PCT_FETCH: partial ESPN stats fetch (rc=$_frc); kickers without stats get no stat line"
    else
      echo "WARN PCT_FETCH: ESPN official kicking stats fetch FAILED (rc=$_frc); rendering OLD layout without percentages"
      PCT_STATS=""
    fi
  fi
fi

export SHOW_PCT PCT_STATS HTML_OUT LEADERS_JSON ALL_JSON POST_OUT LOGO_DIR NOTES_JSON
export REPORT_JSON
export EXCLUDE_JSON="${EXCLUDE_JSON:-$KICKER_EXCLUDE}"
if [[ -f "$OUT/rescan-all-misses.json" ]]; then
  export ALL_MISSES_JSON="${ALL_MISSES_JSON:-$OUT/rescan-all-misses.json}"
fi

_build_log="$(mktemp)"
python3 "$ROOT/build_board.py" | tee "$_build_log"
_CH="$(awk '/^CANVAS_H /{print $2}' "$_build_log")"
_PNG_W="$(awk '/^PNG_W /{print $2}' "$_build_log")"
_PNG_H="$(awk '/^PNG_H /{print $2}' "$_build_log")"
rm -f "$_build_log"
if [[ -z "${_CH:-}" ]]; then
  echo "ERROR BOARD: builder did not report a canvas height" >&2
  exit 1
fi

# Screenshot. Keep the previous PNG aside so a failed render does not leave a
# half-written file at the live path.
rm -f "$OUT_PNG.tmp"
if [[ -f "$OUT_PNG" ]]; then
  mv -f "$OUT_PNG" "$OUT_PNG.prev"
fi
if ! timeout 120 python3 "$ROOT/screenshot.py" "$HTML_OUT" "$OUT_PNG" 1080 "$_CH" 2; then
  echo "ERROR SCREENSHOT: PNG not rendered" >&2
  exit 1
fi

python3 - "$OUT_PNG" "$_PNG_W" "$_PNG_H" <<'PY'
import struct, sys
from pathlib import Path
path, want_w, want_h = Path(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
data = path.read_bytes()
if data[:8] != b"\x89PNG\r\n\x1a\n":
    raise SystemExit(f"ERROR SCREENSHOT: {path} is not a PNG")
width, height = struct.unpack(">II", data[16:24])
print(f"{path} {width}x{height} {path.stat().st_size} bytes")
if (width, height) != (want_w, want_h):
    raise SystemExit(f"ERROR SCREENSHOT: expected {want_w}x{want_h}, got {width}x{height}")
PY

echo "Wrote $OUT_PNG"
echo "Wrote $LEADERS_JSON"
echo "Wrote $POST_OUT"
echo "Done regenerate.sh"
