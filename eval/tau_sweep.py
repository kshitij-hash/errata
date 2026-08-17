#!/usr/bin/env python
"""τ sensitivity for the calibrated refusal — a SWEEP, deliberately not a fit.

Errata's abstention gate is ``E >= τ`` with the five weights of E fixed a priori (evidence-scoring design)
and τ the one fitted quantity. This script answers the only question that can be answered honestly
on this corpus: **how much does the published number depend on where τ sits?**

Why not a re-fit. Fitting τ needs a held-out slice containing abstention-positive questions.
LongMemEval has exactly 30 of them and the eval's sampler takes all 30 into the comparison set by
design (``sample.abstention_whole = true``), so every abstention-positive example the corpus owns
is inside the reported test set. Any τ chosen against them is chosen in-sample, and reporting it as
"fitted on held-out data" would be false. τ therefore stays at its a-priori 0.35 and this sweep is
published beside the table so a reader can see the result is not balanced on a knife edge.

The sweep treats τ as a VETO on the answer the synthesis produced: at each τ, a row that answered
with recorded evidence score E < τ is counted as an abstention instead.

    uv run python tau_sweep.py --run <run_id>
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

import orjson

from errata_eval import config as cfg
from errata_eval.dataset import load_corpus

GRID = (0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55)


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [orjson.loads(line) for line in path.read_bytes().splitlines() if line]


def sweep(rows: list[dict[str, Any]], grid: tuple[float, ...] = GRID) -> list[dict[str, float]]:
    """Each row: is_abstention, abstained, verdict, confidence (E)."""
    out: list[dict[str, float]] = []
    for tau in grid:
        tp = fp = fn = correct = answered = 0
        total = len(rows)
        hits = 0
        for r in rows:
            gold_abs = bool(r["is_abstention"])
            # the veto: an answer whose evidence score is below τ becomes an abstention
            pred_abs = bool(r["abstained"]) or float(r.get("confidence") or 0.0) < tau
            if pred_abs and gold_abs:
                tp += 1
            elif pred_abs and not gold_abs:
                fp += 1
            elif not pred_abs and gold_abs:
                fn += 1
            if not pred_abs:
                answered += 1
                if r["verdict"] == "CORRECT":
                    correct += 1
            # combined score: an abstention question is right iff we abstained; else the judge
            if (gold_abs and pred_abs) or (not gold_abs and not pred_abs and r["verdict"] == "CORRECT"):
                hits += 1
        out.append({
            "tau": tau,
            "overall": 100 * hits / total if total else float("nan"),
            "answered": answered,
            "answered_precision": 100 * correct / answered if answered else float("nan"),
            "abstention_precision": tp / (tp + fp) if (tp + fp) else float("nan"),
            "abstention_recall": tp / (tp + fn) if (tp + fn) else float("nan"),
        })
    return out


def render(table: list[dict[str, float]], *, run: str, tau_shipped: float) -> str:
    lines = [
        f"### τ sensitivity — run `{run}`",
        "",
        "| τ | overall % | answered | answered-precision % | abstention P | abstention R |",
        "|---:|---:|---:|---:|---:|---:|",
    ]
    for r in table:
        mark = " ←shipped" if abs(r["tau"] - tau_shipped) < 1e-9 else ""
        lines.append(
            f"| {r['tau']:.2f}{mark} | {r['overall']:.1f} | {r['answered']:.0f} | "
            f"{r['answered_precision']:.1f} | {r['abstention_precision']:.2f} | "
            f"{r['abstention_recall']:.2f} |"
        )
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--run", required=True, help="run_id under out/")
    p.add_argument("--out", type=Path, default=None)
    p.add_argument("--config", type=Path, default=None)
    args = p.parse_args(argv)

    config = cfg.load_eval_config(args.config or cfg.default_eval_path())
    run_dir = Path("out") / args.run
    answers = read_jsonl(run_dir / "answers.jsonl")
    verdicts = {
        (j["arm"], j["seed"], j["question_id"]): j["verdict"]
        for j in read_jsonl(run_dir / "judgments.jsonl")
    }
    if not answers:
        print(f"tau_sweep: no answers in {run_dir}", file=sys.stderr)
        return 1
    gold = {q.question_id: q.abstention for q in load_corpus(config.data_path())}

    rows = [
        {
            "is_abstention": gold.get(a["question_id"], False),
            "abstained": bool(a.get("abstained")),
            "verdict": verdicts.get((a["arm"], a["seed"], a["question_id"])),
            "confidence": a.get("confidence"),
        }
        for a in answers
        if a["question_id"] in gold
    ]
    doc = render(sweep(rows), run=args.run, tau_shipped=0.35)
    print(doc)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(doc, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
