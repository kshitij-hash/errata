"""Judge validation — the control-set protocol (§4.3), measured, published, and gated.

The control set has two halves, built by two different mechanisms on purpose:

- 60 **negatives** (should be REJECTED): on-topic-but-wrong answers manufactured from the corpus's
  own gold data by deterministic template transforms, 12 per family, no LLM, no cost, reproducible
  from a fixed seed. ``build_negative_controls`` below; committed as ``judge-controls.jsonl``.
- 60 **positives** (should be ACCEPTED): paraphrases of the gold answer that change no name, date,
  quantity or value. A paraphrase cannot be manufactured mechanically without becoming a template
  the judge could learn, so these are the one LLM pass this protocol pays for
  (``build_positive_controls``); committed as ``judge-controls-positive.jsonl``.

Both halves are committed artifacts, so scoring a judge is a replay of a fixed 120-item set rather
than a fresh generation — the measured rate is comparable across judges and across days.

A judge is pinned only if FAR <= 10% overall and superseded-value FAR <= 8%; FRR <= 15% is reported
and gated alongside. We publish the numbers whatever they are, and a failing gate is a war-room
item, never a reason to edit the judge prompt until it passes.
"""

from __future__ import annotations

import random
import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from .dataset import Question, largest_remainder
from .judge import judge_answer
from .prompts import PERTURB_PROMPT_SHA256, fill_perturb_prompt

# Perturbed-negative families (§4.3), 12 items each so the failure surface is characterised.
# This table is the DEFINITION of each family — what "attribution-flip" means is this sentence —
# and doubles as the instruction if a future run ever wants LLM-generated negatives. The shipped
# negatives are the deterministic transforms at the bottom of this file, one per family.
PERTURB_FAMILIES: dict[str, str] = {
    "entity-swap": (
        "Replace the named entity in the reference answer with a different but same-type entity "
        "(a different person, place, or thing). Change nothing else."
    ),
    "value-shift": (
        "Shift one date, number, or quantity in the reference answer by a small, plausible "
        "amount. Change nothing else."
    ),
    "attribution-flip": (
        "Attribute the correct fact to the wrong person or session — swap who said or did it. "
        "Keep the fact itself unchanged."
    ),
    "superseded-value": (
        "Give the EARLIER value of a fact that the history later updated, as if the update never "
        "happened. Keep the phrasing natural."
    ),
    "topical-filler": (
        "Write a fluent answer that stays on the same topic but contains NONE of the specific "
        "facts (names, dates, quantities) the reference answer states."
    ),
}

POSITIVE_INSTRUCTION = (
    "Restate this answer in different words, changing no names, dates, quantities or values."
)

FAMILY_SIZE = 12


@dataclass(slots=True)
class ControlItem:
    question_id: str
    question: str
    gold_answer: str
    candidate: str
    kind: str  # "positive" | "perturbed"
    family: str  # "" for positives, else a PERTURB_FAMILIES key
    verdict: str = ""  # filled in by scoring
    human_label: str = ""  # "CORRECT"/"INCORRECT" for spot-checked items

    @property
    def control_id(self) -> str:
        """Stable identity of one control item, unique across the 120 (kind disambiguates)."""
        return f"{self.kind}:{self.question_id}"

    @property
    def stratum(self) -> str:
        """The sampling cell this item belongs to: its family, or "positive"."""
        return self.family or "positive"

    @property
    def expected(self) -> str:
        """The verdict a perfect judge returns."""
        return "CORRECT" if self.kind == "positive" else "INCORRECT"


def _draw_stratified(corpus: list[Question], n: int, seed: int) -> list[Question]:
    """Draw n non-abstention questions stratified by ability, deterministically by seed."""
    non_abs = [q for q in corpus if not q.abstention]
    by_ability: dict[str, list[Question]] = {}
    for q in non_abs:
        by_ability.setdefault(q.ability, []).append(q)
    populations = {a: len(qs) for a, qs in by_ability.items()}
    alloc = largest_remainder(populations, n)
    drawn: list[Question] = []
    for ability in sorted(by_ability):
        pool = sorted(by_ability[ability], key=lambda q: q.question_id)
        drawn.extend(random.Random(seed).sample(pool, alloc.get(ability, 0)))
    return sorted(drawn, key=lambda q: q.question_id)


@dataclass(slots=True)
class PositiveControl:
    """One paraphrased-gold answer: same facts, different words. The judge must ACCEPT it."""

    question_id: str
    question: str
    gold_answer: str
    candidate: str
    provenance: dict[str, Any]
    family: str = ""  # positives have no perturbation family
    label: str = "positive"

    def to_row(self) -> dict[str, Any]:
        return {
            "question_id": self.question_id,
            "family": self.family,
            "label": self.label,
            "question": self.question,
            "gold_answer": self.gold_answer,
            "answer": self.candidate,
            "provenance": self.provenance,
        }


