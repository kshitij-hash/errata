"""The committed ingest-coupling artifact ``sample-150.json``.

It pins the exact 150 question_ids every arm answers. These assertions bind that file to the
seeded sampler in ``dataset.sample`` so the artifact can never silently drift from the code that
produced it, nor from the corpus it indexes into.
"""

from __future__ import annotations

from pathlib import Path

import orjson

from errata_eval.dataset import is_abstention, sample

# eval/tests/test_sample_artifact.py -> tests -> eval
ARTIFACT = Path(__file__).resolve().parents[1] / "sample-150.json"
SAMPLE_SEED = 20260819
SAMPLE_N = 150


def _load_artifact() -> list[str]:
    return orjson.loads(ARTIFACT.read_bytes())


def test_artifact_exists_and_has_exactly_150_unique_ids() -> None:
    ids = _load_artifact()
    assert isinstance(ids, list)
    assert len(ids) == 150
    assert len(set(ids)) == 150


def test_artifact_contains_all_30_abstention_ids(corpus) -> None:
    ids = set(_load_artifact())
    abstention_ids = {q.question_id for q in corpus if q.abstention}
    assert len(abstention_ids) == 30
    # every abstention question is present — abstention is always taken whole.
    assert abstention_ids <= ids
    assert sum(1 for qid in ids if is_abstention(qid)) == 30


def test_artifact_matches_the_seeded_sampler(corpus) -> None:
    # Deterministic under the same seed: the file is exactly what dataset.sample produces.
    expected = [q.question_id for q in sample(corpus, SAMPLE_N, SAMPLE_SEED)]
    assert _load_artifact() == expected


def test_artifact_is_sorted_and_every_id_exists_in_corpus(corpus) -> None:
    ids = _load_artifact()
    assert ids == sorted(ids)  # stable, tokenizer-independent order
    corpus_ids = {q.question_id for q in corpus}
    assert set(ids) <= corpus_ids
