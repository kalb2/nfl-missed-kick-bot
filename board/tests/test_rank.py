"""Ranking: total misses, then FG misses, then name A–Z. Blocks count inside the total."""

from __future__ import annotations

import unittest

import support  # noqa: F401
from lib.aggregate import rank_kickers, select_board, tally_misses


def miss(kicker, kick, blocked=False, team="DAL", aid=None, week=1, play_id="1"):
    return {
        "playId": play_id,
        "kicker": kicker,
        "athleteId": aid,
        "teamAbbr": team,
        "kickType": kick,
        "blocked": blocked,
        "week": week,
    }


class RankTests(unittest.TestCase):
    def test_blocks_count_toward_fg_and_pat(self):
        kickers = tally_misses(
            [
                miss("Brandon Aubrey", "FG", blocked=True, aid="1", play_id="a"),
                miss("Brandon Aubrey", "FG", blocked=True, aid="1", play_id="b"),
                miss("Brandon Aubrey", "FG", aid="1", play_id="c"),
                miss("Brandon Aubrey", "PAT", aid="1", play_id="d"),
            ]
        )
        self.assertEqual(len(kickers), 1)
        row = kickers[0]
        self.assertEqual((row["fg"], row["fgBlock"], row["fgMiss"]), (3, 2, 1))
        self.assertEqual((row["pat"], row["patBlock"], row["patMiss"]), (1, 0, 1))
        self.assertEqual(row["total"], 4)

    def test_tiebreak_total_then_fg_then_first_name(self):
        kickers = tally_misses(
            [
                miss("Zoe Alpha", "PAT", aid="z", play_id="1"),
                miss("Zoe Alpha", "FG", aid="z", play_id="2"),
                miss("Amy Beta", "FG", aid="a", play_id="3"),
                miss("Amy Beta", "FG", aid="a", play_id="4"),
                miss("Bob Beta", "FG", aid="b", play_id="5"),
                miss("Bob Beta", "FG", aid="b", play_id="6"),
                miss("Cam Gamma", "FG", aid="c", play_id="7"),
                miss("Cam Gamma", "PAT", aid="c", play_id="8"),
                miss("Dee Delta", "FG", aid="d", play_id="9"),
                miss("Dee Delta", "FG", aid="d", play_id="10"),
                miss("Dee Delta", "FG", aid="d", play_id="11"),
            ]
        )
        # Dee 3 (3 FG). Amy and Bob 2 (2 FG) — Amy before Bob. Cam and Zoe 2 (1 FG) — Cam before Zoe.
        names = [row["kicker"] for row in select_board(rank_kickers(kickers), 10)]
        self.assertEqual(names, ["Dee Delta", "Amy Beta", "Bob Beta", "Cam Gamma", "Zoe Alpha"])

    def test_same_total_and_fg_orders_andy_before_cam_before_cameron(self):
        rows = []
        for name, aid in (("Cameron Dicker", "1"), ("Cam Little", "2"), ("Andy Borregales", "3")):
            rows.append(miss(name, "FG", aid=aid, play_id=aid + "a"))
            rows.append(miss(name, "FG", aid=aid, play_id=aid + "b"))
        names = [row["kicker"] for row in select_board(rank_kickers(tally_misses(rows)), 10)]
        self.assertEqual(names, ["Andy Borregales", "Cam Little", "Cameron Dicker"])

    def test_unknown_kickers_are_not_pooled(self):
        kickers = tally_misses(
            [
                miss("Unknown kicker", "FG", play_id="1"),
                miss("Unknown kicker", "FG", play_id="2"),
            ]
        )
        self.assertEqual(len(kickers), 2)
        self.assertTrue(all(row["total"] == 1 for row in kickers))

    def test_athlete_id_merges_a_shorter_initial_name(self):
        kickers = tally_misses(
            [
                miss("D.Carlson", "FG", aid="3051909", play_id="1"),
                miss("Daniel Carlson", "PAT", aid="3051909", play_id="2"),
            ]
        )
        self.assertEqual(len(kickers), 1)
        self.assertEqual(kickers[0]["kicker"], "Daniel Carlson")
        self.assertEqual(kickers[0]["total"], 2)


if __name__ == "__main__":
    unittest.main()
