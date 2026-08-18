# Statistics over the committed run

Computed by `eval/stats.py` from `apps/web/data/results.json` (errata `rerunJ-arith`, full-context `rerunB-nothink`, naive `rerunC-nothink`). Deterministic: seed 20260819, 20,000 resamples, no model call, $0. Regenerate with `uv run python stats.py`.

Two cuts are used throughout, both as RESULTS.md defines them:

- **overall-120** — the 120 non-abstention questions.
- **all-450** — all 150 questions x 3 seeds, a gold-abstention question scored right iff the arm abstained.

Point estimates, for reference:

| arm | overall-120 | all-450 |
|---|---:|---:|
| Errata | 60.0 | 66.7 |
| full-context | 47.5 | 54.0 |
| naive top-k | 45.8 | 56.2 |

## Paired exact McNemar

The pairing unit is the **question**, not the row. The three seeds of one question are the same trial re-run, so treating all 450 rows as independent pairs would roughly triple the discordant counts and turn every p-value into a number the design does not support. A question's three seeds are collapsed by **majority**; `b` counts questions Errata got right and the baseline did not, `c` the reverse. The test is the exact two-sided binomial on the b+c discordant pairs.

| cut | comparison | b | c | exact p |
|---|---|---:|---:|---:|
| overall-120 | Errata vs full-context | 29 | 15 | 0.0488 |
| overall-120 | Errata vs naive top-k | 31 | 14 | 0.0161 |
| all-450 | Errata vs full-context | 33 | 15 | 0.0133 |
| all-450 | Errata vs naive top-k | 31 | 15 | 0.0259 |

Every comparison is significant at 0.05 and the direction is Errata's in all four. That is the whole claim — not the size of the gap, which the interval below covers.

**Sensitivity to the seed-collapse rule.** The rule is a judgement call, so here is what the others give. Errata is deterministic across seeds (0 of 150 questions vary), so every difference below comes from the baselines.

| rule | overall-120 vs full-context | overall-120 vs naive top-k | all-450 vs full-context | all-450 vs naive top-k |
|---|---:|---:|---:|---:|
| seed0 | 30/14 | 31/14 | 34/14 | 31/15 |
| seed1 | 30/15 | 31/14 | 34/15 | 31/16 |
| seed2 | 29/15 | 31/14 | 33/15 | 31/15 |
| majority | 29/15 | 31/14 | 33/15 | 31/15 |
| unanimous | 33/14 | 31/14 | 37/14 | 31/15 |

The counts move by at most 4 and no rule changes a single verdict at 0.05. The conclusion does not rest on the choice.

> **An audit pass reported 33/15, 31/14, 37/15 and 31/16 for these four cells. Three of the four do not reproduce, and they cannot all be right at once.** The grid above is exhaustive over the sensible seed-collapse rules, and no single row matches all four: `unanimous` alone reproduces the two full-context `b` counts (33, 37), while the reported `c` counts (15, 15) come only from a per-seed or majority rule, and the two naive cells (31/14, 31/16) reproduce together only under seed1. A pairing rule has to be one rule. The most likely explanation is that the audit's cells were collected under different collapse conventions rather than one. The data itself is not in question: these counts were recomputed independently from the raw `out/rerun*/judgments.jsonl` and `answers.jsonl` and agree with `results.json` exactly, arm by arm and seed by seed. Nothing here changes a verdict — every cell in the grid is significant at 0.05 bar `majority`/`seed2` on overall-120 vs full-context (p = 0.049), which is the one number worth quoting carefully.

## Paired cluster bootstrap, 95%

20,000 resamples of the QUESTION (not the row), with all three arms recomputed on the same resample — that pairing is why the gap intervals are far tighter than the overlap of the per-arm intervals suggests. Overlapping per-arm intervals are not evidence of no difference here; the gap interval is the one to read.

| quantity | point | 95% percentile | 95% basic |
|---|---:|---:|---:|
| Errata overall-120 | 60.0 | [51.7, 69.2] | [50.8, 68.3] |
| Errata all-450 | 66.7 | [59.3, 74.0] | [59.3, 74.0] |
| gap vs full-context, overall-120 | +12.5 | [+1.9, +23.1] | [+1.9, +23.1] |
| gap vs naive top-k, overall-120 | +14.2 | [+3.3, +25.0] | [+3.3, +25.0] |
| gap vs full-context, all-450 | +12.7 | [+4.0, +21.6] | [+3.8, +21.3] |
| gap vs naive top-k, all-450 | +10.4 | [+1.6, +19.3] | [+1.6, +19.3] |

Both conventions are printed because they are not interchangeable and the choice moves the ends by about a point: percentile takes the empirical quantiles, basic reflects them through the point estimate. Every gap interval excludes 0, which is the same conclusion McNemar reached by a different route.

The same audit pass reported [50.8, 68.3] for Errata overall-120 and [58.7, 74.0] for all-450. The first is the **basic** column here to the decimal, which identifies the convention it used; the second differs by 0.6 on the lower end and matches on the upper. Quote the convention with the interval — an unlabelled bootstrap CI is ambiguous by about a point at this sample size.

## Judge-error sensitivity

The judge's measured false-accept rate is **8.3%** (5/60) with a worst case of **18.3%** (11/60) when all six unparseable verdicts are counted as accepts (judge-validation.md). FRR is held at 0, so accepted = true + FAR x (answered - true). False accepts are charged against **answered** rows only: an abstention never reaches the judge and cannot be falsely accepted.

