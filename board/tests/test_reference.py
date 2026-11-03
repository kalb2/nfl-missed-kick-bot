"""The committed scan fixtures reproduce the Week 8 and Week 4 boards."""

from __future__ import annotations

import re
import unittest

import support
from lib.aggregate import load_exclusions, rank_kickers, select_board, tally_misses
from lib.detect import miss_from_catalog_row
from lib.render import build_board, seg_label

# Week 8 top 10 from the attached rescan-report.json (2026-11-03 scan).
WEEK8 = [
    ("Trey Smack", "GB", 5, 3, 8),
    ("Harrison Butker", "KC", 6, 1, 7),
    ("Eddy Pineiro", "SF", 3, 4, 7),
    ("Daniel Carlson", "NO", 4, 2, 6),
    ("Drew Stevens", "WSH", 3, 3, 6),
    ("Chris Boswell", "PIT", 5, 0, 5),
    ("Dominic Zvada", "NYG", 5, 0, 5),
    ("Brandon Aubrey", "DAL", 4, 1, 5),
    ("Nick Folk", "ATL", 4, 1, 5),
    ("Ryan Fitzgerald", "CAR", 0, 5, 5),
]

# Week 4 top 10 from all-miss-plays.json once the Myers "No Play" kick is dropped.
WEEK4 = [
    ("Brandon Aubrey", 3, 1, 4),
    ("Drew Stevens", 2, 2, 4),
    ("Eddy Pineiro", 2, 2, 4),
    ("Chris Boswell", 3, 0, 3),
    ("Nick Folk", 3, 0, 3),
    ("Daniel Carlson", 2, 1, 3),
    ("Ryan Fitzgerald", 0, 3, 3),
    ("Andy Borregales", 2, 0, 2),
    ("Cam Little", 2, 0, 2),
    ("Cameron Dicker", 2, 0, 2),
]


def _tuple(row):
    return (row["kicker"], row["teamAbbr"], row["fg"], row["pat"], row["total"])


