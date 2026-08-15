"""Judging: an LLM judge for non-abstention answers, deterministic exact-match for abstention.

Two scoring paths, and only one uses an LLM:
- non-abstention rows -> pinned LLM judge, binary CORRECT/INCORRECT (semantic equivalence).
- abstention rows     -> deterministic exact match on abstain vs non-abstain, NO LLM.

The judge never sees the transcript, the arm name, or which system produced the answer; rows are
shuffled before judging so no arm's answers are judged as a contiguous block. Credit-gated.
"""

from __future__ import annotations

import random
import re
from dataclasses import dataclass
from typing import Any

import orjson

from .arms import predicted_abstain
from .prompts import JUDGE_PROMPT_SHA256, fill_judge_prompt

_JSON_RE = re.compile(r"\{.*\}", re.DOTALL)


@dataclass(slots=True)
class Judgment:
    verdict: str  # "CORRECT" | "INCORRECT" | "UNPARSEABLE"
    reason: str
    judge_model: str
    judge_prompt_sha: str
    scorer: str  # "llm" | "exact_abstain"
    usd: float = 0.0
    latency_ms: float = 0.0


def parse_verdict(text: str) -> tuple[str, str]:
    """Extract (verdict, reason) from the judge's JSON reply. Unparseable => INCORRECT surface."""
    match = _JSON_RE.search(text or "")
    if not match:
        return "UNPARSEABLE", ""
    try:
        obj = orjson.loads(match.group(0))
    except orjson.JSONDecodeError:
        return "UNPARSEABLE", ""
    verdict = str(obj.get("verdict", "")).strip().upper()
    reason = str(obj.get("reason", ""))[:200]
    if verdict not in ("CORRECT", "INCORRECT"):
        return "UNPARSEABLE", reason
    return verdict, reason


def score_abstention_row(arm: str, row: dict[str, Any], gold_is_abstention: bool) -> Judgment:
    """Deterministic abstention scoring: a row is CORRECT iff its abstain decision matches gold."""
    pred = predicted_abstain(arm, row)
    correct = pred == gold_is_abstention
    return Judgment(
        verdict="CORRECT" if correct else "INCORRECT",
        reason="abstain match" if correct else "abstain mismatch",
        judge_model="",
        judge_prompt_sha="",
        scorer="exact_abstain",
    )


def judge_answer(
    client: Any,
    model: str,
    *,
    question: str,
    gold_answer: str,
    candidate_answer: str,
    temperature: float = 0.0,
    max_tokens: int = 64,
    ref: dict[str, Any] | None = None,
) -> Judgment:
    prompt = fill_judge_prompt(
        question=question, gold_answer=gold_answer, candidate_answer=candidate_answer
    )
    result = client.complete(
        model=model,
        prompt=prompt,
        temperature=temperature,
        max_tokens=max_tokens,
        op="judge",
        ref=ref,
        response_format={"type": "json_object"},
    )
    verdict, reason = parse_verdict(result.text)
    return Judgment(
        verdict=verdict,
        reason=reason,
        judge_model=model,
        judge_prompt_sha=JUDGE_PROMPT_SHA256,
        scorer="llm",
        usd=result.usd,
        latency_ms=result.latency_ms,
    )


def judge_run(
    client: Any,
    model: str,
    rows: list[dict[str, Any]],
    *,
    gold_by_qid: dict[str, dict[str, Any]],
    shuffle_seed: int = 0,
    temperature: float = 0.0,
    max_tokens: int = 64,
) -> list[dict[str, Any]]:
    """Judge every answer row. Abstention rows are scored deterministically; the rest via the LLM.

    ``gold_by_qid[qid]`` provides ``{"question", "answer", "is_abstention"}``.
    """
    order = list(rows)
    random.Random(shuffle_seed).shuffle(order)
    out: list[dict[str, Any]] = []
    for row in order:
        qid = row["question_id"]
        gold = gold_by_qid[qid]
        arm = row.get("arm", "")
        if gold["is_abstention"]:
            j = score_abstention_row(arm, row, True)
        else:
            j = judge_answer(
                client,
                model,
                question=gold["question"],
                gold_answer=gold["answer"],
                candidate_answer=str(row.get("answer") or ""),
                temperature=temperature,
                max_tokens=max_tokens,
                ref={"arm": arm, "seed": row.get("seed"), "question_id": qid},
            )
        out.append(
            {
                "arm": arm,
                "seed": row.get("seed"),
                "question_id": qid,
                "verdict": j.verdict,
                "reason": j.reason,
                "judge_model": j.judge_model,
                "judge_prompt_sha": j.judge_prompt_sha,
                "scorer": j.scorer,
                "usd": j.usd,
                "latency_ms": j.latency_ms,
            }
        )
    return out
