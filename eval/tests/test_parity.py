"""Parity gate — mocked /api/meta JSON, no live API needed."""

from __future__ import annotations

from errata_eval.cli import check_parity
from errata_eval.prompts import ANSWER_PROMPT_SHA256

ANSWER_MODEL = "qwen/qwen3.7-flash"


def _meta(**overrides):
    meta = {
        "answer_model": ANSWER_MODEL,
        "answer_prompt_sha256": ANSWER_PROMPT_SHA256,
        "extractor_model": "x",
        "conflict_judge_model": "y",
        "git_sha": "deadbeef",
        "corpus_revision": "98d7416c",
    }
    meta.update(overrides)
    return meta


def test_parity_ok_on_match() -> None:
    ok, problems = check_parity(
        _meta(), answer_prompt_sha=ANSWER_PROMPT_SHA256, expected_answer_model=ANSWER_MODEL
    )
    assert ok
    assert problems == []


def test_parity_fails_on_prompt_sha_mismatch() -> None:
    ok, problems = check_parity(
        _meta(answer_prompt_sha256="0" * 64),
        answer_prompt_sha=ANSWER_PROMPT_SHA256,
        expected_answer_model=ANSWER_MODEL,
    )
    assert not ok
    assert any("answer_prompt_sha256" in p for p in problems)


def test_parity_fails_on_model_mismatch() -> None:
    ok, problems = check_parity(
        _meta(answer_model="google/gemini-3.7-flash"),
        answer_prompt_sha=ANSWER_PROMPT_SHA256,
        expected_answer_model=ANSWER_MODEL,
    )
    assert not ok
    assert any("answer_model" in p for p in problems)


def test_parity_fails_on_missing_fields() -> None:
    ok, problems = check_parity(
        {}, answer_prompt_sha=ANSWER_PROMPT_SHA256, expected_answer_model=ANSWER_MODEL
    )
    assert not ok
    assert len(problems) == 2
