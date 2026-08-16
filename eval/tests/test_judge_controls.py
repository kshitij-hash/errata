"""The committed judge-control set — both halves.

``judge-controls.jsonl``: 60 on-topic-but-wrong answers manufactured from the corpus's own gold
data with template transforms — NO LLM. These assertions bind the committed file to
``build_negative_controls`` so it is fully reproducible from the fixed seed, and check every row
carries a valid family + provenance.

``judge-controls-positive.jsonl``: 60 paraphrased-gold answers from one perturber pass. An LLM
output cannot be re-derived offline, so what is asserted here is everything that does not need the
model — which questions it covers (a pure function of the seeded draw), its shape, its provenance —
plus the join between the two halves that ``judge-validate`` scores.
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path

import orjson

from errata_eval.judge_validation import (
    CONTROL_SEED,
    FAMILY_SIZE,
    NEGATIVE_FAMILIES,
    _draw_stratified,
    build_negative_controls,
    control_items_from_rows,
)

_EVAL = Path(__file__).resolve().parents[1]
ARTIFACT = _EVAL / "judge-controls.jsonl"
POSITIVE_ARTIFACT = _EVAL / "judge-controls-positive.jsonl"
VALIDATION_SEED = 20260818  # eval.toml [judge_validation].validation_seed
POSITIVE_N = 60


def _rows() -> list[dict]:
    return [orjson.loads(line) for line in ARTIFACT.read_bytes().splitlines() if line]


def _positive_rows() -> list[dict]:
    return [orjson.loads(line) for line in POSITIVE_ARTIFACT.read_bytes().splitlines() if line]


def test_sixty_rows_twelve_per_family() -> None:
    rows = _rows()
    assert len(rows) == 60
    counts = Counter(r["family"] for r in rows)
    assert set(counts) == set(NEGATIVE_FAMILIES)
    assert all(counts[f] == FAMILY_SIZE for f in NEGATIVE_FAMILIES)  # 12 each => 60


def test_every_row_is_a_valid_negative_with_provenance(corpus) -> None:
    corpus_ids = {q.question_id for q in corpus}
    for r in _rows():
        assert r["label"] == "negative"
        assert r["family"] in NEGATIVE_FAMILIES
        prov = r["provenance"]
        assert isinstance(prov, dict)
        assert prov["transform"] == r["family"]  # which transform produced it
        assert prov["source_question_id"] in corpus_ids  # source ids are real
        # the candidate is a real perturbation, not a copy of the gold answer.
        assert r["answer"] != r["gold_answer"]
        assert isinstance(r["question"], str) and r["question"]


def test_fully_reproducible_from_fixed_seed(corpus) -> None:
    built = build_negative_controls(corpus, seed=CONTROL_SEED)
    # normalize tuples->lists the way JSON serialization does, then compare row-for-row.
    expected = [orjson.loads(orjson.dumps(item.to_row())) for item in built]
    assert _rows() == expected


def test_builder_is_deterministic(corpus) -> None:
    a = [item.to_row() for item in build_negative_controls(corpus, seed=CONTROL_SEED)]
    b = [item.to_row() for item in build_negative_controls(corpus, seed=CONTROL_SEED)]
    assert a == b


def test_positive_controls_cover_the_seeded_stratified_draw(corpus) -> None:
    """Which questions carry a positive control is a pure function of the seed, so it is checkable
    even though the paraphrases themselves came from a model."""
    rows = _positive_rows()
    assert len(rows) == POSITIVE_N
    expected = [q.question_id for q in _draw_stratified(corpus, POSITIVE_N, VALIDATION_SEED)]
    assert [r["question_id"] for r in rows] == expected


def test_every_positive_row_is_a_labelled_paraphrase_with_provenance(corpus) -> None:
    gold_by_qid = {q.question_id: q for q in corpus}
    for r in _positive_rows():
        assert r["label"] == "positive"
        assert r["family"] == ""  # positives carry no perturbation family
        assert isinstance(r["answer"], str) and r["answer"].strip()
        prov = r["provenance"]
        assert prov["transform"] == "paraphrase"
        assert prov["source_question_id"] == r["question_id"]
        assert prov["perturber_model"]  # which model produced it
        assert prov["draw_seed"] == VALIDATION_SEED
        # the row's question/gold are the corpus's, not the model's paraphrase of them.
        q = gold_by_qid[r["question_id"]]
        assert r["question"] == q.question
        assert r["gold_answer"] == q.answer


def test_the_two_halves_load_as_one_120_item_control_set() -> None:
    items = control_items_from_rows(_rows() + _positive_rows())
    assert len(items) == 120
    assert Counter(it.kind for it in items) == {"perturbed": 60, "positive": 60}
    # every item knows the verdict a perfect judge would give it, and has a unique identity.
    assert Counter(it.expected for it in items) == {"INCORRECT": 60, "CORRECT": 60}
    assert len({it.control_id for it in items}) == 120
