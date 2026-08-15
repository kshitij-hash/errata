"""Metric aggregation — pure functions over row fixtures.

A "judged row" is a mapping with (at least):
    is_abstention: bool          # gold, from dataset.is_abstention
    predicted_abstain: bool      # from arms.predicted_abstain
    verdict: str | None          # "CORRECT" | "INCORRECT" | "UNPARSEABLE" (non-abstention only)
    ability: str
    prompt_tokens: int
    usd: float
    latency_ms: float            # harness wall-clock around the HTTP call

A "citation row" is a mapping with:
    cited_session_ids, gold_session_ids, cited_turn_refs, gold_turn_refs

Accuracies are returned as fractions in [0, 1]; report.py renders them as percentages.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping, Sequence

import numpy as np

Row = Mapping[str, object]


# --------------------------------------------------------------------------------------------
# answer accuracy
# --------------------------------------------------------------------------------------------
def _is_correct(row: Row) -> bool:
    return row.get("verdict") == "CORRECT"


def _non_abstention(rows: Iterable[Row]) -> list[Row]:
    return [r for r in rows if not r.get("is_abstention")]


def accuracy(rows: Iterable[Row]) -> float:
    """CORRECT ÷ non-abstention questions. NaN if there are no non-abstention rows."""
    subset = _non_abstention(rows)
    if not subset:
        return float("nan")
    return sum(1 for r in subset if _is_correct(r)) / len(subset)


def accuracy_by_ability(rows: Iterable[Row]) -> dict[str, float]:
    rows = list(rows)
    abilities = {str(r.get("ability")) for r in _non_abstention(rows)}
    out: dict[str, float] = {}
    for ability in abilities:
        subset = [r for r in _non_abstention(rows) if r.get("ability") == ability]
        out[ability] = (
            sum(1 for r in subset if _is_correct(r)) / len(subset) if subset else float("nan")
        )
    return out


# --------------------------------------------------------------------------------------------
# abstention precision / recall / F1  (deterministic scoring; the judge is not involved)
# --------------------------------------------------------------------------------------------
def abstention_confusion(rows: Iterable[Row]) -> tuple[int, int, int, int]:
    """Return (tp, fp, fn, tn). Positives = predicted abstain; gold positive = is_abstention."""
    tp = fp = fn = tn = 0
    for r in rows:
        gold = bool(r.get("is_abstention"))
        pred = bool(r.get("predicted_abstain"))
        if pred and gold:
            tp += 1
        elif pred and not gold:
            fp += 1
        elif not pred and gold:
            fn += 1
        else:
            tn += 1
    return tp, fp, fn, tn


def precision_recall_f1(tp: int, fp: int, fn: int) -> tuple[float, float, float]:
    precision = tp / (tp + fp) if (tp + fp) else float("nan")
    recall = tp / (tp + fn) if (tp + fn) else float("nan")
    if math.isnan(precision) or math.isnan(recall):
        f1 = float("nan")
    elif (precision + recall) == 0:
        f1 = 0.0
    else:
        f1 = 2 * precision * recall / (precision + recall)
    return precision, recall, f1


def abstention_pr(rows: Iterable[Row]) -> dict[str, float | int]:
    tp, fp, fn, tn = abstention_confusion(rows)
    precision, recall, f1 = precision_recall_f1(tp, fp, fn)
    return {
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "tn": tn,
        "precision": precision,
        "recall": recall,
        "f1": f1,
    }


# --------------------------------------------------------------------------------------------
# citation precision / recall (macro over questions)
# --------------------------------------------------------------------------------------------
def _as_ref_set(items: object) -> set:
    out = set()
    for it in items or []:  # type: ignore[union-attr]
        out.add(tuple(it) if isinstance(it, (list, tuple)) else it)
    return out


def _macro_pr(rows: Iterable[Row], cited_key: str, gold_key: str) -> dict[str, float]:
    precisions: list[float] = []
    recalls: list[float] = []
    for r in rows:
        cited = _as_ref_set(r.get(cited_key))
        gold = _as_ref_set(r.get(gold_key))
        inter = cited & gold
        if cited:
            precisions.append(len(inter) / len(cited))
        if gold:
            recalls.append(len(inter) / len(gold))
    return {
        "precision": float(np.mean(precisions)) if precisions else float("nan"),
        "recall": float(np.mean(recalls)) if recalls else float("nan"),
        "n_precision": len(precisions),
        "n_recall": len(recalls),
    }


def session_citation_pr(rows: Iterable[Row]) -> dict[str, float]:
    return _macro_pr(rows, "cited_session_ids", "gold_session_ids")


def turn_citation_pr(rows: Iterable[Row]) -> dict[str, float]:
    # Reported only over questions that have any gold has_answer turn.
    subset = [r for r in rows if _as_ref_set(r.get("gold_turn_refs"))]
    return _macro_pr(subset, "cited_turn_refs", "gold_turn_refs")


# --------------------------------------------------------------------------------------------
# aggregation across seeded runs + latency
# --------------------------------------------------------------------------------------------
def mean_sd(values: Sequence[float]) -> tuple[float, float]:
    """Mean and sample sd (n-1). sd is 0.0 for a single value, NaN for none."""
    arr = np.asarray(list(values), dtype=float)
    if arr.size == 0:
        return float("nan"), float("nan")
    mean = float(arr.mean())
    sd = float(arr.std(ddof=1)) if arr.size >= 2 else 0.0
    return mean, sd


def percentiles(values: Sequence[float], ps: Sequence[float] = (50, 95)) -> dict[float, float]:
    arr = np.asarray(list(values), dtype=float)
    if arr.size == 0:
        return {p: float("nan") for p in ps}
    return {p: float(np.percentile(arr, p)) for p in ps}


def error_rate(rows: Iterable[Row]) -> float:
    """Fraction of rows whose status is non-ok / unparseable."""
    rows = list(rows)
    if not rows:
        return float("nan")
    bad = sum(
        1
        for r in rows
        if r.get("status") not in (None, "ok", 200)
        or r.get("verdict") == "UNPARSEABLE"
    )
    return bad / len(rows)


def cost_per_question(rows: Iterable[Row]) -> float:
    rows = list(rows)
    if not rows:
        return float("nan")
    return sum(float(r.get("usd", 0.0) or 0.0) for r in rows) / len(rows)


def mean_prompt_tokens(rows: Iterable[Row]) -> float:
    rows = list(rows)
    if not rows:
        return float("nan")
    return float(np.mean([float(r.get("prompt_tokens", 0) or 0) for r in rows]))
