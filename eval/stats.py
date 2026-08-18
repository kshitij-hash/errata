"""Inferential statistics over the committed eval artifacts.

RESULTS.md publishes point estimates. This publishes the uncertainty around them: whether the
gaps survive a paired test, how wide the interval on the headline is, what a judge with a known
false-accept rate does to the lead, and what the sample's question-type mix is worth.

Everything here is computed from artifacts already in the repo — no run, no model call, no spend.
Sources:
  apps/web/data/results.json   judged rows for all three arms (errata=rerunJ-arith,
                               full_context=rerunB-nothink, naive=rerunC-nothink)
  eval/out/failure-taxonomy.jsonl   rerunD-g5 bucket counts (OPTIONAL — gitignored, so this
                               section is omitted rather than fatal when it is absent)

Deliberately stdlib + numpy only. scipy is NOT a declared dependency of this project (it is
present today only as a transitive of the `embed` extra), so the exact binomial test is
implemented here rather than imported — a clean `uv sync` must be able to run this.

Usage:  uv run python stats.py [--out out/stats.md] [--resamples 20000]
"""

from __future__ import annotations

import argparse
import json
import math
import random
from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

_EVAL = Path(__file__).resolve().parent  # eval/
_ROOT = _EVAL.parent  # repo root
RESULTS_PATH = _ROOT / "apps" / "web" / "data" / "results.json"
TAXONOMY_PATH = _EVAL / "out" / "failure-taxonomy.jsonl"

ARMS = ("errata", "full_context", "naive")
BASELINES = ("full_context", "naive")
LABEL = {"errata": "Errata", "full_context": "full-context", "naive": "naive top-k"}

# eval.toml [run].sample_seed. Reused so every resample in this file is reproducible.
SEED = 20260819
RESAMPLES = 20_000

# Judge false-accept rate and its worst case, from judge-validation.md: 8.3% (5/60) headline,
# 18.3% (11/60) when all six unparseable verdicts are counted as accepts instead of rejections.
# FRR is held at 0 — the correction below assumes every truly-correct answer was accepted.
FAR_HEADLINE = 0.083
FAR_WORST = 0.183

# The full 500-question corpus's own question_type histogram (data-raw/longmemeval_s_cleaned.json;
# pinned by eval/tests/test_dataset.py). The comparison sample over-weights some of these.
FULL_CORPUS_MIX = {
    "multi-session": 133,
    "temporal-reasoning": 133,
    "knowledge-update": 78,
    "single-session-user": 70,
    "single-session-assistant": 56,
    "single-session-preference": 30,
}


# --------------------------------------------------------------------------------------------
# artifacts
# --------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class Bundle:
    questions: list[dict]
    rows: dict[str, dict[str, dict]]
    n_seeds: int

    @property
    def non_abstention(self) -> list[dict]:
        return [q for q in self.questions if not q["abstention"]]

    def right(self, arm: str, q: dict, seed_idx: int) -> bool:
        """The repo's own scoring rule (apps/web/lib/results.ts::isRight): a gold-abstention
        question is right iff the arm abstained, every other question iff the judge said CORRECT."""
        r = self.rows[arm][q["id"]]
        if q["abstention"]:
            return r["abstained"][seed_idx] is True
        return r["verdicts"][seed_idx] == "CORRECT"

    def answered(self, arm: str, q: dict, seed_idx: int) -> bool:
        return self.rows[arm][q["id"]]["abstained"][seed_idx] is not True


def load_bundle(path: Path = RESULTS_PATH) -> Bundle:
    raw = json.loads(path.read_bytes())
    rows = {a: raw["arms"][a]["rows"] for a in ARMS}
    n_seeds = len(raw["provenance"]["seeds"])
    return Bundle(questions=raw["questions"], rows=rows, n_seeds=n_seeds)


# --------------------------------------------------------------------------------------------
# (a) paired exact McNemar
# --------------------------------------------------------------------------------------------
def exact_mcnemar(b: int, c: int) -> float:
    """Two-sided exact McNemar: a binomial sign test on the b+c discordant pairs against p=0.5.

    Exact rather than the chi-square approximation because b+c is ~50 here and one cell is ~15.
    Implemented directly — scipy is not a declared dependency (see the module docstring).
    """
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    tail = sum(math.comb(n, i) for i in range(k + 1)) / (2**n)
    return min(1.0, 2 * tail)


def _agg(values: Sequence[bool], rule: str) -> bool:
    if rule == "majority":
        return sum(values) * 2 > len(values)
    if rule == "unanimous":
        return all(values)
    if rule.startswith("seed"):
        return bool(values[int(rule[4:])])
    raise ValueError(f"unknown rule {rule!r}")


