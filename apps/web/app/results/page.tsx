import type { Metadata } from 'next';
import Link from 'next/link';
import { ArmChart, ContextChart } from '../../components/results/ArmChart';
import { ScoreCell } from '../../components/results/Cells';
import {
  ARITH_DIFF,
  ARMS,
  type ArmKey,
  EXPERIMENTS,
  PROVENANCE,
  PUBLISHED,
  QUESTIONS,
  REVERT_DIFF_ROWS,
  abstentionPR,
  all450,
  cell,
  ctxTokens,
  cut,
  cutForQuestion,
  judgeFAR,
  judgeFRR,
  judgeFamily,
  pct,
  question,
  questionsIn,
  tauSweep,
} from '../../lib/results';

export const metadata: Metadata = {
  title: 'Results',
  description:
    'The published eval, auditable in the product: every cell opens the judged rows it was counted from — including the ones Errata loses and the experiments that were rejected.',
};

const ARM_KEYS: ArmKey[] = ['errata', 'full_context', 'naive'];
const ABILITY_CUTS = ['information-extraction', 'multi-session', 'temporal', 'knowledge-update'].map((s) => cut(s)!);
const TYPE_CUTS = [
  'single-session-user',
  'single-session-assistant',
  'single-session-preference',
  'multi-session',
  'temporal-reasoning',
  'knowledge-update',
].map((t) => cut(`type-${t}`)!);

/** One-line mechanisms, each sourced from eval/RESULTS.md — no number is retyped here. */
const EXPERIMENT_NOTES: { run: string; what: string; why: string; verdict: 'SHIPPED' | 'REJECTED' | 'VERIFIED' }[] = [
  {
    run: 'rerunG-max45',
    what: 'widen the material window, 30 → 45 claims',
    why: 'the extra claims are distractors, not evidence — answered rose and answered-precision fell, so the window was never the binding constraint',
    verdict: 'REJECTED',
  },
  {
    run: 'rerunH-typed',
    what: 'a $0 deterministic typed-fact recall pass — 34,684 claims appended at zero LLM cost, 0 supersessions minted',
    why: 'typed claims took 27% of the 30-claim window and displaced better evidence; on the case that motivated it all four addends were already in the window and the reader added them wrong — arithmetic, not recall',
    verdict: 'REJECTED',
  },
  {
    run: 'rerunI-restored',
    what: 'restore the graph from the pre-apply snapshot and re-run all 450 rows',
    why: 'the revert is verified rather than asserted — the restored build answers identically to the build that earned the published number',
    verdict: 'VERIFIED',
  },
  {
    run: 'rerunJ-arith',
    what: 'the graph does the sum, not the prompt — question-scoped arithmetic over the material’s amounts, no model call',
    why: 'shipped: three answers changed, two of them from INCORRECT to CORRECT and none the other way; `answered` is identical at 279, so nothing was bought by answering more',
    verdict: 'SHIPPED',
  },
];