# The positive pass is the ONE paid call in this protocol. Temperature is pinned here rather than
# read from [generation] because it belongs to the control set's identity, not to a run's config:
# change it and the committed positives are a different artifact.
POSITIVE_TEMPERATURE = 0.7
# The perturber is a thinking model, and unlike the answer arms it cannot be told to stop: this
# endpoint answers `reasoning.enabled: false` with HTTP 400, "Reasoning is mandatory". Reasoning
# tokens come out of max_tokens, so at 200 the reply itself was truncated mid-word ("The price
# difference is $75" for a gold "$750") in 13 of the first 60. A truncated positive control is not
# a control, it is a manufactured false reject — hence a budget that covers thinking AND answering,
# and a hard failure (not a commit) for any reply that still reaches the cap.
POSITIVE_MAX_TOKENS = 900


def build_positive_controls(
    corpus: list[Question],
    perturber_client: Any,
    perturber_model: str,
    *,
    n: int = 60,
    seed: int = 20260818,
) -> list[PositiveControl]:
    """Paraphrase n gold answers with the perturber model — one call per question, cached.

    The questions are the same stratified-by-ability draw the protocol has always specified
    (``_draw_stratified`` at ``judge_validation.validation_seed``), so which questions carry a
    positive control is fixed by seed and does not depend on the perturber or on run order.
    Raises on an empty OR truncated completion: either one is a false reject the judge would be
    blamed for, and a control set that manufactures its own failures measures nothing.
    """
    items: list[PositiveControl] = []
    for q in _draw_stratified(corpus, n, seed):
        res = perturber_client.complete(
            model=perturber_model,
            prompt=fill_perturb_prompt(
                question=q.question, gold_answer=q.answer, instruction=POSITIVE_INSTRUCTION
            ),
            temperature=POSITIVE_TEMPERATURE,
            max_tokens=POSITIVE_MAX_TOKENS,
            op="perturb",
            ref={"question_id": q.question_id, "kind": "positive"},
        )
        candidate = res.text.strip()
        if not candidate:
            raise ValueError(f"positive control for {q.question_id!r} came back empty")
        if res.completion_tokens >= POSITIVE_MAX_TOKENS:
            raise ValueError(
                f"positive control for {q.question_id!r} hit the {POSITIVE_MAX_TOKENS}-token cap "
                f"and is truncated: {candidate[-60:]!r}"
            )
        items.append(
            PositiveControl(
                question_id=q.question_id,
                question=q.question,
                gold_answer=q.answer,
                candidate=candidate,
                provenance={
                    "transform": "paraphrase",
                    "source_question_id": q.question_id,
                    "instruction": POSITIVE_INSTRUCTION,
                    "perturber_model": perturber_model,
                    "perturb_prompt_sha256": PERTURB_PROMPT_SHA256,
                    "temperature": POSITIVE_TEMPERATURE,
                    "draw_seed": seed,
                },
            )
        )
    return items


def control_items_from_scored(rows: list[dict[str, Any]]) -> list[ControlItem]:
    """Rehydrate a PREVIOUS scored run (out/judge-controls-scored*.jsonl) for re-evaluation.

    Only the fields the metrics need are carried — kind, family, verdict. This is what lets a
    revised control set publish the number the previous one produced, from that run's own data,
    instead of from a figure retyped into a template.
    """
    return [
        ControlItem(
            question_id=r["question_id"],
            question="",
            gold_answer="",
            candidate="",
            kind=r["kind"],
            family=r.get("family") or "",
            verdict=r.get("verdict", ""),
        )
        for r in rows
    ]


def control_items_from_rows(rows: list[dict[str, Any]]) -> list[ControlItem]:
    """Read committed control rows (either half) into scoreable items. Order is preserved."""
    items: list[ControlItem] = []
    for r in rows:
        label = r["label"]
        if label not in ("positive", "negative"):
            raise ValueError(f"control row {r.get('question_id')!r}: unknown label {label!r}")
        items.append(
            ControlItem(
                question_id=r["question_id"],
                question=r["question"],
                gold_answer=r["gold_answer"],
                candidate=r["answer"],
                kind="positive" if label == "positive" else "perturbed",
                family=r.get("family") or "",
            )
        )
    return items


def score_control_set(
    judge_client: Any,
    judge_model: str,
    items: list[ControlItem],
    *,
    temperature: float = 0.0,
    max_tokens: int = 64,
    shuffle_seed: int | None = None,
) -> list[ControlItem]:
    """Score every control item with the pinned judge, in place.

    The judge sees only (question, gold, candidate) — never the family, the label, or the fact that
    this is a control set at all, which is the same blinding the run judge gets. Pass
    ``shuffle_seed`` to break the family blocking in call order so a provider-side ordering effect
    cannot align with a family; the returned list keeps the input order regardless.
    """
    order = list(items)
    if shuffle_seed is not None:
        random.Random(shuffle_seed).shuffle(order)
    for item in order:
        j = judge_answer(
            judge_client,
            judge_model,
            question=item.question,
            gold_answer=item.gold_answer,
            candidate_answer=item.candidate,
            temperature=temperature,
            max_tokens=max_tokens,
            ref={"kind": item.kind, "family": item.family, "question_id": item.question_id},
        )
        item.verdict = j.verdict
    return items