def discordant(bundle: Bundle, qset: Sequence[dict], a: str, b: str, rule: str) -> tuple[int, int]:
    """(b, c) = (a right & b wrong, b right & a wrong), paired per QUESTION.

    The pairing unit is the question, not the (question, seed) row: the three seeds of one
    question are the same trial re-run, so treating 450 rows as 450 independent pairs would
    triple the discordant counts and understate every p-value. `rule` collapses a question's
    three seeds to one boolean; `majority` is the shipped choice (see stats.md).
    """
    bb = cc = 0
    for q in qset:
        ra = _agg([bundle.right(a, q, s) for s in range(bundle.n_seeds)], rule)
        rb = _agg([bundle.right(b, q, s) for s in range(bundle.n_seeds)], rule)
        if ra and not rb:
            bb += 1
        elif rb and not ra:
            cc += 1
    return bb, cc


def mcnemar_table(bundle: Bundle, rule: str = "majority") -> dict[tuple[str, str], tuple[int, int, float]]:
    cuts = {"overall-120": bundle.non_abstention, "all-450": bundle.questions}
    out: dict[tuple[str, str], tuple[int, int, float]] = {}
    for cut, qset in cuts.items():
        for base in BASELINES:
            b, c = discordant(bundle, qset, "errata", base, rule)
            out[(cut, base)] = (b, c, exact_mcnemar(b, c))
    return out


# --------------------------------------------------------------------------------------------
# (b) paired cluster bootstrap
# --------------------------------------------------------------------------------------------
def accuracy(bundle: Bundle, arm: str, qset: Sequence[dict]) -> float:
    n = len(qset) * bundle.n_seeds
    return 100.0 * sum(bundle.right(arm, q, s) for q in qset for s in range(bundle.n_seeds)) / n


def bootstrap_ci(
    qset: Sequence[dict],
    stat: Callable[[Sequence[dict]], float],
    resamples: int = RESAMPLES,
    seed: int = SEED,
) -> tuple[float, float, float, float]:
    """Paired cluster bootstrap. Returns (percentile_lo, percentile_hi, basic_lo, basic_hi).

    The resampling unit is the QUESTION and all arms are recomputed on the SAME resample — that
    is what makes it paired, and it is why the gap intervals are much tighter than the difference
    of the two per-arm intervals would suggest. Resampling rows instead would treat a question's
    three seeds as independent and shrink every interval by ~sqrt(3).

    Both conventions are returned because they disagree materially on a skewed statistic:
    percentile takes the empirical quantiles; basic (reverse-percentile) reflects them through
    the point estimate, 2*theta - q.
    """
    rng = random.Random(seed)
    n = len(qset)
    point = stat(qset)
    draws = []
    for _ in range(resamples):
        pick = [qset[rng.randrange(n)] for _ in range(n)]
        draws.append(stat(pick))
    draws.sort()
    lo = draws[int(0.025 * resamples)]
    hi = draws[int(0.975 * resamples)]
    return lo, hi, 2 * point - hi, 2 * point - lo


# --------------------------------------------------------------------------------------------
# (c) judge-error sensitivity
# --------------------------------------------------------------------------------------------
def far_corrected(accepted: int, answered: int, unjudged_right: int, total: int, far: float) -> float:
    """Accuracy after removing the judge's expected false accepts, at FRR = 0.

    With FRR = 0 every truly-correct answer is accepted, so the judged accepts decompose as
        accepted = true_correct + far * (answered - true_correct)
    and solving for true_correct gives the expression below.

    Two exclusions, and both are load-bearing:
      - false accepts are drawn from ANSWERED-but-wrong rows only. An abstention is never sent to
        the judge and cannot be falsely accepted. The arms abstain at very different rates, so
        charging each the same FAR against its whole row count would flatter whichever answers most.
      - `unjudged_right` (a gold-abstention question the arm correctly abstained on) is scored by
        the deterministic `exact_abstain` path, never by the model, and passes through untouched.
        Folding it into `accepted` is what makes a naive version of this correction absurd — on
        all-450 it puts accepted ABOVE answered and the "corrected" accuracy rises with FAR.
    """
    true_correct = (accepted - far * answered) / (1.0 - far)
    return 100.0 * (true_correct + unjudged_right) / total


