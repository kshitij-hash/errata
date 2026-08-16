"""Snapshot test for the ONE results-table generator (§5.3).

A hand-authored, committed fixture of enriched judged rows (all three arms, three seeds,
abstention rows, and Errata citation rows) is fed through the exact production aggregation path
(``report.aggregate_arm_reports``) and rendered. The generated markdown must match the committed
snapshot byte-for-byte and be deterministic — the table is pasted into the submission README with
no editing, so any drift in column layout or numbers is a regression.

Regenerate the snapshot deliberately (never casually) with::

    rows = [orjson.loads(l) for l in FIXTURE.read_bytes().splitlines() if l]
    SNAPSHOT.write_text(render_table(aggregate_arm_reports(rows, warmup=0)) + "\\n")
"""

from __future__ import annotations

from pathlib import Path

import orjson

from errata_eval import metrics
from errata_eval.report import aggregate_arm_reports, render_table

FIXTURES = Path(__file__).resolve().parent / "fixtures"
FIXTURE = FIXTURES / "judged_rows.jsonl"
SNAPSHOT = FIXTURES / "results_table.md"

# The exact §5.3 header — its column set and order are contractual.
EXPECTED_HEADER = (
    "| Arm | Overall | Info. extraction | Multi-session | Temporal | "
    "Knowledge update | Abstention P / R | Ctx tok/Q | $/Q | p50 / p95 (s) |"
)


def _rows() -> list[dict]:
    return [orjson.loads(line) for line in FIXTURE.read_bytes().splitlines() if line]


def test_table_matches_committed_snapshot() -> None:
    table = render_table(aggregate_arm_reports(_rows(), warmup=0))
    assert table == SNAPSHOT.read_text(encoding="utf-8").rstrip("\n")


def test_table_generator_is_deterministic() -> None:
    rows = _rows()
    a = render_table(aggregate_arm_reports(rows, warmup=0))
    b = render_table(aggregate_arm_reports(rows, warmup=0))
    assert a == b


def test_column_layout_and_row_order() -> None:
    lines = render_table(aggregate_arm_reports(_rows(), warmup=0)).splitlines()
    assert lines[0] == EXPECTED_HEADER
    assert lines[1] == "|" + "|".join(["---"] * 10) + "|"
    # fixed row order: Errata first (never below the fold), then the two baselines.
    assert lines[2].startswith("| **Errata** |")
    assert lines[3].startswith("| Full-context baseline |")
    assert lines[4].startswith("| Naive top-k RAG (k=10) |")


def test_every_accuracy_cell_is_a_three_run_mean_sd() -> None:
    # 3 seeds present => cells render as "mean ± sd", never the "(1 run)" fallback.
    body = render_table(aggregate_arm_reports(_rows(), warmup=0)).splitlines()[2:]
    for line in body:
        assert "(1 run)" not in line
        assert "±" in line


def test_abstention_rows_score_non_degenerately() -> None:
    rows = _rows()
    naive = [r for r in rows if r["arm"] == "naive"]
    pr = metrics.abstention_pr(naive)
    # naive catches 1 of 3 abstentions per seed -> recall 1/3, and falsely abstains -> precision 0.5
    assert pr["recall"] == 1 / 3
    assert pr["precision"] == 0.5
    errata = [r for r in rows if r["arm"] == "errata"]
    assert metrics.abstention_pr(errata)["recall"] == 1.0


def test_citation_rows_exercise_the_citation_metrics() -> None:
    errata = [r for r in _rows() if r["arm"] == "errata"]
    sess = metrics.session_citation_pr(errata)
    turn = metrics.turn_citation_pr(errata)
    assert sess["n_precision"] > 0 and 0.0 < sess["precision"] <= 1.0
    assert turn["n_recall"] > 0 and 0.0 < turn["recall"] <= 1.0