def cohen_kappa(labels_a: list[str], labels_b: list[str]) -> float:
    """Cohen's kappa on paired categorical labels."""
    if not labels_a or len(labels_a) != len(labels_b):
        return float("nan")
    n = len(labels_a)
    po = sum(1 for a, b in zip(labels_a, labels_b) if a == b) / n
    cats = set(labels_a) | set(labels_b)
    ca, cb = Counter(labels_a), Counter(labels_b)
    pe = sum((ca[c] / n) * (cb[c] / n) for c in cats)
    if pe == 1.0:
        return 1.0
    return (po - pe) / (1 - pe)


@dataclass
class ValidationReport:
    judge_model: str
    far: float
    far_by_family: dict[str, float]
    frr: float
    kappa: float
    n_positive: int
    n_perturbed: int
    accepted_by_family: dict[str, int] = field(default_factory=dict)
    n_by_family: dict[str, int] = field(default_factory=dict)
    n_false_accept: int = 0
    n_false_reject: int = 0
    n_unparseable: int = 0
    far_gate: float = 0.10
    far_gate_superseded: float = 0.08
    frr_gate: float = 0.15
    passes_far: bool = field(default=False)
    passes_superseded: bool = field(default=False)
    passes_frr: bool = field(default=False)

    @property
    def pinned(self) -> bool:
        """The pin gate proper: FAR overall and on the superseded-value family (§4.3)."""
        return self.passes_far and self.passes_superseded

    @property
    def all_gates_pass(self) -> bool:
        return self.pinned and self.passes_frr


def evaluate(
    judge_model: str,
    items: list[ControlItem],
    *,
    far_gate: float = 0.10,
    far_gate_superseded: float = 0.08,
    frr_gate: float = 0.15,
) -> ValidationReport:
    """Measure FAR / FRR and apply the gates. Pure: no I/O, no LLM, safe inside pytest.

    A verdict that is neither CORRECT nor INCORRECT (``UNPARSEABLE``) counts as a rejection, which
    is how ``report.py`` scores it on the real runs: it is not a false ACCEPT, but it IS a false
    reject when the item is a positive control. Counting it any other way would let a judge that
    replies in prose look better than one that answers the question.
    """
    positives = [it for it in items if it.kind == "positive"]
    perturbed = [it for it in items if it.kind == "perturbed"]
    n_pos = len(positives) or 1
    n_neg = len(perturbed) or 1

    # FAR = perturbed negatives marked CORRECT / total perturbed.
    n_false_accept = sum(1 for it in perturbed if it.verdict == "CORRECT")
    far = n_false_accept / n_neg
    # FRR = positive controls NOT marked CORRECT / total positives.
    n_false_reject = sum(1 for it in positives if it.verdict != "CORRECT")
    frr = n_false_reject / n_pos

    far_by_family: dict[str, float] = {}
    accepted_by_family: dict[str, int] = {}
    n_by_family: dict[str, int] = {}
    for fam in NEGATIVE_FAMILIES:
        fam_items = [it for it in perturbed if it.family == fam]
        if fam_items:
            accepted = sum(1 for it in fam_items if it.verdict == "CORRECT")
            accepted_by_family[fam] = accepted
            n_by_family[fam] = len(fam_items)
            far_by_family[fam] = accepted / len(fam_items)

    spot = [it for it in items if it.human_label]
    kappa = cohen_kappa([it.human_label for it in spot], [it.verdict for it in spot]) if spot else float("nan")

    report = ValidationReport(
        judge_model=judge_model,
        far=far,
        far_by_family=far_by_family,
        frr=frr,
        kappa=kappa,
        n_positive=len(positives),
        n_perturbed=len(perturbed),
        accepted_by_family=accepted_by_family,
        n_by_family=n_by_family,
        n_false_accept=n_false_accept,
        n_false_reject=n_false_reject,
        n_unparseable=sum(1 for it in items if it.verdict not in ("CORRECT", "INCORRECT")),
        far_gate=far_gate,
        far_gate_superseded=far_gate_superseded,
        frr_gate=frr_gate,
    )
    report.passes_far = far <= far_gate
    report.passes_superseded = far_by_family.get("superseded-value", 1.0) <= far_gate_superseded
    report.passes_frr = frr <= frr_gate
    return report


