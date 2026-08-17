# Judge validation — false-accept and false-reject rates

Judge `anthropic/claude-sonnet-5`, judge prompt sha `07286ad6…`, temperature 0.
Scored on the committed 120-item control set: **60 perturbed negatives** (deterministic transforms, `judge-controls.jsonl`, seed 20260818) and **60 paraphrase positives** (`judge-controls-positive.jsonl`, generated once with `google/gemini-3.7-flash`, draw seed 20260818).

## Headline

| Metric | Definition | Measured | Gate | Result |
|---|---|---:|---:|---|
| False-accept rate | perturbed negatives judged CORRECT | **8.3%** (5/60) | ≤ 10.0% | PASS |
| FAR, superseded-value | the family the whole product is about | **0.0%** (0/12) | ≤ 8.0% | PASS |
| False-reject rate | paraphrase positives not judged CORRECT | **0.0%** (0/60) | ≤ 15.0% | PASS |


## Both control sets, side by side

The control set was revised after the first measured run; `original controls` is what that run scored. Nothing about the judge changed between these two columns — same model, same prompt sha, same temperature, same token budget. Only defective controls changed, and the change log below says which and why.

| Metric | original controls | corrected controls | gate |
|---|---:|---:|---:|
| FAR, overall | 15.0% (9/60) | **8.3%** (5/60) | ≤ 10.0% |
| FAR, entity-swap | 8.3% | 8.3% | — |
| FAR, value-shift | 8.3% | 8.3% | — |
| FAR, attribution-flip | 58.3% | 25.0% | — |
| FAR, superseded-value | 0.0% | 0.0% | ≤ 8.0% |
| FAR, topical-filler | 0.0% | 0.0% | — |
| FRR | 0.0% (0/60) | **0.0%** (0/60) | ≤ 15.0% |
| unparseable | 4 | 6 | — |

Reference point: an independent audit measured **62.8%** false-accept for a naive judge prompt on a comparable control set. That number is why this prompt enumerates the rejection conditions explicitly and tie-breaks to INCORRECT.

## Per-family false-accept rate

| Family | n | accepted | FAR | gate | result |
|---|---:|---:|---:|---:|---|
| entity-swap | 12 | 1 | 8.3% | ≤ 10.0% | PASS |
| value-shift | 12 | 1 | 8.3% | ≤ 10.0% | PASS |
| attribution-flip | 12 | 3 | 25.0% | ≤ 10.0% | **FAIL** |
| superseded-value | 12 | 0 | 0.0% | ≤ 8.0% | PASS |
| topical-filler | 12 | 0 | 0.0% | ≤ 10.0% | PASS |

Unparseable verdicts: 6 of 120. An unparseable reply counts as a rejection — never as an accept — so it can only hurt FRR, never flatter FAR. That is the conservative direction, not a free pass: whenever this count is non-zero the headline FAR is one end of an envelope whose other end treats every unparseable verdict as an accept, and both ends belong in the same paragraph. A reply that stops at the judge's `judge_max_tokens` budget is truncation, not a malformed judge — check `completion_tokens` in the ledger before concluding anything else.

## Human agreement (Cohen's κ)

κ — not yet computed (awaiting the human labels). The stratified 20-item subset is exported to `judge-controls-for-human.md` with a blank verdict column and no judge verdicts visible. Fill it in, then run:

    uv run python kappa.py --labels judge-controls-for-human.md

## Reproducing

    uv run errata-eval controls                     # the 60 negatives, no LLM, free
    uv run errata-eval controls-positive            # the 60 positives, one cached LLM pass
    uv run errata-eval judge-validate               # score all of them, write this file

Incremental spend for the corrected-controls pass: $0.0144 (cache hits are $0 and are ledgered as such).

<!-- hand-written below; preserved across regeneration -->

## Control-set revision log — 2026-08-17

The first measured run of this protocol failed the overall FAR gate at **15.0%**, and the failure
was escalated rather than papered over. The review ruling drew the line this repo now enforces:
**tuning the JUDGE to pass is forbidden; fixing defects in the CONTROL SET is correct measurement
practice, done openly.** Nothing about the judge changed — same model, same `JUDGE_PROMPT` (sha
`07286ad6…`), same temperature 0, same `judge_max_tokens = 64`. Both numbers are published above.

### What changed, and why

Two defects in `_t_attribution_flip` were making it mismeasure the judge rather than test it. Both
are fixed by a **predicate over the gold and the question** — never by a list of question ids.
That distinction is the whole integrity of this revision: selecting controls by the verdict they
happened to receive is how a control set is quietly tuned, and it is precisely what a defect
predicate cannot do, because it does not know the verdicts.

