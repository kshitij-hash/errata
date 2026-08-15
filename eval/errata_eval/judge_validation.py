"""Judge validation — the control-set protocol (§4.3), measured, published, and gated.

Builds a control set of positive controls (should be accepted) and perturbed negatives (should
be rejected) across five perturbation families, scores it with a candidate judge, and reports the
false-accept rate. A judge is pinned only if FAR <= 10% overall and superseded-value FAR <= 8%.
We publish the number whatever it is. Credit-gated.
"""

from __future__ import annotations

import random
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from .dataset import Question, largest_remainder
from .judge import judge_answer
from .prompts import fill_perturb_prompt

# Perturbed-negative families (§4.3). 12 items each so the failure surface is characterised.
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


def build_control_set(
    corpus: list[Question],
    perturber_client: Any,
    perturber_model: str,
    *,
    n: int = 60,
    seed: int = 20260818,
) -> list[ControlItem]:
    """Build 2n control items: n positive controls + n perturbed negatives (families balanced)."""
    questions = _draw_stratified(corpus, n, seed)
    families = list(PERTURB_FAMILIES)
    items: list[ControlItem] = []
    for i, q in enumerate(questions):
        # positive control
        pos = perturber_client.complete(
            model=perturber_model,
            prompt=fill_perturb_prompt(
                question=q.question, gold_answer=q.answer, instruction=POSITIVE_INSTRUCTION
            ),
            temperature=0.7,
            max_tokens=200,
            op="perturb",
            ref={"question_id": q.question_id, "kind": "positive"},
        )
        items.append(
            ControlItem(q.question_id, q.question, q.answer, pos.text.strip(), "positive", "")
        )
        # perturbed negative — family assigned by block so each family gets exactly n/len items
        family = families[i % len(families)]
        neg = perturber_client.complete(
            model=perturber_model,
            prompt=fill_perturb_prompt(
                question=q.question, gold_answer=q.answer, instruction=PERTURB_FAMILIES[family]
            ),
            temperature=0.7,
            max_tokens=200,
            op="perturb",
            ref={"question_id": q.question_id, "kind": "perturbed", "family": family},
        )
        items.append(
            ControlItem(q.question_id, q.question, q.answer, neg.text.strip(), "perturbed", family)
        )
    return items


def score_control_set(
    judge_client: Any, judge_model: str, items: list[ControlItem]
) -> list[ControlItem]:
    for item in items:
        j = judge_answer(
            judge_client,
            judge_model,
            question=item.question,
            gold_answer=item.gold_answer,
            candidate_answer=item.candidate,
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
    passes_far: bool = field(default=False)
    passes_superseded: bool = field(default=False)
    passes_frr: bool = field(default=False)

    @property
    def pinned(self) -> bool:
        return self.passes_far and self.passes_superseded


def evaluate(
    judge_model: str,
    items: list[ControlItem],
    *,
    far_gate: float = 0.10,
    far_gate_superseded: float = 0.08,
    frr_gate: float = 0.15,
) -> ValidationReport:
    positives = [it for it in items if it.kind == "positive"]
    perturbed = [it for it in items if it.kind == "perturbed"]
    n_pos = len(positives) or 1
    n_neg = len(perturbed) or 1

    # FAR = perturbed negatives marked CORRECT / total perturbed.
    far = sum(1 for it in perturbed if it.verdict == "CORRECT") / n_neg
    # FRR = positive controls marked INCORRECT / total positives.
    frr = sum(1 for it in positives if it.verdict == "INCORRECT") / n_pos

    far_by_family: dict[str, float] = {}
    for fam in PERTURB_FAMILIES:
        fam_items = [it for it in perturbed if it.family == fam]
        if fam_items:
            far_by_family[fam] = (
                sum(1 for it in fam_items if it.verdict == "CORRECT") / len(fam_items)
            )

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
    )
    report.passes_far = far <= far_gate
    report.passes_superseded = far_by_family.get("superseded-value", 1.0) <= far_gate_superseded
    report.passes_frr = frr <= frr_gate
    return report
