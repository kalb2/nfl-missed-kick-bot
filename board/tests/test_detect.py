"""Counting rules: FG, PAT, blocks, and kicks that are not misses."""

from __future__ import annotations

import unittest

import support  # noqa: F401
from lib.detect import classify_miss


def play(type_id, type_text, text, paa=None):
    row = {"id": "1", "text": text, "type": {"id": type_id, "text": type_text}}
    if paa:
        row["pointAfterAttempt"] = paa
    return row


class ClassifyTests(unittest.TestCase):
    def test_field_goal_miss(self):
        kick, outcome, detection = classify_miss(
            play("60", "Field Goal Missed", "D.Carlson 62 yard field goal is No Good, Wide Right.")
        )
        self.assertEqual((kick, outcome, detection), ("FG", "miss", "fg"))

    def test_blocked_field_goal_type_18(self):
        kick, outcome, _ = classify_miss(
            play("18", "Blocked Field Goal", "B.Aubrey 59 yard field goal is BLOCKED (K.Jackson).")
        )
        self.assertEqual((kick, outcome), ("FG", "blocked"))

    def test_blocked_field_goal_text_only(self):
        kick, outcome, _ = classify_miss(
            play("60", "Field Goal Missed", "T.Smack 47 yard field goal is BLOCKED (Z.Harrison).")
        )
        self.assertEqual((kick, outcome), ("FG", "blocked"))

    def test_pat_miss_on_touchdown(self):
        kick, outcome, detection = classify_miss(
            play(
                "67",
                "Passing Touchdown",
                "B.Young pass short middle, TOUCHDOWN. R.Fitzgerald extra point is No Good, Wide Right.",
                {"id": "62", "text": "Extra Point Missed"},
            )
        )
        self.assertEqual((kick, outcome, detection), ("PAT", "miss", "paa-on-td"))

    def test_blocked_pat_paa_43(self):
        kick, outcome, detection = classify_miss(
            play(
                "67",
                "Passing Touchdown",
                "B.Young pass short left, TOUCHDOWN. R.Fitzgerald extra point is Blocked (D.Odeyingbo).",
                {"id": "43", "text": "Blocked PAT"},
            )
        )
        self.assertEqual((kick, outcome, detection), ("PAT", "blocked", "paa-blocked"))

    def test_extra_point_good_is_not_a_miss(self):
        kick, outcome, _ = classify_miss(
            play(
                "67",
                "Passing Touchdown",
                "TOUCHDOWN. B.Aubrey extra point is GOOD.",
                {"id": "61", "text": "Extra Point Good"},
            )
        )
        self.assertEqual((kick, outcome), (None, None))

    def test_pat_text_backup_without_paa(self):
        kick, outcome, _ = classify_miss(
            play("67", "Passing Touchdown", "TOUCHDOWN. S.Shrader extra point is No Good, Wide Right.")
        )
        self.assertEqual((kick, outcome), ("PAT", "miss"))

    def test_pat_blocked_text_backup_without_paa(self):
        kick, outcome, _ = classify_miss(
            play("68", "Rushing Touchdown", "TOUCHDOWN. D.Stevens extra point is Blocked (J.Carter).")
        )
        self.assertEqual((kick, outcome), ("PAT", "blocked"))

    def test_field_goal_text_backup(self):
        kick, outcome, detection = classify_miss(
            play("", "", "J.Sanders 54 yard field goal is No Good, Wide Left.")
        )
        self.assertEqual((kick, outcome, detection), ("FG", "miss", "text-fg-miss"))


if __name__ == "__main__":
    unittest.main()