# --------------------------------------------------------------------------------------------
# Human spot check (Cohen's κ) and the published write-ups
# --------------------------------------------------------------------------------------------
def stratified_spot_check(
    items: list[ControlItem], n: int, *, seed: int = 20260818
) -> list[ControlItem]:
    """Draw n control items proportionally across the six strata (positive + five families).

    Deterministic given seed, so the sheet a human labelled is the sheet the κ script re-reads.
    """
    by_stratum: dict[str, list[ControlItem]] = {}
    for it in items:
        by_stratum.setdefault(it.stratum, []).append(it)
    alloc = largest_remainder({s: len(v) for s, v in by_stratum.items()}, n)
    drawn: list[ControlItem] = []
    for stratum in sorted(by_stratum):
        pool = sorted(by_stratum[stratum], key=lambda it: it.control_id)
        drawn.extend(random.Random(seed).sample(pool, alloc.get(stratum, 0)))
    return sorted(drawn, key=lambda it: (it.stratum, it.control_id))


def _cell(text: str, limit: int = 600) -> str:
    """One markdown table cell: no pipes, no newlines, bounded."""
    flat = " ".join(str(text).split())
    if len(flat) > limit:
        flat = flat[: limit - 1].rstrip() + "…"
    return flat.replace("|", "\\|")


def render_human_sheet(
    spot: list[ControlItem], *, judge_model: str, total_items: int
) -> str:
    """The human-labelling sheet: question, gold, candidate, and a BLANK verdict column.

    It carries no verdict from the judge and no hint of which half an item came from — a labeller
    who can see the answer key is not an independent rater, and κ against a peeked label is noise.
    """
    lines = [
        "# Judge controls — human labelling sheet",
        "",
        (
            f"A stratified {len(spot)} of the {total_items} judge-validation control items "
            "(proportional across the six strata: paraphrase positives and the five perturbation "
            "families). Which items these are is fixed by seed, not by what the judge said."
        ),
        "",
        (
            "**How to label.** For each row decide, from the question and the reference answer "
            "alone, whether the candidate answer states the same facts. Write `CORRECT` or "
            "`INCORRECT` in the **Verdict** column. Leave nothing blank; if you genuinely cannot "
            "tell, write `INCORRECT` (the judge prompt tie-breaks the same way, so the comparison "
            "stays fair)."
        ),
        "",
        "The judge's own verdicts are deliberately **not** in this file. When every row is filled:",
        "",
        "    uv run python kappa.py --labels judge-controls-for-human.md",
        "",
        f"reports Cohen's κ between you and `{judge_model}` on these items.",
        "",
        "| # | control_id | Question | Reference answer (gold) | Candidate answer | Verdict |",
        "|---:|---|---|---|---|---|",
    ]
    for i, it in enumerate(spot, start=1):
        lines.append(
            f"| {i} | `{it.control_id}` | {_cell(it.question)} | {_cell(it.gold_answer)} | "
            f"{_cell(it.candidate)} |  |"
        )
    lines.append("")
    return "\n".join(lines)


def _pct(x: float) -> str:
    return f"{x * 100:.1f}%"


def _gate(ok: bool) -> str:
    return "PASS" if ok else "**FAIL**"


# Everything from this line down in judge-validation.md is written by a human and survives a
# re-render. A failed gate is a war-room item, and the analysis of WHY it failed is not something
# the harness can generate — but it must not be clobbered by the next run either.
HANDWRITTEN_MARKER = "<!-- hand-written below; preserved across regeneration -->"


def preserved_tail(existing: str) -> str:
    """The hand-written tail of a previous judge-validation.md, marker included."""
    idx = existing.find(HANDWRITTEN_MARKER)
    return "" if idx < 0 else existing[idx:]


