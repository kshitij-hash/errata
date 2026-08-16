"""Turn-index golden — the pytest half of integration seam #2 (positional turn identity).

Shares ONE fixture with the ingest vitest suite (packages/ingest/fixtures/turn-index-vectors.json)
so TS and Python count turns identically: turn_index is the 0-based position WITHIN its session, and
the SAME session_id may appear twice in a history (~13 of 500 LongMemEval histories do this), so
session identity is the ordinal, never session_id. If the two readers ever diverge, one suite fails.
"""
import json
from pathlib import Path

from errata_eval.dataset import _build_question

# eval/tests/ -> ../../packages/ingest/fixtures/turn-index-vectors.json
FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "packages"
    / "ingest"
    / "fixtures"
    / "turn-index-vectors.json"
)


def _load() -> tuple[dict, list[dict]]:
    data = json.loads(FIXTURE.read_text())
    raw = dict(data["raw"])
    # The fixture is reader-neutral (the TS reader needs no question_type); the eval's stricter
    # schema wants one. It is irrelevant to turn identity, so any answerable type serves.
    raw.setdefault("question_type", "single-session-user")
    return raw, data["expected"]


def test_turn_index_is_positional_within_session() -> None:
    raw, expected = _load()
    q = _build_question(raw)
    for e in expected:
        session = q.sessions[e["session_ordinal"]]
        turn = session.turns[e["turn_index"]]
        assert turn.turn_index == e["turn_index"], f'{e["session_ordinal"]}/{e["turn_index"]}'
        assert session.session_id == e["session_id"]
        assert turn.role == e["role"]
        assert turn.content == e["content"]


def test_duplicate_session_ids_stay_distinct_by_ordinal() -> None:
    raw, _ = _load()
    q = _build_question(raw)
    # ordinals 1 and 2 carry the SAME session_id...
    assert q.sessions[1].session_id == "dupe_sid"
    assert q.sessions[2].session_id == "dupe_sid"
    # ...yet are distinct sessions: distinct first-turn content proves the ordinal keys them apart.
    assert q.sessions[1].turns[0].content != q.sessions[2].turns[0].content
