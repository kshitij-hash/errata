"""Corpus loading, checksums, strata, and seeded stratified sampling.

The truth about abstention lives in ONE place here — ``is_abstention`` — and a unit test
asserts the corpus contains exactly 30 abstention questions with the exact per-type breakdown.
If that test fails, the dataset changed and the run is void.
"""

from __future__ import annotations

import hashlib
import math
import random
from collections import Counter
from pathlib import Path

import orjson
from pydantic import BaseModel, ConfigDict

# question_type -> reported ability. Abstention is orthogonal and handled separately.
_ABILITY_BY_TYPE: dict[str, str] = {
    "single-session-user": "information_extraction",
    "single-session-assistant": "information_extraction",
    "single-session-preference": "information_extraction",
    "multi-session": "multi_session",
    "temporal-reasoning": "temporal",
    "knowledge-update": "knowledge_update",
}

ABSTENTION_STRATUM = "_ABSTENTION"
ABSTENTION_ABILITY = "abstention"

# Reported abilities (the four non-abstention accuracy columns), in table order.
REPORTED_ABILITIES: tuple[str, ...] = (
    "information_extraction",
    "multi_session",
    "temporal",
    "knowledge_update",
)


def is_abstention(q: Question | dict | str) -> bool:
    """Gold abstention is defined ONLY by the question_id suffix. NOT question_type."""
    if isinstance(q, str):
        qid = q
    elif isinstance(q, Question):
        qid = q.question_id
    else:
        qid = q["question_id"]
    return qid.endswith("_abs")


def ability_of(question_type: str, abstention: bool) -> str:
    if abstention:
        return ABSTENTION_ABILITY
    return _ABILITY_BY_TYPE.get(question_type, question_type)


# --------------------------------------------------------------------------------------------
# frozen models
# --------------------------------------------------------------------------------------------
class Turn(BaseModel):
    model_config = ConfigDict(frozen=True)
    role: str
    content: str
    has_answer: bool = False
    turn_index: int  # POSITIONAL 0-based index within its session (turns carry no id)


class Session(BaseModel):
    model_config = ConfigDict(frozen=True)
    session_id: str
    date: str
    turns: tuple[Turn, ...]


class Question(BaseModel):
    model_config = ConfigDict(frozen=True)
    question_id: str
    question_type: str
    question: str
    question_date: str
    answer: str  # gold; never shown to any answering arm
    abstention: bool
    ability: str
    sessions: tuple[Session, ...]
    evidence_session_ids: tuple[str, ...]  # answer_session_ids (session-level gold)
    evidence_turn_refs: tuple[tuple[str, int], ...]  # (session_id, turn_index) has_answer gold

    @property
    def history_id(self) -> str:
        """history_id == question_id — the identity mapping sent to POST /api/ask."""
        return self.question_id

    def stratum(self) -> str:
        return ABSTENTION_STRATUM if self.abstention else self.question_type


def stratum_of(q: Question) -> str:
    return q.stratum()


