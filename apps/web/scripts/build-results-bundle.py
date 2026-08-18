"""Derive the /results static bundle from the corpus + the eval run artifacts.

Read-only over data-raw/ and eval/; writes exactly one file, apps/web/data/results.json.
No network, no LLM, nothing under eval/ is modified.

Every aggregate the web page prints is recomputed in apps/web/lib/results.ts from the rows in
this bundle, and apps/web/lib/results.spec.ts asserts those aggregates against the README
NUMBERS BLOCK. This script therefore ships ROWS, not scores — except for the rejected-experiment
runs, whose rows are not bundled and whose published aggregates are computed here.
"""

from __future__ import annotations

import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

import orjson

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "apps/web/data/results.json"
INSUFFICIENT = "INSUFFICIENT_INFORMATION"

ABILITY_BY_TYPE = {
    "single-session-user": "information_extraction",
    "single-session-assistant": "information_extraction",
    "single-session-preference": "information_extraction",
    "multi-session": "multi_session",
    "temporal-reasoning": "temporal",
    "knowledge-update": "knowledge_update",
}

RUNS = {
    "errata": "rerunJ-arith",
    "full_context": "rerunB-nothink",
    "naive": "rerunC-nothink",
}
SEEDS = (11, 22, 33)


def clip(s: str | None, n: int) -> str:
    s = (s or "").strip()
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def read_jsonl(path: Path):
    with open(path, "rb") as f:
        for line in f:
            line = line.strip()
            if line:
                yield orjson.loads(line)


def load_run(run: str):
    answers: dict[int, dict[str, dict]] = defaultdict(dict)
    judgments: dict[int, dict[str, dict]] = defaultdict(dict)
    for r in read_jsonl(ROOT / f"eval/out/{run}/answers.jsonl"):
        answers[r["seed"]][r["question_id"]] = r
    for r in read_jsonl(ROOT / f"eval/out/{run}/judgments.jsonl"):
        judgments[r["seed"]][r["question_id"]] = r
    return answers, judgments


def errata_summary(run: str, questions: dict) -> dict:
    """all-450 / answered / answered-precision / ctx tokens for an Errata-arm run."""
    answers, judgments = load_run(run)
    total = answered = correct_answered = 0
    for seed in SEEDS:
        for qid, q in questions.items():
            row = answers[seed][qid]
            abstained = bool(row.get("abstained"))
            verdict = (judgments[seed].get(qid) or {}).get("verdict")
            if not abstained:
                answered += 1
                if verdict == "CORRECT":
                    correct_answered += 1
            if q["abstention"]:
                total += 1 if abstained else 0
            elif verdict == "CORRECT":
                total += 1
    tokens = statistics.mean(
        float(answers[SEEDS[0]][qid].get("prompt_tokens") or 0) for qid in questions
    )
    return {
        "all450": round(100 * total / (3 * len(questions)), 1),
        "answered": answered,
        "answered_prec": round(100 * correct_answered / answered, 1),
        "ctx_tok": round(tokens),
    }


