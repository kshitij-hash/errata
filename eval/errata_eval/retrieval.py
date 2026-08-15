"""Chunker + local bge-small index for the naive top-k arm ONLY.

``sentence-transformers`` (and its torch) is imported lazily inside the encoder, so importing
this module — and running the offline test bar — never pulls torch. Install the encoder with
``uv sync --extra embed``.

Chunking rule: contiguous turns within ONE session, never crossing a session boundary. Each
chunk's text is prefixed with ``[{session_id} · {session_date}]`` and that header is part of
the embedded string (the baseline must see the temporal signal, or the control is rigged).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

# bge's documented query instruction prefix — omitting it is a ~2pp self-inflicted loss.
BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: "


@dataclass(slots=True)
class Chunk:
    session_id: str
    session_date: str
    text: str  # includes the header, exactly as embedded


def _header(session_id: str, session_date: str, prepend_date: bool) -> str:
    return f"[{session_id} · {session_date}] " if prepend_date else f"[{session_id}] "


def chunk_session(
    session: Any,
    *,
    max_chars: int = 2000,
    overlap_chars: int = 256,
    prepend_date: bool = True,
) -> list[Chunk]:
    """Chunk one session into overlapping contiguous-turn windows (never crossing sessions)."""
    header = _header(session.session_id, session.date, prepend_date)
    turn_texts = [
        f"{'USER' if t.role == 'user' else 'ASSISTANT'}: {t.content}" for t in session.turns
    ]
    body = "\n".join(turn_texts)
    budget = max(1, max_chars - len(header))
    chunks: list[Chunk] = []
    start = 0
    n = len(body)
    if n == 0:
        return [Chunk(session.session_id, session.date, header.strip())]
    step = max(1, budget - overlap_chars)
    while start < n:
        piece = body[start : start + budget]
        chunks.append(Chunk(session.session_id, session.date, header + piece))
        if start + budget >= n:
            break
        start += step
    return chunks


def chunk_question(
    question: Any,
    *,
    max_chars: int = 2000,
    overlap_chars: int = 256,
    prepend_date: bool = True,
) -> list[Chunk]:
    chunks: list[Chunk] = []
    for s in question.sessions:
        chunks.extend(
            chunk_session(
                s, max_chars=max_chars, overlap_chars=overlap_chars, prepend_date=prepend_date
            )
        )
    return chunks


class Encoder:
    """Lazy wrapper around sentence-transformers bge-small (local, $0, offline)."""

    def __init__(self, model_name: str = "BAAI/bge-small-en-v1.5") -> None:
        self.model_name = model_name
        self._model = None

    def _ensure(self) -> Any:
        if self._model is None:
            from sentence_transformers import SentenceTransformer  # lazy: needs the embed extra

            self._model = SentenceTransformer(self.model_name)
        return self._model

    def encode(self, texts: list[str], *, is_query: bool = False) -> np.ndarray:
        model = self._ensure()
        if is_query:
            texts = [BGE_QUERY_PREFIX + t for t in texts]
        vecs = model.encode(texts, normalize_embeddings=True, convert_to_numpy=True)
        return np.asarray(vecs, dtype=np.float32)


class SessionIndex:
    """Per-question dense index; exact cosine (X @ q). Cached to data/index/{qid}.npz."""

    def __init__(
        self,
        encoder: Encoder,
        *,
        cache_dir: str | Path = "data/index",
        max_chars: int = 2000,
        overlap_chars: int = 256,
        prepend_date: bool = True,
    ) -> None:
        self.encoder = encoder
        self.cache_dir = Path(cache_dir)
        self.max_chars = max_chars
        self.overlap_chars = overlap_chars
        self.prepend_date = prepend_date

    def _cache_path(self, question_id: str) -> Path:
        return self.cache_dir / f"{question_id}.npz"

    def build(self, question: Any) -> tuple[np.ndarray, list[Chunk]]:
        chunks = chunk_question(
            question,
            max_chars=self.max_chars,
            overlap_chars=self.overlap_chars,
            prepend_date=self.prepend_date,
        )
        cache = self._cache_path(question.question_id)
        if cache.exists():
            # Cache holds only a plain float32 array we wrote ourselves; no pickled objects.
            data = np.load(cache, allow_pickle=False)
            return data["vectors"], chunks
        vectors = self.encoder.encode([c.text for c in chunks])
        cache.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(cache, vectors=vectors)
        return vectors, chunks

    def top_k(self, question: Any, k: int = 10) -> list[Chunk]:
        vectors, chunks = self.build(question)
        q = self.encoder.encode([question.question], is_query=True)[0]
        scores = vectors @ q  # exact cosine (both L2-normalised)
        top = np.argsort(-scores)[:k]
        return [chunks[i] for i in top]

    def top_k_context(self, question: Any, k: int = 10) -> str:
        return "\n\n".join(c.text for c in self.top_k(question, k=k))