class ReferenceTests(unittest.TestCase):
    def test_rescan_report_top10_is_the_week8_board(self):
        report = support.load("rescan-report.json")
        got = [_tuple(row) for row in report["viewA_top10"]]
        self.assertEqual(got, WEEK8)
        self.assertEqual(report["week"], 8)
        self.assertIn("Harrison Mevis", report["excludedKickers"])

    def test_retally_of_week8_plays_matches_the_report(self):
        report = support.load("rescan-report.json")
        plays = support.load("rescan-all-misses.json")
        excl = support.load_exclude()
        ranked = rank_kickers(tally_misses(plays), excl)
        board = select_board(ranked, 10)
        self.assertEqual([_tuple(row) for row in board], WEEK8)
        by_name = {row["kicker"]: row for row in ranked}
        # Block splits on the graphic: Smack 5-2, Pineiro 3-1, Aubrey 4-2, Fitzgerald 5-2.
        self.assertEqual((by_name["Trey Smack"]["fgBlock"], by_name["Trey Smack"]["patBlock"]), (2, 0))
        self.assertEqual(by_name["Eddy Pineiro"]["fgBlock"], 1)
        self.assertEqual(by_name["Brandon Aubrey"]["fgBlock"], 2)
        self.assertEqual(by_name["Ryan Fitzgerald"]["patBlock"], 2)
        self.assertEqual(by_name["Daniel Carlson"]["patBlock"], 1)
        self.assertEqual(by_name["Drew Stevens"]["patBlock"], 1)
        self.assertTrue(by_name["Harrison Mevis"]["excluded"])
        self.assertEqual(len(plays), report["totalMissPlays"])

    def test_all_miss_plays_week4_ranking_skips_the_erased_kick(self):
        plays = support.load("all-miss-plays.json")
        counted = []
        skipped = []
        for row in plays:
            miss, reason = miss_from_catalog_row(row)
            if reason:
                skipped.append((row["playId"], reason, row["kicker"]))
            else:
                counted.append(miss)
        self.assertEqual(skipped, [("4018729773227", "penalty play type", "Jason Myers")])
        ranked = rank_kickers(tally_misses(counted), [])
        top = select_board(ranked, 10)
        self.assertEqual([(row["kicker"], row["fg"], row["pat"], row["total"]) for row in top], WEEK4)
        myers = next(row for row in ranked if row["kicker"] == "Jason Myers")
        self.assertEqual((myers["fg"], myers["pat"], myers["total"]), (0, 1, 1))

    def test_week8_html_matches_the_graphic_rules(self):
        report = support.load("rescan-report.json")
        stats = support.load("espn-kicking-stats.json")
        built = build_board(
            report,
            exclusions=load_exclusions({"exclude": support.load_exclude()}),
            notes={},
            stats=stats,
            show_pct=True,
            logo_dir=support.LOGOS,
            all_misses=support.load("rescan-all-misses.json"),
        )
        self.assertEqual([_tuple(row) for row in built["rows"]], WEEK8)
        self.assertTrue(built["pct_status"].startswith("ok - 10/10"))
        self.assertEqual(built["png_size"], (2160, 3920))
        html = built["html"]
        self.assertIn("SEASON MISS LEADERS", html)
        self.assertIn("2026 REGULAR SEASON · THRU WEEK 8", html)
        self.assertIn("#1B4F8A", html)
        self.assertIn("#8ECAE6", html)
        self.assertIn("#F7F4EC", html)
        self.assertNotIn("/tmp/", html)
        self.assertIn("5 - 2 BLK", html)  # Smack FG and Fitzgerald PAT
        self.assertIn("3 - 1 BLK", html)  # Pineiro FG, Carlson PAT, Stevens PAT
        self.assertIn("4 - 2 BLK", html)  # Aubrey FG
        labels = re.findall(r'class="seg[^"]*"[^>]*>([^<]*)', html)
        self.assertGreaterEqual(len(labels), 10)
        for label in labels:
            self.assertNotIn("(", label, label)
            self.assertNotIn(")", label, label)
        self.assertIn("FG 11/16 (69%) · PAT 16/19 (84%)", html)
        self.assertIn("FG 12/18 (67%) · PAT 17/18 (94%)", html)
        self.assertIn("FG 6/9 (67%) · PAT 21/25 (84%)", html)
        self.assertIn("FG 13/13 (100%) · PAT 13/18 (72%)", html)
        for abbr in ("gb", "kc", "sf", "no", "wsh", "pit", "nyg", "dal", "atl", "car"):
            self.assertIn(f"logos/{abbr}.png", html)
            self.assertTrue((support.LOGOS / f"{abbr}.png").is_file())
        post = built["post"]
        self.assertIn("thru Week 8", post)
        # Names appear in rank order.
        cursor = 0
        for name, *_rest in WEEK8:
            found = post.find(name, cursor)
            self.assertGreater(found, cursor, name)
            cursor = found

    def test_in_bar_label_has_no_parentheses(self):
        self.assertEqual(seg_label(3, 1), "3 - 1 BLK")
        self.assertEqual(seg_label(5, 0), "5")
        self.assertNotIn("(", seg_label(4, 2))

    def test_mismatch_drops_one_line_and_stays_partial(self):
        report = support.load("rescan-report.json")
        stats = support.load("espn-kicking-stats.json")
        # Corrupt Smack's official makes so ESPN misses no longer equal the board.
        for row in stats["rows"]:
            if row[2] == "4869461":
                row[8] = [16, 16, 19, 16]  # 0 FG misses, 3 PAT misses
        built = build_board(
            report,
            exclusions=support.load_exclude(),
            stats=stats,
            show_pct=True,
            logo_dir=support.LOGOS,
        )
        self.assertTrue(built["pct_status"].startswith("partial - 9/10"))
        self.assertIn("Trey Smack", built["pct_status"])
        self.assertTrue(any("PCT_MISMATCH" in warning and "Trey Smack" in warning for warning in built["warnings"]))
        smack = built["rows"][0]
        self.assertIsNone(smack["pct"])
        self.assertIn(">&nbsp;</div>", built["html"])

    def test_workflow_is_manual_and_does_not_post(self):
        text = (support.ROOT / ".github" / "workflows" / "season-miss-leaders.yml").read_text()
        self.assertIn("workflow_dispatch:", text)
        for banned in ("schedule:", "repository_dispatch:", "pull_request:", "push:", "twitter", "api.x.com", "secrets."):
            self.assertNotIn(banned, text.lower() if banned == "twitter" else text, banned)
        self.assertNotIn("X_API", text)


if __name__ == "__main__":
    unittest.main()
