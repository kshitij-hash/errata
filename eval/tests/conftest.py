"""Shared fixtures. Loads the 277 MB corpus ONCE per session (orjson, ~2 s)."""

from __future__ import annotations

from pathlib import Path

import pytest

from errata_eval.dataset import load_corpus

# eval/tests/conftest.py -> tests -> eval -> repo root -> data-raw/
CORPUS_PATH = Path(__file__).resolve().parents[2] / "data-raw" / "longmemeval_s_cleaned.json"


@pytest.fixture(scope="session")
def corpus_path() -> Path:
    if not CORPUS_PATH.exists():
        pytest.skip(f"corpus not present at {CORPUS_PATH}")
    return CORPUS_PATH


@pytest.fixture(scope="session")
def corpus(corpus_path: Path):
    return load_corpus(corpus_path)
