"""The three arms behind one Protocol.

- ``ErrataArm``  — POST /api/ask, reads the contract v1.1 response. Needs NO OpenRouter (the
  Errata answer path has no LLM), so its integration is creditless.
- ``FullContextArm`` / ``NaiveTopKArm`` — stuff a context into the shared answer prompt and call
  the answer model via OpenRouter. Credit-gated.

``predicted_abstain`` is a pure function importable without any network/LLM/torch import.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Protocol

import httpx

from .prompts import INSUFFICIENT_MARKER, fill_answer_prompt

# Fields Errata's contract must return; a missing field is a hard integration failure.
ERRATA_REQUIRED_FIELDS = ("answer", "abstained", "citations", "confidence")


def predicted_abstain(arm: str, row: Mapping[str, Any]) -> bool:
    """Abstain detection for both arm response shapes.

    Errata is authoritative via its ``abstained`` contract field; the baselines are detected by
    the shared machine-readable ``INSUFFICIENT_INFORMATION`` marker.
    """
    if arm == "errata":
        return bool(row.get("abstained"))
    answer = row.get("answer") or ""
    return str(answer).lstrip().startswith(INSUFFICIENT_MARKER)


def contract_violation(row: Mapping[str, Any]) -> bool:
    """Errata says abstained=false but its prose starts with the abstain marker (or vice versa)."""
    answer = str(row.get("answer") or "")
    prose_abstain = answer.lstrip().startswith(INSUFFICIENT_MARKER)
    return bool(row.get("abstained")) != prose_abstain


# --------------------------------------------------------------------------------------------
# context assembly
# --------------------------------------------------------------------------------------------
def assemble_full_context(question: Any) -> str:
    """Whole history in one block: sessions in date order, USER:/ASSISTANT: turns.

    No truncation, no summarisation, no reranking.
    """
    blocks: list[str] = []
    for s in question.sessions:
        lines = [f"### Session {s.session_id} — {s.date}"]
        for t in s.turns:
            speaker = "USER" if t.role == "user" else "ASSISTANT"
            lines.append(f"{speaker}: {t.content}")
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


class Arm(Protocol):
    name: str

    def answer(self, question: Any, *, seed: int) -> dict[str, Any]:
        """Return an answers.jsonl row for one question."""
        ...


# --------------------------------------------------------------------------------------------
# Arm A — Errata, via its real API (creditless)
# --------------------------------------------------------------------------------------------
class ErrataArm:
    name = "errata"

    def __init__(
        self,
        base_url: str,
        ask_path: str = "/api/ask",
        *,
        timeout_s: float = 120.0,
        send_question_date: bool = True,
        client: httpx.Client | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.ask_path = ask_path
        self.timeout_s = timeout_s
        self.send_question_date = send_question_date
        self._client = client or httpx.Client(timeout=timeout_s)

    def _post(self, payload: dict[str, Any]) -> httpx.Response:
        return self._client.post(f"{self.base_url}{self.ask_path}", json=payload)

    def check_bogus_id(self, history_id: str = "__nonexistent__") -> bool:
        """A 200 on a bogus history_id is a fatal integration bug. Returns True iff it 404s."""
        resp = self._post({"question": "ping", "history_id": history_id})
        return resp.status_code == 404

    @staticmethod
    def parse_response(body: Mapping[str, Any]) -> dict[str, Any]:
        missing = [f for f in ERRATA_REQUIRED_FIELDS if f not in body]
        if missing:
            raise ValueError(f"Errata contract violation: missing fields {missing}")
        usage = body.get("usage") or {}
        citations = [
            {
                "session_id": c["session_id"],
                "turn_index": c.get("turn_index", c.get("turn_id")),
                "span": c.get("span"),
            }
            for c in (body.get("citations") or [])
        ]
        return {
            "answer": body.get("answer"),
            "abstained": bool(body.get("abstained")),
            "confidence": body.get("confidence"),
            "citations": citations,
            "cited_session_ids": [c["session_id"] for c in citations],
            "cited_turn_refs": [
                (c["session_id"], c["turn_index"])
                for c in citations
                if c["turn_index"] is not None
            ],
            "prompt_tokens": usage.get("prompt_tokens"),
            "completion_tokens": usage.get("completion_tokens"),
            "model": usage.get("model"),
            "usd": body.get("cost", usage.get("usd", 0.0)),
            "cypher": body.get("cypher"),
            "vector_baseline": body.get("vector_baseline"),
            "latency_ms_server": body.get("latency_ms"),
            "trace_id": body.get("trace_id"),
        }

    def answer(self, question: Any, *, seed: int) -> dict[str, Any]:
        import time

        payload: dict[str, Any] = {"question": question.question, "history_id": question.history_id}
        if self.send_question_date:
            payload["question_date"] = question.question_date
        t0 = time.perf_counter()
        resp = self._post(payload)
        latency_ms = (time.perf_counter() - t0) * 1000.0
        row: dict[str, Any] = {
            "arm": self.name,
            "seed": seed,
            "question_id": question.question_id,
            "status": resp.status_code,
            "latency_ms_client": latency_ms,
        }
        if resp.status_code != 200:
            row["error"] = resp.text[:500]
            return row
        parsed = self.parse_response(resp.json())
        row.update(parsed)
        row["contract_violation"] = contract_violation(row)
        return row


# --------------------------------------------------------------------------------------------
# Arms B / C — need the answer model via OpenRouter (credit-gated)
# --------------------------------------------------------------------------------------------
class _LLMArm:
    """Shared plumbing for the full-context and naive arms."""

    name = "llm"

    def __init__(self, client: Any, model: str, *, temperature: float, max_tokens: int) -> None:
        self.client = client  # errata_eval.openrouter.OpenRouterClient
        self.model = model
        self.temperature = temperature
        self.max_tokens = max_tokens

    def _context(self, question: Any) -> str:
        raise NotImplementedError

    def answer(self, question: Any, *, seed: int) -> dict[str, Any]:
        prompt = fill_answer_prompt(
            question_date=question.question_date,
            context=self._context(question),
            question=question.question,
        )
        result = self.client.complete(
            model=self.model,
            prompt=prompt,
            temperature=self.temperature,
            max_tokens=self.max_tokens,
            seed=seed,
            op="answer",
            ref={"arm": self.name, "seed": seed, "question_id": question.question_id},
        )
        return {
            "arm": self.name,
            "seed": seed,
            "question_id": question.question_id,
            "status": "ok",
            "answer": result.text,
            "abstained": None,  # baselines abstain only via the INSUFFICIENT marker
            "confidence": None,
            "citations": [],
            "cited_session_ids": [],
            "cited_turn_refs": [],
            "prompt_tokens": result.prompt_tokens,
            "completion_tokens": result.completion_tokens,
            "model": self.model,
            "usd": result.usd,
            "latency_ms_client": result.latency_ms,
            "latency_ms_server": result.latency_ms,
            "trace_id": result.trace_id,
        }


class FullContextArm(_LLMArm):
    name = "full_context"

    def _context(self, question: Any) -> str:
        return assemble_full_context(question)


class NaiveTopKArm(_LLMArm):
    name = "naive"

    def __init__(self, client: Any, model: str, index: Any, *, k: int, **kw: Any) -> None:
        super().__init__(client, model, **kw)
        self.index = index  # errata_eval.retrieval.SessionIndex
        self.k = k

    def _context(self, question: Any) -> str:
        # retrieval is imported by the caller who builds the index (keeps torch out of import).
        return self.index.top_k_context(question, k=self.k)
