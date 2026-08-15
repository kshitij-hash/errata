"""Pydantic models over ``eval.toml`` and ``prices.toml``.

Config is validated at parse time, not at hour 3. Everything variable lives in the toml files;
no constant is duplicated in code.
"""

from __future__ import annotations

import tomllib
from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field


@lru_cache(maxsize=1)
def repo_root() -> Path:
    """Locate the monorepo root by walking up from this file.

    Falls back to ``.../eval``'s parent so relative config paths resolve regardless of cwd.
    """
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "pnpm-workspace.yaml").exists() or (parent / ".git").exists():
            return parent
    # errata_eval/config.py -> errata_eval -> eval -> repo root
    return here.parents[2]


# --------------------------------------------------------------------------------------------
# eval.toml
# --------------------------------------------------------------------------------------------
class RunConfig(BaseModel):
    model_config = ConfigDict(frozen=True)
    run_id: str = ""
    seeds: list[int] = Field(default_factory=lambda: [11, 22, 33])
    sample_seed: int = 20260819
    concurrency: dict[str, int] = Field(default_factory=dict)
    warmup_queries: int = 5


class DataConfig(BaseModel):
    model_config = ConfigDict(frozen=True)
    path: str = "data-raw/longmemeval_s_cleaned.json"
    dir: str = "data"


class DatasetConfig(BaseModel):
    model_config = ConfigDict(frozen=True)
    repo_id: str
    revision: str
    file: str
    sha256: str


class SampleConfig(BaseModel):
    model_config = ConfigDict(frozen=True)
    comparison_n: int = 150
    full_n: int = 500
    smoke_n: int = 25
    abstention_whole: bool = True
    abstention_floor: int = 5


class ModelsConfig(BaseModel):
    model_config = ConfigDict(frozen=True)
    answer: str
    answer_sensitivity: str
    judge_primary: str
    judge_escalation: str
    judge_fallback: str
    perturber: str
    embedder: str


class GenerationConfig(BaseModel):
    model_config = ConfigDict(frozen=True)
    answer_temperature: float = 0.0
    answer_max_tokens: int = 300
    judge_temperature: float = 0.0
    judge_max_tokens: int = 64


class NaiveTopkConfig(BaseModel):
    model_config = ConfigDict(frozen=True)
    k: int = 10
    chunk_max_chars: int = 2000
    chunk_overlap_chars: int = 256
    respect_session_boundary: bool = True
    prepend_session_date: bool = True


class ErrataConfig(BaseModel):
    model_config = ConfigDict(frozen=True)
    base_url: str
    ask_path: str = "/api/ask"
    meta_path: str = "/api/meta"
    timeout_s: int = 120
    require_parity: bool = True
    send_question_date: bool = True


class SpendConfig(BaseModel):
    model_config = ConfigDict(frozen=True)
    hard_cap_usd: float
    warn_at_usd: float
    per_arm_cap_usd: dict[str, float] = Field(default_factory=dict)
    ledger_path: str = "out/ledger.jsonl"
    ts_ledger_path: str = "../.data/ledger.jsonl"


class JudgeValidationConfig(BaseModel):
    model_config = ConfigDict(frozen=True)
    n: int = 60
    validation_seed: int = 20260818
    spot_check_n: int = 20
    far_gate: float = 0.10
    far_gate_superseded: float = 0.08
    frr_gate: float = 0.15


class EvalConfig(BaseModel):
    model_config = ConfigDict(frozen=True)
    run: RunConfig
    data: DataConfig
    dataset: DatasetConfig
    sample: SampleConfig
    models: ModelsConfig
    generation: GenerationConfig
    naive_topk: NaiveTopkConfig
    errata: ErrataConfig
    spend: SpendConfig
    judge_validation: JudgeValidationConfig = Field(default_factory=JudgeValidationConfig)

    def data_path(self) -> Path:
        """Absolute path to the corpus. Relative config paths are repo-root-relative."""
        p = Path(self.data.path)
        return p if p.is_absolute() else (repo_root() / p)


# --------------------------------------------------------------------------------------------
# prices.toml
# --------------------------------------------------------------------------------------------
class ModelPrice(BaseModel):
    model_config = ConfigDict(frozen=True, populate_by_name=True)
    input_per_m: float = Field(alias="in")
    output_per_m: float = Field(alias="out")
    ctx: int

    def cost(self, prompt_tokens: int, completion_tokens: int) -> float:
        """USD for a call, priced from this pinned sheet (per-million rates)."""
        return (
            prompt_tokens * self.input_per_m + completion_tokens * self.output_per_m
        ) / 1_000_000.0


class Prices(BaseModel):
    model_config = ConfigDict(frozen=True)
    source: str
    fetched_at: str
    models: dict[str, ModelPrice]

    def price(self, model: str) -> ModelPrice:
        if model not in self.models:
            raise KeyError(f"no pinned price for model {model!r} in prices.toml")
        return self.models[model]

    def cost(self, model: str, prompt_tokens: int, completion_tokens: int) -> float:
        return self.price(model).cost(prompt_tokens, completion_tokens)


# --------------------------------------------------------------------------------------------
# loaders
# --------------------------------------------------------------------------------------------
def _load_toml(path: str | Path) -> dict:
    with open(path, "rb") as f:
        return tomllib.load(f)


def load_eval_config(path: str | Path) -> EvalConfig:
    return EvalConfig.model_validate(_load_toml(path))


def load_prices(path: str | Path) -> Prices:
    raw = _load_toml(path)
    source = raw.pop("source", "")
    fetched_at = raw.pop("fetched_at", "")
    models = {name: ModelPrice.model_validate(body) for name, body in raw.items()}
    return Prices(source=source, fetched_at=fetched_at, models=models)


def default_eval_path() -> Path:
    return repo_root() / "eval" / "eval.toml"


def default_prices_path() -> Path:
    return repo_root() / "eval" / "prices.toml"
