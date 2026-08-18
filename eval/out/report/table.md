| Arm | Overall | Info. extraction | Multi-session | Temporal | Knowledge update | Abstention P / R | Ctx tok/Q | $/Q | p50 / p95 (s) |
|---|---|---|---|---|---|---|---|---|---|
| **Errata** | 60.0 ± 0.0 | 44.7 ± 0.0 | 67.7 ± 0.0 | 51.5 ± 0.0 | 94.4 ± 0.0 | 0.49 / 0.93 | 2,532 | $0.0000 | 0.24 / 0.29 |
| Full-context baseline | 47.5 ± 0.8 | 80.7 ± 1.5 | 35.5 ± 3.2 | 13.1 ± 1.7 | 61.1 ± 0.0 | 0.58 / 0.80 | 109,943 | $0.0110 | 8.00 / 8.68 |
| Naive top-k RAG (k=10) | 45.8 ± 0.0 | 63.2 ± 0.0 | 29.0 ± 0.0 | 21.2 ± 0.0 | 83.3 ± 0.0 | 0.41 / 0.98 | 4,665 | $0.0005 | 0.86 / 1.34 |

> Dataset: `xiaowu0162/longmemeval-cleaned`, revision `98d7416c…`, file `longmemeval_s_cleaned.json` (sha256 `d6f21ea9…`). All three arms answer the **same 150 questions**, a seeded stratified subsample (`sample_seed=20260819`) proportional by question type with **all 30 abstention questions included**; the full-context baseline runs on this subsample rather than all 500 for cost reasons. 3 runs, seeds 11/22/33, temperature 0 — sd reflects provider nondeterminism, not sampling spread. Answer model `qwen/qwen3.7-flash` and answer prompt (sha `a1ea7ee7…`) **identical across all three arms**, verified at run start against the deployed API. Judge `anthropic/claude-sonnet-5` (prompt sha `07286ad6…`), measured false-accept rate **8.3%** on 60 perturbed control answers (reference: an independent audit measured 62.81% for a naive judge). Abstention is scored by exact match, not by the judge. Naive top-k: `BAAI/bge-small-en-v1.5`, 2000-char chunks within session boundaries, k=10; index build cost excluded from $/Q and reported separately. Reproduce: `uv run errata-eval report --runs <run_id>`.

> Note: Errata's `$/Q` and `p50 / p95` in this rendering come from `rerunJ-arith`, which replayed
> 447 of 450 answers from a warm cache — both columns flatter the arm. The published cold-cache
> figures are `rerunF-wave`'s ($0.0000257/Q, 0.26 / 1.28 s) and are the ones the README carries;
> see `eval/RESULTS.md`. Accuracy columns are unaffected by caching.
