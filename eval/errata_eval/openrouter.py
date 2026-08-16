"""OpenRouter client: httpx, retry/backoff, ledger append, price accounting.

Credit-gated. Never exercised by the offline test bar and never called inside pytest.
Every call writes one append-only ledger row (§6.3 schema); ``usd`` is computed from the
PINNED price sheet, not from the provider's self-reported figure (stored as ``usd_reported``).

An optional on-disk cache (``cache_dir``) mirrors packages/llm's: temperature-0 calls are
content-addressed by (model, prompt, temperature, max_tokens, response_format), so re-running a
deterministic pass — the judge-validation control set, a positive-control rebuild — is $0 and
byte-identical instead of a second charge. A cache hit still writes a ledger row (``usd`` 0.0,
``cost_source`` "cache"): the ledger stays the single account of what the harness did.
"""

from __future__ import annotations

import hashlib
import os
import random
import threading
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import orjson

from .config import Prices

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"


class SpendCapError(RuntimeError):
    """Raised when the running ledger total crosses the hard cap."""


class CircuitBreak(RuntimeError):
    """Raised on HTTP 402 (out of credits) — stop immediately, do not retry."""


def cache_key_for(
    *,
    model: str,
    prompt: str,
    temperature: float,
    max_tokens: int,
    response_format: dict[str, Any] | None = None,
    reasoning_enabled: bool | None = None,
) -> str:
    """Content address of one completion request. Pure; the cache's whole identity lives here.

    Everything that can change the reply is in the key — including ``reasoning_enabled``, which
    changes it drastically: a thinking model spends the token budget on reasoning and returns a
    reply truncated mid-word, so a cache that ignored the flag would serve those truncations back
    forever. ``seed`` deliberately is NOT in the key: the harness sends it only to pin provider
    nondeterminism at temperature 0. Nothing else may be added without invalidating every entry.
    """
    canonical = orjson.dumps(
        {
            "model": model,
            "prompt": prompt,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "response_format": response_format,
            "reasoning_enabled": reasoning_enabled,
        },
        option=orjson.OPT_SORT_KEYS,
    )
    return hashlib.sha256(canonical).hexdigest()


@dataclass(slots=True)
class LLMResult:
    text: str
    prompt_tokens: int
    completion_tokens: int
    usd: float
    usd_reported: float
    latency_ms: float
    trace_id: str
    model: str
    attempt: int
    ok: bool = True


