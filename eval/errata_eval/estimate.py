"""Pre-run cost estimator — projects per-arm and total USD before any spend.

It consumes the committed sample artifact (``sample-150.json``), the pinned price sheet, and a
per-arm token model grounded in the cost analysis: the per-call input/output token counts for
each arm, re-priced here from ``prices.toml`` (never a provider's self-reported figure). The
``estimate`` command runs first in every real run and refuses to proceed if the projected total
plus what has already been spent would breach the hard cap.

Everything here is arithmetic — no network, no LLM, no dataset load. The number is reproducible by
anyone holding the artifact and the price sheet.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from .config import EvalConfig, Prices
from .dataset import is_abstention


# Per-call token model per answer arm (grounded in the cost analysis). ``question_set`` selects
# the size the arm runs on: "full" = the whole corpus, "comparison" = the seeded subsample.
#   - Errata retrieves a compact belief-graph context (~2K tok in).
#   - full-context stuffs the entire ~122K-token history into one prompt — its whole point.
#   - naive top-k stuffs k=10 chunks (~6K tok in).
@dataclass(frozen=True)
class ArmTokenModel:
    in_per_call: int
    out_per_call: int
    question_set: str  # "full" | "comparison"


ANSWER_ARM_TOKENS: dict[str, ArmTokenModel] = {
    "errata": ArmTokenModel(in_per_call=2000, out_per_call=200, question_set="full"),
    "full_context": ArmTokenModel(in_per_call=122156, out_per_call=200, question_set="comparison"),
    "naive": ArmTokenModel(in_per_call=6000, out_per_call=200, question_set="full"),
}

# The judge sees one call per non-abstention answer row (abstention is scored by exact match, no
# LLM). Per-call tokens are the question + reference + candidate in, a <=64-token verdict out.
JUDGE_IN_PER_CALL = 701
JUDGE_OUT_PER_CALL = 60

# Retries, dry runs, re-judging, and general slippage. Applied to every projected line.
OVERHEAD_FRACTION = 0.25


@dataclass(frozen=True)
class LineItem:
    name: str
    calls: int
    in_tokens: int
    out_tokens: int
    model: str
    usd: float


@dataclass(frozen=True)
class Estimate:
    lines: tuple[LineItem, ...]
    subtotal_usd: float
    overhead_usd: float
    projected_usd: float
    escalation_delta_usd: float  # extra if the judge escalates (contingency, NOT in projected)
    worst_case_usd: float
    comparison_n: int
    full_n: int
    n_abstention: int
    seeds: int

    @property
    def arm_lines(self) -> tuple[LineItem, ...]:
        return tuple(li for li in self.lines if li.name in ANSWER_ARM_TOKENS)


def estimate_cost(
    *,
    sample_ids: Sequence[str],
    config: EvalConfig,
    prices: Prices,
    overhead: float = OVERHEAD_FRACTION,
) -> Estimate:
    """Project per-arm + judge cost from the artifact, the config, and the pinned prices."""
    comparison_n = len(sample_ids)
    n_abstention = sum(1 for qid in sample_ids if is_abstention(qid))
    seeds = len(config.run.seeds)
    full_n = config.sample.full_n
    answer_model = config.models.answer
    set_size = {"full": full_n, "comparison": comparison_n}

    lines: list[LineItem] = []
    for arm in ("errata", "full_context", "naive"):
        m = ANSWER_ARM_TOKENS[arm]
        calls = set_size[m.question_set] * seeds
        per_call = prices.cost(answer_model, m.in_per_call, m.out_per_call)
        lines.append(
            LineItem(
                name=arm,
                calls=calls,
                in_tokens=m.in_per_call * calls,
                out_tokens=m.out_per_call * calls,
                model=answer_model,
                usd=per_call * calls,
            )
        )

    # judge: non-abstention rows across every judged arm-run.
    judge_rows = (
        (full_n - n_abstention) * seeds  # errata, full set
        + (full_n - n_abstention) * seeds  # naive, full set
        + (comparison_n - n_abstention) * seeds  # full-context, comparison set
    )
    judge_model = config.models.judge_primary
    judge_per_call = prices.cost(judge_model, JUDGE_IN_PER_CALL, JUDGE_OUT_PER_CALL)
    lines.append(
        LineItem(
            name="judge",
            calls=judge_rows,
            in_tokens=JUDGE_IN_PER_CALL * judge_rows,
            out_tokens=JUDGE_OUT_PER_CALL * judge_rows,
            model=judge_model,
            usd=judge_per_call * judge_rows,
        )
    )

    subtotal = sum(li.usd for li in lines)
    overhead_usd = subtotal * overhead
    projected = subtotal + overhead_usd

    escalation_model = config.models.judge_escalation
    escalation_per_call = prices.cost(escalation_model, JUDGE_IN_PER_CALL, JUDGE_OUT_PER_CALL)
    escalation_delta = (escalation_per_call - judge_per_call) * judge_rows * (1.0 + overhead)

    return Estimate(
        lines=tuple(lines),
        subtotal_usd=subtotal,
        overhead_usd=overhead_usd,
        projected_usd=projected,
        escalation_delta_usd=escalation_delta,
        worst_case_usd=projected + escalation_delta,
        comparison_n=comparison_n,
        full_n=full_n,
        n_abstention=n_abstention,
        seeds=seeds,
    )


_ARM_LABEL = {
    "errata": "Arm A — Errata",
    "full_context": "Arm B — full-context",
    "naive": "Arm C — naive top-k",
    "judge": "Judge (non-abstention rows)",
}


def render_estimate(est: Estimate, *, hard_cap: float, already_spent: float = 0.0) -> str:
    """A human-readable projection table + totals, for the CLI and the README."""
    rows = [
        "| Line | Calls | In (M tok) | Out (M tok) | Model | USD |",
        "|---|---:|---:|---:|---|---:|",
    ]
    for li in est.lines:
        rows.append(
            f"| {_ARM_LABEL.get(li.name, li.name)} | {li.calls:,} | "
            f"{li.in_tokens / 1e6:.2f} | {li.out_tokens / 1e6:.2f} | {li.model} | ${li.usd:.4f} |"
        )
    rows.append(f"| Overhead @{OVERHEAD_FRACTION:.0%} | | | | | ${est.overhead_usd:.4f} |")
    rows.append(f"| **Projected total** | | | | | **${est.projected_usd:.4f}** |")
    total = est.projected_usd + already_spent
    status = "OK" if total <= hard_cap else "OVER CAP"
    lines = "\n".join(rows)
    return (
        f"{lines}\n\n"
        f"Sample: {est.comparison_n} comparison questions ({est.n_abstention} abstention), "
        f"full corpus {est.full_n}, {est.seeds} seeds.\n"
        f"Projected ${est.projected_usd:.2f} + already spent ${already_spent:.2f} "
        f"= ${total:.2f} vs hard cap ${hard_cap:.2f} -> {status}.\n"
        f"Contingency (judge escalation): +${est.escalation_delta_usd:.2f} "
        f"-> worst case ${est.worst_case_usd:.2f}."
    )
