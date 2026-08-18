"""Pins the inferential statistics in eval/stats.py against the committed judged rows.

If these fail, either `apps/web/data/results.json` changed (a re-run landed and RESULTS.md,
stats.md and every published gap need regenerating with it) or the estimators in stats.py drifted.
Both are things that must never happen silently — the McNemar counts are the evidence that the
headline gap is not noise.

The discordant counts are pinned exactly, per the docstring in `discordant`: the pairing unit is
the question, and the collapse rule is named in every expectation because the counts move with it.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

# eval/tests/test_stats.py -> tests -> eval/ ; stats.py is a sibling script, not a package module.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import stats

BUNDLE = stats.load_bundle()

# Collapse rule shipped by stats.py's headline table. Every count below is rule-specific.
RULE = "majority"

# (b, c) = (Errata right & baseline wrong, baseline right & Errata wrong), paired per question.
EXPECTED_MCNEMAR = {
    ("overall-120", "full_context"): (29, 15),
    ("overall-120", "naive"): (31, 14),
    ("all-450", "full_context"): (33, 15),
    ("all-450", "naive"): (31, 15),
}

# The full grid over collapse rules. Pinned because stats.md publishes it as the evidence that no
# choice of rule changes the conclusion — and because an audit pass reported counts that no single
# rule reproduces (see the note in stats.md).
EXPECTED_GRID = {
    "seed0": {("overall-120", "full_context"): (30, 14), ("overall-120", "naive"): (31, 14),
              ("all-450", "full_context"): (34, 14), ("all-450", "naive"): (31, 15)},
    "seed1": {("overall-120", "full_context"): (30, 15), ("overall-120", "naive"): (31, 14),
              ("all-450", "full_context"): (34, 15), ("all-450", "naive"): (31, 16)},
    "seed2": {("overall-120", "full_context"): (29, 15), ("overall-120", "naive"): (31, 14),
              ("all-450", "full_context"): (33, 15), ("all-450", "naive"): (31, 15)},
    "unanimous": {("overall-120", "full_context"): (33, 14), ("overall-120", "naive"): (31, 14),
                  ("all-450", "full_context"): (37, 14), ("all-450", "naive"): (31, 15)},
}

# Point estimates, from apps/web/lib/results.ts's own scoring rule.
EXPECTED_ACC = {
    "errata": (60.0, 200.0 / 3),
    "full_context": (47.5, 54.0),
    "naive": (45.833333333333336, 56.22222222222222),
}


def _cuts() -> dict[str, list[dict]]:
    return {"overall-120": BUNDLE.non_abstention, "all-450": BUNDLE.questions}


def test_corpus_shape_is_the_one_the_counts_were_pinned_on() -> None:
    assert len(BUNDLE.questions) == 150
    assert len(BUNDLE.non_abstention) == 120
    assert BUNDLE.n_seeds == 3


def test_point_estimates() -> None:
    for arm, (overall, all450) in EXPECTED_ACC.items():
        assert math.isclose(stats.accuracy(BUNDLE, arm, BUNDLE.non_abstention), overall, abs_tol=1e-9)
        assert math.isclose(stats.accuracy(BUNDLE, arm, BUNDLE.questions), all450, abs_tol=1e-9)


def test_mcnemar_discordant_counts() -> None:
    cuts = _cuts()
    for (cut, base), expected in EXPECTED_MCNEMAR.items():
        assert stats.discordant(BUNDLE, cuts[cut], "errata", base, RULE) == expected, (cut, base)


def test_mcnemar_grid_over_every_collapse_rule() -> None:
    cuts = _cuts()
    for rule, cells in EXPECTED_GRID.items():
        for (cut, base), expected in cells.items():
            assert stats.discordant(BUNDLE, cuts[cut], "errata", base, rule) == expected, (rule, cut, base)


def test_every_comparison_favours_errata_and_clears_0_05() -> None:
    """The claim the whole table exists to support. b > c in every cell, p <= 0.05 in every cell."""
    for (cut, base), (b, c, p) in stats.mcnemar_table(BUNDLE, RULE).items():
        assert b > c, (cut, base, b, c)
        assert p <= 0.05, (cut, base, p)


def test_exact_mcnemar_matches_a_hand_computed_binomial() -> None:
    # 31/14: two-sided exact sign test on 45 discordant pairs.
    n, k = 45, 14
    expected = 2 * sum(math.comb(n, i) for i in range(k + 1)) / 2**n
    assert math.isclose(stats.exact_mcnemar(31, 14), expected, rel_tol=1e-12)
    assert stats.exact_mcnemar(0, 0) == 1.0
    assert math.isclose(stats.exact_mcnemar(5, 5), 1.0, rel_tol=1e-12)


def test_bootstrap_is_deterministic_and_brackets_the_point_estimate() -> None:
    """A seeded bootstrap that moves between runs is not evidence of anything."""
    stat = lambda qs: stats.accuracy(BUNDLE, "errata", qs)
    first = stats.bootstrap_ci(BUNDLE.non_abstention, stat, resamples=2000)
    second = stats.bootstrap_ci(BUNDLE.non_abstention, stat, resamples=2000)
    assert first == second
    lo, hi, _, _ = first
    assert lo < stats.accuracy(BUNDLE, "errata", BUNDLE.non_abstention) < hi


def test_far_correction_never_rewards_a_worse_judge() -> None:
    """Guards the bug this correction invites: folding un-judged abstention wins into `accepted`
    makes 'corrected' accuracy RISE with FAR, which is nonsense. Accuracy must be monotonically
    non-increasing in FAR for every arm on every cut."""
    for qset in _cuts().values():
        s = stats.judge_sensitivity(BUNDLE, qset)
        for arm, d in s.items():
            assert d["accepted"] <= d["answered"], arm
            assert d["raw"] >= d["far_headline"] >= d["far_worst"], (arm, d)


def test_far_correction_widens_the_lead_over_full_context() -> None:
    """The substantive finding: a judge that over-accepts costs the arm that answers most, and
    Errata answers least, so correcting for it can only help Errata's lead."""
    s = stats.judge_sensitivity(BUNDLE, BUNDLE.non_abstention)
    raw = s["errata"]["raw"] - s["full_context"]["raw"]
    head = s["errata"]["far_headline"] - s["full_context"]["far_headline"]
    worst = s["errata"]["far_worst"] - s["full_context"]["far_worst"]
    assert math.isclose(raw, 12.5, abs_tol=0.05)
    assert head > raw and worst > head
    assert math.isclose(head, 14.5, abs_tol=0.1)
    assert math.isclose(worst, 17.5, abs_tol=0.1)


def test_post_stratification_costs_errata_and_not_the_baselines() -> None:
    """Re-weighting the sample to the corpus's own question-type mix is a real deduction from the
    headline; if this flips, the 64.6 in stats.md and RESULTS.md is stale."""
    deltas = {
        arm: stats.post_stratified(BUNDLE, arm) - stats.accuracy(BUNDLE, arm, BUNDLE.questions)
        for arm in stats.ARMS
    }
    assert math.isclose(deltas["errata"], -2.05, abs_tol=0.02)
    assert math.isclose(deltas["full_context"], 0.14, abs_tol=0.02)
    assert math.isclose(deltas["naive"], 0.09, abs_tol=0.02)
    assert math.isclose(stats.post_stratified(BUNDLE, "errata"), 64.6, abs_tol=0.05)


def test_full_corpus_mix_totals_500_and_covers_the_sample() -> None:
    assert sum(stats.FULL_CORPUS_MIX.values()) == 500
    assert {q["type"] for q in BUNDLE.questions} == set(stats.FULL_CORPUS_MIX)
