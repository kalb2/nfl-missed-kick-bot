"""kicker-exclude.json drops a kicker from the board without deleting the misses."""

from __future__ import annotations

import unittest

import support
from lib.aggregate import is_excluded, rank_kickers, select_board

MEVIS = {
    "kicker": "Harrison Mevis",
    "athleteId": "4574716",
    "teamAbbr": "LAR",
    "fg": 9,
    "pat": 0,
    "fgMiss": 8,
    "fgBlock": 1,
    "patMiss": 0,
    "patBlock": 0,
    "total": 9,
    "week": 5,
}
SMACK = {
    "kicker": "Trey Smack",
    "athleteId": "4869461",
    "teamAbbr": "GB",
    "fg": 5,
    "pat": 3,
    "fgMiss": 3,
    "fgBlock": 2,
    "patMiss": 3,
    "patBlock": 0,
    "total": 8,
    "week": 8,
}


class ExcludeTests(unittest.TestCase):
    def test_mevis_id_is_on_the_list(self):
        excl = support.load_exclude()
        self.assertTrue(is_excluded(MEVIS, excl))
        self.assertFalse(is_excluded(SMACK, excl))

    def test_excluded_kicker_loses_the_board_slot_and_stays_in_the_pool(self):
        excl = support.load_exclude()
        ranked = rank_kickers([MEVIS, SMACK], excl)
        board = select_board(ranked, 10)
        self.assertEqual([row["kicker"] for row in board], ["Trey Smack"])
        mevis = next(row for row in ranked if row["kicker"] == "Harrison Mevis")
        self.assertTrue(mevis["excluded"])
        self.assertEqual(mevis["total"], 9)

    def test_name_match_when_the_play_has_no_athlete_id(self):
        excl = support.load_exclude()
        nameless = dict(MEVIS, athleteId=None)
        self.assertTrue(is_excluded(nameless, excl))

    def test_different_athlete_id_does_not_match_on_name(self):
        excl = support.load_exclude()
        someone_else = dict(MEVIS, athleteId="999")
        self.assertFalse(is_excluded(someone_else, excl))

    def test_week8_report_flags_mevis_and_keeps_him_off_the_top_10(self):
        report = support.load("rescan-report.json")
        excl = support.load_exclude()
        ranked = rank_kickers(report["allKickers"], excl)
        board = select_board(ranked, 10)
        self.assertNotIn("Harrison Mevis", [row["kicker"] for row in board])
        mevis = next(row for row in ranked if row["athleteId"] == "4574716")
        self.assertTrue(mevis["excluded"])
        self.assertEqual(mevis["total"], 4)
        self.assertEqual([row["kicker"] for row in report["viewA_top10"]], [row["kicker"] for row in board])


if __name__ == "__main__":
    unittest.main()
