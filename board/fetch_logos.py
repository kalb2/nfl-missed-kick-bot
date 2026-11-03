#!/usr/bin/env python3
"""Download ESPN NFL team logos into board/logos.

Committed files are the source of truth and are left alone unless --refresh
is passed. The URL is fixed so a re-download is deterministic:

  https://a.espncdn.com/i/teamlogos/nfl/500/{abbr}.png

regenerate.sh refuses to render when a top-10 logo is missing, which is what
used to blank the graphic after /tmp was wiped.
"""

from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

BOARD = Path(__file__).resolve().parent
LOGO_DIR = BOARD / "logos"
URL = "https://a.espncdn.com/i/teamlogos/nfl/500/{abbr}.png"
UA = "Mozilla/5.0 (compatible; NFLKickerMissesVerify/1.0)"

# The 32 abbreviations ESPN puts on 2026 scoreboard teams. jax (not jac) and
# wsh (not was) match the play-by-play abbrs the board renders.
ABBRS = [
    "ari", "atl", "bal", "buf", "car", "chi", "cin", "cle",
    "dal", "den", "det", "gb", "hou", "ind", "jax", "kc",
    "lac", "lar", "lv", "mia", "min", "ne", "no", "nyg",
    "nyj", "phi", "pit", "sea", "sf", "tb", "ten", "wsh",
]


def fetch_one(abbr: str, dest: Path) -> None:
    req = urllib.request.Request(URL.format(abbr=abbr), headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = resp.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise RuntimeError(f"{abbr}: response is not a PNG ({len(data)} bytes)")
    tmp = dest.with_suffix(".png.tmp")
    tmp.write_bytes(data)
    tmp.replace(dest)


def main(argv: list[str]) -> int:
    refresh = "--refresh" in argv
    requested = [arg.lower() for arg in argv if not arg.startswith("-")]
    abbrs = requested or ABBRS
    LOGO_DIR.mkdir(parents=True, exist_ok=True)
    wrote = 0
    for abbr in abbrs:
        dest = LOGO_DIR / f"{abbr}.png"
        if dest.is_file() and not refresh:
            continue
        fetch_one(abbr, dest)
        wrote += 1
        print(f"logo {abbr} -> {dest}")
    print(f"logos: {wrote} downloaded, {len(list(LOGO_DIR.glob('*.png')))} on disk in {LOGO_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
