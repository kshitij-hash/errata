# errata-eval

Standalone `uv` evaluation harness for Errata. It is **not** a pnpm workspace member and
talks to Errata **only over HTTP** (`POST /api/ask`, `GET /api/meta`) — it never imports TS,
never opens Bolt, never reads HydraDB. A number it produces is reproducible by anyone with the
deployed URL.

Corpus: `xiaowu0162/longmemeval-cleaned`, 500 questions, 30 abstentions
(`question_id.endswith("_abs")`). Abstention is always taken whole in every sample.

## Setup

    uv sync                 # core deps + dev group (no torch); `uv run pytest` is green
    uv sync --extra embed   # adds sentence-transformers/torch for the naive arm + demo beat

## The four commands

    uv run errata-eval sample --n 150 --print-ids        # the seeded comparison set
    uv run errata-eval parity --config eval.toml         # /api/meta prompt+model parity gate
    uv run errata-eval run --arm errata --seeds 11,22,33 # run an arm over a set
    uv run errata-eval report --runs <run_id>            # emit out/report/table.md + caption

`judge-validate` builds the perturbed control set and measures the judge false-accept rate.

## Projected cost (dry run)

`uv run errata-eval estimate` projects per-arm and total USD from `sample-150.json`, the pinned
`prices.toml`, and a per-arm token model, before any spend. The answer model
`qwen/qwen3.7-flash` prices all three answer arms; the judge line prices the configured
`judge_primary`. Current projection:

| Line | Calls | In (M tok) | Out (M tok) | USD |
|---|---:|---:|---:|---:|
| Arm A — Errata (500 Q × 3) | 1,500 | 3.00 | 0.30 | $0.1290 |
| Arm B — full-context (150 Q × 3) | 450 | 54.97 | 0.09 | $1.6608 |
| Arm C — naive top-k (500 Q × 3) | 1,500 | 9.00 | 0.30 | $0.3090 |
| Judge (3,180 non-abstention rows) | 3,180 | 2.23 | 0.19 | $6.3664 |
| Overhead @25% | | | | $2.1163 |
| **Projected total** | | | | **$10.58** |

Projected **$10.58** sits under the **$18.00** hard cap (`spend.hard_cap_usd`). The estimator runs
first in every real run and exits non-zero if `projected + already_spent` would breach the cap.
A judge escalation to `judge_escalation` is a separate contingency (worst case ≈ $22.52), handled
by the recovery ladder, not folded into the gated projected total. Embedding is $0 (local bge).

## Notes

- Answer/judge/perturb prompts live in `errata_eval/prompts.py`; the answer prompt's sha256 is
  checked against the deployed API by the parity gate before any spend.
- `embed_beat.py` (demo `vector_baseline` fixture) needs the `embed` extra:
  `uv run --extra embed python embed_beat.py`. It is not part of the offline test bar.