**Defect 1 — the incomplete flip (6 controls sharpened).** When the gold names the party ("The user
would prefer responses that build upon **their** previous experimentation…"), flipping only the
leading noun left every co-referring pronoun pointing at the original party, so the candidate still
described the same preference. The transform now performs the complete role swap — the named party
*and* its co-referents:

> before — "**The assistant** would prefer responses that build upon **their** previous experimentation with turbinado sugar"
> after  — "**The assistant** would prefer responses that build upon **the assistant's** previous experimentation with turbinado sugar"

The review named three of these. There are **six**, and all six were fixed. The three it named
are exactly the three the judge accepted; the other three it rejected or truncated on. Fixing only
the accepted ones would have been selecting controls by verdict in the direction that lowers FAR,
which is the bias this whole exercise exists to avoid. `38146c39`, `afdc33df`, `54026fce`,
`75832dbd`, `1d4e3b97`, `35a27287`.

**Defect 2 — the no-op flip (1 control removed, 1 drawn in its place).** `16c90bf4` asked what the
*assistant* recommended, so its gold is in the assistant's voice ("I recommended using a Pilsner or
Lager") and mapping first person to "the assistant" preserved the meaning exactly. The candidate
asserted nothing wrong and **the judge was right to accept it**. The transform now skips golds in
the assistant's voice, and the family drew the next eligible question, `195a1a1b`.

**One forced cascade, disclosed: `e493bb7c` → `16c90bf4` in topical-filler.** Families share a
used-question set and draw in a fixed order, so releasing `16c90bf4` from attribution-flip made it
available to topical-filler, which took it and dropped `e493bb7c`. This is churn unrelated to the
defect, so it was checked rather than waved past: **the dropped control scored INCORRECT and its
replacement also scores INCORRECT**, so the cascade moves the measurement by exactly zero.

Every other one of the 120 controls is byte-identical, and 112 of the 120 verdicts are cache
replays of the original run — same bytes in, same verdict out.

### Where the 6.7 points went

| control | family | before → after | cause |
|---|---|---|---|
| `16c90bf4` | attribution-flip → topical-filler | CORRECT → INCORRECT | broken control removed; the judge's original accept was correct |
| `195a1a1b` | attribution-flip (new) | — → UNPARSEABLE | replacement draw |
| `38146c39` | attribution-flip | CORRECT → INCORRECT | sharpened |
| `afdc33df` | attribution-flip | UNPARSEABLE → INCORRECT | sharpened |
| `1d4e3b97` | attribution-flip | CORRECT → UNPARSEABLE | sharpened |
| `75832dbd` | attribution-flip | CORRECT → UNPARSEABLE | sharpened |
| `54026fce` | attribution-flip | INCORRECT → INCORRECT | sharpened, verdict unmoved |
| `35a27287` | attribution-flip | UNPARSEABLE → UNPARSEABLE | sharpened, verdict unmoved |
| `e493bb7c` | topical-filler | INCORRECT → (removed) | cascade, net zero |

### The truncation artifact, and the honest envelope

All **6** unparseable verdicts are attribution-flip items, and every one of them returned
**exactly 64 completion tokens — the cap**. This is truncation, not a malformed judge: the judge
wanted to write more about precisely the family it finds hardest. The deployed judge config is left
**frozen** (same 64-token budget as the published runs) so this measurement stays comparable with
`RESULTS.md`; raising it would produce a number that no longer describes the judge that graded
those runs. Across all 3,128 real judge calls in the ledger only 21 hit the cap, so the artifact is
rare overall (0.7%) and concentrated here.

Per the pre-registered rule an unparseable verdict counts as a **rejection**, which is the
conservative direction: it can only inflate FRR, never flatter FAR. But it means the headline is
one end of an envelope, and the other end belongs in the same paragraph as the number:

| | scored (unparseable = rejection) | worst case (unparseable = accept) |
|---|---:|---:|
| FAR, overall | **8.3%** (5/60) | 18.3% (11/60) |
| FAR, attribution-flip | **25.0%** (3/12) | 75.0% (9/12) |
| FAR, other four families | 4.2% (2/48) | 4.2% (2/48) |

**The gate passes on the pre-registered scoring rule. It does not pass on the worst case, and the
worst case is confined to attribution-flip.** Read together, the two columns say the same thing the
failing run said, only more precisely: this judge's one weak family is wrong-speaker attribution.

### What still stands

- **Attribution-flip remains the weak family** at 25.0% scored, against ≤10% — the per-family table
  above still reads FAIL on that row, and it should. The overall gate is what the protocol pins a
  judge on; the family row is a documented weakness, published, not smoothed.
- **superseded-value is 0/12 in both control sets.** The judge cannot be fooled by an earlier value
  presented as current — the one category Errata's thesis actually rests on.
- **FRR is 0/60 in both**: no paraphrase of a gold answer was rejected.
- **Escalation to `judge_escalation` (`claude-opus-5`) was not run** and is not needed: the overall
  gate passes without it.
