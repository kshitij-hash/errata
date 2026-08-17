"""errata-eval command line.

Subcommands: sample, parity, estimate, run, judge, report, and the judge-validation trio
(controls, controls-positive, judge-validate).

The parity gate (``parity``) is the load-bearing safety check: it asserts the deployed API's
answer prompt sha and answer model match ours BEFORE any spend, exiting non-zero on mismatch.
``check_parity`` is a pure function so it can be unit-tested against a mocked /api/meta payload.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import orjson

from . import config as cfg
from .dataset import Question, load_corpus, sample, verify_checksum
from .prompts import ANSWER_PROMPT_SHA256
from .report import ArmReport, render_caption, write_report

EXIT_PARITY_MISMATCH = 4
EXIT_DATASET = 2
EXIT_GATE_FAILED = 6

# Deterministic passes (control generation, control scoring) replay from here at $0. Under out/,
# which is gitignored: a cache is a local accelerator, never an artifact of record.
DEFAULT_LLM_CACHE_DIR = "out/llm-cache"


def _cache_dir(args: argparse.Namespace) -> str | None:
    """Resolve --cache-dir: absent => the default cache, empty string => no cache at all."""
    if args.cache_dir is None:
        return DEFAULT_LLM_CACHE_DIR
    return args.cache_dir or None


# --------------------------------------------------------------------------------------------
# parity (pure core + CLI wrapper)
# --------------------------------------------------------------------------------------------
def check_parity(
    meta: Mapping[str, Any],
    *,
    answer_prompt_sha: str,
    expected_answer_model: str,
) -> tuple[bool, list[str]]:
    """Return (ok, problems). Compares /api/meta against our prompt sha and configured model."""
    problems: list[str] = []
    got_sha = meta.get("answer_prompt_sha256")
    if got_sha != answer_prompt_sha:
        problems.append(
            f"answer_prompt_sha256 mismatch: api={got_sha!r} ours={answer_prompt_sha!r}"
        )
    got_model = meta.get("answer_model")
    if got_model != expected_answer_model:
        problems.append(
            f"answer_model mismatch: api={got_model!r} config={expected_answer_model!r}"
        )
    return (not problems), problems


def _load_config(args: argparse.Namespace) -> cfg.EvalConfig:
    path = args.config or cfg.default_eval_path()
    return cfg.load_eval_config(path)


def _load_sample(config: cfg.EvalConfig, n: int, seed: int, *, verify: bool = False) -> list[Question]:
    path = config.data_path()
    if verify:
        verify_checksum(path, config.dataset.sha256)
    corpus = load_corpus(path)
    return sample(
        corpus,
        n,
        seed,
        abstention_whole=config.sample.abstention_whole,
        abstention_floor=config.sample.abstention_floor,
    )


# --------------------------------------------------------------------------------------------
# sample
# --------------------------------------------------------------------------------------------
def cmd_sample(args: argparse.Namespace) -> int:
    config = _load_config(args)
    n = args.n or config.sample.comparison_n
    seed = args.seed if args.seed is not None else config.run.sample_seed
    chosen = _load_sample(config, n, seed)
    ids = [q.question_id for q in chosen]
    if args.out:
        # The ingest-coupling artifact: a plain JSON array of question_ids, sorted, so the
        # ingest job and every arm answer exactly this seeded comparison set.
        out_path = Path(args.out)
        out_path.write_bytes(orjson.dumps(ids, option=orjson.OPT_INDENT_2) + b"\n")
        n_abs = sum(1 for q in chosen if q.abstention)
        print(f"wrote {len(ids)} question_ids ({n_abs} abstention, seed={seed}) to {out_path}")
    elif args.print_ids:
        for qid in ids:
            print(qid)
    else:
        n_abs = sum(1 for q in chosen if q.abstention)
        print(f"sampled {len(chosen)} questions (seed={seed}); {n_abs} abstention")
    return 0


# --------------------------------------------------------------------------------------------
# parity
# --------------------------------------------------------------------------------------------
def cmd_parity(args: argparse.Namespace) -> int:
    import httpx

    config = _load_config(args)
    url = config.errata.base_url.rstrip("/") + config.errata.meta_path
    try:
        resp = httpx.get(url, timeout=config.errata.timeout_s)
        resp.raise_for_status()
        meta = resp.json()
    except httpx.HTTPError as exc:
        print(f"parity: could not reach {url}: {exc}", file=sys.stderr)
        return EXIT_PARITY_MISMATCH
    ok, problems = check_parity(
        meta,
        answer_prompt_sha=ANSWER_PROMPT_SHA256,
        expected_answer_model=config.models.answer,
    )
    if ok:
        print(f"parity OK: answer_model={config.models.answer} prompt_sha={ANSWER_PROMPT_SHA256[:8]}…")
        return 0
    for p in problems:
        print(f"parity MISMATCH: {p}", file=sys.stderr)
    print("aborting before any spend (exit 4)", file=sys.stderr)
    return EXIT_PARITY_MISMATCH


# --------------------------------------------------------------------------------------------
# run
# --------------------------------------------------------------------------------------------
def _run_id(config: cfg.EvalConfig) -> str:
    return config.run.run_id or datetime.now(UTC).strftime("%Y%m%dT%H%MZ")


def _completed_keys(path: Path) -> set[tuple[str, int, str]]:
    done: set[tuple[str, int, str]] = set()
    if not path.exists():
        return done
    for line in path.read_bytes().splitlines():
        if not line:
            continue
        row = orjson.loads(line)
        if row.get("status") in ("ok", 200):
            done.add((row.get("arm"), row.get("seed"), row.get("question_id")))
    return done


def cmd_run(args: argparse.Namespace) -> int:
    config = _load_config(args)
    run_id = args.run_id or _run_id(config)
    seeds = [int(s) for s in args.seeds.split(",")] if args.seeds else config.run.seeds
    n = (
        config.sample.full_n
        if args.set == "full"
        else config.sample.smoke_n
        if args.set == "smoke"
        else config.sample.comparison_n
    )
    chosen = _load_sample(config, n, config.run.sample_seed, verify=args.verify)

    out_dir = Path("out") / run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    answers_path = out_dir / "answers.jsonl"
    done = _completed_keys(answers_path) if args.resume else set()

    arm = _build_arm(args.arm, config)
    written = 0
    empty_streak = 0
    with open(answers_path, "ab") as fh:
        for seed in seeds:
            for q in chosen:
                if (args.arm, seed, q.question_id) in done:
                    continue
                row = arm.answer(q, seed=seed)
                # circuit breaker: a paid arm producing empty answers is burning budget on garbage
                # (a thinking model once spent the whole max_tokens on reasoning — 448/450 empty
                # answers, ~$6 wasted). Three consecutive empties aborts the arm BEFORE scale.
                if not row.get("abstained") and not str(row.get("answer") or "").strip():
                    empty_streak += 1
                    if empty_streak >= 3:
                        print(
                            f"run {run_id}: ABORT — {empty_streak} consecutive empty answers "
                            f"from arm={args.arm}; fix the arm before spending more",
                            file=sys.stderr,
                        )
                        return 5
                else:
                    empty_streak = 0
                fh.write(orjson.dumps(row))
                fh.write(b"\n")
                written += 1
    print(f"run {run_id}: arm={args.arm} wrote {written} rows to {answers_path}")
    return 0


def _build_arm(arm_name: str, config: cfg.EvalConfig) -> Any:
    from .arms import ErrataArm

    if arm_name == "errata":
        return ErrataArm(
            config.errata.base_url,
            config.errata.ask_path,
            timeout_s=config.errata.timeout_s,
            send_question_date=config.errata.send_question_date,
        )
    # credit-gated arms need OpenRouter + (for naive) the local index.
    from .arms import FullContextArm, NaiveTopKArm
    from .openrouter import Ledger, OpenRouterClient

    ledger = Ledger(
        Path(config.spend.ledger_path),
        warn_at_usd=config.spend.warn_at_usd,
        hard_cap_usd=config.spend.hard_cap_usd,
        run_id=config.run.run_id,
    )
    client = OpenRouterClient(
        cfg.load_prices(cfg.default_prices_path()), ledger, run_id=config.run.run_id
    )
    gen = config.generation
    if arm_name == "full_context":
        return FullContextArm(
            client,
            config.models.answer,
            temperature=gen.answer_temperature,
            max_tokens=gen.answer_max_tokens,
        )
    if arm_name == "naive":
        from .retrieval import Encoder, SessionIndex

        index = SessionIndex(
            Encoder(config.models.embedder),
            max_chars=config.naive_topk.chunk_max_chars,
            overlap_chars=config.naive_topk.chunk_overlap_chars,
            prepend_date=config.naive_topk.prepend_session_date,
        )
        return NaiveTopKArm(
            client,
            config.models.answer,
            index,
            k=config.naive_topk.k,
            temperature=gen.answer_temperature,
            max_tokens=gen.answer_max_tokens,
        )
    raise ValueError(f"unknown arm {arm_name!r}")


# --------------------------------------------------------------------------------------------
# estimate — pre-run cost projection
# --------------------------------------------------------------------------------------------
EXIT_OVER_CAP = 3


def _default_sample_path() -> Path:
    return cfg.repo_root() / "eval" / "sample-150.json"


def cmd_estimate(args: argparse.Namespace) -> int:
    from .estimate import estimate_cost, render_estimate

    config = _load_config(args)
    prices = cfg.load_prices(args.prices or cfg.default_prices_path())
    sample_path = args.sample or _default_sample_path()
    sample_ids = orjson.loads(Path(sample_path).read_bytes())

    est = estimate_cost(sample_ids=sample_ids, config=config, prices=prices)
    print(render_estimate(est, hard_cap=config.spend.hard_cap_usd, already_spent=args.already_spent))
    if est.projected_usd + args.already_spent > config.spend.hard_cap_usd:
        print(
            f"estimate: projected + already_spent exceeds hard cap "
            f"${config.spend.hard_cap_usd:.2f} — aborting (exit {EXIT_OVER_CAP})",
            file=sys.stderr,
        )
        return EXIT_OVER_CAP
    return 0


# --------------------------------------------------------------------------------------------
# controls — the two halves of the judge-control set
# --------------------------------------------------------------------------------------------
def _eval_dir() -> Path:
    return cfg.repo_root() / "eval"


def default_negative_controls_path() -> Path:
    return _eval_dir() / "judge-controls.jsonl"


def default_positive_controls_path() -> Path:
    return _eval_dir() / "judge-controls-positive.jsonl"


def _write_rows(path: Path, rows: list[dict[str, Any]]) -> None:
    with open(path, "wb") as fh:
        for row in rows:
            fh.write(orjson.dumps(row))
            fh.write(b"\n")


def cmd_controls(args: argparse.Namespace) -> int:
    from .judge_validation import CONTROL_SEED, build_negative_controls

    config = _load_config(args)
    corpus = load_corpus(config.data_path())
    seed = args.seed if args.seed is not None else CONTROL_SEED
    items = build_negative_controls(corpus, seed=seed)

    out_path = Path(args.out) if args.out else default_negative_controls_path()
    _write_rows(out_path, [item.to_row() for item in items])
    fams = sorted({item.family for item in items})
    print(f"wrote {len(items)} negative controls ({len(fams)} families, seed={seed}) to {out_path}")
    return 0


def cmd_controls_positive(args: argparse.Namespace) -> int:
    """Generate the paraphrased-gold POSITIVE controls. The one paid pass in the eval protocol, and cached."""
    from .judge_validation import build_positive_controls
    from .openrouter import Ledger, OpenRouterClient

    config = _load_config(args)
    corpus = load_corpus(config.data_path())
    jv = config.judge_validation
    ledger = Ledger(
        Path(config.spend.ledger_path),
        warn_at_usd=config.spend.warn_at_usd,
        hard_cap_usd=config.spend.hard_cap_usd,
        run_id=config.run.run_id,
    )
    client = OpenRouterClient(
        cfg.load_prices(cfg.default_prices_path()),
        ledger,
        run_id=config.run.run_id,
        cache_dir=_cache_dir(args),
    )
    try:
        items = build_positive_controls(
            corpus,
            client,
            config.models.perturber,
            n=args.n or jv.n,
            seed=jv.validation_seed,
        )
    finally:
        client.close()
        ledger.flush()
    out_path = Path(args.out) if args.out else default_positive_controls_path()
    _write_rows(out_path, [item.to_row() for item in items])
    print(
        f"wrote {len(items)} positive controls (perturber={config.models.perturber}, "
        f"seed={jv.validation_seed}) to {out_path}; ledger +${ledger.total_usd:.4f}"
    )
    ledger.close()
    return 0


# --------------------------------------------------------------------------------------------
# judge-validate
# --------------------------------------------------------------------------------------------
def cmd_judge_validate(args: argparse.Namespace) -> int:
    """Score the committed 120-item control set with the pinned judge and publish the rates.

    Generation and measurement are separate commands on purpose: this one never builds a control,
    so the judge is always measured against the same committed artifact, and a re-run is a replay.
    Exits ``EXIT_GATE_FAILED`` on a failed gate — the numbers are still written first.
    """
    from .judge_validation import (
        CONTROL_SEED,
        control_items_from_rows,
        control_items_from_scored,
        evaluate,
        preserved_tail,
        render_human_sheet,
        render_validation_md,
        score_control_set,
        stratified_spot_check,
    )
    from .openrouter import Ledger, OpenRouterClient
    from .prompts import JUDGE_PROMPT_SHA256

    config = _load_config(args)
    jv = config.judge_validation
    neg_path = args.negatives or default_negative_controls_path()
    pos_path = args.positives or default_positive_controls_path()
    rows = _read_jsonl(Path(neg_path)) + _read_jsonl(Path(pos_path))
    if not rows:
        print(f"judge-validate: no controls at {neg_path} / {pos_path}", file=sys.stderr)
        return 1
    items = control_items_from_rows(rows)

    ledger = Ledger(
        Path(config.spend.ledger_path),
        warn_at_usd=config.spend.warn_at_usd,
        hard_cap_usd=config.spend.hard_cap_usd,
        run_id=config.run.run_id,
    )
    client = OpenRouterClient(
        cfg.load_prices(cfg.default_prices_path()),
        ledger,
        run_id=config.run.run_id,
        cache_dir=_cache_dir(args),
    )
    judge_model = args.judge or config.models.judge_primary
    gen = config.generation
    try:
        score_control_set(
            client,
            judge_model,
            items,
            temperature=gen.judge_temperature,
            max_tokens=gen.judge_max_tokens,
            shuffle_seed=jv.validation_seed,
        )
    finally:
        client.close()
        ledger.flush()
    spend = ledger.total_usd
    ledger.close()

    report = evaluate(
        judge_model,
        items,
        far_gate=jv.far_gate,
        far_gate_superseded=jv.far_gate_superseded,
        frr_gate=jv.frr_gate,
    )

    scored_path = Path("out") / "judge-controls-scored.jsonl"
    scored_path.parent.mkdir(parents=True, exist_ok=True)
    _write_rows(
        scored_path,
        [
            {
                "control_id": it.control_id,
                "question_id": it.question_id,
                "kind": it.kind,
                "family": it.family,
                "expected": it.expected,
                "verdict": it.verdict,
                "judge_model": judge_model,
                "judge_prompt_sha": JUDGE_PROMPT_SHA256,
            }
            for it in items
        ],
    )
    spot = stratified_spot_check(items, jv.spot_check_n, seed=jv.validation_seed)
    (_eval_dir() / "judge-controls-for-human.md").write_text(
        render_human_sheet(spot, judge_model=judge_model, total_items=len(items)),
        encoding="utf-8",
    )
    # A revised control set publishes the previous set's numbers beside its own, computed from
    # that run's own scored rows rather than retyped.
    prior = None
    if args.prior:
        prior_rows = _read_jsonl(Path(args.prior))
        if not prior_rows:
            print(f"judge-validate: no prior scored rows at {args.prior}", file=sys.stderr)
            return 1
        prior = evaluate(
            judge_model,
            control_items_from_scored(prior_rows),
            far_gate=jv.far_gate,
            far_gate_superseded=jv.far_gate_superseded,
            frr_gate=jv.frr_gate,
        )

    validation_path = _eval_dir() / "judge-validation.md"
    body = render_validation_md(
        report,
        judge_prompt_sha=JUDGE_PROMPT_SHA256,
        perturber_model=config.models.perturber,
        validation_seed=jv.validation_seed,
        control_seed=CONTROL_SEED,
        spend_usd=spend,
        spot_check_n=jv.spot_check_n,
        prior=prior,
        prior_label=args.prior_label,
    )
    # A re-render replaces the measured numbers and keeps the hand-written analysis under them.
    tail = preserved_tail(validation_path.read_text(encoding="utf-8")) if validation_path.exists() else ""
    validation_path.write_text(body + ("\n" + tail if tail else ""), encoding="utf-8")

    print(f"judge={judge_model} FAR={report.far:.1%} FRR={report.frr:.1%} pinned={report.pinned}")
    for fam in sorted(report.far_by_family):
        print(f"  {fam}: FAR={report.far_by_family[fam]:.1%}")
    print(f"scored {len(items)} controls, spend ${spend:.4f}; wrote eval/judge-validation.md")
    if not report.all_gates_pass:
        print(
            "judge-validate: a GATE FAILED — publish the number, do not tune the prompt to pass it",
            file=sys.stderr,
        )
        return EXIT_GATE_FAILED
    return 0


# --------------------------------------------------------------------------------------------
# report
# --------------------------------------------------------------------------------------------
def _gold_by_qid(corpus: list[Question]) -> dict[str, Question]:
    return {q.question_id: q for q in corpus}


def _build_arm_reports(
    answers: list[dict], judgments: list[dict], gold: dict[str, Question], warmup: int
) -> list[ArmReport]:
    from .arms import predicted_abstain
    from .report import aggregate_arm_reports

    verdict_by_key = {(j["arm"], j["seed"], j["question_id"]): j["verdict"] for j in judgments}
    enriched: list[dict] = []
    for a in answers:
        q = gold.get(a["question_id"])
        if q is None:
            continue
        arm, seed = a["arm"], a["seed"]
        enriched.append(
            {
                "arm": arm,
                "seed": seed,
                "is_abstention": q.abstention,
                "ability": q.ability,
                "predicted_abstain": predicted_abstain(arm, a),
                "verdict": verdict_by_key.get((arm, seed, a["question_id"])),
                "prompt_tokens": a.get("prompt_tokens") or 0,
                "usd": a.get("usd") or 0.0,
                "latency_ms": a.get("latency_ms_client") or 0.0,
                "status": a.get("status"),
            }
        )
    return aggregate_arm_reports(enriched, warmup=warmup)


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [orjson.loads(line) for line in path.read_bytes().splitlines() if line]


def cmd_judge(args: argparse.Namespace) -> int:
    """Judge every answer row of a run: deterministic for abstention gold, LLM for the rest.

    Writes ``out/<run_id>/judgments.jsonl`` (append; ``--resume`` skips already-judged keys), the
    file ``report`` consumes. The LLM path goes through the capped, ledgered OpenRouterClient.
    """
    from .judge import judge_run
    from .openrouter import Ledger, OpenRouterClient

    config = _load_config(args)
    run_dir = Path("out") / args.run
    answers = _read_jsonl(run_dir / "answers.jsonl")
    if not answers:
        print(f"judge: no answers in {run_dir}/answers.jsonl", file=sys.stderr)
        return 1
    out_path = run_dir / "judgments.jsonl"
    done = {
        (j.get("arm"), j.get("seed"), j.get("question_id")) for j in _read_jsonl(out_path)
    } if args.resume else set()
    todo = [r for r in answers if (r.get("arm"), r.get("seed"), r.get("question_id")) not in done]
    if not todo:
        print("judge: nothing to do")
        return 0

    corpus = load_corpus(config.data_path())
    gold_by_qid = {
        q.question_id: {"question": q.question, "answer": q.answer, "is_abstention": q.abstention}
        for q in corpus
    }
    ledger = Ledger(
        Path(config.spend.ledger_path),
        warn_at_usd=config.spend.warn_at_usd,
        hard_cap_usd=config.spend.hard_cap_usd,
        run_id=config.run.run_id,
    )
    client = OpenRouterClient(
        cfg.load_prices(cfg.default_prices_path()), ledger, run_id=config.run.run_id
    )
    model = args.judge or config.models.judge_primary
    gen = config.generation
    rows = judge_run(
        client,
        model,
        todo,
        gold_by_qid=gold_by_qid,
        shuffle_seed=config.run.sample_seed,
        temperature=gen.judge_temperature,
        max_tokens=gen.judge_max_tokens,
    )
    with open(out_path, "ab") as fh:
        for row in rows:
            fh.write(orjson.dumps(row))
            fh.write(b"\n")
    spent = sum(r.get("usd", 0.0) or 0.0 for r in rows)
    print(f"judge: wrote {len(rows)} judgments to {out_path} (llm spend ${spent:.4f})")
    return 0


def cmd_report(args: argparse.Namespace) -> int:
    config = _load_config(args)
    corpus = load_corpus(config.data_path())
    gold = _gold_by_qid(corpus)
    answers: list[dict] = []
    judgments: list[dict] = []
    for run_id in args.runs:
        run_dir = Path("out") / run_id
        answers.extend(_read_jsonl(run_dir / "answers.jsonl"))
        judgments.extend(_read_jsonl(run_dir / "judgments.jsonl"))
    if not answers:
        print("report: no answers found", file=sys.stderr)
        return 1
    reports = _build_arm_reports(answers, judgments, gold, config.run.warmup_queries)
    judge_model = next((j.get("judge_model") for j in judgments if j.get("judge_model")), "")
    judge_sha = next((j.get("judge_prompt_sha") for j in judgments if j.get("judge_prompt_sha")), "")
    n_q = len({a["question_id"] for a in answers})
    caption = render_caption(
        config=config,
        manifest={},
        answer_prompt_sha=ANSWER_PROMPT_SHA256,
        judge_model=judge_model or config.models.judge_primary,
        judge_prompt_sha=judge_sha or "",
        judge_far=args.far,
        n_questions=n_q,
    )
    out = write_report(reports, outdir=Path("out") / "report", caption=caption)
    print(f"wrote {out}")
    return 0


# --------------------------------------------------------------------------------------------
# argparse
# --------------------------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="errata-eval", description="Errata evaluation harness.")
    p.add_argument("--config", type=Path, default=None, help="path to eval.toml")
    sub = p.add_subparsers(dest="command", required=True)

    s = sub.add_parser("sample", help="print/write the seeded stratified comparison set")
    s.add_argument("--n", type=int, default=None)
    s.add_argument("--seed", type=int, default=None)
    s.add_argument("--print-ids", action="store_true")
    s.add_argument("--out", type=Path, default=None, help="write question_ids as a JSON array")
    s.set_defaults(func=cmd_sample)

    pa = sub.add_parser("parity", help="assert /api/meta matches our prompt sha + answer model")
    pa.set_defaults(func=cmd_parity)

    r = sub.add_parser("run", help="run one arm over a question set")
    r.add_argument("--arm", required=True, choices=["errata", "full_context", "naive"])
    r.add_argument("--seeds", default=None, help="comma-separated, e.g. 11,22,33")
    r.add_argument("--set", default="comparison", choices=["comparison", "full", "smoke"])
    r.add_argument("--resume", action="store_true")
    r.add_argument("--run-id", default=None, help="write into out/<run-id>/ (resume an existing dir)")
    r.add_argument("--verify", action="store_true", help="sha256-gate the corpus first")
    r.set_defaults(func=cmd_run)

    es = sub.add_parser("estimate", help="project per-arm + total USD before any spend")
    es.add_argument("--sample", type=Path, default=None, help="path to sample-150.json")
    es.add_argument("--prices", type=Path, default=None, help="path to prices.toml")
    es.add_argument("--already-spent", type=float, default=0.0)
    es.set_defaults(func=cmd_estimate)

    ct = sub.add_parser("controls", help="write the deterministic negative judge-control set (no LLM)")
    ct.add_argument("--seed", type=int, default=None)
    ct.add_argument("--out", type=Path, default=None, help="output .jsonl path")
    ct.set_defaults(func=cmd_controls)

    cp = sub.add_parser(
        "controls-positive", help="generate the paraphrase POSITIVE controls (one cached LLM pass)"
    )
    cp.add_argument("--n", type=int, default=None)
    cp.add_argument("--out", type=Path, default=None, help="output .jsonl path")
    cp.add_argument("--cache-dir", default=None, help="LLM cache dir ('' disables)")
    cp.set_defaults(func=cmd_controls_positive)

    jd = sub.add_parser("judge", help="judge a run's answers.jsonl → judgments.jsonl")
    jd.add_argument("--run", required=True, help="run_id under out/")
    jd.add_argument("--judge", default=None, help="override judge model")
    jd.add_argument("--resume", action="store_true")
    jd.set_defaults(func=cmd_judge)

    jv = sub.add_parser("judge-validate", help="score the committed control set; publish FAR/FRR")
    jv.add_argument("--judge", default=None, help="override the judge model under test")
    jv.add_argument("--negatives", type=Path, default=None)
    jv.add_argument("--positives", type=Path, default=None)
    jv.add_argument("--cache-dir", default=None, help="LLM cache dir ('' disables)")
    jv.add_argument("--prior", type=Path, default=None, help="a previous scored .jsonl to publish beside this run")
    jv.add_argument("--prior-label", default="original controls", help="column heading for --prior")
    jv.set_defaults(func=cmd_judge_validate)

    rp = sub.add_parser("report", help="emit out/report/table.md + caption")
    rp.add_argument("--runs", nargs="+", required=True)
    rp.add_argument("--far", type=float, default=None, help="measured judge FAR for the caption")
    rp.set_defaults(func=cmd_report)
    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
