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
    uv run errata-eval parity                            # /api/meta prompt+model parity gate
    uv run errata-eval run --arm errata --seeds 11,22,33 # run an arm over a set
    uv run errata-eval judge --run <run_id>              # judge it (cached; unchanged rows are $0)
    uv run errata-eval report --runs <run_id>            # emit out/report/table.md + caption

`--config` is a top-level flag (`errata-eval --config eval.toml parity`), not a per-subcommand one.
`judge` is content-addressed like every other pass: re-judging a run in which only a few answers
moved charges only for the pairs that actually changed, and `--cache-dir ''` disables that.

### Judge validation (three commands, two committed artifacts)

    uv run errata-eval controls           # 60 perturbed NEGATIVES, deterministic, no LLM, free
    uv run errata-eval controls-positive  # 60 paraphrase POSITIVES, one cached perturber pass
    uv run errata-eval judge-validate     # score all 120 with the pinned judge; write the report

Generation and measurement are separate on purpose: `judge-validate` never builds a control, so a
judge is always measured against the same committed 120-item set (`judge-controls.jsonl` +
`judge-controls-positive.jsonl`) and a re-run replays from the LLM cache at $0. It writes
`judge-validation.md` (FAR overall and per family, FRR, gate pass/fail — hand-written analysis under
the marker line survives a re-render), `judge-controls-for-human.md` (a stratified 20-item sheet
with a blank verdict column), and `out/judge-controls-scored.jsonl`. It exits 6 on a failed gate.

    uv run python kappa.py --labels judge-controls-for-human.md   # Cohen's κ, once labelled, $0

**Measured**: FAR **8.3%** (5/60) against a ≤10% gate — 15.0% before a disclosed control-set
revision that fixed 7 defective controls, with the judge itself untouched; superseded-value
**0.0%** (0/12) against its tighter ≤8% gate; FRR 0.0% (0/60). Attribution-flip stays the weak
family at 25.0%. `judge-validation.md` publishes both control sets side by side, the change log,
and the worst-case envelope for the unparseable verdicts. Re-measuring against a previous run:

    uv run errata-eval judge-validate --prior out/judge-controls-scored-v1.jsonl

## Two analysis scripts (no new spend)

    uv run python failure_review.py --run <run_id> --compare naive=<run_id>   # out/failure-taxonomy.md
    uv run python tau_sweep.py --run <run_id>                                 # τ sensitivity table

`failure_review.py` joins a run's answers + judgments with the gold corpus and replays every
question through `POST /api/ask` with `debug: true`, which returns a `trace` (anchors, the ranked
material, the gate that fired). The answer LLM is served from Errata's on-disk cache, so replaying
an already-run question is $0. It buckets every non-CORRECT row by cause — see its docstring.

`tau_sweep.py` reports how the published numbers move with τ. It is a sweep and not a fit, and its
docstring says why: all 30 of the corpus's abstention questions are inside the comparison set by
design, so this corpus has no held-out slice on which τ could honestly be fitted.

## Projected cost (dry run)

`uv run errata-eval estimate` projects per-arm and total USD from `sample-150.json`, the pinned
`prices.toml`, and a per-arm token model, before any spend. The answer model
`qwen/qwen3.7-flash` prices all three answer arms; the judge line prices the configured
`judge_primary`. Current projection, regenerated from the live estimator:

| Line | Calls | In (M tok) | Out (M tok) | USD |
|---|---:|---:|---:|---:|
| Arm A — Errata (500 Q × 3) | 1,500 | 3.00 | 0.30 | $0.4170 |
| Arm B — full-context (150 Q × 3) | 450 | 54.97 | 0.09 | $5.5321 |
| Arm C — naive top-k (500 Q × 3) | 1,500 | 9.00 | 0.30 | $1.0170 |
| Judge (3,180 non-abstention rows) | 3,180 | 2.23 | 0.19 | $6.3664 |
| Overhead @25% | | | | $3.3331 |
| **Projected total** | | | | **$16.67** |

**This projection is OVER the $15.00 hard cap (`spend.hard_cap_usd`), so `estimate` exits 3.** That
is the gate working rather than a defect, and the figure is not what was actually spent: the
estimator prices a COLD, cache-empty run of all three arms from nothing, while the published runs
were produced incrementally against a warm on-disk LLM cache. Actual spend is **$12.55** on the
eval ledger (`out/ledger.jsonl` — the committed file is the source of truth; recompute it), plus
$9.37 on Errata's separate ingest ledger.

The two numbers answer different questions — `estimate` answers "what would reproducing all of this
from scratch cost today", the ledger answers "what has this actually cost" — and the earlier version
of this table ($10.58 under an $18.00 cap) matched neither, having drifted from both the prices and
the cap. Reproducing from a cold cache needs `spend.hard_cap_usd` raised to ≈$20 or the arms run one
at a time; the cap has deliberately NOT been raised here, because a spend ceiling is a budget
decision rather than a bookkeeping one. A judge escalation to `judge_escalation` is a further
contingency (worst case ≈ $28.60), handled by the recovery ladder, not folded into the gated
projected total. Embedding is $0 (local bge).

## Notes

- Answer/judge/perturb prompts live in `errata_eval/prompts.py`; the answer prompt's sha256 is
  checked against the deployed API by the parity gate before any spend.
- `embed_beat.py` (demo `vector_baseline` fixture) needs the `embed` extra:
  `uv run --extra embed python embed_beat.py`. It is not part of the offline test bar.
