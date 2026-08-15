"""Accuracy, abstention P/R, citation P/R, mean±sd, latency — pure functions over fixtures."""

from __future__ import annotations

import math

from errata_eval import metrics


def _row(is_abs, pred_abs, verdict, ability="multi_session", **extra):
    base = {
        "is_abstention": is_abs,
        "predicted_abstain": pred_abs,
        "verdict": verdict,
        "ability": ability,
    }
    base.update(extra)
    return base


def test_accuracy_over_non_abstention_only() -> None:
    rows = [
        _row(False, False, "CORRECT"),
        _row(False, False, "INCORRECT"),
        _row(False, False, "CORRECT"),
        _row(True, True, None),  # abstention gold: excluded from accuracy denominator
    ]
    assert metrics.accuracy(rows) == 2 / 3


def test_accuracy_by_ability() -> None:
    rows = [
        _row(False, False, "CORRECT", ability="temporal"),
        _row(False, False, "INCORRECT", ability="temporal"),
        _row(False, False, "CORRECT", ability="multi_session"),
    ]
    by = metrics.accuracy_by_ability(rows)
    assert by["temporal"] == 0.5
    assert by["multi_session"] == 1.0


def test_abstention_precision_recall_f1() -> None:
    # 3 gold abstentions: 2 caught (TP), 1 missed (FN). 1 false abstain on an answerable (FP).
    rows = [
        _row(True, True, None),
        _row(True, True, None),
        _row(True, False, "INCORRECT"),  # FN
        _row(False, True, "INCORRECT"),  # FP
        _row(False, False, "CORRECT"),  # TN
    ]
    pr = metrics.abstention_pr(rows)
    assert (pr["tp"], pr["fp"], pr["fn"], pr["tn"]) == (2, 1, 1, 1)
    assert pr["precision"] == 2 / 3
    assert pr["recall"] == 2 / 3
    assert math.isclose(pr["f1"], 2 / 3)


def test_session_citation_pr_macro() -> None:
    rows = [
        {"cited_session_ids": ["a", "b"], "gold_session_ids": ["a"]},  # p=1/2, r=1
        {"cited_session_ids": ["c"], "gold_session_ids": ["c", "d"]},  # p=1, r=1/2
    ]
    out = metrics.session_citation_pr(rows)
    assert math.isclose(out["precision"], (0.5 + 1.0) / 2)
    assert math.isclose(out["recall"], (1.0 + 0.5) / 2)


def test_turn_citation_pr_restricts_to_questions_with_gold_turns() -> None:
    rows = [
        {"cited_turn_refs": [("s", 0)], "gold_turn_refs": [("s", 0), ("s", 1)]},  # p=1, r=1/2
        {"cited_turn_refs": [("s", 3)], "gold_turn_refs": []},  # skipped (no gold turns)
    ]
    out = metrics.turn_citation_pr(rows)
    assert math.isclose(out["precision"], 1.0)
    assert math.isclose(out["recall"], 0.5)
    assert out["n_recall"] == 1  # only the first question counted


def test_mean_sd() -> None:
    mean, sd = metrics.mean_sd([0.72, 0.74, 0.76])
    assert math.isclose(mean, 0.74)
    assert math.isclose(sd, 0.02, rel_tol=1e-9)  # sample sd (n-1)
    # single value -> sd 0.0, not NaN
    m1, s1 = metrics.mean_sd([0.5])
    assert (m1, s1) == (0.5, 0.0)
    # empty -> NaN
    m0, s0 = metrics.mean_sd([])
    assert math.isnan(m0) and math.isnan(s0)


def test_percentiles() -> None:
    pct = metrics.percentiles([1, 2, 3, 4], ps=(50, 95))
    assert math.isclose(pct[50], 2.5)


def test_error_rate_and_cost() -> None:
    rows = [
        {"status": "ok", "usd": 0.01, "prompt_tokens": 100},
        {"status": 500, "usd": 0.0, "prompt_tokens": 0},
        {"status": "ok", "verdict": "UNPARSEABLE", "usd": 0.02, "prompt_tokens": 200},
    ]
    assert math.isclose(metrics.error_rate(rows), 2 / 3)
    assert math.isclose(metrics.cost_per_question(rows), 0.03 / 3)
    assert math.isclose(metrics.mean_prompt_tokens(rows), 100.0)