# --------------------------------------------------------------------------------------------
# checksum + load
# --------------------------------------------------------------------------------------------
def sha256_file(path: str | Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while block := f.read(chunk):
            h.update(block)
    return h.hexdigest()


def _build_question(raw: dict) -> Question:
    session_ids = raw["haystack_session_ids"]
    dates = raw["haystack_dates"]
    sessions_raw = raw["haystack_sessions"]
    if not (len(session_ids) == len(dates) == len(sessions_raw)):
        raise ValueError(f"zip length mismatch for {raw['question_id']}")

    abstention = is_abstention(raw["question_id"])
    sessions: list[Session] = []
    turn_refs: list[tuple[str, int]] = []
    for sid, date, turns_raw in zip(session_ids, dates, sessions_raw):
        turns: list[Turn] = []
        for idx, t in enumerate(turns_raw):
            has_answer = bool(t.get("has_answer", False))
            turns.append(
                Turn(role=t["role"], content=t["content"], has_answer=has_answer, turn_index=idx)
            )
            if has_answer:
                turn_refs.append((sid, idx))
        sessions.append(Session(session_id=sid, date=date, turns=tuple(turns)))

    return Question(
        question_id=raw["question_id"],
        question_type=raw["question_type"],
        question=raw["question"],
        question_date=raw["question_date"],
        answer=str(raw["answer"]),  # ~32 gold answers are ints (e.g. counts); store as text
        abstention=abstention,
        ability=ability_of(raw["question_type"], abstention),
        sessions=tuple(sessions),
        evidence_session_ids=tuple(raw.get("answer_session_ids", []) or []),
        evidence_turn_refs=tuple(turn_refs),
    )


def load_corpus(path: str | Path) -> list[Question]:
    """Load and parse the corpus with orjson (the blob is ~277 MB)."""
    with open(path, "rb") as f:
        raw = orjson.loads(f.read())
    return [_build_question(q) for q in raw]


def verify_checksum(path: str | Path, expected_sha256: str) -> str:
    actual = sha256_file(path)
    if actual != expected_sha256:
        raise ValueError(
            f"corpus sha256 mismatch: expected {expected_sha256}, got {actual}. "
            "A changed corpus invalidates every published number."
        )
    return actual


# --------------------------------------------------------------------------------------------
# strata + invariants
# --------------------------------------------------------------------------------------------
def strata(corpus: list[Question]) -> dict[str, list[Question]]:
    out: dict[str, list[Question]] = {}
    for q in corpus:
        out.setdefault(q.stratum(), []).append(q)
    return out


def abstention_breakdown(corpus: list[Question]) -> dict[str, int]:
    """Per-question_type counts among the abstention questions."""
    return dict(Counter(q.question_type for q in corpus if q.abstention))


def question_type_histogram(corpus: list[Question]) -> dict[str, int]:
    return dict(Counter(q.question_type for q in corpus))


def has_answer_count(corpus: list[Question]) -> int:
    return sum(len(q.evidence_turn_refs) for q in corpus)


# --------------------------------------------------------------------------------------------
# largest-remainder (Hare) allocation
# --------------------------------------------------------------------------------------------
def largest_remainder(populations: dict[str, int], total: int) -> dict[str, int]:
    """Allocate ``total`` proportional to populations, Hare/largest-remainder rounding.

    Ties in the fractional remainder are broken by stratum name ascending — deterministic,
    no seed involvement.
    """
    if total <= 0:
        return {k: 0 for k in populations}
    n = sum(populations.values())
    if n == 0:
        return {k: 0 for k in populations}
    quotas = {k: populations[k] * total / n for k in populations}
    floors = {k: math.floor(quotas[k]) for k in populations}
    remainder = total - sum(floors.values())
    order = sorted(populations, key=lambda k: (-(quotas[k] - floors[k]), k))
    for k in order[:remainder]:
        floors[k] += 1
    return floors


# --------------------------------------------------------------------------------------------
# stratified sampling — seeded, proportional, abstention whole
# --------------------------------------------------------------------------------------------
def sample(
    corpus: list[Question],
    n: int,
    seed: int,
    *,
    abstention_whole: bool = True,
    abstention_floor: int = 5,
) -> list[Question]:
    """Seeded stratified sample.

    - Abstention taken WHOLE (all 30) when ``abstention_whole`` and ``n`` allows; otherwise a
      floor of ``abstention_floor`` deterministically sampled (the smoke relaxation).
    - Remaining budget allocated across the six non-abstention strata proportional to size,
      largest-remainder rounding.
    - Within a stratum: sort by question_id ascending, then ``Random(seed).sample(...)``.
    - Sample membership depends on ``seed`` only — not dict/file order, not Python version.
    """
    by_stratum = strata(corpus)
    abst = sorted(by_stratum.get(ABSTENTION_STRATUM, []), key=lambda q: q.question_id)
    non_abs = {k: v for k, v in by_stratum.items() if k != ABSTENTION_STRATUM}

    if abstention_whole and n >= len(abst):
        chosen_abs = list(abst)
    else:
        k = min(abstention_floor if not abstention_whole else len(abst), len(abst), n)
        chosen_abs = random.Random(seed).sample(abst, k)
        chosen_abs.sort(key=lambda q: q.question_id)

    remaining = n - len(chosen_abs)
    populations = {name: len(qs) for name, qs in non_abs.items()}
    alloc = largest_remainder(populations, remaining)

    chosen: list[Question] = list(chosen_abs)
    for name in sorted(non_abs):
        pool = sorted(non_abs[name], key=lambda q: q.question_id)
        k = alloc.get(name, 0)
        if k > len(pool):
            raise ValueError(f"stratum {name} allocation {k} exceeds population {len(pool)}")
        chosen.extend(random.Random(seed).sample(pool, k))

    return sorted(chosen, key=lambda q: q.question_id)


def allocation(corpus: list[Question], n: int, *, abstention_whole: bool = True) -> dict[str, int]:
    """The per-stratum allocation for a sample of size n (arithmetic only, no seed)."""
    by_stratum = strata(corpus)
    abst = by_stratum.get(ABSTENTION_STRATUM, [])
    non_abs = {k: v for k, v in by_stratum.items() if k != ABSTENTION_STRATUM}
    n_abs = len(abst) if abstention_whole else min(5, len(abst))
    populations = {name: len(qs) for name, qs in non_abs.items()}
    alloc = largest_remainder(populations, n - n_abs)
    alloc[ABSTENTION_STRATUM] = n_abs
    return alloc
