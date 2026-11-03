"""Paths for the season miss-leaders board. Logos stay in the repo, never /tmp."""

from __future__ import annotations

from pathlib import Path

BOARD_DIR = Path(__file__).resolve().parents[1]
LOGO_DIR = BOARD_DIR / "logos"
FIXTURE_DIR = BOARD_DIR / "fixtures"
DEFAULT_OUT = BOARD_DIR / "out"
EXCLUDE_PATH = BOARD_DIR / "kicker-exclude.json"
NOTES_PATH = BOARD_DIR / "kicker-notes.json"

# ESPN CDN abbreviations that differ from the abbr the scoreboard puts on a team.
LOGO_ALIASES = {
    "was": "wsh",
    "jac": "jax",
}
