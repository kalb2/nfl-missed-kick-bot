"""Official FGA/FGM/XPA/XPM must agree with the board or the stat line is omitted."""

from __future__ import annotations

import unittest

import support
from lib.pct import index_stats, pct_round, stat_line, summarize_pct

SMACK = {"kicker": "Trey Smack", "teamAbbr": "GB", "athleteId": "4869461", "fg": 5, "pat": 3}


class PctTests(unittest.TestCase):
    def setUp(self):
        self.stats = index_stats(support.load("espn-kicking-stats.json"))

    def test_half_up_rounding(self):
        self.assertEqual(pct_round(11, 16), 69)  # 68.75
        self.assertEqual(pct_round(12, 18), 67)  # 66.666
        self.assertEqual(pct_round(16, 18), 89)  # 88.888
        self.assertEqual(pct_round(16, 19), 84)  # 84.21
        self.assertEqual(pct_round(1, 2), 50)

    def test_smack_matches_the_week8_graphic(self):
        line, warning = stat_line(SMACK, self.stats)
        self.assertIsNone(warning)
        self.assertEqual(line, "FG 11/16 (69%) · PAT 16/19 (84%)")

    def test_butker_and_fitzgerald_lines(self):
        butker, _ = stat_line(
            {"kicker": "Harrison Butker", "teamAbbr": "KC", "athleteId": "3055899", "fg": 6, "pat": 1},
            self.stats,
        )
        fitz, _ = stat_line(
            {"kicker": "Ryan Fitzgerald", "teamAbbr": "CAR", "athleteId": "4568263", "fg": 0, "pat": 5},
            self.stats,
        )
        self.assertEqual(butker, "FG 12/18 (67%) · PAT 17/18 (94%)")
        self.assertEqual(fitz, "FG 13/13 (100%) · PAT 13/18 (72%)")

    def test_mismatch_omits_the_line(self):
        line, warning = stat_line(dict(SMACK, fg=4), self.stats)
        self.assertIsNone(line)
        self.assertIn("WARN PCT_MISMATCH", warning)
        self.assertIn("Trey Smack", warning)
        self.assertIn("FG 5/PAT 3", warning)
        self.assertIn("board FG 4/PAT 3", warning)

    def test_missing_kicker_omits_the_line(self):
        line, warning = stat_line(
            {"kicker": "Nobody Kickers", "teamAbbr": "ZZ", "athleteId": "1", "fg": 1, "pat": 0},
            self.stats,
        )
        self.assertIsNone(line)
        self.assertIn("WARN PCT_MISSING", warning)

    def test_zero_attempts_render_an_em_dash(self):
        indexed = {
            "1": {"fga": 0, "fgm": 0, "xpa": 4, "xpm": 3},
        }
        line, warning = stat_line(
            {"kicker": "Pat Only", "teamAbbr": "NO", "athleteId": "1", "fg": 0, "pat": 1},
            indexed,
        )
        self.assertIsNone(warning)
        self.assertEqual(line, "FG — · PAT 3/4 (75%)")

    def test_status_ok_partial_and_fallback(self):
        show, status = summarize_pct({1: "FG 1/2 (50%) · PAT 1/1 (100%)"}, {1: "A"})
        self.assertTrue(show)
        self.assertEqual(status, "ok - 1/1 stat lines shown")

        show, status = summarize_pct({1: "ok", 2: None}, {1: "A", 2: "B"})
        self.assertTrue(show)
        self.assertEqual(status, "partial - 1/2 stat lines shown; omitted: B")

        show, status = summarize_pct({1: None, 2: None}, {1: "A", 2: "B"})
        self.assertFalse(show)
        self.assertEqual(status, "fallback - old layout, 0/2 stat lines matched")


if __name__ == "__main__":
    unittest.main()