def render_validation_md(
    report: ValidationReport,
    *,
    judge_prompt_sha: str,
    perturber_model: str,
    validation_seed: int,
    control_seed: int,
    spend_usd: float,
    spot_check_n: int,
    naive_judge_reference: float = 0.6281,
    prior: ValidationReport | None = None,
    prior_label: str = "original controls",
) -> str:
    """The published judge-validation write-up (eval/judge-validation.md).

    ``prior`` publishes a previous control set's numbers beside the current ones. A control set
    that gets revised has to show both, or the revision is indistinguishable from a quiet re-roll.
    """
    fam_rows = [
        f"| {fam} | {report.n_by_family.get(fam, 0)} | {report.accepted_by_family.get(fam, 0)} | "
        f"{_pct(report.far_by_family[fam])} | "
        f"{'≤ ' + _pct(report.far_gate_superseded) if fam == 'superseded-value' else '≤ ' + _pct(report.far_gate)} | "
        f"{_gate(report.far_by_family[fam] <= (report.far_gate_superseded if fam == 'superseded-value' else report.far_gate))} |"
        for fam in NEGATIVE_FAMILIES
        if fam in report.far_by_family
    ]
    kappa_line = (
        f"κ = {report.kappa:.3f}"
        if report.kappa == report.kappa  # not NaN
        else "κ — not yet computed (awaiting the human labels)"
    )
    total = report.n_positive + report.n_perturbed
    lines = [
        "# Judge validation — false-accept and false-reject rates",
        "",
        f"Judge `{report.judge_model}`, judge prompt sha `{judge_prompt_sha[:8]}…`, temperature 0.",
        (
            f"Scored on the committed {total}-item control set: **{report.n_perturbed} perturbed "
            f"negatives** (deterministic transforms, `judge-controls.jsonl`, seed {control_seed}) "
            f"and **{report.n_positive} paraphrase positives** (`judge-controls-positive.jsonl`, "
            f"generated once with `{perturber_model}`, draw seed {validation_seed})."
        ),
        "",
        "## Headline",
        "",
        "| Metric | Definition | Measured | Gate | Result |",
        "|---|---|---:|---:|---|",
        (
            f"| False-accept rate | perturbed negatives judged CORRECT | **{_pct(report.far)}** "
            f"({report.n_false_accept}/{report.n_perturbed}) | ≤ {_pct(report.far_gate)} | "
            f"{_gate(report.passes_far)} |"
        ),
        (
            "| FAR, superseded-value | the family the whole product is about | "
            f"**{_pct(report.far_by_family.get('superseded-value', float('nan')))}** "
            f"({report.accepted_by_family.get('superseded-value', 0)}/"
            f"{report.n_by_family.get('superseded-value', 0)}) | "
            f"≤ {_pct(report.far_gate_superseded)} | {_gate(report.passes_superseded)} |"
        ),
        (
            f"| False-reject rate | paraphrase positives not judged CORRECT | **{_pct(report.frr)}**"
            f" ({report.n_false_reject}/{report.n_positive}) | ≤ {_pct(report.frr_gate)} | "
            f"{_gate(report.passes_frr)} |"
        ),
        "",
        *(
            [
                "",
                "## Both control sets, side by side",
                "",
                (
                    f"The control set was revised after the first measured run; `{prior_label}` is "
                    "what that run scored. Nothing about the judge changed between these two "
                    "columns — same model, same prompt sha, same temperature, same token budget. "
                    "Only defective controls changed, and the change log below says which and why."
                ),
                "",
                f"| Metric | {prior_label} | corrected controls | gate |",
                "|---|---:|---:|---:|",
                (
                    f"| FAR, overall | {_pct(prior.far)} "
                    f"({prior.n_false_accept}/{prior.n_perturbed}) "
                    f"| **{_pct(report.far)}** ({report.n_false_accept}/{report.n_perturbed}) "
                    f"| ≤ {_pct(report.far_gate)} |"
                ),
                *[
                    f"| FAR, {fam} | {_pct(prior.far_by_family.get(fam, float('nan')))} "
                    f"| {_pct(report.far_by_family.get(fam, float('nan')))} | "
                    f"{'≤ ' + _pct(report.far_gate_superseded) if fam == 'superseded-value' else '—'} |"
                    for fam in NEGATIVE_FAMILIES
                ],
                (
                    f"| FRR | {_pct(prior.frr)} ({prior.n_false_reject}/{prior.n_positive}) "
                    f"| **{_pct(report.frr)}** ({report.n_false_reject}/{report.n_positive}) "
                    f"| ≤ {_pct(report.frr_gate)} |"
                ),
                f"| unparseable | {prior.n_unparseable} | {report.n_unparseable} | — |",
            ]
            if prior is not None
            else []
        ),
        "",
        (
            f"Reference point: an independent audit measured **{_pct(naive_judge_reference)}** "
            "false-accept for a naive judge prompt on a comparable control set. That number is why "
            "this prompt enumerates the rejection conditions explicitly and tie-breaks to "
            "INCORRECT."
        ),
        "",
        "## Per-family false-accept rate",
        "",
        "| Family | n | accepted | FAR | gate | result |",
        "|---|---:|---:|---:|---:|---|",
        *fam_rows,
        "",
        (
            f"Unparseable verdicts: {report.n_unparseable} of {total}. An unparseable reply counts "
            "as a rejection — never as an accept — so it can only hurt FRR, never flatter FAR. "
            "That is the conservative direction, not a free pass: whenever this count is non-zero "
            "the headline FAR is one end of an envelope whose other end treats every unparseable "
            "verdict as an accept, and both ends belong in the same paragraph. A reply that stops "
            "at the judge's `judge_max_tokens` budget is truncation, not a malformed judge — check "
            "`completion_tokens` in the ledger before concluding anything else."
        ),
        "",
        "## Human agreement (Cohen's κ)",
        "",
        (
            f"{kappa_line}. The stratified {spot_check_n}-item subset is exported to "
            "`judge-controls-for-human.md` with a blank verdict column and no judge verdicts "
            "visible. Fill it in, then run:"
        ),
        "",
        "    uv run python kappa.py --labels judge-controls-for-human.md",
        "",
        "## Reproducing",
        "",
        "    uv run errata-eval controls                     # the 60 negatives, no LLM, free",
        "    uv run errata-eval controls-positive            # the 60 positives, one cached LLM pass",
        "    uv run errata-eval judge-validate               # score all of them, write this file",
        "",
        (
            f"Incremental spend for the scored pass: ${spend_usd:.4f} (cache hits are $0 and are "
            "ledgered as such)."
        ),
    ]
    return "\n".join(lines) + "\n"


