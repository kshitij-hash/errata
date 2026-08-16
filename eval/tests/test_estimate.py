"""Pre-run cost estimator (§6.2): the projected total must sit under the $18 eval hard cap.

The estimate is driven by the committed sample artifact + the pinned price sheet + a per-arm
token model, and uses the shared answer model price for all three answer arms. This is the gate
that keeps a run from ever starting if it would breach the cap.
"""

from __future__ import annotations

from pathlib import Path

import orjson

from errata_eval import config as cfg
from errata_eval.estimate import ANSWER_ARM_TOKENS, estimate_cost

_EVAL = Path(__file__).resolve().parents[1]
SAMPLE = _EVAL / "sample-150.json"
HARD_CAP_USD = 18.00


def _estimate():
    config = cfg.load_eval_config(cfg.default_eval_path())
    prices = cfg.load_prices(cfg.default_prices_path())
    sample_ids = orjson.loads(SAMPLE.read_bytes())
    return estimate_cost(sample_ids=sample_ids, config=config, prices=prices), config


def test_projected_total_is_under_the_hard_cap() -> None:
    est, config = _estimate()
    # the acceptance gate: the whole eval must project under the $18 budget line — at the HONEST
    # tier prices (qwen long-context bills ~3.3x its catalog headline; prices.toml pins the tier).
    assert est.projected_usd < HARD_CAP_USD
    # the runtime ledger cap is a separate control: it tracks REMAINING key headroom mid-campaign,
    # so it may sit below the full-run projection once part of the run has already been spent.
    assert 0 < config.spend.hard_cap_usd <= HARD_CAP_USD


def test_estimate_consumes_the_sample_artifact() -> None:
    est, _ = _estimate()
    assert est.comparison_n == 150
    assert est.n_abstention == 30
    assert est.seeds == 3
    assert est.full_n == 500


def test_answer_arms_priced_with_the_shared_answer_model() -> None:
    est, config = _estimate()
    for li in est.arm_lines:
        assert li.name in ANSWER_ARM_TOKENS
        assert li.model == config.models.answer  # qwen/qwen3.7-flash, held constant


def test_per_arm_call_counts_follow_the_token_model() -> None:
    est, _ = _estimate()
    calls = {li.name: li.calls for li in est.lines}
    assert calls["errata"] == 500 * 3          # full corpus x 3 seeds
    assert calls["naive"] == 500 * 3
    assert calls["full_context"] == 150 * 3    # comparison set x 3 seeds
    assert calls["judge"] == (470 + 470 + 120) * 3  # non-abstention rows across judged arm-runs


def test_projected_is_subtotal_plus_overhead() -> None:
    est, _ = _estimate()
    subtotal = sum(li.usd for li in est.lines)
    assert abs(est.subtotal_usd - subtotal) < 1e-9
    assert abs(est.projected_usd - subtotal * 1.25) < 1e-9
