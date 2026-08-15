"""errata-eval command line.

Subcommands: sample, parity, run, judge-validate, report.

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
from . import metrics
from .dataset import Question, load_corpus, sample, verify_checksum
from .prompts import ANSWER_PROMPT_SHA256
from .report import ArmReport, render_caption, write_report

EXIT_PARITY_MISMATCH = 4
EXIT_DATASET = 2


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
    if args.print_ids:
        for q in chosen:
            print(q.question_id)
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
    run_id = _run_id(config)
    seeds = [int(s) for s in args.seeds.split(",")] if args.seeds else config.run.seeds
    n = config.sample.full_n if args.set == "full" else config.sample.comparison_n
    chosen = _load_sample(config, n, config.run.sample_seed, verify=args.verify)

    out_dir = Path("out") / run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    answers_path = out_dir / "answers.jsonl"
    done = _completed_keys(answers_path) if args.resume else set()

    arm = _build_arm(args.arm, config)
    written = 0
    with open(answers_path, "ab") as fh:
        for seed in seeds:
            for q in chosen:
                if (args.arm, seed, q.question_id) in done:
                    continue
                row = arm.answer(q, seed=seed)
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
# judge-validate
# --------------------------------------------------------------------------------------------
def cmd_judge_validate(args: argparse.Namespace) -> int:
    from .judge_validation import build_control_set, evaluate, score_control_set
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
    prices = cfg.load_prices(cfg.default_prices_path())
    client = OpenRouterClient(prices, ledger, run_id=config.run.run_id)
    judge_model = args.judge or config.models.judge_primary
    items = build_control_set(
        corpus, client, config.models.perturber, n=args.n or jv.n, seed=jv.validation_seed
    )
    score_control_set(client, judge_model, items)
    report = evaluate(
        judge_model,
        items,
        far_gate=jv.far_gate,
        far_gate_superseded=jv.far_gate_superseded,
        frr_gate=jv.frr_gate,
    )
    print(f"judge={judge_model} FAR={report.far:.1%} FRR={report.frr:.1%} pinned={report.pinned}")
    for fam, far in sorted(report.far_by_family.items()):
        print(f"  {fam}: FAR={far:.1%}")
    return 0 if report.pinned else 1


# --------------------------------------------------------------------------------------------
# report
# --------------------------------------------------------------------------------------------
def _gold_by_qid(corpus: list[Question]) -> dict[str, Question]:
    return {q.question_id: q for q in corpus}


def _build_arm_reports(
    answers: list[dict], judgments: list[dict], gold: dict[str, Question], warmup: int
) -> list[ArmReport]:
    from .arms import predicted_abstain

    verdict_by_key = {(j["arm"], j["seed"], j["question_id"]): j["verdict"] for j in judgments}
    by_arm: dict[str, list[dict]] = {}
    for a in answers:
        by_arm.setdefault(a["arm"], []).append(a)

    reports: list[ArmReport] = []
    for arm, arm_rows in by_arm.items():
        seeds = sorted({r["seed"] for r in arm_rows})
        overall_per_seed: list[float] = []
        ability_per_seed: dict[str, list[float]] = {}
        all_rows: list[dict] = []
        for seed in seeds:
            seed_rows = [r for r in arm_rows if r["seed"] == seed]
            enriched = []
            for r in seed_rows:
                q = gold.get(r["question_id"])
                if q is None:
                    continue
                enriched.append(
                    {
                        "is_abstention": q.abstention,
                        "ability": q.ability,
                        "predicted_abstain": predicted_abstain(arm, r),
                        "verdict": verdict_by_key.get((arm, seed, r["question_id"])),
                        "prompt_tokens": r.get("prompt_tokens") or 0,
                        "usd": r.get("usd") or 0.0,
                        "latency_ms": r.get("latency_ms_client") or 0.0,
                        "status": r.get("status"),
                    }
                )
            all_rows.extend(enriched)
            overall_per_seed.append(metrics.accuracy(enriched))
            for ability, acc in metrics.accuracy_by_ability(enriched).items():
                ability_per_seed.setdefault(ability, []).append(acc)

        abst = metrics.abstention_pr(all_rows)
        # latency excludes warmup rows per seed
        lat = [r["latency_ms"] / 1000.0 for r in all_rows[warmup:]]
        pct = metrics.percentiles(lat)
        reports.append(
            ArmReport(
                arm=arm,
                n_runs=len(seeds),
                overall=metrics.mean_sd(overall_per_seed),
                by_ability={a: metrics.mean_sd(v) for a, v in ability_per_seed.items()},
                abstention=(float(abst["precision"]), float(abst["recall"])),
                ctx_tokens=metrics.mean_prompt_tokens(all_rows),
                cost_per_q=metrics.cost_per_question(all_rows),
                latency_p50_s=pct[50],
                latency_p95_s=pct[95],
                error_rate=metrics.error_rate(all_rows),
            )
        )
    return reports


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [orjson.loads(line) for line in path.read_bytes().splitlines() if line]


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

    s = sub.add_parser("sample", help="print the seeded stratified comparison set")
    s.add_argument("--n", type=int, default=None)
    s.add_argument("--seed", type=int, default=None)
    s.add_argument("--print-ids", action="store_true")
    s.set_defaults(func=cmd_sample)

    pa = sub.add_parser("parity", help="assert /api/meta matches our prompt sha + answer model")
    pa.set_defaults(func=cmd_parity)

    r = sub.add_parser("run", help="run one arm over a question set")
    r.add_argument("--arm", required=True, choices=["errata", "full_context", "naive"])
    r.add_argument("--seeds", default=None, help="comma-separated, e.g. 11,22,33")
    r.add_argument("--set", default="comparison", choices=["comparison", "full", "smoke"])
    r.add_argument("--resume", action="store_true")
    r.add_argument("--verify", action="store_true", help="sha256-gate the corpus first")
    r.set_defaults(func=cmd_run)

    jv = sub.add_parser("judge-validate", help="build + score the perturbed control set")
    jv.add_argument("--n", type=int, default=None)
    jv.add_argument("--judge", default=None)
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