# ============================================================================================
# Deterministic negative controls — NO LLM, free, offline, reproducible from a fixed seed.
#
# The 60 *positive* paraphrase controls genuinely need a perturber model (build_control_set
# above). The 60 *negative* controls do not: an on-topic-but-wrong answer can be manufactured
# from the corpus's own gold data with template transforms, one per family (§4.3). This gives a
# deterministic, zero-cost floor for the judge-validation set that the funded run only augments.
# ============================================================================================

# Families in fixed order; 12 negatives each => 60. Distinct from PERTURB_FAMILIES (LLM prompts):
# these are mechanical transforms, and each records exactly which transform + source ids produced it.
NEGATIVE_FAMILIES: tuple[str, ...] = (
    "entity-swap",
    "value-shift",
    "attribution-flip",
    "superseded-value",
    "topical-filler",
)

# Seed governs ONLY which eligible questions each family draws; the transforms are deterministic.
CONTROL_SEED = 20260818

_PROPER_RE = re.compile(r"[A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)*")
# Mid-sentence capitalized spans (preceded by a lowercase word or comma) are almost always real
# proper nouns, not sentence-initial adverbs — a cleaner pool to draw entity swaps from.
_MIDSENT_RE = re.compile(r"(?<=[a-z,]\s)([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)*)")
_NUM_RE = re.compile(r"\d+")

# Capitalized words that are not entities (sentence starters / determiners / quantifiers). A
# single-word proper-noun match in this set is dropped; multi-word matches are always kept.
_STOPWORDS: frozenset[str] = frozenset(
    {
        "The", "A", "An", "I", "It", "He", "She", "We", "They", "You", "This", "That", "These",
        "Those", "There", "Here", "My", "Your", "His", "Her", "Our", "Its", "Their", "Some",
        "Many", "Most", "All", "Both", "Each", "Every", "Yes", "No", "Not", "And", "But", "Or",
        "So", "Then", "Now", "Also", "However", "When", "While", "During", "After", "Before",
        "Today", "Yesterday", "Tomorrow", "About", "For", "With", "From", "To", "Of", "In", "On",
        "AM", "PM", "M", "OK", "TV",
        "First", "Second", "Third", "Fourth", "Fifth", "Next", "Last", "Finally", "Later",
        "Overall", "Yeah",
    }
)

# Whole-word attribution swaps: first- and second-person flip to the assistant (attributing the
# fact to the wrong party), and the bare nouns "user"/"assistant" swap for each other so
# "The user …" -> "The assistant …" stays grammatical. Applied in ONE pass so tokens map
# independently and cannot cascade.
#
# REVISED 2026-08-17 after the first measured run (see judge-validation.md). Two defects in this
# transform were making it mismeasure the judge rather than test it, and both are fixed below by a
# predicate over the gold/question — never by a list of question ids, which would be selecting
# controls by the verdict they happened to get.
_ATTRIBUTION_MAP: dict[str, str] = {
    "myself": "the assistant",
    "mine": "the assistant's",
    "my": "the assistant's",
    "me": "the assistant",
    "i": "the assistant",
    "yourself": "the assistant",
    "yours": "the assistant's",
    "your": "the assistant's",
    "you": "the assistant",
    "user": "assistant",
    "assistant": "user",
}

# DEFECT 1 — the incomplete flip. When the gold NAMES the party ("The user would prefer responses
# that build upon THEIR previous experimentation…"), flipping only the leading noun leaves every
# co-referring pronoun pointing at the original party, and the candidate still describes the same
# preference. A judge accepting that is not clearly wrong, so the item tests nothing. These golds
# get the COMPLETE role swap: the named party and the pronouns that co-refer with it.
_COREF_MAP: dict[str, str] = {
    "theirs": "the assistant's",
    "their": "the assistant's",
    "them": "the assistant",
    "they": "the assistant",
}
_NAMES_PARTY_RE = re.compile(r"\b(?:user|assistant)\b", re.IGNORECASE)

