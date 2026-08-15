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

## Notes

- Answer/judge/perturb prompts live in `errata_eval/prompts.py`; the answer prompt's sha256 is
  checked against the deployed API by the parity gate before any spend.
- `embed_beat.py` (demo `vector_baseline` fixture) needs the `embed` extra:
  `uv run --extra embed python embed_beat.py`. It is not part of the offline test bar.
