"""Penalty and No Play kicks are skipped. Flags enforced between downs still count."""

from __future__ import annotations

import unittest

import support
from lib.detect import classify_miss, miss_from_catalog_row, nullified_reason

MYERS_NO_PLAY = (
    "J.Myers 53 yard field goal is No Good, Wide Right, Center-C.Stoll, Holder-M.Dickson."
    "PENALTY on LAC-T.Tuipulotu, Leverage, 15 yards, enforced at LAC 35 - No Play."
)
AUBREY_BETWEEN_DOWNS = (
    "(Shotgun) D.Prescott pass short left to J.Williams for 17 yards, TOUCHDOWN. "
    "PENALTY on DAL-J.Williams, Taunting, 15 yards, enforced between downs. "
    "B.Aubrey extra point is No Good, Wide Left."
)
STEVENS_BETWEEN_DOWNS = (
    "INTERCEPTED by K.Medrano, TOUCHDOWN.PENALTY on WAS, Unsportsmanlike Conduct, "
    "15 yards, enforced between downs. D.Stevens extra point is No Good, Wide Left."
)


class NullifiedTests(unittest.TestCase):
    def test_penalty_play_type_is_skipped(self):
        play = {
            "id": "4018729773227",
            "text": MYERS_NO_PLAY,
            "type": {"id": "8", "text": "Penalty"},
        }
        self.assertEqual(nullified_reason([play], set()), "penalty play type")
        # The miss wording is still recognizable, and still must not count.
        self.assertEqual(classify_miss(play)[0], "FG")

    def test_no_play_text_is_skipped_even_when_typed_as_a_miss(self):
        play = {
            "id": "szmyt",
            "text": "A.Szmyt 42 yard field goal is BLOCKED (K.Martin). PENALTY on BLT, Defensive Offside, enforced at BLT 23 - No Play.",
            "type": {"id": "18", "text": "Blocked Field Goal"},
        }
        self.assertEqual(nullified_reason([play], set()), "No Play")

    def test_nullified_and_replayed_down(self):
        self.assertEqual(
            nullified_reason([{"id": "1", "text": "Field goal is No Good. Play NULLIFIED.", "type": {"id": "60", "text": "Field Goal Missed"}}], set()),
            "nullified",
        )
        self.assertEqual(
            nullified_reason(
                [{"id": "1", "text": "Field goal is No Good. The down will be replayed.", "type": {"id": "60", "text": "Field Goal Missed"}}],
                set(),
            ),
            "down replayed",
        )

    def test_reversed_ruling_without_a_later_miss(self):
        play = {
            "id": "1",
            "text": "J.Myers 40 yard field goal is No Good. RULING REVERSED. The field goal is good.",
            "type": {"id": "60", "text": "Field Goal Missed"},
        }
        self.assertEqual(nullified_reason([play], set()), "ruling reversed")

    def test_miss_after_reversed_still_counts(self):
        play = {
            "id": "1",
            "text": "RULING REVERSED. J.Myers 40 yard field goal is No Good, Wide Left.",
            "type": {"id": "60", "text": "Field Goal Missed"},
        }
        self.assertIsNone(nullified_reason([play], set()))

    def test_between_downs_pat_still_counts(self):
        for text, type_id, type_text, paa in (
            (AUBREY_BETWEEN_DOWNS, "67", "Passing Touchdown", {"id": "62", "text": "Extra Point Missed"}),
            (STEVENS_BETWEEN_DOWNS, "36", "Interception Return Touchdown", {"id": "62", "text": "Extra Point Missed"}),
        ):
            play = {"id": "p", "text": text, "type": {"id": type_id, "text": type_text}, "pointAfterAttempt": paa}
            self.assertIsNone(nullified_reason([play], set()), text[:40])
            self.assertEqual(classify_miss(play)[:2], ("PAT", "miss"))

    def test_accepted_penalty_on_the_kick_is_skipped(self):
        play = {
            "id": "1",
            "text": "J.Myers 53 yard field goal is No Good, Wide Right.",
            "type": {"id": "60", "text": "Field Goal Missed"},
            "isPenalty": True,
            "penalty": {"status": {"slug": "accepted", "text": "Accepted"}},
        }
        self.assertEqual(nullified_reason([play], set()), "accepted penalty on the kick")

    def test_accepted_penalty_enforced_between_downs_counts(self):
        play = {
            "id": "1",
            "text": "B.Aubrey extra point is No Good. PENALTY, enforced between downs.",
            "type": {"id": "67", "text": "Passing Touchdown"},
            "pointAfterAttempt": {"id": "62", "text": "Extra Point Missed"},
            "isPenalty": True,
            "penalty": {"status": {"slug": "accepted", "text": "Accepted"}},
        }
        self.assertIsNone(nullified_reason([play], set()))

    def test_pat_on_a_touchdown_still_in_scoring_plays_counts(self):
        play = {
            "id": "td1",
            "text": "TOUCHDOWN. R.Fitzgerald extra point is No Good, Wide Right.",
            "type": {"id": "67", "text": "Passing Touchdown"},
            "pointAfterAttempt": {"id": "62", "text": "Extra Point Missed"},
            "isPenalty": True,
            "penalty": {"status": {"slug": "accepted", "text": "Accepted"}},
        }
        self.assertIsNone(nullified_reason([play], {"td1"}))
        self.assertEqual(nullified_reason([play], set()), "accepted penalty on the kick")

    def test_touchdown_removed_from_scoring_plays_is_skipped(self):
        play = {
            "id": "td1",
            "text": "TOUCHDOWN. R.Fitzgerald extra point is No Good.",
            "type": {"id": "67", "text": "Passing Touchdown"},
            "pointAfterAttempt": {"id": "62", "text": "Extra Point Missed"},
            "scoringPlay": True,
        }
        self.assertEqual(nullified_reason([play], {"other"}), "touchdown no longer in scoringPlays")
        self.assertIsNone(nullified_reason([play], {"td1"}))

    def test_week4_catalog_skips_myers_no_play(self):
        plays = support.load("all-miss-plays.json")
        myers = next(row for row in plays if row["playId"] == "4018729773227")
        miss, reason = miss_from_catalog_row(myers)
        self.assertIsNone(miss)
        self.assertEqual(reason, "penalty play type")
        aubrey = next(row for row in plays if row["playId"] == "4018729303720")
        miss, reason = miss_from_catalog_row(aubrey)
        self.assertIsNone(reason)
        self.assertEqual(miss["kickType"], "PAT")
        self.assertFalse(miss["blocked"])


if __name__ == "__main__":
    unittest.main()
