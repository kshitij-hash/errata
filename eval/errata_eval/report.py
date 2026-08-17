"""The ONE markdown table generator.

Renders from a results object to ``out/report/table.md``, pasted into the submission README with
no editing. Row order is fixed (Errata, full-context, naive); a cell with fewer than 3 runs is
rendered ``00.0 (1 run)`` so it cannot pass for a 3-run number; if any arm's error rate exceeds
2% the generator refuses to emit and names the offending run.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import orjson

from . import metrics

ROW_ORDER = ("errata", "full_context", "naive")
ARM_DISPLAY = {
    "errata": "**Errata**",
    "full_context": "Full-context baseline",
    "naive": "Naive top-k RAG (k=10)",
}
ABILITY_ORDER = ("information_extraction", "multi_session", "temporal", "knowledge_update")
ABILITY_DISPLAY = {
    "information_extraction": "Info. extraction",
    "multi_session": "Multi-session",
    "temporal": "Temporal",
    "knowledge_update": "Knowledge update",
}
ERROR_RATE_LIMIT = 0.02


class ReportError(RuntimeError):
    pass


@dataclass
class ArmReport:
    arm: str
    n_runs: int
    overall: tuple[float, float]  # (mean, sd) as fractions in [0, 1]
    by_ability: dict[str, tuple[float, float]]  # ability -> (mean, sd) fractions
    abstention: tuple[float, float]  # (precision, recall)
    ctx_tokens: float  # mean prompt_tokens
    cost_per_q: float
    latency_p50_s: float
    latency_p95_s: float
    error_rate: float = 0.0


# --------------------------------------------------------------------------------------------
# aggregation: enriched judged rows -> one ArmReport per arm (the production path, made pure)
# --------------------------------------------------------------------------------------------
def aggregate_arm_reports(rows: Iterable[Mapping[str, Any]], *, warmup: int = 0) -> list[ArmReport]:
    """Build one ``ArmReport`` per arm from enriched judged rows.

    Each row carries: ``arm``, ``seed``, ``is_abstention``, ``ability``, ``predicted_abstain``,
    ``verdict``, ``prompt_tokens``, ``usd``, ``latency_ms``, ``status``. Accuracy is computed per
    seed then reduced to mean±sd; abstention P/R, ctx tokens, $/Q and error rate pool every row;
    latency percentiles exclude the first ``warmup`` rows (in arm→seed order). Deterministic.
    """
    by_arm: dict[str, list[Mapping[str, Any]]] = {}
    for r in rows:
        by_arm.setdefault(str(r["arm"]), []).append(r)

    reports: list[ArmReport] = []
    for arm, arm_rows in by_arm.items():
        seeds = sorted({r["seed"] for r in arm_rows})
        overall_per_seed: list[float] = []
        ability_per_seed: dict[str, list[float]] = {}
        all_rows: list[Mapping[str, Any]] = []
        for seed in seeds:
            seed_rows = [r for r in arm_rows if r["seed"] == seed]
            all_rows.extend(seed_rows)
            overall_per_seed.append(metrics.accuracy(seed_rows))
            for ability, acc in metrics.accuracy_by_ability(seed_rows).items():
                ability_per_seed.setdefault(ability, []).append(acc)

        abst = metrics.abstention_pr(all_rows)
        lat = [float(r.get("latency_ms", 0.0) or 0.0) / 1000.0 for r in all_rows[warmup:]]
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


# --------------------------------------------------------------------------------------------
# formatting
# --------------------------------------------------------------------------------------------
def _fmt_acc(cell: tuple[float, float], n_runs: int) -> str:
    mean, sd = cell
    if math.isnan(mean):
        return "—"
    if n_runs < 3:
        plural = "run" if n_runs == 1 else "runs"
        return f"{mean * 100:.1f} ({n_runs} {plural})"
    return f"{mean * 100:.1f} ± {sd * 100:.1f}"


def _fmt_abst(pr: tuple[float, float]) -> str:
    p, r = pr
    ps = "—" if math.isnan(p) else f"{p:.2f}"
    rs = "—" if math.isnan(r) else f"{r:.2f}"
    return f"{ps} / {rs}"


def _fmt_ctx(x: float) -> str:
    return "—" if math.isnan(x) else f"{round(x):,}"


def _fmt_cost(x: float) -> str:
    return "—" if math.isnan(x) else f"${x:.4f}"


def _fmt_lat(p50: float, p95: float) -> str:
    p50s = "—" if math.isnan(p50) else f"{p50:.2f}"
    p95s = "—" if math.isnan(p95) else f"{p95:.2f}"
    return f"{p50s} / {p95s}"


def _row(rep: ArmReport) -> str:
    cells = [
        ARM_DISPLAY.get(rep.arm, rep.arm),
        _fmt_acc(rep.overall, rep.n_runs),
    ]
    for ability in ABILITY_ORDER:
        cells.append(_fmt_acc(rep.by_ability.get(ability, (float("nan"), 0.0)), rep.n_runs))
    cells.append(_fmt_abst(rep.abstention))
    cells.append(_fmt_ctx(rep.ctx_tokens))
    cells.append(_fmt_cost(rep.cost_per_q))
    cells.append(_fmt_lat(rep.latency_p50_s, rep.latency_p95_s))
    return "| " + " | ".join(cells) + " |"


def render_table(reports: list[ArmReport]) -> str:
    by_arm = {r.arm: r for r in reports}
    offending = [
        r.arm
        for r in reports
        if not math.isnan(r.error_rate) and r.error_rate > ERROR_RATE_LIMIT
    ]
    if offending:
        raise ReportError(
            f"error rate > {ERROR_RATE_LIMIT:.0%} for arm(s) {offending}; refusing to emit table"
        )
    header = (
        "| Arm | Overall | Info. extraction | Multi-session | Temporal | "
        "Knowledge update | Abstention P / R | Ctx tok/Q | $/Q | p50 / p95 (s) |"
    )
    sep = "|" + "|".join(["---"] * 10) + "|"
    lines = [header, sep]
    for arm in ROW_ORDER:
        if arm in by_arm:
            lines.append(_row(by_arm[arm]))
    return "\n".join(lines)


# --------------------------------------------------------------------------------------------
# caption
# --------------------------------------------------------------------------------------------
def render_caption(
    *,
    config: Any,
    manifest: dict[str, Any],
    answer_prompt_sha: str,
    judge_model: str,
    judge_prompt_sha: str,
    judge_far: float | None,
    n_questions: int,
) -> str:
    ds = config.dataset
    rev8 = ds.revision[:8]
    sha8 = ds.sha256[:8]
    far_txt = "not yet measured" if judge_far is None else f"{judge_far * 100:.1f}%"
    seeds = "/".join(str(s) for s in config.run.seeds)
    return (
        f"> Dataset: `{ds.repo_id}`, revision `{rev8}…`, file `{ds.file}` (sha256 `{sha8}…`). "
        f"All three arms answer the **same {n_questions} questions**, a seeded stratified subsample "
        f"(`sample_seed={config.run.sample_seed}`) proportional by question type with **all 30 "
        f"abstention questions included**; the full-context baseline runs on this subsample rather "
        f"than all 500 for cost reasons. {len(config.run.seeds)} runs, seeds {seeds}, temperature 0 "
        f"— sd reflects provider nondeterminism, not sampling spread. Answer model "
        f"`{config.models.answer}` and answer prompt (sha `{answer_prompt_sha[:8]}…`) **identical "
        f"across all three arms**, verified at run start against the deployed API. Judge "
        f"`{judge_model}` (prompt sha `{judge_prompt_sha[:8]}…`), measured false-accept rate "
        f"**{far_txt}** on 60 perturbed control answers (reference: an independent audit measured "
        f"62.81% for a naive judge). Abstention is scored by exact match, not by the judge. Naive "
        f"top-k: `{config.models.embedder}`, {config.naive_topk.chunk_max_chars}-char chunks within "
        f"session boundaries, k={config.naive_topk.k}; index build cost excluded from $/Q and "
        f"reported separately. Reproduce: `uv run errata-eval report --runs <run_id>`."
    )


# --------------------------------------------------------------------------------------------
# writing
# --------------------------------------------------------------------------------------------
def write_report(
    reports: list[ArmReport],
    *,
    outdir: str | Path,
    caption: str = "",
    summary: dict[str, Any] | None = None,
) -> Path:
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    table = render_table(reports)
    doc = table + ("\n\n" + caption if caption else "") + "\n"
    table_path = outdir / "table.md"
    table_path.write_text(doc, encoding="utf-8")
    if summary is not None:
        (outdir / "summary.json").write_bytes(orjson.dumps(summary, option=orjson.OPT_INDENT_2))
    return table_path
