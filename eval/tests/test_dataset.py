"""Corpus invariants. If any of these fails, the dataset changed and the run is void."""

from __future__ import annotations

from pathlib import Path

from errata_eval.dataset import (
    abstention_breakdown,
    has_answer_count,
    is_abstention,
    question_type_histogram,
    sha256_file,
)

EXPECTED_SHA256 = "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442"

# The load-bearing assertion: 30 abstentions with this exact per-type breakdown (the eval protocol/C1, C2).
EXPECTED_ABSTENTION_BREAKDOWN = {
    "multi-session": 12,
    "temporal-reasoning": 6,
    "knowledge-update": 6,
    "single-session-user": 6,
}

EXPECTED_QTYPE_HISTOGRAM = {
    "knowledge-update": 78,
    "multi-session": 133,
    "single-session-assistant": 56,
    "single-session-preference": 30,
    "single-session-user": 70,
    "temporal-reasoning": 133,
}


def test_file_sha256(corpus_path: Path) -> None:
    assert sha256_file(corpus_path) == EXPECTED_SHA256


def test_corpus_size_and_unique_ids(corpus) -> None:
    assert len(corpus) == 500
    assert len({q.question_id for q in corpus}) == 500


def test_exactly_30_abstentions_with_breakdown(corpus) -> None:
    abstentions = [q for q in corpus if q.abstention]
    assert len(abstentions) == 30
    assert abstention_breakdown(corpus) == EXPECTED_ABSTENTION_BREAKDOWN


def test_is_abstention_is_id_suffix_not_type(corpus) -> None:
    # Abstention is defined ONLY by the question_id suffix; no question_type ends in _abs.
    for q in corpus:
        assert is_abstention(q.question_id) == q.abstention
        assert not q.question_type.endswith("_abs")


def test_raw_question_type_histogram(corpus) -> None:
    assert question_type_histogram(corpus) == EXPECTED_QTYPE_HISTOGRAM


def test_has_answer_count(corpus) -> None:
    assert has_answer_count(corpus) == 896


def test_turn_indices_are_positional(corpus) -> None:
    q = corpus[0]
    for session in q.sessions:
        assert [t.turn_index for t in session.turns] == list(range(len(session.turns)))


def test_evidence_subset_and_zip_lengths(corpus) -> None:
    for q in corpus:
        session_ids = {s.session_id for s in q.sessions}
        assert set(q.evidence_session_ids).issubset(session_ids)
        # every has_answer turn ref points at a real (session, index)
        for sid, idx in q.evidence_turn_refs:
            assert sid in session_ids
