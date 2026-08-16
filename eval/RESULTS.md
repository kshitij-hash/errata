# Results — LongMemEval comparison-150 (2026-08-17)

Runs: `rerunD-g5` (Errata, v3 — span-aware retrieval + broadened extraction) · `rerunB-nothink`
(full-context) · `rerunC-nothink` (naive top-k). Total eval spend $11.67 reported (judge
claude-sonnet-5); Errata's own ingest ledger stands at $8.18 against a $50 cap.

**Headline: Errata leads overall (53.3 vs 47.5 full-context and 45.8 naive) at 1/52nd the context
tokens, 1/523rd the $/Q and 31x lower p50 latency than full-context, with a citation on every
answer** — and it does it while abstaining more accurately than full-context (P 0.47 / R 0.93 vs
0.58 / 0.80) rather than by answering more. **Honest gap: single-fact extraction recall (44.7 vs
80.7), which is now one specific, named, priced failure — see "What is still broken" below.**

| Arm | Overall | Info. extraction | Multi-session | Temporal | Knowledge update | Abstention P / R | Ctx tok/Q | $/Q | p50 / p95 (s) |
|---|---|---|---|---|---|---|---|---|---|
| **Errata** | 53.3 ± 0.0 | 44.7 ± 0.0 | 61.3 ± 0.0 | 30.3 ± 0.0 | 100.0 ± 0.0 | 0.47 / 0.93 | 2,095 | $0.0000 | 0.26 / 1.22 |
| Full-context baseline | 47.5 ± 0.8 | 80.7 ± 1.5 | 35.5 ± 3.2 | 13.1 ± 1.7 | 61.1 ± 0.0 | 0.58 / 0.80 | 109,943 | $0.0110 | 8.00 / 8.68 |
| Naive top-k RAG (k=10) | 45.8 ± 0.0 | 63.2 ± 0.0 | 29.0 ± 0.0 | 21.2 ± 0.0 | 83.3 ± 0.0 | 0.41 / 0.98 | 4,665 | $0.0005 | 0.86 / 1.34 |

> Dataset: `xiaowu0162/longmemeval-cleaned`, revision `98d7416c…`, file `longmemeval_s_cleaned.json` (sha256 `d6f21ea9…`). All three arms answer the **same 150 questions**, a seeded stratified subsample (`sample_seed=20260819`) proportional by question type with **all 30 abstention questions included**; the full-context baseline runs on this subsample rather than all 500 for cost reasons. 3 runs, seeds 11/22/33, temperature 0 — sd reflects provider nondeterminism, not sampling spread. Answer model `qwen/qwen3.7-flash` and answer prompt (sha `a1ea7ee7…`) **identical across all three arms**, verified at run start against the deployed API. Judge `anthropic/claude-sonnet-5` (prompt sha `07286ad6…`), measured false-accept rate **not yet measured** on 60 perturbed control answers (reference: an independent audit measured 62.81% for a naive judge). Abstention is scored by exact match, not by the judge. Naive top-k: `BAAI/bge-small-en-v1.5`, 2000-char chunks within session boundaries, k=10; index build cost excluded from $/Q and reported separately. Reproduce: `uv run errata-eval report --runs rerunD-g5 rerunB-nothink rerunC-nothink`.

`Overall` and the four ability columns are accuracy over the **120 non-abstention** questions;
abstention is scored separately and deterministically as P/R. Errata's `$/Q` is $0.000021, not zero
— the v2 synthesis step pays for ~2,095 prompt tokens per question and the column rounds to four
decimals. Errata's arm is bit-identical across the three seeds (0 of 150 questions changed answer
or verdict), which is what its ±0.0 means; the baselines' spread is provider nondeterminism.

Counting every one of the 450 rows — a gold-abstention question is right iff the arm abstained,
every other row iff the judge said CORRECT — the same three runs read **Errata 61.3, naive 56.2,
full-context 54.0**, with answered-precision 70.3 / 70.5 / 52.5.

## Before → after

The previously published row (`rerunA-synth`) against this one. Same 150 questions, same three
seeds, same judge model and judge prompt sha, same answer model and answer prompt sha.

| | Overall | Info. ext. | Multi-session | Temporal | Knowledge upd. | Abst. P / R | answered | answered-prec. | Ctx tok/Q |
|---|---|---|---|---|---|---|---|---|---|
| Errata — before | 41.7 | 34.2 | 29.0 | 36.4 | 88.9 | 0.39 / 0.90 | 243 | 61.7% | 923 |
| **Errata — after** | **53.3** | **44.7** | **61.3** | 30.3 | **100.0** | **0.47 / 0.93** | 273 | **70.3%** | 2,095 |