def judge_sensitivity(bundle: Bundle, qset: Sequence[dict]) -> dict[str, dict[str, float]]:
    total = len(qset) * bundle.n_seeds
    out: dict[str, dict[str, float]] = {}
    for arm in ARMS:
        judged = [(q, s) for q in qset for s in range(bundle.n_seeds) if not q["abstention"]]
        unjudged = [(q, s) for q in qset for s in range(bundle.n_seeds) if q["abstention"]]
        accepted = sum(bundle.right(arm, q, s) for q, s in judged)
        answered = sum(bundle.answered(arm, q, s) for q, s in judged)
        unjudged_right = sum(bundle.right(arm, q, s) for q, s in unjudged)
        out[arm] = {
            "accepted": accepted,
            "answered": answered,
            "unjudged_right": unjudged_right,
            "raw": 100.0 * (accepted + unjudged_right) / total,
            "far_headline": far_corrected(accepted, answered, unjudged_right, total, FAR_HEADLINE),
            "far_worst": far_corrected(accepted, answered, unjudged_right, total, FAR_WORST),
        }
    return out


# --------------------------------------------------------------------------------------------
# (d) corpus-mix post-stratification
# --------------------------------------------------------------------------------------------
def post_stratified(bundle: Bundle, arm: str, mix: dict[str, int] | None = None) -> float:
    """all-450 accuracy re-weighted from the sample's question-type mix to the full corpus's.

    The comparison sample is allocated proportionally BUT carries all 30 gold-abstention
    questions by design (`sample.abstention_whole`), which tilts the mix. This asks what the
    same per-type accuracies would total under the 500-question corpus's own histogram.
    """
    mix = mix or FULL_CORPUS_MIX
    total_w = sum(mix.values())
    acc = 0.0
    for qtype, weight in mix.items():
        sub = [q for q in bundle.questions if q["type"] == qtype]
        if not sub:
            raise ValueError(f"no sampled questions of type {qtype!r}")
        acc += (weight / total_w) * (accuracy(bundle, arm, sub) / 100.0)
    return 100.0 * acc


# --------------------------------------------------------------------------------------------
# rerunD taxonomy (optional)
# --------------------------------------------------------------------------------------------
def taxonomy_buckets(path: Path = TAXONOMY_PATH) -> Counter | None:
    if not path.exists():
        return None
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    return Counter(r["bucket"] for r in rows)


# --------------------------------------------------------------------------------------------
# report
# --------------------------------------------------------------------------------------------
def _fmt_p(p: float) -> str:
    return f"{p:.4f}" if p >= 0.001 else f"{p:.1e}"


