"""Out-of-sample sanity holdout on the 20 ingested canary histories.

The comparison set is 150 questions drawn at `sample_seed`. Twenty MORE histories were ingested
as canaries and never scored (RESULTS.md, "The full-500 run, priced and declined"). Their
questions are therefore genuinely out of sample: the graph holds them, nothing was tuned on them,
and no number published anywhere has seen them. This runs the Errata arm over exactly those and
judges the answers with the pinned judge.

READ THE DISCLOSURE BEFORE QUOTING THE NUMBER. The canary draw was the FIRST twenty histories in
corpus order, and the corpus is ordered by question type, so all twenty are `single-session-user`
— the easiest stratum, and the one Errata already scores 100% on inside the comparison set. None
is a gold-abstention question. This is a confirm-only check: it can detect a gross regression
(ingest silently broken, wrong history wired up, contract drift) and it cannot support any claim
about accuracy on the corpus as a whole. It is not a held-out test set and must never be
presented as one.

`errata-eval run` has no flag for a custom question subset — `--set` picks from {comparison,
full, smoke} and re-derives the draw from the config seed — so this drives `errata_eval.arms`
and `errata_eval.judge` directly rather than reaching for a config edit that would move the
comparison draw itself.

Spend: the Errata arm is answered by the API process against ITS key (v2 synthesis) and lands in
the API's ledger. What THIS process pays for is the judge — one call per non-abstention question.
Both are capped below and by eval.toml's own hard cap.

Usage:  uv run python holdout.py [--out out/holdout-canary] [--cap-usd 0.10] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import httpx
import orjson

from errata_eval import config as cfg
from errata_eval.arms import ErrataArm
from errata_eval.dataset import load_corpus
from errata_eval.judge import judge_run
from errata_eval.openrouter import Ledger, OpenRouterClient

_EVAL = Path(__file__).resolve().parent
SAMPLE_PATH = _EVAL / "sample-150.json"

# The demo histories are ingested too but are not corpus questions; they are not holdout material.
DEMO_HISTORIES = {"852ce960", "852ce960-clean"}


def holdout_ids(base_url: str, timeout_s: float = 30.0) -> list[str]:
    """Ingested histories that are not in the comparison draw and not the demo.

    The ingest manifest is the API's own view (`/api/meta.ingested_history_ids`, which lists the
    built lexicons), so this cannot drift from what the graph actually holds.
    """
    meta = httpx.get(f"{base_url}/api/meta", timeout=timeout_s).json()
    ingested = set(meta["ingested_history_ids"])
    sample = set(json.loads(SAMPLE_PATH.read_bytes()))
    return sorted(ingested - sample - DEMO_HISTORIES)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", default=None)
    ap.add_argument("--out", default=str(_EVAL / "out" / "holdout-canary"))
    ap.add_argument("--cap-usd", type=float, default=0.10, help="abort if judge spend exceeds this")
    ap.add_argument("--seed", type=int, default=None, help="defaults to the first configured seed")
    ap.add_argument("--dry-run", action="store_true", help="resolve the question set and stop")
    args = ap.parse_args()

    config = cfg.load_eval_config(Path(args.config) if args.config else cfg.default_eval_path())
    seed = args.seed if args.seed is not None else config.run.seeds[0]

    ids = holdout_ids(config.errata.base_url, config.errata.timeout_s)
    corpus = {q.question_id: q for q in load_corpus(config.data_path())}
    missing = [i for i in ids if i not in corpus]
    if missing:
        print(f"holdout: {len(missing)} ingested ids are not corpus questions: {missing}", file=sys.stderr)
    questions = [corpus[i] for i in ids if i in corpus]

    types = sorted({q.question_type for q in questions})
    n_abs = sum(1 for q in questions if q.abstention)
    print(f"holdout: {len(questions)} out-of-sample questions; types={types}; gold-abstention={n_abs}")
    if args.dry_run:
        for q in questions:
            print(f"  {q.question_id}  {q.question_type}")
        return 0

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Answering costs the API's key, so a complete previous pass is reused rather than repeated.
    answers_path = out_dir / "answers.jsonl"
    cached = []
    if answers_path.exists():
        cached = [orjson.loads(b) for b in answers_path.read_bytes().splitlines() if b.strip()]
    if {r.get("question_id") for r in cached} == {q.question_id for q in questions}:
        print(f"holdout: reusing {len(cached)} answers from {answers_path}")
        answers = cached
    else:
        arm = ErrataArm(
            config.errata.base_url,
            config.errata.ask_path,
            timeout_s=config.errata.timeout_s,
            send_question_date=config.errata.send_question_date,
        )
        answers = []
        for i, q in enumerate(questions, 1):
            row = arm.answer(q, seed=seed)
            answers.append(row)
            state = "ABSTAIN" if row.get("abstained") else "answer "
            print(f"  [{i:2d}/{len(questions)}] {q.question_id} {state} {str(row.get('answer'))[:60]!r}")
        answers_path.write_bytes(b"".join(orjson.dumps(r) + b"\n" for r in answers))

    ledger = Ledger(
        Path(config.spend.ledger_path),
        warn_at_usd=config.spend.warn_at_usd,
        hard_cap_usd=config.spend.hard_cap_usd,
        run_id="holdout-canary",
    )
    client = OpenRouterClient(
        cfg.load_prices(cfg.default_prices_path()), ledger, run_id="holdout-canary",
        cache_dir=str(_EVAL / "out" / "llm-cache"),
    )
    gold = {
        q.question_id: {"question": q.question, "answer": q.answer, "is_abstention": q.abstention}
        for q in questions
    }
    judgments = judge_run(
        client, config.models.judge_primary, answers,
        gold_by_qid=gold, shuffle_seed=config.run.sample_seed,
        temperature=config.generation.judge_temperature,
        max_tokens=config.generation.judge_max_tokens,
    )
    (out_dir / "judgments.jsonl").write_bytes(b"".join(orjson.dumps(r) + b"\n" for r in judgments))

    spend = sum(float(j.get("usd") or 0.0) for j in judgments)
    correct = sum(1 for j in judgments if j["verdict"] == "CORRECT")
    print(f"\nholdout: {correct}/{len(judgments)} CORRECT  (judge spend ${spend:.4f})")
    for j in judgments:
        if j["verdict"] != "CORRECT":
            print(f"  {j['verdict']:12s} {j['question_id']}  {j['reason'][:90]}")
    if spend > args.cap_usd:
        print(f"holdout: judge spend ${spend:.4f} EXCEEDED the ${args.cap_usd:.2f} cap", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