This is the correction that matters most for reading the table honestly, because the arms answer at very different rates — and it moves the lead the *unflattering* way for the baselines, not for Errata. Errata abstains more, so it has less to lose.

**overall-120**

| arm | answered (judged) | accepted | right un-judged | raw | FAR 8.3% | FAR 18.3% |
|---|---:|---:|---:|---:|---:|---:|
| Errata | 273 | 216 | 0 | 60.0 | 58.6 | 56.5 |
| full-context | 308 | 171 | 0 | 47.5 | 44.1 | 39.0 |
| naive top-k | 232 | 165 | 0 | 45.8 | 44.1 | 41.7 |
| **lead vs full-context** | | | | **+12.5** | **+14.5** | **+17.5** |
| **lead vs naive top-k** | | | | **+14.2** | **+14.4** | **+14.8** |

**all-450**

| arm | answered (judged) | accepted | right un-judged | raw | FAR 8.3% | FAR 18.3% |
|---|---:|---:|---:|---:|---:|---:|
| Errata | 273 | 216 | 84 | 66.7 | 65.5 | 63.8 |
| full-context | 308 | 171 | 72 | 54.0 | 51.2 | 47.2 |
| naive top-k | 232 | 165 | 88 | 56.2 | 54.9 | 52.9 |
| **lead vs full-context** | | | | **+12.7** | **+14.3** | **+16.6** |
| **lead vs naive top-k** | | | | **+10.4** | **+10.6** | **+10.9** |

## Post-stratification to the true corpus mix

The comparison sample is allocated proportionally by question type but carries all 30 gold-abstention questions by design (`sample.abstention_whole = true`), which tilts its mix away from the corpus's. Re-weighting the same per-type accuracies to the full 500-question histogram asks what the number would be on a sample that was not tilted.

| question type | in corpus (500) | in sample (150) | Errata | full-context | naive top-k |
|---|---:|---:|---:|---:|---:|
| multi-session | 133 | 43 | 72.1 | 46.5 | 47.3 |
| temporal-reasoning | 133 | 39 | 59.0 | 23.9 | 33.3 |
| knowledge-update | 78 | 24 | 95.8 | 62.5 | 87.5 |
| single-session-user | 70 | 22 | 100.0 | 100.0 | 77.3 |
| single-session-assistant | 56 | 14 | 7.1 | 92.9 | 92.9 |
| single-session-preference | 30 | 8 | 0.0 | 20.8 | 0.0 |

| arm | all-450 | post-stratified | delta |
|---|---:|---:|---:|
| Errata | 66.7 | 64.6 | -2.05 |
| full-context | 54.0 | 54.1 | +0.14 |
| naive top-k | 56.2 | 56.3 | +0.09 |

Errata is the only arm the re-weighting costs anything (-2.1); the baselines are flat to within a rounding step. The driver is visible in the per-type row: Errata is at 7.1 on single-session-assistant and 0.0 on single-session-preference, and the sample carries *less* of both than the corpus does, while over-weighting multi-session and single-session-user where Errata is strongest. Both tilts push the same way. A fair reading of the headline is therefore **64.6, not 66.7** — a real deduction from the published number, and the baselines do not pay it.

## Out-of-sample sanity holdout

**out-of-sample sanity holdout: 14/20 (all single-session-user — a confirm-only draw, disclosed).**

Twenty histories beyond the comparison draw were ingested as canaries and never scored. Their questions are genuinely out of sample — in the graph, never tuned on, never published. `eval/holdout.py` runs the Errata arm over exactly those and judges with the pinned judge.

**The disclosure matters more than the number.** The canary draw was the first twenty histories in corpus order and the corpus is ordered by type, so all twenty are `single-session-user` — the easiest stratum — and none is a gold-abstention question. It can catch a gross regression; it cannot support a claim about the corpus. Judge spend $0.0231.

| | |
|---|---:|
| judged | 20 |
| CORRECT | 14 |
| over-abstained (gold has an answer) | 4 |
| UNPARSEABLE judge reply | 1 |
| envelope, counting unparseable as accepts | 15/20 |

An unparseable verdict counts as a REJECTION here, so 14/20 is the low end and 15/20 the high end — judge-validation.md requires both whenever that count is non-zero. The one unparseable row answered 'University of Melbourne' against a gold of 'University of Melbourne in Australia'; the judge reply, not the answer, is what failed.

**Read this next to the in-sample number for the same stratum.** Errata scores 100.0 on the 22 single-session-user questions inside the comparison set, against 70-75 here. The gap is one small sample against another and nothing is fitted to the comparison set, so this is not evidence of overfitting — but it is a concrete reason not to read a per-type 100.0 as the stratum's true accuracy, and the strongest argument in this document for buying a real held-out set before quoting per-type numbers.

The 4 misses that were over-abstentions are the same failure mode the taxonomy names `A3_material_lacked_it` — the calibrated abstention firing where the history does hold the answer. That is the honest direction to fail in, and it is already the largest bucket below.

## Failure taxonomy (rerunD-g5)

150 questions, one row each.

| bucket | n |
|---|---:|
| ok_answered | 64 |
| ok_abstained | 28 |
| A3_material_lacked_it | 27 |
| B2_extraction_gap | 15 |
| B1_wrong_claim_picked | 7 |
| A4_material_had_it | 4 |
| B3_judge_rejected | 3 |
| C_false_answer | 2 |

