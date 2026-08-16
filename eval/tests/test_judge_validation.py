"""The judge-validation arithmetic and its two published artifacts.

Everything here is pure: FAR/FRR from a list of verdicts, the stratified spot-check draw, Cohen's
κ, and the two rendered markdown files. No LLM, no network — the scoring pass that produces the
verdicts is credit-gated and lives in the CLI, but nothing it computes is.
"""

from __future__ import annotations

import math

from errata_eval.judge_validation import (
    NEGATIVE_FAMILIES,
    ControlItem,
    cohen_kappa,
    control_items_from_rows,
    evaluate,
    render_human_sheet,
    render_validation_md,
    stratified_spot_check,
)


def _item(kind: str, family: str, qid: str, verdict: str = "") -> ControlItem:
    return ControlItem(
        question_id=qid,
        question=f"q-{qid}",
        gold_answer=f"gold-{qid}",
        candidate=f"cand-{qid}",
        kind=kind,
        family=family,
        verdict=verdict,
    )


def _control_set(
    *, accepts_per_family: dict[str, int] | None = None, positive_rejects: int = 0
) -> list[ControlItem]:
    """12 negatives per family + 60 positives, with a chosen number of judge mistakes in each."""
    accepts = accepts_per_family or {}
    items: list[ControlItem] = []
    for fam in NEGATIVE_FAMILIES:
        for i in range(12):
            verdict = "CORRECT" if i < accepts.get(fam, 0) else "INCORRECT"
            items.append(_item("perturbed", fam, f"{fam}-{i}", verdict))
    for i in range(60):
        verdict = "INCORRECT" if i < positive_rejects else "CORRECT"
        items.append(_item("positive", "", f"pos-{i}", verdict))
    return items


# --------------------------------------------------------------------------------------------
# FAR / FRR
# --------------------------------------------------------------------------------------------
def test_a_perfect_judge_scores_zero_on_both_rates() -> None:
    report = evaluate("test-judge", _control_set())
    assert report.far == 0.0
    assert report.frr == 0.0
    assert report.far_by_family == {fam: 0.0 for fam in NEGATIVE_FAMILIES}
    assert report.all_gates_pass


def test_far_is_accepted_negatives_over_negatives_and_frr_is_rejected_positives() -> None:
    report = evaluate("test-judge", _control_set(accepts_per_family={"value-shift": 3}, positive_rejects=6))
    assert report.n_false_accept == 3
    assert report.far == 3 / 60
    assert report.far_by_family["value-shift"] == 3 / 12
    assert report.far_by_family["entity-swap"] == 0.0
    assert report.n_false_reject == 6
    assert report.frr == 6 / 60


def test_gates_are_read_from_their_arguments_and_the_superseded_gate_is_the_tighter_one() -> None:
    # 1/12 = 8.3% superseded FAR: under the 10% overall ceiling, OVER the 8% family ceiling.
    report = evaluate(
        "test-judge",
        _control_set(accepts_per_family={"superseded-value": 1}),
        far_gate=0.10,
        far_gate_superseded=0.08,
        frr_gate=0.15,
    )
    assert report.passes_far  # 1/60 overall
    assert not report.passes_superseded
    assert not report.pinned  # a judge is not pinned on the overall rate alone


def test_an_unparseable_verdict_is_a_rejection_never_an_accept() -> None:
    items = _control_set()
    items[0].verdict = "UNPARSEABLE"  # a negative: still not accepted
    items[-1].verdict = "UNPARSEABLE"  # a positive: a false REJECT
    report = evaluate("test-judge", items)
    assert report.far == 0.0
    assert report.n_false_reject == 1
    assert report.n_unparseable == 2


def test_kappa_is_nan_until_a_human_has_labelled_something() -> None:
    report = evaluate("test-judge", _control_set())
    assert math.isnan(report.kappa)


