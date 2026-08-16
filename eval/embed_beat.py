#!/usr/bin/env python
"""Demo beat 1 — measure the ``beat-0.94.json`` fixture against the REAL demo history.

Two cosines are measured, both with BAAI/bge-small-en-v1.5, and both written to the fixture with
their provenance. Nothing here is hand-entered: every number and every citation comes out of a
measurement, and the script refuses to invent one.

1. **The pair cosine** — cosine between the superseded claim's evidence span and the current
   claim's evidence span, sweeping every superseded↔current pair the demo history holds and
   keeping the highest. This is the beat's real point: two claims that are near-identical to an
   embedder (~0.9) and opposite in truth. Similarity cannot separate them; the revision edge can.

2. **The retrieval cosine** — the question against 2000-char dated session chunks, exactly the
   granularity the eval's naive top-k arm indexes at. This is what a vector store would actually
   hand back, and on this history the top hit is the SUPERSEDED session.

Claims + citations are read over HTTP from a running Errata API (the eval never touches the graph
directly); session text comes from the LongMemEval corpus file.

    uv run --extra embed python embed_beat.py \
        --api http://127.0.0.1:8787 --history 852ce960-clean

It imports sentence-transformers (torch) only when executed, and is NOT part of the offline bar.
"""

from __future__ import annotations

import argparse
import itertools
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

EMBEDDER = "BAAI/bge-small-en-v1.5"
BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: "
REPO = Path(__file__).resolve().parents[1]
OUT_PATH = REPO / "apps" / "web" / "fixtures" / "beat-0.94.json"
CORPUS = REPO / "data-raw" / "longmemeval_s_cleaned.json"

# The attributes the demo can open. Every one is swept; only those with a superseded predecessor
# can produce a pair.
DEMO_ATTRIBUTES = [
    "mortgage_preapproval_amount",
    "mortgage_lender",
    "job_title",
    "home_purchase_status",
    "job_offer",
    "millennium_park_familiarity",
    "daily_commute_duration_minutes",
]
CHUNK_CHARS = 2000
CHUNK_OVERLAP = 256


def beliefs(api: str, history: str, subject: str, attributes: list[str]) -> list[dict[str, Any]]:
    """Every (current, superseded) claim pair the demo history holds, over HTTP."""
    pairs: list[dict[str, Any]] = []
    with httpx.Client(base_url=api, timeout=30.0) as client:
        for attribute in attributes:
            r = client.get(
                "/api/belief",
                params={"history_id": history, "subject": subject, "attribute": attribute},
            )
            r.raise_for_status()
            body = r.json()
            head = body.get("belief")
            if not head:
                continue
            for older in body.get("superseded") or []:
                pairs.append({"attribute": attribute, "current": head, "superseded": older})
    return pairs


def claim_side(claim: dict[str, Any], session_dates: dict[str, str]) -> dict[str, Any]:
    cite = claim["citation"]
    return {
        "text": claim["evidence_span"],
        "value": claim["value"],
        "citation": {
            "session_id": cite["session_id"],
            "turn_index": cite["turn_index"],
            "session_date": session_dates.get(cite["session_id"], ""),
            "claim_id": cite.get("claim_id"),
        },
    }


