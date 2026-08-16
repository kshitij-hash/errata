# Judge validation — false-accept and false-reject rates

Judge `anthropic/claude-sonnet-5`, judge prompt sha `07286ad6…`, temperature 0.
Scored on the committed 120-item control set: **60 perturbed negatives** (deterministic transforms, `judge-controls.jsonl`, seed 20260818) and **60 paraphrase positives** (`judge-controls-positive.jsonl`, generated once with `google/gemini-3.7-flash`, draw seed 20260818).

## Headline

| Metric | Definition | Measured | Gate | Result |
|---|---|---:|---:|---|
| False-accept rate | perturbed negatives judged CORRECT | **15.0%** (9/60) | ≤ 10.0% | **FAIL** |
| FAR, superseded-value | the family the whole product is about | **0.0%** (0/12) | ≤ 8.0% | PASS |
| False-reject rate | paraphrase positives not judged CORRECT | **0.0%** (0/60) | ≤ 15.0% | PASS |

Reference point: an independent audit measured **62.8%** false-accept for a naive judge prompt on a comparable control set. That number is why this prompt enumerates the rejection conditions explicitly and tie-breaks to INCORRECT.

## Per-family false-accept rate

| Family | n | accepted | FAR | gate | result |
|---|---:|---:|---:|---:|---|
| entity-swap | 12 | 1 | 8.3% | ≤ 10.0% | PASS |
| value-shift | 12 | 1 | 8.3% | ≤ 10.0% | PASS |
| attribution-flip | 12 | 7 | 58.3% | ≤ 10.0% | **FAIL** |
| superseded-value | 12 | 0 | 0.0% | ≤ 8.0% | PASS |
| topical-filler | 12 | 0 | 0.0% | ≤ 10.0% | PASS |

Unparseable verdicts: 4 of 120. An unparseable reply counts as a rejection — never as an accept — so it can only hurt FRR, never flatter FAR.

## Human agreement (Cohen's κ)

κ — not yet computed (awaiting the human labels). The stratified 20-item subset is exported to `judge-controls-for-human.md` with a blank verdict column and no judge verdicts visible. Fill it in, then run:

    uv run python kappa.py --labels judge-controls-for-human.md

## Reproducing

    uv run errata-eval controls                     # the 60 negatives, no LLM, free
    uv run errata-eval controls-positive            # the 60 positives, one cached LLM pass
    uv run errata-eval judge-validate               # score all of them, write this file

Incremental spend for the scored pass: $0.1561 (cache hits are $0 and are ledgered as such).

<!-- hand-written below; preserved across regeneration -->

## The failed gate, and what was NOT done about it

**The overall FAR gate fails: 15.0% against a ≤10% ceiling.** Nothing above was tuned to make it
pass — not the judge prompt, not the control set, not the gate. Per the protocol a failed pin gate
is a war-room item, so what follows is a diagnosis, and the numbers stand as measured.

**The overage is one family.** Four of the five families are at or under their ceiling
(entity-swap 8.3%, value-shift 8.3%, superseded-value 0.0%, topical-filler 0.0%). Attribution-flip
alone is 58.3% (7 of 12), and 7/60 = 11.7 points of the 15.0% overall rate come from it. Drop that
family and the other 48 negatives give 2/48 = 4.2%.

**Reading the 7 accepted attribution flips, they are not one thing.** All 12 items in this family
are the deterministic transform that rewrites first/second person to "the assistant"
(`_ATTRIBUTION_MAP`), and its stated assumption is that in these gold answers both first and second
person refer to the USER. That assumption does not hold uniformly:

| Sub-class | n | Example (gold → candidate) | Verdict on the verdict |
|---|---:|---|---|
| Clean flips: the answer's subject really does change | 3 | "I attended three weddings…" → "The assistant attended three weddings…" | genuine false accepts — the judge is wrong |
| Preference paragraphs where only the leading noun moves | 3 | "The user would prefer responses that build upon **their** previous experimentation…" → "The assistant would prefer responses that build upon their previous experimentation…" | arguable — the sentence still describes the same preference, the transform is weak |
| Assistant-voice gold, where the flip is a no-op | 1 | "I recommended using a Pilsner or Lager" (asked: "what did **you** mention?") → "The assistant recommended using a Pilsner or Lager" | the control is invalid; the judge was right to accept |

So of the 9 false accepts overall, **3 are unambiguous judge errors** (2 of them outside this
family), **3 are a weak control**, and **1 is a broken control**. The measured 15.0% is the number
this control set produces; the judge's true attribution sensitivity is somewhere between that and
the 4.2% the other four families show, and this run cannot say where.

**Four verdicts in this same family came back UNPARSEABLE** (4 of 120 overall, all
attribution-flip) — the judge is given `judge_max_tokens = 64`, the same budget the published runs
used, and these are the items it evidently wanted to write more about. They are counted as
rejections, so the 58.3% is a **lower bound** on this family, not an upper one.

**What the war room has to decide**, in the order that matters:

1. Is attribution-flip, as transformed today, a fair test? Fixing the two identified defects (skip
   gold answers written in the assistant's voice; require the flip to change more than a leading
   noun) means rebuilding those 12 controls and re-scoring. That is a change to the *instrument*,
   and it must be decided and disclosed as one — doing it quietly after seeing a failing number is
   exactly how a gate becomes decorative.
2. Independently of (1): does anything published depend on this? The runs in `RESULTS.md` are
   graded by this judge, so the honest reading is that its accuracy on answers whose SUBJECT is
   wrong is unmeasured-to-poor. No Errata number leans on that: the knowledge-update column leans
   on superseded-value, measured here at 0/12.
3. Whether to escalate to `judge_escalation` (`anthropic/claude-opus-5`) on this same 120-item set.
   That is the pre-registered recovery ladder for a failed FAR gate and costs roughly 2.5× this
   pass. It has NOT been run.

**Not done, deliberately:** no edit to `JUDGE_PROMPT`, no re-score, no re-draw of the control set,
no gate relaxation, no escalation. The next command anyone runs against this file should be a
decision, not a re-measurement.