# --------------------------------------------------------------------------------------------
# Cohen's κ
# --------------------------------------------------------------------------------------------
def test_kappa_is_one_on_perfect_agreement_and_zero_on_chance() -> None:
    labels = ["CORRECT", "INCORRECT"] * 10
    assert cohen_kappa(labels, labels) == 1.0
    # both raters say CORRECT half the time but never agree about which half => κ < 0.
    assert cohen_kappa(labels, ["INCORRECT", "CORRECT"] * 10) < 0.0


def test_kappa_discounts_agreement_a_constant_rater_would_get_by_luck() -> None:
    # 90% raw agreement, but the judge said CORRECT to everything.
    human = ["CORRECT"] * 18 + ["INCORRECT"] * 2
    judge = ["CORRECT"] * 20
    assert cohen_kappa(human, judge) == 0.0


# --------------------------------------------------------------------------------------------
# the spot-check draw
# --------------------------------------------------------------------------------------------
def test_spot_check_is_proportional_across_the_six_strata_and_seed_stable() -> None:
    items = _control_set()
    spot = stratified_spot_check(items, 20, seed=20260818)
    assert len(spot) == 20
    strata = {s: sum(1 for it in spot if it.stratum == s) for s in {it.stratum for it in spot}}
    assert strata["positive"] == 10  # 60 of 120 items => half the sheet
    assert all(strata[fam] == 2 for fam in NEGATIVE_FAMILIES)  # 12 of 120 => 2 each
    again = stratified_spot_check(items, 20, seed=20260818)
    assert [it.control_id for it in spot] == [it.control_id for it in again]
    other = stratified_spot_check(items, 20, seed=1)
    assert [it.control_id for it in spot] != [it.control_id for it in other]


# --------------------------------------------------------------------------------------------
# the two rendered artifacts
# --------------------------------------------------------------------------------------------
def test_human_sheet_has_a_blank_verdict_column_and_leaks_no_judge_verdict() -> None:
    items = _control_set(accepts_per_family={"entity-swap": 12}, positive_rejects=60)
    spot = stratified_spot_check(items, 20, seed=20260818)
    sheet = render_human_sheet(spot, judge_model="anthropic/claude-sonnet-5", total_items=len(items))
    rows = [ln for ln in sheet.splitlines() if ln.startswith("| ") and "control_id" not in ln]
    assert len(rows) == 20
    for row in rows:
        assert row.rstrip().endswith("|  |")  # the verdict cell is empty
        assert "CORRECT" not in row  # no verdict, and no "INCORRECT" either
    # nothing in the sheet says which half an item came from beyond its id.
    assert "perturbed" not in sheet.split("| # |")[0]


def test_validation_md_publishes_the_measured_numbers_and_marks_a_failed_gate() -> None:
    report = evaluate(
        "anthropic/claude-sonnet-5",
        _control_set(accepts_per_family={"superseded-value": 2}),
    )
    md = render_validation_md(
        report,
        judge_prompt_sha="07286ad6deadbeef",
        perturber_model="google/gemini-3.7-flash",
        validation_seed=20260818,
        control_seed=20260818,
        spend_usd=0.1234,
        spot_check_n=20,
    )
    assert "anthropic/claude-sonnet-5" in md
    assert "07286ad6" in md
    assert "3.3%" in md  # 2/60 overall FAR
    assert "16.7%" in md  # 2/12 superseded-value FAR
    assert "**FAIL**" in md  # and it is marked as a failure, not smoothed over
    assert "62.8%" in md  # the naive-judge reference point stays in the write-up
    assert "$0.1234" in md
    for fam in NEGATIVE_FAMILIES:
        assert fam in md


def test_control_items_from_rows_rejects_an_unknown_label() -> None:
    rows = [
        {
            "question_id": "q1",
            "family": "",
            "label": "maybe",
            "question": "q",
            "gold_answer": "g",
            "answer": "a",
        }
    ]
    try:
        control_items_from_rows(rows)
    except ValueError as exc:
        assert "maybe" in str(exc)
    else:  # pragma: no cover - the assertion is the test
        raise AssertionError("an unknown control label must not be silently scored")