# DEFECT 2 — the no-op flip. When the question asks what the ASSISTANT said ("you mentioned … what
# did you recommend?"), the gold is in the assistant's voice ("I recommended a Pilsner"), so
# mapping first person to "the assistant" preserves the meaning exactly: the candidate asserts
# nothing wrong and the judge is RIGHT to accept it. Such questions are skipped, and the family
# draws the next eligible one instead of shipping a control that cannot be failed honestly.
_FIRST_PERSON_RE = re.compile(r"\b(?:I|my|me|mine|myself)\b")
_ASSISTANT_VOICE_RE = re.compile(
    r"\byou(?:'ve|\s+have)?\s+(?:\w+\s+){0,2}?"
    r"(?:mentioned|recommended|suggested|said|told|gave|advised|listed|named|described|shared|"
    r"provided|offered|proposed)\b",
    re.IGNORECASE,
)


def _attribution_regex(mapping: dict[str, str]) -> re.Pattern[str]:
    return re.compile(
        r"\b(" + "|".join(sorted(mapping, key=len, reverse=True)) + r")\b", re.IGNORECASE
    )


_ATTRIBUTION_RE = _attribution_regex(_ATTRIBUTION_MAP)
_ATTRIBUTION_COREF_RE = _attribution_regex({**_ATTRIBUTION_MAP, **_COREF_MAP})


@dataclass(slots=True)
class NegativeControl:
    question_id: str
    question: str
    gold_answer: str
    candidate: str  # the derived on-topic-but-wrong answer
    family: str
    provenance: dict[str, Any]
    label: str = "negative"

    def to_row(self) -> dict[str, Any]:
        return {
            "question_id": self.question_id,
            "family": self.family,
            "label": self.label,
            "question": self.question,
            "gold_answer": self.gold_answer,
            "answer": self.candidate,
            "provenance": self.provenance,
        }


def _clean_spans(spans: list[str]) -> list[str]:
    out: list[str] = []
    for span in spans:
        if " " not in span and span in _STOPWORDS:
            continue
        if len(span) < 2:
            continue
        out.append(span)
    return out


def _entities(text: str) -> list[str]:
    """Proper-noun-ish spans, sentence-initial common words filtered out."""
    return _clean_spans([m.group(0) for m in _PROPER_RE.finditer(text)])


def _history_text(q: Question) -> str:
    return " ".join(t.content for s in q.sessions for t in s.turns)


def _history_entities(q: Question) -> list[str]:
    """Mid-sentence proper nouns from the history — the swap-replacement pool."""
    return _clean_spans([m.group(1) for m in _MIDSENT_RE.finditer(_history_text(q))])


def _pick_gold_entity(ents: list[str]) -> str:
    # The most specific entity in the gold answer: longest, ties broken lexicographically.
    return min(set(ents), key=lambda e: (-len(e), e))


def _pick_replacement(alts: list[str], like: str) -> str:
    # A plausible swap resembles the original in shape: same word count, then closest length.
    like_words = like.count(" ") + 1
    like_len = len(like)
    return min(
        set(alts),
        key=lambda e: (abs((e.count(" ") + 1) - like_words), abs(len(e) - like_len), e),
    )


def _t_entity_swap(q: Question) -> tuple[str, dict[str, Any]] | None:
    gold_ents = _entities(q.answer)
    if not gold_ents:
        return None
    gold_set = set(gold_ents)
    alts = [e for e in _history_entities(q) if e not in gold_set and len(e) >= 3]
    if not alts:
        return None
    original = _pick_gold_entity(gold_ents)
    replacement = _pick_replacement(alts, original)
    if replacement == original:
        return None
    candidate = q.answer.replace(original, replacement, 1)
    if candidate == q.answer:
        return None
    return candidate, {
        "transform": "entity-swap",
        "source_question_id": q.question_id,
        "original_entity": original,
        "replacement_entity": replacement,
        "replacement_source": "same-history proper noun",
    }


def _t_value_shift(q: Question) -> tuple[str, dict[str, Any]] | None:
    m = _NUM_RE.search(q.answer)
    if not m:
        return None
    original = m.group(0)
    shifted = str(int(original) + 1)
    candidate = q.answer[: m.start()] + shifted + q.answer[m.end() :]
    if candidate == q.answer:
        return None
    return candidate, {
        "transform": "value-shift",
        "source_question_id": q.question_id,
        "original_value": original,
        "shifted_value": shifted,
        "delta": 1,
    }


def _t_attribution_flip(q: Question) -> tuple[str, dict[str, Any]] | None:
    # DEFECT 2: an assistant-voice gold cannot be attribution-flipped — skip, do not mismeasure.
    if _FIRST_PERSON_RE.search(q.answer) and _ASSISTANT_VOICE_RE.search(q.question):
        return None
    # DEFECT 1: a gold that names the party gets the complete swap, pronouns included.
    complete = bool(_NAMES_PARTY_RE.search(q.answer))
    mapping = {**_ATTRIBUTION_MAP, **_COREF_MAP} if complete else _ATTRIBUTION_MAP
    pattern = _ATTRIBUTION_COREF_RE if complete else _ATTRIBUTION_RE
    flips: list[tuple[str, str]] = []

    def _repl(m: re.Match[str]) -> str:
        word = m.group(0)
        rep = mapping[word.lower()]
        if word[:1].isupper():
            rep = rep[:1].upper() + rep[1:]
        flips.append((word, rep))
        return rep

    candidate = pattern.sub(_repl, q.answer)
    if not flips or candidate == q.answer:
        return None
    return candidate, {
        "transform": "attribution-flip",
        "source_question_id": q.question_id,
        "flips": flips,
        "scope": "party+coreferents" if complete else "party",
    }


