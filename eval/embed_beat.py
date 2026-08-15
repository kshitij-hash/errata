#!/usr/bin/env python
"""Demo beat 1 — the ``vector_baseline`` fixture (best-effort, needs the `embed` extra).

Computes BAAI/bge-small-en-v1.5 embeddings for a query against a *current* claim and a
*superseded* claim, and writes ``apps/web/fixtures/beat-0.94.json``:

    {"query": ..., "candidates": [{"text": ..., "cosine": ...}, ...], "embedder": ...}

The point of the beat: a pure vector store retrieves the superseded claim at a *higher* cosine
than the answer path should trust — motivating Errata's belief graph over a vector store in the
answer path. This is NOT part of the offline test bar; run it under the embed extra:

    uv run --extra embed python embed_beat.py

It imports sentence-transformers (torch) only when executed.
"""

from __future__ import annotations

import json
from pathlib import Path

QUERY = "What model does the user prefer for their coding assistant?"

# The current (later) belief and the superseded (earlier) belief about the same fact.
CANDIDATES = [
    "The user now prefers Qwen3.7-Flash for their coding assistant.",  # current / correct
    "The user prefers GPT-4o for their coding assistant.",  # superseded / stale
]

EMBEDDER = "BAAI/bge-small-en-v1.5"
BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: "
OUT_PATH = Path(__file__).resolve().parents[1] / "apps" / "web" / "fixtures" / "beat-0.94.json"


def main() -> None:
    from sentence_transformers import SentenceTransformer  # lazy: needs the embed extra

    model = SentenceTransformer(EMBEDDER)
    q = model.encode([BGE_QUERY_PREFIX + QUERY], normalize_embeddings=True, convert_to_numpy=True)[0]
    cand_vecs = model.encode(CANDIDATES, normalize_embeddings=True, convert_to_numpy=True)
    cosines = (cand_vecs @ q).astype(float)

    fixture = {
        "query": QUERY,
        "candidates": [
            {"text": text, "cosine": round(float(cos), 4)}
            for text, cos in zip(CANDIDATES, cosines)
        ],
        "embedder": EMBEDDER,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT_PATH}")
    for c in fixture["candidates"]:
        print(f"  {c['cosine']:.4f}  {c['text']}")


if __name__ == "__main__":
    main()