def session_chunks(rec: dict[str, Any]) -> list[dict[str, Any]]:
    """The eval's chunking rule: contiguous turns within ONE session, dated header included."""
    out: list[dict[str, Any]] = []
    for i, turns in enumerate(rec["haystack_sessions"]):
        session_id = rec["haystack_session_ids"][i]
        raw_date = rec["haystack_dates"][i]
        header = f"[{session_id} · {raw_date}] "
        body = "\n".join(
            f"{'USER' if t['role'] == 'user' else 'ASSISTANT'}: {t['content']}" for t in turns
        )
        budget = max(1, CHUNK_CHARS - len(header))
        step = max(1, budget - CHUNK_OVERLAP)
        start = 0
        while True:
            out.append(
                {
                    "ordinal": i,
                    "session_id": session_id,
                    "session_date": raw_date.split()[0].replace("/", "-"),
                    "text": header + body[start : start + budget],
                }
            )
            if start + budget >= len(body) or not body:
                break
            start += step
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:8787")
    ap.add_argument("--history", default="852ce960-clean")
    ap.add_argument("--subject", default="the user")
    ap.add_argument("--corpus-id", default="852ce960", help="the question_id in the corpus file")
    ap.add_argument("--out", default=str(OUT_PATH))
    args = ap.parse_args()

    from sentence_transformers import SentenceTransformer  # lazy: needs the embed extra

    corpus = json.loads(CORPUS.read_text())
    rec = next(r for r in corpus if r["question_id"] == args.corpus_id)
    del corpus
    question = rec["question"]
    session_dates = {
        sid: rec["haystack_dates"][i].split()[0].replace("/", "-")
        for i, sid in enumerate(rec["haystack_session_ids"])
    }

    pairs = beliefs(args.api, args.history, args.subject, DEMO_ATTRIBUTES)
    if not pairs:
        raise SystemExit(f"no superseded↔current pair in {args.history}: nothing to measure")

    model = SentenceTransformer(EMBEDDER)

    # --- 1. sweep every superseded↔current pair -------------------------------------------------
    texts: list[str] = []
    for p in pairs:
        texts += [p["current"]["evidence_span"], p["superseded"]["evidence_span"]]
    vecs = model.encode(texts, normalize_embeddings=True, convert_to_numpy=True)
    print(f"swept {len(pairs)} superseded↔current pair(s) in {args.history}:")
    swept = []
    for i, p in enumerate(pairs):
        cos = float(vecs[2 * i] @ vecs[2 * i + 1])
        swept.append((cos, p))
        print(
            f"  {cos:.4f}  {p['attribute']}: {p['superseded']['value']!r} → {p['current']['value']!r}"
        )
    # also report every cross-attribute combination, so "highest" is over the whole sweep
    for (a, pa), (b, pb) in itertools.combinations(list(enumerate(pairs)), 2):
        cross = float(vecs[2 * a + 1] @ vecs[2 * b + 1])
        print(
            f"  {cross:.4f}  (cross) {pa['attribute']} superseded vs {pb['attribute']} superseded"
        )
    swept.sort(key=lambda t: -t[0])
    best_cos, best = swept[0]

    # --- 2. what a vector store actually retrieves for the question -----------------------------
    chunks = session_chunks(rec)
    qv = model.encode(
        [BGE_QUERY_PREFIX + question], normalize_embeddings=True, convert_to_numpy=True
    )[0]
    cv = model.encode(
        [c["text"] for c in chunks], normalize_embeddings=True, convert_to_numpy=True, batch_size=32
    )
    sims = cv @ qv
    ranked = sorted(zip(sims.tolist(), chunks), key=lambda t: -t[0])
    sup_sid = best["superseded"]["citation"]["session_id"]
    cur_sid = best["current"]["citation"]["session_id"]
    top = ranked[0]
    best_sup = next((r for r in ranked if r[1]["session_id"] == sup_sid), None)
    best_cur = next((r for r in ranked if r[1]["session_id"] == cur_sid), None)
    print(f"\nretrieval over {len(chunks)} session chunks for: {question}")
    for cos, c in ranked[:5]:
        print(f"  {cos:.4f}  s{c['ordinal']} {c['session_id']} {c['session_date']}")

    def hit(entry: Any, superseded: bool) -> dict[str, Any]:
        cos, c = entry
        return {
            "cosine": round(float(cos), 4),
            "session_id": c["session_id"],
            "session_date": c["session_date"],
            "session_ordinal": c["ordinal"],
            "superseded": superseded,
        }

    fixture: dict[str, Any] = {
        "query": question,
        "embedder": EMBEDDER,
        "measured_at": datetime.now(tz=UTC).date().isoformat(),
        "measured_by": "eval/embed_beat.py",
        "history_id": args.history,
        "corpus_question_id": args.corpus_id,
        "pair": {
            "cosine": round(best_cos, 4),
            "attribute": best["attribute"],
            "basis": (
                "cosine between the two claims' evidence spans (bge-small, no query prefix); "
                "highest of every superseded↔current pair in this history"
            ),
            "superseded": claim_side(best["superseded"], session_dates),
            "current": claim_side(best["current"], session_dates),
        },
        "retrieval": {
            "basis": (
                f"the question against {CHUNK_CHARS}-char dated session chunks — the granularity "
                "the eval's naive top-k arm indexes at"
            ),
            "chunks": len(chunks),
            "top": hit(top, top[1]["session_id"] == sup_sid),
            "superseded_session": hit(best_sup, True) if best_sup else None,
            "current_session": hit(best_cur, False) if best_cur else None,
        },
        # kept for apps/api's `vector_baseline`: what a vector store hands back for this question,
        # highest cosine first. The cosines here are the RETRIEVAL measurement.
        "candidates": [
            {
                "text": best["superseded"]["evidence_span"],
                "cosine": round(float(best_sup[0]), 4) if best_sup else 0.0,
                "superseded": True,
                "citation": claim_side(best["superseded"], session_dates)["citation"],
            },
            {
                "text": best["current"]["evidence_span"],
                "cosine": round(float(best_cur[0]), 4) if best_cur else 0.0,
                "superseded": False,
                "citation": claim_side(best["current"], session_dates)["citation"],
            },
        ],
    }

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(fixture, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"\nwrote {out}")
    print(f"  pair cosine      {fixture['pair']['cosine']:.4f}  ({fixture['pair']['attribute']})")
    print(
        f"  retrieval top    {fixture['retrieval']['top']['cosine']:.4f}  superseded={fixture['retrieval']['top']['superseded']}"
    )
    if best_cos < 0.85:
        print(
            "  NOTE: the highest genuine pair cosine is below 0.85. It is written as measured — "
            "the number on screen is never rounded up to a target."
        )


if __name__ == "__main__":
    main()