def _t_superseded_value(q: Question) -> tuple[str, dict[str, Any]] | None:
    """Use an EARLIER value that literally appears in this knowledge-update history."""
    hist = _history_text(q)
    gold_nums = _NUM_RE.findall(q.answer)
    if gold_nums:
        g0 = int(gold_nums[0])
        gold_set = {int(n) for n in gold_nums}
        hist_alts = sorted({int(n) for n in _NUM_RE.findall(hist)} - gold_set)
        if hist_alts:
            chosen = min(hist_alts, key=lambda v: (abs(v - g0), v))
            m = _NUM_RE.search(q.answer)
            assert m is not None
            candidate = q.answer[: m.start()] + str(chosen) + q.answer[m.end() :]
            if candidate != q.answer:
                return candidate, {
                    "transform": "superseded-value",
                    "source_question_id": q.question_id,
                    "gold_value": m.group(0),
                    "earlier_value": str(chosen),
                    "mode": "numeric",
                    "earlier_source": "same knowledge-update history",
                }
    gold_ents = _entities(q.answer)
    if gold_ents:
        gold_set = set(gold_ents)
        alts = [e for e in _history_entities(q) if e not in gold_set and len(e) >= 3]
        if alts:
            original = _pick_gold_entity(gold_ents)
            replacement = _pick_replacement(alts, original)
            candidate = q.answer.replace(original, replacement, 1)
            if candidate != q.answer:
                return candidate, {
                    "transform": "superseded-value",
                    "source_question_id": q.question_id,
                    "gold_value": original,
                    "earlier_value": replacement,
                    "mode": "entity",
                    "earlier_source": "same knowledge-update history",
                }
    return None


def _t_topical_filler(q: Question) -> tuple[str, dict[str, Any]] | None:
    """A fluent on-topic hedge that contains NONE of the gold facts (numbers or entities)."""
    question = q.question.strip()
    candidate = (
        "Your chat history touches on this topic, but it does not record a specific answer to "
        f'"{question}"; the earlier conversations stay general and never pin down a single value.'
    )
    gold_tokens = set(_NUM_RE.findall(q.answer)) | set(_entities(q.answer))
    for tok in gold_tokens:
        if tok and tok in candidate:  # the question echoed a gold fact — not fact-free, skip
            return None
    return candidate, {
        "transform": "topical-filler",
        "source_question_id": q.question_id,
        "basis": "question-derived generic hedge",
    }


_NEGATIVE_TRANSFORMS = {
    "entity-swap": _t_entity_swap,
    "value-shift": _t_value_shift,
    "attribution-flip": _t_attribution_flip,
    "superseded-value": _t_superseded_value,
    "topical-filler": _t_topical_filler,
}


def build_negative_controls(
    corpus: list[Question], *, seed: int = CONTROL_SEED, family_size: int = FAMILY_SIZE
) -> list[NegativeControl]:
    """Manufacture ``family_size`` negatives per family from gold data. Deterministic given seed.

    superseded-value draws only from knowledge-update questions (its whole point is an
    earlier/updated value); the rest draw from the full non-abstention pool. No question is
    reused across families. Raises if any family cannot be filled — that means the corpus changed.
    """
    non_abs = sorted((q for q in corpus if not q.abstention), key=lambda q: q.question_id)
    knowledge_update = [q for q in non_abs if q.question_type == "knowledge-update"]

    used: set[str] = set()
    items: list[NegativeControl] = []
    for fam in NEGATIVE_FAMILIES:
        pool = knowledge_update if fam == "superseded-value" else non_abs
        order = list(pool)
        random.Random(seed + NEGATIVE_FAMILIES.index(fam)).shuffle(order)
        transform = _NEGATIVE_TRANSFORMS[fam]
        picked = 0
        for q in order:
            if q.question_id in used:
                continue
            res = transform(q)
            if res is None:
                continue
            candidate, provenance = res
            items.append(
                NegativeControl(
                    question_id=q.question_id,
                    question=q.question,
                    gold_answer=q.answer,
                    candidate=candidate,
                    family=fam,
                    provenance=provenance,
                )
            )
            used.add(q.question_id)
            picked += 1
            if picked >= family_size:
                break
        if picked < family_size:
            raise ValueError(
                f"family {fam!r}: only {picked}/{family_size} negatives available — corpus changed"
            )
    return items
