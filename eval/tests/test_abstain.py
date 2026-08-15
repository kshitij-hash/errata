"""Abstain detection on both arm response shapes (§4.1)."""

from __future__ import annotations

from errata_eval.arms import contract_violation, predicted_abstain


def test_errata_uses_the_abstained_flag() -> None:
    # Errata is authoritative via its contract field, not its prose.
    assert predicted_abstain("errata", {"abstained": True, "answer": "anything"}) is True
    assert predicted_abstain("errata", {"abstained": False, "answer": "Paris"}) is False
    # Even if the prose says the marker, the flag wins for Errata.
    assert (
        predicted_abstain("errata", {"abstained": False, "answer": "INSUFFICIENT_INFORMATION: x"})
        is False
    )


def test_baseline_uses_the_insufficient_marker() -> None:
    assert predicted_abstain(
        "full_context", {"answer": "INSUFFICIENT_INFORMATION: nothing about that"}
    )
    assert predicted_abstain("naive", {"answer": "INSUFFICIENT_INFORMATION: n/a"})
    assert not predicted_abstain("full_context", {"answer": "Paris"})


def test_baseline_marker_tolerates_leading_whitespace() -> None:
    assert predicted_abstain("naive", {"answer": "  \n INSUFFICIENT_INFORMATION: x"})
    assert not predicted_abstain("naive", {"answer": ""})
    assert not predicted_abstain("naive", {"answer": None})


def test_contract_violation_detection() -> None:
    # abstained flag disagrees with the prose marker -> violation.
    assert contract_violation({"abstained": False, "answer": "INSUFFICIENT_INFORMATION: x"})
    assert contract_violation({"abstained": True, "answer": "Paris"})
    # agreement -> no violation.
    assert not contract_violation({"abstained": True, "answer": "INSUFFICIENT_INFORMATION: x"})
    assert not contract_violation({"abstained": False, "answer": "Paris"})
