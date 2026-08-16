"""The committed deterministic negative judge-control set (``judge-controls.jsonl``).

60 on-topic-but-wrong answers manufactured from the corpus's own gold data with template
transforms — NO LLM. These assertions bind the committed file to ``build_negative_controls`` so it
is fully reproducible from the fixed seed, and check every row carries a valid family + provenance.
The 60 *positive* paraphrase controls genuinely need an LLM, so only a no-rows stub is committed.
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path

import orjson

from errata_eval.judge_validation import (
    CONTROL_SEED,
    FAMILY_SIZE,
    NEGATIVE_FAMILIES,
    build_negative_controls,
)

_EVAL = Path(__file__).resolve().parents[1]
ARTIFACT = _EVAL / "judge-controls.jsonl"
POSITIVE_STUB = _EVAL / "judge-controls-positive.stub.jsonl"


def _rows() -> list[dict]:
    return [orjson.loads(line) for line in ARTIFACT.read_bytes().splitlines() if line]


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


def test_positive_controls_are_a_no_row_stub() -> None:
    text = POSITIVE_STUB.read_text(encoding="utf-8")
    lines = [ln for ln in text.splitlines() if ln.strip()]
    assert len(lines) == 1  # exactly the one header line
    assert lines[0].startswith("# TODO(funded)")
    # no fabricated JSON rows.
    for ln in lines:
        assert not ln.lstrip().startswith("{")