def render(bundle: Bundle, resamples: int = RESAMPLES) -> str:
    L: list[str] = []
    w = L.append
    cuts = {"overall-120": bundle.non_abstention, "all-450": bundle.questions}

    w("# Statistics over the committed run\n")
    w(
        "Computed by `eval/stats.py` from `apps/web/data/results.json` (errata `rerunJ-arith`, "
        "full-context `rerunB-nothink`, naive `rerunC-nothink`). Deterministic: seed "
        f"{SEED}, {resamples:,} resamples, no model call, $0. Regenerate with "
        "`uv run python stats.py`.\n"
    )
    w("Two cuts are used throughout, both as RESULTS.md defines them:\n")
    w("- **overall-120** — the 120 non-abstention questions.")
    w("- **all-450** — all 150 questions x 3 seeds, a gold-abstention question scored right iff the arm abstained.\n")

    w("Point estimates, for reference:\n")
    w("| arm | overall-120 | all-450 |")
    w("|---|---:|---:|")
    for arm in ARMS:
        w(f"| {LABEL[arm]} | {accuracy(bundle, arm, bundle.non_abstention):.1f} | {accuracy(bundle, arm, bundle.questions):.1f} |")
    w("")

    # ---- (a)
    w("## Paired exact McNemar\n")
    w(
        "The pairing unit is the **question**, not the row. The three seeds of one question are "
        "the same trial re-run, so treating all 450 rows as independent pairs would roughly "
        "triple the discordant counts and turn every p-value into a number the design does not "
        "support. A question's three seeds are collapsed by **majority**; `b` counts questions "
        "Errata got right and the baseline did not, `c` the reverse. The test is the exact "
        "two-sided binomial on the b+c discordant pairs.\n"
    )
    w("| cut | comparison | b | c | exact p |")
    w("|---|---|---:|---:|---:|")
    table = mcnemar_table(bundle, "majority")
    for (cut, base), (b, c, p) in table.items():
        w(f"| {cut} | Errata vs {LABEL[base]} | {b} | {c} | {_fmt_p(p)} |")
    w("")
    w(
        "Every comparison is significant at 0.05 and the direction is Errata's in all four. "
        "That is the whole claim — not the size of the gap, which the interval below covers.\n"
    )

    w("**Sensitivity to the seed-collapse rule.** The rule is a judgement call, so here is what "
      "the others give. Errata is deterministic across seeds (0 of 150 questions vary), so every "
      "difference below comes from the baselines.\n")
    w("| rule | " + " | ".join(f"{cut} vs {LABEL[b]}" for cut in cuts for b in BASELINES) + " |")
    w("|---|" + "---:|" * (len(cuts) * len(BASELINES)))
    for rule in ("seed0", "seed1", "seed2", "majority", "unanimous"):
        cells = []
        for cut, qset in cuts.items():
            for base in BASELINES:
                bb, cc = discordant(bundle, qset, "errata", base, rule)
                cells.append(f"{bb}/{cc}")
        w(f"| {rule} | " + " | ".join(cells) + " |")
    w("")
    w(
        "The counts move by at most 4 and no rule changes a single verdict at 0.05. The "
        "conclusion does not rest on the choice.\n"
    )
    w(
        "> **An audit pass reported 33/15, 31/14, 37/15 and 31/16 for these four cells. Three of "
        "the four do not reproduce, and they cannot all be right at once.** The grid above is "
        "exhaustive over the sensible seed-collapse rules, and no single row matches all four: "
        "`unanimous` alone reproduces the two full-context `b` counts (33, 37), while the "
        "reported `c` counts (15, 15) come only from a per-seed or majority rule, and the two "
        "naive cells (31/14, 31/16) reproduce together only under seed1. A pairing rule has to be "
        "one rule. The most likely explanation is that the audit's cells were collected under "
        "different collapse conventions rather than one. The data itself is not in question: "
        "these counts were recomputed independently from the raw `out/rerun*/judgments.jsonl` "
        "and `answers.jsonl` and agree with `results.json` exactly, arm by arm and seed by seed. "
        "Nothing here changes a verdict — every cell in the grid is significant at 0.05 bar "
        "`majority`/`seed2` on overall-120 vs full-context (p = 0.049), which is the one number "
        "worth quoting carefully.\n"
    )

    # ---- (b)
    w("## Paired cluster bootstrap, 95%\n")
    w(
        f"{resamples:,} resamples of the QUESTION (not the row), with all three arms recomputed "
        "on the same resample — that pairing is why the gap intervals are far tighter than the "
        "overlap of the per-arm intervals suggests. Overlapping per-arm intervals are not "
        "evidence of no difference here; the gap interval is the one to read.\n"
    )
    w("| quantity | point | 95% percentile | 95% basic |")
    w("|---|---:|---:|---:|")
    for cut, qset in cuts.items():
        lo, hi, blo, bhi = bootstrap_ci(qset, lambda p, c=cut: accuracy(bundle, "errata", p), resamples)
        w(f"| Errata {cut} | {accuracy(bundle, 'errata', qset):.1f} | [{lo:.1f}, {hi:.1f}] | [{blo:.1f}, {bhi:.1f}] |")
    for cut, qset in cuts.items():
        for base in BASELINES:
            pt = accuracy(bundle, "errata", qset) - accuracy(bundle, base, qset)
            lo, hi, blo, bhi = bootstrap_ci(
                qset, lambda p, b=base: accuracy(bundle, "errata", p) - accuracy(bundle, b, p), resamples
            )
            w(f"| gap vs {LABEL[base]}, {cut} | {pt:+.1f} | [{lo:+.1f}, {hi:+.1f}] | [{blo:+.1f}, {bhi:+.1f}] |")
    w("")
    w(
        "Both conventions are printed because they are not interchangeable and the choice moves "
        "the ends by about a point: percentile takes the empirical quantiles, basic reflects them "
        "through the point estimate. Every gap interval excludes 0, which is the same conclusion "
        "McNemar reached by a different route.\n"
    )
    w(
        "The same audit pass reported [50.8, 68.3] for Errata overall-120 and [58.7, 74.0] for "
        "all-450. The first is the **basic** column here to the decimal, which identifies the "
        "convention it used; the second differs by 0.6 on the lower end and matches on the "
        "upper. Quote the convention with the interval — an unlabelled bootstrap CI is ambiguous "
        "by about a point at this sample size.\n"
    )

    # ---- (c)
    w("## Judge-error sensitivity\n")
    w(
        f"The judge's measured false-accept rate is **{FAR_HEADLINE:.1%}** (5/60) with a worst "
        f"case of **{FAR_WORST:.1%}** (11/60) when all six unparseable verdicts are counted as "
        "accepts (judge-validation.md). FRR is held at 0, so accepted = true + FAR x (answered - "
        "true). False accepts are charged against **answered** rows only: an abstention never "
        "reaches the judge and cannot be falsely accepted.\n"
    )
    w(
        "This is the correction that matters most for reading the table honestly, because the "
        "arms answer at very different rates — and it moves the lead the *unflattering* way for "
        "the baselines, not for Errata. Errata abstains more, so it has less to lose.\n"
    )
    for cut, qset in cuts.items():
        s = judge_sensitivity(bundle, qset)
        w(f"**{cut}**\n")
        w("| arm | answered (judged) | accepted | right un-judged | raw | FAR 8.3% | FAR 18.3% |")
        w("|---|---:|---:|---:|---:|---:|---:|")
        for arm in ARMS:
            d = s[arm]
            w(
                f"| {LABEL[arm]} | {d['answered']} | {d['accepted']} | {d['unjudged_right']} | "
                f"{d['raw']:.1f} | {d['far_headline']:.1f} | {d['far_worst']:.1f} |"
            )
        for base in BASELINES:
            raw = s["errata"]["raw"] - s[base]["raw"]
            h = s["errata"]["far_headline"] - s[base]["far_headline"]
            wc = s["errata"]["far_worst"] - s[base]["far_worst"]
            w(f"| **lead vs {LABEL[base]}** | | | | **{raw:+.1f}** | **{h:+.1f}** | **{wc:+.1f}** |")
        w("")

    # ---- (d)
    w("## Post-stratification to the true corpus mix\n")
    w(
        "The comparison sample is allocated proportionally by question type but carries all 30 "
        "gold-abstention questions by design (`sample.abstention_whole = true`), which tilts its "
        "mix away from the corpus's. Re-weighting the same per-type accuracies to the full "
        "500-question histogram asks what the number would be on a sample that was not tilted.\n"
    )
    samp = Counter(q["type"] for q in bundle.questions)
    w("| question type | in corpus (500) | in sample (150) | " + " | ".join(LABEL[a] for a in ARMS) + " |")
    w("|---|---:|---:|" + "---:|" * len(ARMS))
    for qtype, weight in FULL_CORPUS_MIX.items():
        sub = [q for q in bundle.questions if q["type"] == qtype]
        cells = " | ".join(f"{accuracy(bundle, a, sub):.1f}" for a in ARMS)
        w(f"| {qtype} | {weight} | {samp[qtype]} | {cells} |")
    w("")
    w("| arm | all-450 | post-stratified | delta |")
    w("|---|---:|---:|---:|")
    for arm in ARMS:
        raw = accuracy(bundle, arm, bundle.questions)
        ps = post_stratified(bundle, arm)
        w(f"| {LABEL[arm]} | {raw:.1f} | {ps:.1f} | {ps - raw:+.2f} |")
    w("")
    w(
        "Errata is the only arm the re-weighting costs anything (-2.1); the baselines are flat to "
        "within a rounding step. The driver is visible in the per-type row: Errata is at 7.1 on "
        "single-session-assistant and 0.0 on single-session-preference, and the sample carries "
        "*less* of both than the corpus does, while over-weighting multi-session and "
        "single-session-user where Errata is strongest. Both tilts push the same way. A fair "
        "reading of the headline is therefore **64.6, not 66.7** — a real deduction from the "
        "published number, and the baselines do not pay it.\n"
    )

    # ---- rerunD
    buckets = taxonomy_buckets()
    w("## Failure taxonomy (rerunD-g5)\n")
    if buckets is None:
        w(
            "`eval/out/failure-taxonomy.jsonl` is not present. It is gitignored (`out/*`), so it "
            "exists only on a machine that has run the taxonomy; this section is skipped rather "
            "than fatal. `eval/out/failure-taxonomy.md` carries the committed prose version.\n"
        )
    else:
        w(f"{sum(buckets.values())} questions, one row each.\n")
        w("| bucket | n |")
        w("|---|---:|")
        for bucket, n in sorted(buckets.items(), key=lambda kv: (-kv[1], kv[0])):
            w(f"| {bucket} | {n} |")
        w("")

    return "\n".join(L) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=str(_EVAL / "out" / "stats.md"))
    ap.add_argument("--resamples", type=int, default=RESAMPLES)
    args = ap.parse_args()

    bundle = load_bundle()
    text = render(bundle, args.resamples)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text)
    print(f"wrote {out} ({len(text)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