@dataclass
class Ledger:
    """Append-only JSONL ledger with a running total and cap enforcement."""

    path: Path
    warn_at_usd: float
    hard_cap_usd: float
    run_id: str = ""
    total_usd: float = 0.0
    _rows_since_flush: int = 0
    _warned: bool = False
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _fh: Any = None

    def __post_init__(self) -> None:
        self.path = Path(self.path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = open(self.path, "ab")  # noqa: SIM115 — long-lived append handle, closed in close()

    def append(self, row: dict[str, Any]) -> None:
        with self._lock:
            self._fh.write(orjson.dumps(row))
            self._fh.write(b"\n")
            self._rows_since_flush += 1
            if self._rows_since_flush >= 20:
                self._fh.flush()
                os.fsync(self._fh.fileno())
                self._rows_since_flush = 0
            self.total_usd += float(row.get("usd", 0.0) or 0.0)
            if not self._warned and self.total_usd > self.warn_at_usd:
                self._warned = True
                print(f"[ledger] WARNING: spend ${self.total_usd:.4f} > warn ${self.warn_at_usd}")
            if self.total_usd > self.hard_cap_usd:
                self.flush()
                raise SpendCapError(
                    f"spend ${self.total_usd:.4f} > hard cap ${self.hard_cap_usd}"
                )

    def flush(self) -> None:
        with self._lock:
            if self._fh:
                self._fh.flush()
                os.fsync(self._fh.fileno())

    def close(self) -> None:
        self.flush()
        if self._fh:
            self._fh.close()
            self._fh = None


class OpenRouterClient:
    def __init__(
        self,
        prices: Prices,
        ledger: Ledger,
        *,
        run_id: str,
        api_key: str | None = None,
        timeout_s: float = 120.0,
        max_attempts: int = 6,
        component: str = "eval",
        cache_dir: str | Path | None = None,
    ) -> None:
        self.prices = prices
        self.ledger = ledger
        self.run_id = run_id
        self.component = component
        self.max_attempts = max_attempts
        self.cache_dir = Path(cache_dir) if cache_dir is not None else None
        key = api_key or os.environ.get("OPENROUTER_API_KEY")
        if not key:
            raise RuntimeError("OPENROUTER_API_KEY not set (secrets live in env only)")
        self._client = httpx.Client(
            timeout=timeout_s,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        )

    def complete(
        self,
        *,
        model: str,
        prompt: str,
        temperature: float,
        max_tokens: int,
        seed: int | None = None,
        op: str = "answer",
        ref: dict[str, Any] | None = None,
        response_format: dict[str, Any] | None = None,
        reasoning_enabled: bool | None = None,
    ) -> LLMResult:
        payload: dict[str, Any] = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        cache_key = cache_key_for(
            model=model,
            prompt=prompt,
            temperature=temperature,
            max_tokens=max_tokens,
            response_format=response_format,
            reasoning_enabled=reasoning_enabled,
        )
        hit = self._read_cache(cache_key)
        if hit is not None:
            return self._record_cache_hit(hit, model, op, ref)
        if seed is not None:
            payload["seed"] = seed
        if response_format is not None:
            payload["response_format"] = response_format
        if reasoning_enabled is not None:
            # Hybrid thinking models (qwen3.7-flash) spend the whole max_tokens budget on reasoning
            # and return EMPTY content — 448/450 empty answers in the first Arm B run. Answer arms
            # pass False: plain completion, no thinking.
            payload["reasoning"] = {"enabled": reasoning_enabled}

        last_error: str | None = None
        for attempt in range(1, self.max_attempts + 1):
            t0 = time.perf_counter()
            try:
                resp = self._client.post(OPENROUTER_URL, json=payload)
            except httpx.HTTPError as exc:  # connection errors: retry with backoff
                last_error = repr(exc)
                self._sleep_backoff(attempt)
                continue
            latency_ms = (time.perf_counter() - t0) * 1000.0

            if resp.status_code == 402:
                raise CircuitBreak("HTTP 402 from OpenRouter: out of credits")
            if resp.status_code == 429:
                last_error = "rate_limited"
                self._sleep_backoff(attempt, retry_after=resp.headers.get("Retry-After"))
                continue
            if 400 <= resp.status_code < 500:
                # non-429 4xx: a request bug, not transient — do not retry.
                self._log_failure(model, op, ref, attempt, f"http {resp.status_code}: {resp.text[:200]}")
                raise httpx.HTTPStatusError(
                    f"OpenRouter {resp.status_code}", request=resp.request, response=resp
                )
            if resp.status_code >= 500:
                last_error = f"http {resp.status_code}"
                self._sleep_backoff(attempt)
                continue

            body = resp.json()
            return self._record(body, model, op, ref, attempt, latency_ms, cache_key)

        self._log_failure(model, op, ref, self.max_attempts, last_error or "unknown")
        raise RuntimeError(f"OpenRouter call failed after {self.max_attempts} attempts: {last_error}")

    # ----------------------------------------------------------------------------------------
    def _record(
        self,
        body: dict[str, Any],
        model: str,
        op: str,
        ref: dict[str, Any] | None,
        attempt: int,
        latency_ms: float,
        cache_key: str = "",
    ) -> LLMResult:
        choice = (body.get("choices") or [{}])[0]
        text = (choice.get("message") or {}).get("content", "") or ""
        usage = body.get("usage") or {}
        prompt_tokens = int(usage.get("prompt_tokens", 0))
        completion_tokens = int(usage.get("completion_tokens", 0))
        cached = int(usage.get("prompt_tokens_details", {}).get("cached_tokens", 0) or 0)
        usd = self.prices.cost(model, prompt_tokens, completion_tokens)
        usd_reported = float(usage.get("cost", 0.0) or 0.0)
        trace_id = body.get("id", "")
        self.ledger.append(
            {
                "ts": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
                "component": self.component,
                "op": op,
                "run_id": self.run_id,
                "provider": "openrouter",
                "model": model,
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "cached_prompt_tokens": cached,
                "usd": usd,
                "usd_reported": usd_reported,
                "latency_ms": latency_ms,
                "ok": True,
                "attempt": attempt,
                "error": None,
                "ref": ref or {},
            }
        )
        self._write_cache(
            cache_key,
            {
                "text": text,
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "trace_id": trace_id,
            },
        )
        return LLMResult(
            text=text,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            usd=usd,
            usd_reported=usd_reported,
            latency_ms=latency_ms,
            trace_id=trace_id,
            model=model,
            attempt=attempt,
        )

    # ---- on-disk cache -----------------------------------------------------------------------
    def _cache_path(self, key: str) -> Path | None:
        if self.cache_dir is None or not key:
            return None
        return self.cache_dir / f"{key}.json"

    def _read_cache(self, key: str) -> dict[str, Any] | None:
        path = self._cache_path(key)
        if path is None or not path.exists():
            return None
        try:
            return orjson.loads(path.read_bytes())
        except (orjson.JSONDecodeError, OSError):
            return None

    def _write_cache(self, key: str, value: dict[str, Any]) -> None:
        path = self._cache_path(key)
        if path is None:
            return
        try:  # best-effort: a cache write must never fail a call that already succeeded
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(orjson.dumps(value))
        except OSError:
            pass

    def _record_cache_hit(
        self, hit: dict[str, Any], model: str, op: str, ref: dict[str, Any] | None
    ) -> LLMResult:
        """A replay costs $0 but is still an event, so it still gets a ledger row."""
        prompt_tokens = int(hit.get("prompt_tokens", 0))
        completion_tokens = int(hit.get("completion_tokens", 0))
        self.ledger.append(
            {
                "ts": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
                "component": self.component,
                "op": op,
                "run_id": self.run_id,
                "provider": "openrouter",
                "model": model,
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "cached_prompt_tokens": prompt_tokens,
                "usd": 0.0,
                "usd_reported": 0.0,
                "latency_ms": 0.0,
                "ok": True,
                "attempt": 0,
                "cost_source": "cache",
                "error": None,
                "ref": ref or {},
            }
        )
        return LLMResult(
            text=str(hit.get("text", "")),
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            usd=0.0,
            usd_reported=0.0,
            latency_ms=0.0,
            trace_id=str(hit.get("trace_id", "")),
            model=model,
            attempt=0,
        )

    def _log_failure(
        self, model: str, op: str, ref: dict[str, Any] | None, attempt: int, error: str
    ) -> None:
        self.ledger.append(
            {
                "ts": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
                "component": self.component,
                "op": op,
                "run_id": self.run_id,
                "provider": "openrouter",
                "model": model,
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "cached_prompt_tokens": 0,
                "usd": 0.0,
                "usd_reported": 0.0,
                "latency_ms": 0.0,
                "ok": False,
                "attempt": attempt,
                "error": error,
                "ref": ref or {},
            }
        )

    @staticmethod
    def _sleep_backoff(attempt: int, retry_after: str | None = None) -> None:
        if retry_after:
            try:
                # CAP the honored Retry-After: a server once sent 3600 and put the whole run into an
                # hour-long sleep with zero progress signal. Waiting >90 s per attempt is worse than
                # burning an attempt — the outer loop still bounds total attempts.
                time.sleep(min(float(retry_after), 90.0))
                return
            except ValueError:
                pass
        # exponential backoff with full jitter, capped.
        delay = min(2**attempt, 60) * random.random()
        time.sleep(delay)

    def close(self) -> None:
        self._client.close()