def main() -> int:
    ids = set(json.loads((ROOT / "eval/sample-150.json").read_text()))

    with open(ROOT / "data-raw/longmemeval_s_cleaned.json", "rb") as f:
        corpus = orjson.loads(f.read())

    questions: dict[str, dict] = {}
    for raw in corpus:
        qid = raw["question_id"]
        if qid not in ids:
            continue
        abstention = qid.endswith("_abs")
        questions[qid] = {
            "id": qid,
            "type": raw["question_type"],
            "ability": "abstention" if abstention else ABILITY_BY_TYPE[raw["question_type"]],
            "abstention": abstention,
            "question": clip(raw["question"], 400),
            "gold": clip(str(raw["answer"]), 700),
            "date": raw["question_date"],
        }
    del corpus
    if set(questions) != ids:
        print(f"MISSING from corpus: {sorted(ids - set(questions))}")
        return 1

    # ---- the three arms of record, row by row -----------------------------------------
    arms: dict[str, dict] = {}
    for arm, run in RUNS.items():
        answers, judgments = load_run(run)
        rows = {}
        for qid in questions:
            first = answers[SEEDS[0]].get(qid)
            if first is None:
                print(f"MISSING answer {arm} {qid}")
                return 1
            texts = [answers[s].get(qid, {}).get("answer") or "" for s in SEEDS]
            verdicts = [(judgments[s].get(qid) or {}).get("verdict") for s in SEEDS]
            abstained = [
                bool(answers[s].get(qid, {}).get("abstained"))
                if arm == "errata"
                else str(answers[s].get(qid, {}).get("answer") or "")
                .lstrip()
                .startswith(INSUFFICIENT)
                for s in SEEDS
            ]
            row: dict = {
                "answer": clip(texts[0], 700),
                "abstained": abstained,
                "verdicts": verdicts,
                "reason": clip((judgments[SEEDS[0]].get(qid) or {}).get("reason"), 220),
                "tok": int(first.get("prompt_tokens") or 0),
            }
            if any(t != texts[0] for t in texts[1:]):
                row["seed_variants"] = [clip(t, 300) for t in texts[1:]]
            cites = [
                {"s": c.get("session_id"), "t": c.get("turn_index"), "q": clip(c.get("span"), 220)}
                for c in (first.get("citations") or [])[:4]
            ]
            if cites:
                row["cites"] = cites
            if first.get("confidence") is not None:
                row["conf"] = round(float(first["confidence"]), 4)
            rows[qid] = row
        arms[arm] = {"run": run, "rows": rows}

    # ---- the Errata waves, including the two rejected ones ------------------------------
    experiments = {
        run: errata_summary(run, questions)
        for run in ("rerunF-wave", "rerunG-max45", "rerunH-typed", "rerunI-restored", "rerunJ-arith")
    }

    # ---- rerunF-wave → rerunJ-arith: which answers moved, and which way -----------------
    f_ans, f_jud = load_run("rerunF-wave")
    j_ans, j_jud = load_run("rerunJ-arith")
    changed = sorted(
        qid
        for qid in questions
        if any(f_ans[s][qid].get("answer") != j_ans[s][qid].get("answer") for s in SEEDS)
    )
    arith_diff = [
        {
            "id": qid,
            "before": clip(f_ans[SEEDS[0]][qid].get("answer"), 200),
            "after": clip(j_ans[SEEDS[0]][qid].get("answer"), 200),
            "verdict_before": (f_jud[SEEDS[0]].get(qid) or {}).get("verdict"),
            "verdict_after": (j_jud[SEEDS[0]].get(qid) or {}).get("verdict"),
        }
        for qid in changed
    ]
    i_ans, _ = load_run("rerunI-restored")
    revert_diff_rows = sum(
        1 for s in SEEDS for qid in questions if f_ans[s][qid].get("answer") != i_ans[s][qid].get("answer")
    )

    # ---- the judge control set (committed evidence behind FAR / FRR) --------------------
    scored = {r["control_id"]: r for r in read_jsonl(ROOT / "eval/out/judge-controls-scored.jsonl")}
    controls = []
    for path, kind in (
        (ROOT / "eval/judge-controls.jsonl", "perturbed"),
        (ROOT / "eval/judge-controls-positive.jsonl", "positive"),
    ):
        for r in read_jsonl(path):
            cid = f"{kind}:{r['question_id']}"
            s = scored.get(cid)
            if s is None:
                print(f"MISSING scored control {cid}")
                return 1
            controls.append(
                {
                    "id": r["question_id"],
                    "kind": kind,
                    "family": r.get("family") or "",
                    "verdict": s["verdict"],
                    "question": clip(r["question"], 300),
                    "gold": clip(str(r["gold_answer"]), 320),
                    "answer": clip(str(r["answer"]), 320),
                    "transform": (r.get("provenance") or {}).get("transform", ""),
                }
            )

    bundle = {
        "provenance": {
            "note": "Derived from the eval run artifacts and the pinned corpus. Rows are verbatim; every score on the page is recomputed from these rows in the browser-free build step.",
            "dataset": {
                "repo_id": "xiaowu0162/longmemeval-cleaned",
                "revision": "98d7416c24c778c2fee6e6f3006e7a073259d48f",
                "file": "longmemeval_s_cleaned.json",
                "sha256": "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442",
            },
            "sample": "eval/sample-150.json · sample_seed=20260819 · all 30 abstention questions",
            "seeds": list(SEEDS),
            "runs": RUNS,
            "answer_model": "qwen/qwen3.7-flash",
            "answer_prompt_sha": "a1ea7ee7…",
            "judge_model": "anthropic/claude-sonnet-5",
            "judge_prompt_sha": "07286ad6…",
        },
        "questions": list(questions.values()),
        "arms": arms,
        "experiments": experiments,
        "arith_diff": arith_diff,
        "revert_diff_rows": revert_diff_rows,
        "judge_controls": controls,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(orjson.dumps(bundle))
    print(json.dumps(experiments, indent=1))
    print(f"arith_diff {len(arith_diff)} · revert diff rows {revert_diff_rows} · controls {len(controls)}")
    print(f"wrote {OUT} — {OUT.stat().st_size / 1024:.0f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