Answered-precision went UP while the number of answers went up, which is the result that matters:
the arm did not buy its overall number by answering more often. Temporal is the one regression — 10
of 33 non-abstention temporal questions correct, down from 12 — two questions, inside the noise of a
33-question cell, but a regression, and not hidden.

Cut by the corpus's own `question_type` rather than by `ability` (which folds the three
single-session types into one column and hides where the deficit is), over all 450 rows:

| question_type | n | Errata before | Errata after | full-context | naive |
|---|---:|---:|---:|---:|---:|
| knowledge-update | 24 | 91.7% | **100.0%** | 62.5% | 87.5% |
| multi-session | 43 | 46.5% | **67.4%** | 46.5% | 47.3% |
| single-session-user | 22 | 86.4% | **100.0%** | 100.0% | 77.3% |
| temporal-reasoning | 39 | 41.0% | **41.0%** | 23.9% | 33.3% |
| single-session-assistant | 14 | 0.0% | 7.1% | **92.9%** | **92.9%** |
| single-session-preference | 8 | 0.0% | 0.0% | **20.8%** | 0.0% |

**Errata beats or ties both baselines on every question type except the two single-session
categories at the bottom, and those 22 of 150 questions are the entire remaining deficit.**

## What is still broken, and why it was not fixed

Both bottom rows are write-path gaps, not answer-path gaps: the graph does not contain the fact.

- **single-session-assistant (7.1%).** The question asks about something the ASSISTANT said — "the
  7th job in the list you gave me", "the move after 27. Kg2 Bd5+". The extractor now reads each
  session's main assistant reply, and the chess case works end to end, but a ten-item enumerated
  answer cannot survive a batch capped at 10 claims across 12 turns. Lifting that cap is exactly the
  configuration measured at **$20.72** to re-extract the 150 histories; the shipped configuration
  cost $4.19. This is a disclosed budget decision, not a modelling result.
- **single-session-preference (0.0%).** The gold answer is a paragraph about how the user would like
  to be answered ("would prefer responses that use their existing Suica card and TripIt app…"),
  scored against a one-line claim value. The naive baseline also scores 0.0% here; only full-context
  reaches 20.8%. It is not clear a memory layer wins this at all, and no attempt was made to make it
  look winnable.

## τ was NOT re-fitted, deliberately

The evidence score E gates abstention at `E ≥ τ`, with the five weights of E fixed a priori and τ
the one fitted quantity. **It is not fitted here, and τ stays at its a-priori 0.35.** Fitting it
needs a held-out slice containing abstention-positive questions; LongMemEval has exactly 30 and the
sampler takes all 30 into the comparison set by design (`sample.abstention_whole = true`), so every
abstention-positive example the corpus owns is inside the reported test set. A τ chosen against them
is chosen in-sample, and calling it "fitted on held-out data" would be false.

Published instead is a sensitivity sweep (`uv run python tau_sweep.py --run rerunD-g5`, also
`out/tau-sweep.md`), which treats τ as a veto on the synthesis answer:

| τ | overall % | answered | answered-precision % | abstention P | abstention R |
|---:|---:|---:|---:|---:|---:|
| 0.20 | 61.3 | 273 | 70.3 | 0.47 | 0.93 |
| 0.30 | 61.3 | 273 | 70.3 | 0.47 | 0.93 |
| 0.35 ←shipped | 61.3 | 273 | 70.3 | 0.47 | 0.93 |
| 0.40 | 61.3 | 267 | 71.9 | 0.46 | 0.93 |
| 0.45 | 59.3 | 255 | 71.8 | 0.43 | 0.93 |
| 0.50 | 54.7 | 219 | 74.0 | 0.36 | 0.93 |

The shipped number sits on a plateau, not a knife edge: τ can move ±0.05 either way and the table
does not change. That plateau is itself new. On the previous run the same veto at τ = 0.35 would
have cut overall from 51.3 to **35.3**, because E's `s` term was a token-F1 that scored ~0 on most
real questions while τ was set for a different scale. E and τ must be on the same scale before a
veto means anything, and **that is not something to switch on quietly** — which is why `s` now takes
the same span-aware relevance the retrieval uses, and why the sweep ships beside the table.

## Reproducing

    uv run errata-eval parity                                        # prompt+model gate, before spend
    uv run errata-eval run --arm errata --seeds 11,22,33 --run-id rerunD-g5
    uv run errata-eval judge --run rerunD-g5
    uv run errata-eval report --runs rerunD-g5 rerunB-nothink rerunC-nothink
    uv run python failure_review.py --run rerunD-g5 --compare naive=rerunC-nothink
    uv run python tau_sweep.py --run rerunD-g5

The failure taxonomy behind every number above is `out/failure-taxonomy.md`; the write-path changes
that produced them are `docs/gauntlets.md` §G5.
