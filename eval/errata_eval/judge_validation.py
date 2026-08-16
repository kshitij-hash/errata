"""Judge validation — the control-set protocol (§4.3), measured, published, and gated.

Builds a control set of positive controls (should be accepted) and perturbed negatives (should
be rejected) across five perturbation families, scores it with a candidate judge, and reports the
false-accept rate. A judge is pinned only if FAR <= 10% overall and superseded-value FAR <= 8%.
We publish the number whatever it is. Credit-gated.
"""

from __future__ import annotations

import random
import re
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

# Whole-word attribution swaps. In these gold answers first- AND second-person both refer to the
# USER, so both flip to the assistant (attributing the fact to the wrong party); the bare nouns
# "user"/"assistant" swap for each other so "The user …" -> "The assistant …" stays grammatical.
# Applied in ONE pass so tokens map independently and cannot cascade.
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
_ATTRIBUTION_RE = re.compile(
    r"\b(" + "|".join(sorted(_ATTRIBUTION_MAP, key=len, reverse=True)) + r")\b",
    re.IGNORECASE,
)


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
    flips: list[tuple[str, str]] = []

    def _repl(m: re.Match[str]) -> str:
        word = m.group(0)
        rep = _ATTRIBUTION_MAP[word.lower()]
        if word[:1].isupper():
            rep = rep[:1].upper() + rep[1:]
        flips.append((word, rep))
        return rep

    candidate = _ATTRIBUTION_RE.sub(_repl, q.answer)
    if not flips or candidate == q.answer:
        return None
    return candidate, {
        "transform": "attribution-flip",
        "source_question_id": q.question_id,
        "flips": flips,
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