export default function ResultsPage() {
  const far = judgeFAR();
  const frr = judgeFRR();
  const superseded = judgeFamily('superseded-value');
  const attribution = judgeFamily('attribution-flip');

  return (
    <main className="route res">
      <h1 className="rtitle">What it scores — and what it lost</h1>
      <p className="q" style={{ maxWidth: '640px' }}>
        Three arms, the same {QUESTIONS.length} LongMemEval questions, the same answer model and prompt — so the
        comparison measures the memory layer, not the reader. Every number on this page is recomputed at build time
        from the judged rows, and every one of them opens those rows. The cells Errata loses are printed as losses.
      </p>

      {/* ───────────────────────────── the verdict, drawn ───────────────────────────── */}
      <ArmChart cuts={[cut('overall')!, ...ABILITY_CUTS]} />
      <p className="cap">
        Counting all {QUESTIONS.length * PROVENANCE.seeds.length} rows including abstention, the same runs read{' '}
        <b>
          Errata {pct(all450('errata'))}, naive {pct(all450('naive'))}, full-context {pct(all450('full_context'))}
        </b>
        . What the accuracies above cost to produce:
      </p>
      <ContextChart />

      <details className="disc prov-disc">
        <summary>Runs of record — the full provenance</summary>
        <div className="prov mono">
          <span>
            {QUESTIONS.length} LongMemEval questions · {PROVENANCE.sample}
          </span>
          <span>
            seeds {PROVENANCE.seeds.join('/')} · temperature 0 · answer model {PROVENANCE.answer_model} · answer prompt
            sha {PROVENANCE.answer_prompt_sha} across all three arms
          </span>
          <span>
            judge {PROVENANCE.judge_model} (sha {PROVENANCE.judge_prompt_sha}) · abstention scored by exact match,
            never by the judge
          </span>
          <span>
            runs of record: {ARMS.map((a) => `${a.short} ${a.run}`).join(' · ')} · dataset {PROVENANCE.dataset.repo_id}{' '}
            @ {PROVENANCE.dataset.revision.slice(0, 8)}… (sha256 {PROVENANCE.dataset.sha256.slice(0, 8)}…)
          </span>
        </div>
      </details>

      {/* ───────────────────────────── the three-arm table ───────────────────────────── */}
      <h2 className="sect" id="arms">
        The three arms, same questions, same answer prompt
      </h2>
      <div className="tablewrap">
        <table className="restable">
          <thead>
            <tr>
              <th>Arm</th>
              <th>Overall</th>
              {ABILITY_CUTS.map((c) => (
                <th key={c.slug}>{c.short ?? c.label}</th>
              ))}
              <th>Abst. P / R</th>
              <th>Ctx tok/Q</th>
              <th>
                $/Q<span className="fn">†</span>
              </th>
              <th>
                p50 / p95 (s)<span className="fn">†</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {ARMS.map((a) => {
              const pr = abstentionPR(a.key);
              return (
                <tr key={a.key} className={a.key === 'errata' ? 'ours' : undefined}>
                  <th scope="row">
                    {a.label}
                    <span className="runid mono">{a.run}</span>
                  </th>
                  <td>
                    <ScoreCell arm={a.key} cut={cut('overall')!} arms={ARM_KEYS} />
                  </td>
                  {ABILITY_CUTS.map((c) => (
                    <td key={c.slug}>
                      <ScoreCell arm={a.key} cut={c} arms={ARM_KEYS} />
                    </td>
                  ))}
                  <td>
                    <Link href={`/results/${a.key}/abstention`} className="scell">
                      <b>
                        {pr.p.toFixed(2)} / {pr.r.toFixed(2)}
                      </b>
                      <span className="frac">
                        tp {pr.tp} · fp {pr.fp}
                      </span>
                    </Link>
                  </td>
                  <td>
                    <Link href={`/results/${a.key}/overall`} className="scell">
                      <b>{Math.round(ctxTokens(a.key)).toLocaleString('en-US')}</b>
                    </Link>
                  </td>
                  <td className="mono flat">{PUBLISHED.usdPerQ[a.key]}</td>
                  <td className="mono flat">{PUBLISHED.latency[a.key]}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="cap">
        <b>Overall</b> and the four ability columns are accuracy over the {questionsIn(cut('overall')!).length}{' '}
        non-abstention questions; the ± is the sample sd across the three seeds, which is provider nondeterminism rather
        than sampling spread — Errata and the naive arm are bit-identical across seeds, which is what their ± 0.0 means.
        Abstention is scored deterministically by exact match and never reaches the judge.{' '}
        <span className="fn">†</span> $/Q and latency are the two columns not recomputed from these rows: Errata’s are
        measured on <span className="mono">rerunF-wave</span>, the last cold-cache run, because{' '}
        <span className="mono">rerunJ-arith</span> replayed 447 of 450 answers from cache and would flatter both.
        Errata’s $/Q is <span className="mono">{PUBLISHED.errataUsdExact}</span>, not zero — the column rounds to four
        decimals.
      </p>

      {/* ───────────────────────────── the honest gap ───────────────────────────── */}
      <h2 className="sect" id="gap">
        The honest gap, kept next to the headline
      </h2>
      <p className="cap">
        Information extraction is the one column Errata loses, and it loses it badly:{' '}
        <b className="loseink">{pct(cell('errata', cut('information-extraction')!).pct)}</b> against full-context’s{' '}
        <b>{pct(cell('full_context', cut('information-extraction')!).pct)}</b>. Cut by the corpus’s own question types
        rather than by ability — which folds the three single-session types into one column and hides where the deficit
        is — the entire remaining deficit is{' '}
        {questionsIn(cut('type-single-session-assistant')!).length +
          questionsIn(cut('type-single-session-preference')!).length}{' '}
        of {QUESTIONS.length} questions.
      </p>
      <ArmChart cuts={TYPE_CUTS} groupW={190} note={'accuracy by the corpus\u2019s own question_type, over all rows \u00b7 tap a group for its judged rows'} />
      <div className="tablewrap">
        <table className="restable">
          <thead>
            <tr>
              <th>question_type</th>
              <th>n</th>
              {ARMS.map((a) => (
                <th key={a.key}>{a.short}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TYPE_CUTS.map((c) => {
              const losing = c.key === 'single-session-assistant' || c.key === 'single-session-preference';
              return (
                <tr key={c.slug} className={losing ? 'losing' : undefined}>
                  <th scope="row" className="mono">
                    {c.label}
                  </th>
                  <td className="mono flat">{questionsIn(c).length}</td>
                  {ARM_KEYS.map((k) => (
                    <td key={k}>
                      <ScoreCell arm={k} cut={c} arms={ARM_KEYS} withSd={false} />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="cap">
        Both losing rows are write-path gaps — the fact is not in the graph to retrieve — and the first is a{' '}
        <b>priced decision, not a modelling result</b>: lifting the extraction cap that drops long enumerated assistant
        answers was measured at <b>$20.72</b> to re-extract the 150 histories against the <b>$4.19</b> the shipped
        configuration cost. A $0 deterministic recall pass aimed at the same gap was built, applied, measured, and
        reverted — it is the second row of the table below. The account is in{' '}
        <span className="mono">eval/RESULTS.md</span>.
      </p>

      {/* ───────────────────────────── rejected experiments ───────────────────────────── */}
      <h2 className="sect" id="rejected">
        What we published that lost
      </h2>
      <p className="cap">
        Two changes were built in full, judged in full, and rejected by their own measurement. They are printed here
        with the shipped run, at the same size, because a result you only publish when it wins is not a result. These
        rows are counted over all {QUESTIONS.length * PROVENANCE.seeds.length} rows of each Errata wave.
      </p>
      <div className="tablewrap">
        <table className="restable">
          <thead>
            <tr>
              <th>Run</th>
              <th>What changed</th>
              <th>All-450</th>
              <th>answered</th>
              <th>answered-prec.</th>
              <th>Ctx tok/Q</th>
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {EXPERIMENT_NOTES.map((e) => {
              const m = EXPERIMENTS[e.run]!;
              return (
                <tr key={e.run} className={e.verdict === 'REJECTED' ? 'losing' : undefined}>
                  <th scope="row" className="mono">
                    {e.run}
                  </th>
                  <td>
                    {e.what}
                    <span className="why">{e.why}</span>
                  </td>
                  <td className="mono flat big">{pct(m.all450)}</td>
                  <td className="mono flat">{m.answered}</td>
                  <td className="mono flat">{pct(m.answered_prec)}%</td>
                  <td className="mono flat">{m.ctx_tok.toLocaleString('en-US')}</td>
                  <td>
                    <span className={`vb ${e.verdict === 'SHIPPED' ? 'ok' : e.verdict === 'VERIFIED' ? 'unp' : 'bad'}`}>
                      {e.verdict}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="cap">
        The baseline both rejections were measured against is <span className="mono">rerunF-wave</span> at{' '}
        <b>{pct(EXPERIMENTS['rerunF-wave']!.all450)}</b>. The revert is verified rather than asserted:{' '}
        <span className="mono">rerunI-restored</span> differs from it in <b>{REVERT_DIFF_ROWS} of 450 answers</b>, which
        is checked here against the artifacts on every test run.
      </p>

      <h3 className="sub">The three answers that moved, and which way</h3>
      <p className="cap">
        <span className="mono">rerunF-wave</span> → <span className="mono">rerunJ-arith</span>, seed 11. Two flipped to
        CORRECT, one stayed wrong and is printed anyway.
      </p>
      <ul className="difflist">
        {ARITH_DIFF.map((d) => (
          <li key={d.id}>
            <Link href={`/results/errata/${cutForQuestion(question(d.id)).slug}#${d.id}`} className="mono qid">
              {d.id}
            </Link>
            <span className="mono was">{d.before}</span>
            <span className="arrow">→</span>
            <span className="mono now">{d.after}</span>
            <span className={`vb ${d.verdict_after === 'CORRECT' ? 'ok' : 'bad'}`}>
              {d.verdict_before} → {d.verdict_after}
            </span>
          </li>
        ))}
      </ul>

      {/* ───────────────────────────── judge validation ───────────────────────────── */}
      <h2 className="sect" id="judge">
        The judge was validated before the table was believed
      </h2>
      <div className="tiles">
        <Link href="/results/judge#far" className="tile">
          <div className="tk">False-accept rate</div>
          <div className="tv">{pct(far.pct)}%</div>
          <div className="tm">
            {far.accepted}/{far.n} perturbed negatives · gate ≤ 10.0%
          </div>
          <div className="tg pass">PASS</div>
        </Link>
        <Link href="/results/judge#frr" className="tile">
          <div className="tk">False-reject rate</div>
          <div className="tv">{pct(frr.pct)}%</div>
          <div className="tm">
            {frr.rejected}/{frr.n} paraphrased golds · gate ≤ 15.0%
          </div>
          <div className="tg pass">PASS</div>
        </Link>
        <Link href="/results/judge#superseded-value" className="tile">
          <div className="tk">FAR · superseded-value</div>
          <div className="tv">{pct(superseded.far)}%</div>
          <div className="tm">
            {superseded.accepted}/{superseded.n} · the family this project’s thesis rests on
          </div>
          <div className="tg pass">PASS</div>
        </Link>
        <Link href="/results/judge#attribution-flip" className="tile fail">
          <div className="tk">FAR · attribution-flip</div>
          <div className="tv">{pct(attribution.far)}%</div>
          <div className="tm">
            {attribution.accepted}/{attribution.n} · gate ≤ {pct(attribution.gate)}% · worst case 75.0% once the{' '}
            {attribution.unparseable} truncated verdicts count as accepts
          </div>
          <div className="tg failg">FAILS ITS GATE — PUBLISHED ANYWAY</div>
        </Link>
      </div>
      <p className="cap">
        Scored on the committed 120-item control set: 60 perturbed negatives and 60 paraphrase positives, with the judge
        itself frozen. The overall figure was <b>15.0%</b> before a disclosed control-set revision that fixed seven
        defective controls — the revision was made by a predicate over the gold, never by a list of question ids,
        because selecting controls by the verdict they received is how a control set gets quietly tuned. An unparseable
        verdict counts as a rejection, which can only hurt FAR’s sibling FRR and never flatter FAR; the other end of
        that envelope is 18.3% overall and 75.0% on attribution-flip, and it belongs in the same paragraph. Full
        account: <span className="mono">eval/judge-validation.md</span> ·{' '}
        <Link href="/results/judge">open all 120 controls →</Link>
      </p>

      {/* ───────────────────────────── tau ───────────────────────────── */}
      <h2 className="sect" id="tau">
        τ was not fitted
      </h2>
      <p className="cap">
        The abstention gate stays at its a-priori <b>{PUBLISHED.tau.shipped}</b>. Every abstention-positive question the
        corpus owns is inside the reported test set by design, so a fitted τ would be in-sample and saying otherwise
        would be false. A sensitivity sweep ships instead: overall is <b>{PUBLISHED.tau.plateau}</b> — a plateau, not a
        knife edge.
      </p>
      <div className="tablewrap">
        <table className="restable compact">
          <thead>
            <tr>
              <th>τ</th>
              <th>overall %</th>
              <th>answered</th>
              <th>answered-prec. %</th>
              <th>abstention P</th>
              <th>abstention R</th>
            </tr>
          </thead>
          <tbody>
            {tauSweep().map((t) => (
              <tr key={t.tau} className={t.shipped ? 'ours' : undefined}>
                <th scope="row" className="mono">
                  {t.tau.toFixed(2)}
                  {t.shipped && ' — shipped'}
                </th>
                <td className="mono flat big">{pct(t.overall)}</td>
                <td className="mono flat">{t.answered}</td>
                <td className="mono flat">{pct(t.answeredPrec)}</td>
                <td className="mono flat">{t.p.toFixed(2)}</td>
                <td className="mono flat">{t.r.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="cap">
        The sweep is deterministic and model-free — it treats τ as a veto on the recorded synthesis answers — so it is
        recomputed here from the same rows the table above is counted from, and it reproduces the committed{' '}
        <span className="mono">eval/out/tau-sweep-arith.md</span> line for line.
      </p>

      <p className="cap repro mono">
        reproduce · uv run errata-eval parity · uv run errata-eval run --arm errata --seeds 11,22,33 --run-id
        rerunJ-arith · uv run errata-eval judge --run rerunJ-arith · uv run errata-eval report --runs rerunJ-arith
        rerunB-nothink rerunC-nothink
      </p>
    </main>
  );
}
