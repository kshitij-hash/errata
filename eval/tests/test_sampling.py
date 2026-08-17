"""Allocation arithmetic + seed stability; the abstention set is always taken whole."""

from __future__ import annotations

from errata_eval.dataset import ABSTENTION_STRATUM, allocation, largest_remainder, sample

# The computed allocation for n=150 (spec the eval protocol, arithmetic verified).
EXPECTED_ALLOC_150 = {
    "knowledge-update": 18,
    "multi-session": 31,
    "single-session-assistant": 14,
    "single-session-preference": 8,
    "single-session-user": 16,
    "temporal-reasoning": 33,
}

SAMPLE_SEED = 20260819


def test_largest_remainder_matches_spec_table() -> None:
    populations = {
        "knowledge-update": 72,
        "multi-session": 121,
        "single-session-assistant": 56,
        "single-session-preference": 30,
        "single-session-user": 64,
        "temporal-reasoning": 127,
    }
    alloc = largest_remainder(populations, 120)
    assert alloc == EXPECTED_ALLOC_150
    assert sum(alloc.values()) == 120


def test_largest_remainder_ties_break_by_name() -> None:
    # Two strata with equal remainder; only one seat left -> the name-ascending one wins.
    alloc = largest_remainder({"bbb": 1, "aaa": 1}, 1)
    assert alloc == {"aaa": 1, "bbb": 0}


def test_allocation_over_corpus(corpus) -> None:
    alloc = allocation(corpus, 150)
    assert alloc[ABSTENTION_STRATUM] == 30
    non_abs = {k: v for k, v in alloc.items() if k != ABSTENTION_STRATUM}
    assert non_abs == EXPECTED_ALLOC_150
    assert sum(alloc.values()) == 150


def test_sample_size_and_abstention_whole(corpus) -> None:
    chosen = sample(corpus, 150, SAMPLE_SEED)
    assert len(chosen) == 150
    assert sum(1 for q in chosen if q.abstention) == 30  # all 30, always


def test_sample_per_stratum_counts(corpus) -> None:
    chosen = sample(corpus, 150, SAMPLE_SEED)
    counts: dict[str, int] = {}
    for q in chosen:
        counts[q.stratum()] = counts.get(q.stratum(), 0) + 1
    assert counts[ABSTENTION_STRATUM] == 30
    for stratum, expected in EXPECTED_ALLOC_150.items():
        assert counts.get(stratum, 0) == expected


def test_sample_is_seed_stable_and_sorted(corpus) -> None:
    a = [q.question_id for q in sample(corpus, 150, SAMPLE_SEED)]
    b = [q.question_id for q in sample(corpus, 150, SAMPLE_SEED)]
    assert a == b
    assert a == sorted(a)  # returned sorted by question_id


def test_sample_membership_depends_only_on_seed(corpus) -> None:
    a = {q.question_id for q in sample(corpus, 150, 11)}
    b = {q.question_id for q in sample(corpus, 150, 22)}
    # Different seeds pick different non-abstention members (abstention set is identical).
    assert a != b


def test_smoke_relaxes_abstention_to_floor(corpus) -> None:
    chosen = sample(corpus, 25, 11, abstention_whole=False, abstention_floor=5)
    assert len(chosen) == 25
    assert sum(1 for q in chosen if q.abstention) == 5
