"""Put board/ on sys.path so tests import lib without installing a package."""

from __future__ import annotations

import json
import sys
from pathlib import Path

BOARD = Path(__file__).resolve().parents[1]
ROOT = BOARD.parent
if str(BOARD) not in sys.path:
    sys.path.insert(0, str(BOARD))

FIXTURES = BOARD / "fixtures"
LOGOS = BOARD / "logos"


def load(name: str):
    return json.loads((FIXTURES / name).read_text())


def load_exclude() -> list:
    return json.loads((BOARD / "kicker-exclude.json").read_text())["exclude"]
