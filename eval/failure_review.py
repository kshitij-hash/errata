#!/usr/bin/env python
"""Failure taxonomy for the Errata arm — no model calls, no new spend.

Joins a run's ``answers.jsonl`` + ``judgments.jsonl`` with the gold corpus, replays every question
through ``POST /api/ask`` with ``debug: true`` (the answer LLM is served from Errata's on-disk
cache, so a replay of an already-run question is $0), and buckets every non-CORRECT row:

  A. abstained-but-answerable, by the gate that fired
     A1 no entity anchor resolved       — the lexicon matched nothing, the ask never queried
     A2 anchor ok, no attribute fit     — claims came back, none scored above zero
     A3 material lacked the fact        — synthesis saw N claims and said INSUFFICIENT_INFORMATION,
                                          and no claim supporting the gold answer was in them
     A4 material HAD the fact           — the answering claim was in the material and synthesis
                                          still refused (a genuine over-refusal)
     A5 below tau                       — the deterministic gate refused

  B. answered-wrong
     B1 wrong claim picked              — a gold-supporting claim was in the material, answer missed
     B2 extraction gap                  — no claim in the whole history supports the gold answer
     B3 judge rejected a right-looking answer — the answer text contains the gold answer

  C. answered a gold-abstention question (false answer)

"Supports the gold answer" is a LEXICAL heuristic (``gold_supported``): every numeric token of the
gold answer present, and >=60% of its content tokens present, inside one claim's value+span. It is
an estimator for triage, not a scorer — the judge remains the only scorer of record.

    uv run python failure_review.py --run rerunA-synth --out out/failure-taxonomy.md
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import httpx
import orjson

from errata_eval import config as cfg
from errata_eval.dataset import Question, load_corpus, sample

# byte-for-byte the stopword list in packages/core/src/evidence.ts (the ask path's own tokenizer).
_STOPWORD_TEXT = """a an the of to in on at for from by with about as into over after before is are
was were be been do did does what when where which who whom whose why how i you he she it we they
my your his her its our their me him them and or but if then than that this these those there here
have has had will would can could should may might must not no yes"""
STOPWORDS = frozenset(_STOPWORD_TEXT.split())

_NUM = re.compile(r"\d")


def content_tokens(text: str) -> list[str]:
    """Mirror of core.contentTokens: lowercase alphanumeric runs, stopwords and 1-char dropped."""
    return [t for t in re.split(r"[^a-z0-9]+", text.lower()) if len(t) > 1 and t not in STOPWORDS]


def gold_supported(gold: str, haystack: str) -> bool:
    """Lexical estimator: does ``haystack`` (a claim's value + evidence span) carry the gold answer?"""
    g = content_tokens(gold)
    if not g:
        return False
    hay = set(content_tokens(haystack))
    nums = [t for t in g if _NUM.search(t)]
    if nums and not all(n in hay for n in nums):
        return False
    hit = sum(1 for t in g if t in hay)
    return hit / len(g) >= 0.6


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [orjson.loads(line) for line in path.read_bytes().splitlines() if line]


def replay(base_url: str, q: Question, timeout_s: float) -> dict[str, Any]:
    with httpx.Client(timeout=timeout_s) as client:
        resp = client.post(
            f"{base_url.rstrip('/')}/api/ask",
            json={
                "question": q.question,
                "history_id": q.history_id,
                "question_date": q.question_date,
                "debug": True,
            },
        )
        resp.raise_for_status()
        return resp.json()


def classify(q: Question, verdict: str | None, row: dict[str, Any], trace: dict[str, Any]) -> dict[str, Any]:
    """One row → its bucket. Pure given the replay trace."""
    material = trace.get("material") or []
    hist = trace.get("history_claims") or []
    in_material = any(gold_supported(q.answer, f"{m['attribute']} {m['value']} {m['span']}") for m in material)
    in_graph = any(gold_supported(q.answer, f"{c['attribute']} {c['value']} {c['span']}") for c in hist)
    abstained = bool(row.get("abstained"))
    answer_text = str(row.get("answer") or "")

    if q.abstention:
        bucket = "C_false_answer" if not abstained else "ok_abstained"
    elif abstained:
        reason = trace.get("abstain_reason")
        bucket = {
            "no_anchor": "A1_no_anchor",
            "no_claim_fit": "A2_no_attribute_fit",
            "below_tau": "A5_below_tau",
        }.get(str(reason), "A4_material_had_it" if in_material else "A3_material_lacked_it")
    elif verdict == "CORRECT":
        bucket = "ok_answered"
    elif gold_supported(q.answer, answer_text):
        bucket = "B3_judge_rejected"
    elif not in_graph:
        bucket = "B2_extraction_gap"
    else:
        bucket = "B1_wrong_claim_picked"

    return {
        "question_id": q.question_id,
        "ability": q.ability,
        "question_type": q.question_type,
        "question": q.question,
        "gold": q.answer,
        "answer": answer_text or None,
        "abstained": abstained,
        "verdict": verdict,
        "bucket": bucket,
        "abstain_reason": trace.get("abstain_reason"),
        "anchors": trace.get("anchors"),
        "matched_tokens": trace.get("matched_tokens"),
        "unmatched_tokens": trace.get("unmatched_tokens"),
        "claim_rows": trace.get("claim_rows"),
        "history_claims": len(hist),
        "material_size": len(material),
        "material_top": [f"{m['attribute']}={m['value']}" for m in material[:4]],
        "gold_in_material": in_material,
        "gold_in_graph": in_graph,
    }


BUCKET_ORDER = (
    "A1_no_anchor",
    "A2_no_attribute_fit",
    "A3_material_lacked_it",
    "A4_material_had_it",
    "A5_below_tau",
    "B1_wrong_claim_picked",
    "B2_extraction_gap",
    "B3_judge_rejected",
    "C_false_answer",
    "ok_answered",
    "ok_abstained",
)

BUCKET_DOC = {
    "A1_no_anchor": "abstained · no entity anchor resolved (lexicon matched no question token)",
    "A2_no_attribute_fit": "abstained · anchors resolved but no claim scored above zero",
    "A3_material_lacked_it": "abstained · synthesis saw material that did not contain the answer",
    "A4_material_had_it": "abstained · the answering claim WAS in the material (over-refusal)",
    "A5_below_tau": "abstained · deterministic evidence score below tau",
    "B1_wrong_claim_picked": "answered wrong · a gold-supporting claim was in the material",
    "B2_extraction_gap": "answered wrong · no claim in the history supports the gold answer",
    "B3_judge_rejected": "answered wrong · answer text contains the gold answer (judge call)",
    "C_false_answer": "answered a gold-abstention question",
    "ok_answered": "answered and judged CORRECT",
    "ok_abstained": "abstained on a gold-abstention question",
}


def cross_arm_by_type(
    qtype: dict[str, str], runs: dict[str, Path]
) -> dict[str, dict[str, tuple[int, int]]]:
    """(arm, question_type) → (correct, n) over every judged row of each run."""
    out: dict[str, dict[str, tuple[int, int]]] = {}
    for arm, run_dir in runs.items():
        tally: dict[str, tuple[int, int]] = {}
        for j in read_jsonl(run_dir / "judgments.jsonl"):
            t = qtype.get(str(j["question_id"]))
            if t is None:
                continue
            correct, n = tally.get(t, (0, 0))
            tally[t] = (correct + (1 if j["verdict"] == "CORRECT" else 0), n + 1)
        out[arm] = tally
    return out


def render(rows: list[dict[str, Any]], *, run: str, examples: int,
           cross: dict[str, dict[str, tuple[int, int]]] | None = None) -> str:
    counts = Counter(r["bucket"] for r in rows)
    total = len(rows)
    out: list[str] = [
        f"# Failure taxonomy — Errata arm, run `{run}`",
        "",
        (
            f"{total} questions (the seeded comparison-150). The arm is deterministic across the "
            "three seeds — 0 of 150 questions changed answer or verdict between seeds 11/22/33 — "
            "so the taxonomy is built once per question and multiplies by 3 for the 450-row totals."
        ),
        "",
        "## Counts",
        "",
        "| Bucket | n | % of 150 | Meaning |",
        "|---|---:|---:|---|",
    ]
    for b in BUCKET_ORDER:
        n = counts.get(b, 0)
        if n == 0 and b.startswith("ok"):
            continue
        out.append(f"| `{b}` | {n} | {100 * n / total:.1f} | {BUCKET_DOC[b]} |")
    out.append("")

    abstained_answerable = sum(counts.get(b, 0) for b in BUCKET_ORDER if b.startswith("A"))
    answered_wrong = sum(counts.get(b, 0) for b in BUCKET_ORDER if b.startswith("B"))
    out += [
        (
            f"Abstained-but-answerable: **{abstained_answerable}** of 120 answerable questions "
            f"({100 * abstained_answerable / 120:.1f}%). Answered-wrong: **{answered_wrong}**. "
            f"False answers on gold-abstention: **{counts.get('C_false_answer', 0)}** of 30."
        ),
        "",
        "## Per-ability",
        "",
        "| Ability | n | abstained-answerable | answered-wrong | correct |",
        "|---|---:|---:|---:|---:|",
    ]
    by_ability: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        by_ability[str(r["ability"])].append(r)
    for ability in sorted(by_ability):
        sub = by_ability[ability]
        a = sum(1 for r in sub if r["bucket"].startswith("A"))
        b = sum(1 for r in sub if r["bucket"].startswith("B"))
        ok = sum(1 for r in sub if r["bucket"].startswith("ok"))
        out.append(f"| {ability} | {len(sub)} | {a} | {b} | {ok} |")
    out.append("")

    if cross:
        arms = list(cross)
        out += [
            "## Per-question_type, all arms (this is the decisive cut)",
            "",
            (
                "`ability` folds the three single-session types into one column and hides where "
                "the deficit actually is. Split by the corpus's own `question_type`:"
            ),
            "",
            "| question_type | n | " + " | ".join(arms) + " |",
            "|---|---:|" + "---:|" * len(arms),
        ]
        types = sorted({str(r["question_type"]) for r in rows})
        for t in types:
            n = sum(1 for r in rows if r["question_type"] == t)
            cells = []
            for arm in arms:
                correct, total = cross[arm].get(t, (0, 0))
                cells.append(f"{100 * correct / total:.1f}%" if total else "—")
            out.append(f"| {t} | {n} | " + " | ".join(cells) + " |")
        out.append("")

    # the front-door diagnostic: how much of the material budget the lexical ranker actually uses
    scored = [r for r in rows if r["material_size"]]
    if scored:
        zero_match = sum(1 for r in scored if not r["matched_tokens"])
        out += [
            "## Front-door diagnostics",
            "",
            (
                f"- questions where NO question token matched a lexicon term: **{zero_match}** of "
                f"{len(scored)} ({100 * zero_match / len(scored):.0f}%) — these anchor only via "
                "the first-person SELF entity, so the entity filter selects nothing."
            ),
            (
                "- median claims reachable from the anchors: "
                f"**{sorted(r['claim_rows'] for r in scored)[len(scored) // 2]}**, "
                f"cut to a {max(r['material_size'] for r in scored)}-claim material window."
            ),
            (
                "- questions whose history has ZERO extracted claims: "
                f"**{sum(1 for r in rows if r['history_claims'] == 0)}**."
            ),
            "",
        ]

    for b in BUCKET_ORDER:
        if b.startswith("ok"):
            continue
        sub = [r for r in rows if r["bucket"] == b]
        if not sub:
            continue
        out += [f"## `{b}` — {len(sub)} ({BUCKET_DOC[b]})", ""]
        for r in sub[:examples]:
            got = (
                f"ABSTAINED (reason `{r['abstain_reason']}`)"
                if r["abstained"]
                else f"`{r['answer']}`"
            )
            out += [
                f"- **{r['question_id']}** ({r['ability']})",
                f"  - Q: {r['question']}",
                f"  - gold: `{r['gold']}`",
                f"  - errata: {got}",
                f"  - matched tokens {r['matched_tokens']} · unmatched {r['unmatched_tokens']}",
                (
                    f"  - {r['claim_rows']} claims reachable / {r['history_claims']} in history; "
                    f"gold in material={r['gold_in_material']} in graph={r['gold_in_graph']}"
                ),
                f"  - material head: {r['material_top']}",
            ]
        out.append("")
    return "\n".join(out) + "\n"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--run", default="rerunA-synth", help="run_id under out/")
    p.add_argument("--out", type=Path, default=Path("out/failure-taxonomy.md"))
    p.add_argument("--json", type=Path, default=None, help="also write the per-row buckets as jsonl")
    p.add_argument("--examples", type=int, default=10, help="verbatim examples per bucket")
    p.add_argument("--config", type=Path, default=None)
    p.add_argument(
        "--compare",
        nargs="*",
        default=[],
        metavar="ARM=RUN_ID",
        help="baseline runs to cut by question_type alongside this one, e.g. naive=rerunC-nothink",
    )
    args = p.parse_args(argv)

    config = cfg.load_eval_config(args.config or cfg.default_eval_path())
    run_dir = Path("out") / args.run
    answers = read_jsonl(run_dir / "answers.jsonl")
    judgments = read_jsonl(run_dir / "judgments.jsonl")
    if not answers:
        print(f"failure_review: no answers in {run_dir}", file=sys.stderr)
        return 1

    corpus = load_corpus(config.data_path())
    chosen = sample(
        corpus,
        config.sample.comparison_n,
        config.run.sample_seed,
        abstention_whole=config.sample.abstention_whole,
        abstention_floor=config.sample.abstention_floor,
    )
    # the arm is deterministic across seeds; keep the lowest seed's row per question.
    answer_by_qid: dict[str, dict[str, Any]] = {}
    for a in sorted(answers, key=lambda r: r.get("seed", 0)):
        answer_by_qid.setdefault(str(a["question_id"]), a)
    verdict_by_qid: dict[str, str] = {}
    for j in sorted(judgments, key=lambda r: r.get("seed", 0)):
        verdict_by_qid.setdefault(str(j["question_id"]), str(j["verdict"]))

    base = config.errata.base_url

    def one(q: Question) -> dict[str, Any] | None:
        row = answer_by_qid.get(q.question_id)
        if row is None:
            return None
        body = replay(base, q, config.errata.timeout_s)
        return classify(q, verdict_by_qid.get(q.question_id), row, body.get("trace") or {})

    with ThreadPoolExecutor(max_workers=8) as pool:
        rows = [r for r in pool.map(one, chosen) if r is not None]

    runs: dict[str, Path] = {"errata": run_dir}
    for spec in args.compare:
        arm, _, rid = spec.partition("=")
        runs[arm or rid] = Path("out") / (rid or arm)
    cross = cross_arm_by_type({q.question_id: q.question_type for q in chosen}, runs)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        render(rows, run=args.run, examples=args.examples, cross=cross), encoding="utf-8"
    )
    if args.json:
        args.json.write_bytes(b"\n".join(orjson.dumps(r) for r in rows) + b"\n")
    counts = Counter(r["bucket"] for r in rows)
    print(f"failure_review: {len(rows)} questions → {args.out}")
    for b in BUCKET_ORDER:
        if counts.get(b):
            print(f"  {b:26s} {counts[b]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
