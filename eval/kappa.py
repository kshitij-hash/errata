#!/usr/bin/env python
"""Cohen's κ between a human labeller and the pinned judge, on the spot-check subset.

The human sheet (``judge-controls-for-human.md``, written by ``errata-eval judge-validate``) has a
blank **Verdict** column and no judge verdicts in it — that is deliberate, because a rater who can
see the answer key is not an independent rater. Fill the column in, then:

    uv run python kappa.py --labels judge-controls-for-human.md

This reads the labels back out of that same file, joins them to ``out/judge-controls-scored.jsonl``
on ``control_id``, and prints κ plus the confusion matrix. NO LLM call, no spend, no network.

A CSV/TSV of ``control_id,label`` is accepted too, for a labeller who would rather work in a sheet.

κ, not raw agreement: on a set that is half positives by construction, a judge that answered
CORRECT every time would score 50% agreement and κ = 0. The interpretation bands quoted below are
Landis & Koch's, and they are a convention, not a gate — the gates in this protocol are FAR/FRR.
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
from pathlib import Path

import orjson

from errata_eval.judge_validation import cohen_kappa

EVAL_DIR = Path(__file__).resolve().parent
DEFAULT_LABELS = EVAL_DIR / "judge-controls-for-human.md"
DEFAULT_SCORED = EVAL_DIR / "out" / "judge-controls-scored.jsonl"

VALID = ("CORRECT", "INCORRECT")
# A markdown row from the human sheet: | 3 | `positive:0a34ad58` | question | gold | cand | LABEL |
_MD_ROW = re.compile(r"^\|(?P<cells>.*)\|\s*$")
_ID_CELL = re.compile(r"`?(?P<id>(?:positive|perturbed):[A-Za-z0-9_-]+)`?")


def normalize(label: str) -> str:
    """Accept the obvious human spellings; reject anything ambiguous rather than guess."""
    v = label.strip().strip("*`").upper()
    if v in ("C", "Y", "YES", "TRUE", "OK"):
        return "CORRECT"
    if v in ("I", "N", "NO", "FALSE", "WRONG"):
        return "INCORRECT"
    return v


def parse_markdown_labels(text: str) -> dict[str, str]:
    """Pull (control_id -> label) out of the filled-in sheet: last cell of each identified row."""
    out: dict[str, str] = {}
    for line in text.splitlines():
        m = _MD_ROW.match(line.strip())
        if not m:
            continue
        cells = [c.strip() for c in m.group("cells").split("|")]
        ids = [_ID_CELL.fullmatch(c) for c in cells]
        hit = next((i for i in ids if i), None)
        if hit is None or not cells:
            continue
        label = normalize(cells[-1])
        if label:
            out[hit.group("id")] = label
    return out


def parse_delimited_labels(text: str, delimiter: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for row in csv.reader(text.splitlines(), delimiter=delimiter):
        if len(row) < 2 or not row[0].strip():
            continue
        cid = row[0].strip().strip("`")
        if not _ID_CELL.fullmatch(cid):
            continue  # header or stray line
        label = normalize(row[-1])
        if label:
            out[cid] = label
    return out


def load_labels(path: Path) -> dict[str, str]:
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".md":
        return parse_markdown_labels(text)
    if path.suffix.lower() == ".tsv":
        return parse_delimited_labels(text, "\t")
    return parse_delimited_labels(text, ",")


def load_scored(path: Path) -> dict[str, dict]:
    rows = [orjson.loads(line) for line in path.read_bytes().splitlines() if line]
    return {r["control_id"]: r for r in rows}


def band(kappa: float) -> str:
    """Landis & Koch's conventional bands. A description, not a gate."""
    for threshold, name in (
        (0.81, "almost perfect"),
        (0.61, "substantial"),
        (0.41, "moderate"),
        (0.21, "fair"),
        (0.01, "slight"),
    ):
        if kappa >= threshold:
            return name
    return "poor / no better than chance"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--labels", type=Path, default=DEFAULT_LABELS, help="filled-in sheet (.md/.csv/.tsv)")
    p.add_argument("--scored", type=Path, default=DEFAULT_SCORED, help="judge verdicts (jsonl)")
    args = p.parse_args(argv)

    if not args.labels.exists():
        print(f"kappa: no labels file at {args.labels}", file=sys.stderr)
        return 2
    if not args.scored.exists():
        print(
            f"kappa: no scored controls at {args.scored} — run `errata-eval judge-validate` first",
            file=sys.stderr,
        )
        return 2

    labels = load_labels(args.labels)
    scored = load_scored(args.scored)
    if not labels:
        print(f"kappa: {args.labels} has no filled-in verdicts yet", file=sys.stderr)
        return 1

    bad = {cid: v for cid, v in labels.items() if v not in VALID}
    if bad:
        for cid, v in sorted(bad.items()):
            print(f"kappa: {cid}: unrecognised label {v!r} (want CORRECT or INCORRECT)", file=sys.stderr)
        return 1
    missing = sorted(set(labels) - set(scored))
    if missing:
        print(f"kappa: {len(missing)} labelled ids are not in {args.scored}: {missing[:5]}", file=sys.stderr)
        return 1

    ids = sorted(labels)
    human = [labels[i] for i in ids]
    judge = [scored[i]["verdict"] for i in ids]
    k = cohen_kappa(human, judge)
    agree = sum(1 for a, b in zip(human, judge) if a == b)

    judge_model = next((r.get("judge_model", "") for r in scored.values()), "")
    print(f"n = {len(ids)} labelled control items; judge = {judge_model or 'unknown'}")
    print(f"raw agreement = {agree}/{len(ids)} = {agree / len(ids):.1%}")
    print(f"Cohen's kappa = {k:.3f}  ({band(k)})")
    print()
    print("                judge CORRECT   judge INCORRECT")
    for h in VALID:
        cells = [sum(1 for a, b in zip(human, judge) if a == h and b == j) for j in VALID]
        print(f"human {h:<9} {cells[0]:>11}   {cells[1]:>15}")
    disagreements = [i for i, a, b in zip(ids, human, judge) if a != b]
    if disagreements:
        print()
        print("disagreements: " + ", ".join(disagreements))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
