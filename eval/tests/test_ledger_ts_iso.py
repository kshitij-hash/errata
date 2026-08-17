"""Ledger timestamp format — integration seam (one costs ledger, two writers).

The TS ledger (packages/llm/src/ledger.ts) documents `ts` as ISO-8601 UTC and its reader parses it
as ISO; the eval's OpenRouterClient stamps every row with the same shape. This pins the eval side:
if the format ever drifts to epoch millis or drops the UTC designator, a single shared ledger stops
being co-readable and this fails — matching the cross-language note in ledger.ts.
"""
from datetime import UTC, datetime

import pytest

# The exact format the eval stamps onto every ledger row (errata_eval/openrouter.py). Kept in
# lockstep with that call site — a change there without a change here should break this test.
EVAL_TS_FORMAT = "%Y-%m-%dT%H:%M:%S.%fZ"


def test_eval_ts_is_iso8601_utc_and_round_trips() -> None:
    # A fixed instant — the format is under test, not the wall clock.
    instant = datetime(2026, 8, 16, 12, 34, 56, 789000, tzinfo=UTC)
    ts = instant.strftime(EVAL_TS_FORMAT)
    assert ts == "2026-08-16T12:34:56.789000Z"
    parsed = datetime.fromisoformat(ts)  # 'Z' → aware UTC in py3.11+
    assert parsed.tzinfo is not None
    assert parsed.utctimetuple() == instant.utctimetuple()


def test_eval_ts_is_a_calendar_string_not_epoch() -> None:
    ts = datetime(2026, 1, 2, 3, 4, 5, 6000, tzinfo=UTC).strftime(EVAL_TS_FORMAT)
    assert "T" in ts and ts.endswith("Z")
    # A calendar string, never a bare number — float() must reject it (guards against epoch drift).
    with pytest.raises(ValueError):
        float(ts)
