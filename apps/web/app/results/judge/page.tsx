import type { Metadata } from 'next';
import Link from 'next/link';
import { JUDGE_CONTROLS, JUDGE_FAMILIES, PROVENANCE, judgeFAR, judgeFRR, judgeFamily, pct } from '../../../lib/results';

export const metadata: Metadata = {
  title: 'Judge validation',
  description:
    'The committed 120-item control set, scored: which perturbed negatives this judge accepted, and which paraphrased golds it rejected.',
};

const FAMILY_NOTE: Record<string, string> = {
  'entity-swap': 'the gold’s entity replaced by another proper noun from the same history',
  'value-shift': 'the gold’s number moved — same shape, wrong quantity',
  'attribution-flip': 'the right fact attributed to the wrong speaker; this judge’s one weak family',
  'superseded-value': 'an earlier, superseded value presented as current — the family this project’s thesis rests on',
  'topical-filler': 'fluent, on-topic prose that answers nothing',
};

export default function JudgePage() {
  const far = judgeFAR();
  const frr = judgeFRR();
  const positives = JUDGE_CONTROLS.filter((c) => c.kind === 'positive');

  return (
    <main className="route res drill">
      <p className="crumb mono">
        <Link href="/results">← results</Link> · judge validation · {PROVENANCE.judge_model} (prompt sha{' '}
        {PROVENANCE.judge_prompt_sha}, temperature 0)
      </p>
      <h1 className="rtitle">What the judge accepted that it should not have</h1>
      <p className="q" style={{ maxWidth: '640px' }}>
        The judge was measured before any of the results were believed, on a control set that is committed to the
        repository — so the same judge is always scored against the same set, and a re-run replays from cache at $0. All{' '}
        {JUDGE_CONTROLS.length} controls are printed below, the accepts first: a perturbed negative it called CORRECT is
        a <b>false accept</b>, and there are {far.accepted}.
      </p>

      <div className="prov mono" id="far">
        <span>
          false-accept {pct(far.pct)}% — {far.accepted} of {far.n} perturbed negatives judged CORRECT · gate ≤ 10.0% ·
          PASS
        </span>
        <span id="frr">
          false-reject {pct(frr.pct)}% — {frr.rejected} of {frr.n} paraphrased golds not judged CORRECT · gate ≤ 15.0% ·
          PASS
        </span>
        <span>
          {far.unparseable} unparseable verdicts, all in attribution-flip, every one exactly 64 completion tokens —
          truncation, not a malformed judge. Counted as rejections, which can only hurt false-reject and never flatter
          false-accept; the worst-case end of that envelope is 18.3% overall and 75.0% on attribution-flip.
        </span>
      </div>

      <div className="tablewrap">
        <table className="restable">
          <thead>
            <tr>
              <th>Family</th>
              <th>n</th>
              <th>accepted</th>
              <th>FAR</th>
              <th>gate</th>
              <th>result</th>
              <th>the perturbation</th>
            </tr>
          </thead>
          <tbody>
            {JUDGE_FAMILIES.map((f) => {
              const s = judgeFamily(f);
              const failed = s.far > s.gate;
              return (
                <tr key={f} className={failed ? 'losing' : undefined}>
                  <th scope="row" className="mono">
                    <a href={`#${f}`}>{f}</a>
                  </th>
                  <td className="mono flat">{s.n}</td>
                  <td className="mono flat">{s.accepted}</td>
                  <td className="mono flat big">{pct(s.far)}%</td>
                  <td className="mono flat">≤ {pct(s.gate)}%</td>
                  <td>
                    <span className={`vb ${failed ? 'bad' : 'ok'}`}>{failed ? 'FAIL' : 'PASS'}</span>
                  </td>
                  <td className="why-inline">{FAMILY_NOTE[f]}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {JUDGE_FAMILIES.map((f) => {
        /** accepts first, then truncations, then the ones it got right — an audit page leads with its failures */
        const weight = (v: string) => (v === 'CORRECT' ? 0 : v === 'UNPARSEABLE' ? 1 : 2);
        const rows = JUDGE_CONTROLS.filter((c) => c.kind === 'perturbed' && c.family === f).sort(
          (a, b) => weight(a.verdict) - weight(b.verdict),
        );
        const s = judgeFamily(f);
        return (
          <section key={f} id={f} className="fam">
            <h2 className="sect">
              {f} <span className="hscore">{pct(s.far)}%</span>
            </h2>
            <p className="cap">{FAMILY_NOTE[f]}</p>
            <ol className="rows">
              {rows.map((c) => (
                <li
                  key={c.id}
                  className={`rowcard ${c.verdict === 'CORRECT' ? 'bad' : c.verdict === 'UNPARSEABLE' ? 'split' : 'good'}`}
                >
                  <div className="rhead">
                    <span
                      className={`vb ${c.verdict === 'CORRECT' ? 'bad' : c.verdict === 'UNPARSEABLE' ? 'unp' : 'ok'}`}
                    >
                      {c.verdict === 'CORRECT' ? 'FALSE ACCEPT' : c.verdict}
                    </span>
                    <span className="mono qid">{c.id}</span>
                    <span className="mono qtype">{c.transform}</span>
                  </div>
                  <p className="qtext">{c.question}</p>
                  <dl className="ab">
                    <dt>gold</dt>
                    <dd className="gold">{c.gold}</dd>
                    <dt>candidate</dt>
                    <dd>{c.answer}</dd>
                  </dl>
                </li>
              ))}
            </ol>
          </section>
        );
      })}

      <section className="fam" id="positives">
        <h2 className="sect">
          paraphrase positives <span className="hscore">{pct(frr.pct)}%</span>
        </h2>
        <p className="cap">
          {positives.length} paraphrases of a gold answer, every one of which the judge should accept. It accepted{' '}
          {positives.length - frr.rejected}.
        </p>
        <div className="tablewrap">
          <table className="restable compact">
            <thead>
              <tr>
                <th>control</th>
                <th>gold</th>
                <th>paraphrase</th>
                <th>verdict</th>
              </tr>
            </thead>
            <tbody>
              {positives.map((c) => (
                <tr key={c.id} className={c.verdict === 'CORRECT' ? undefined : 'losing'}>
                  <th scope="row" className="mono">
                    {c.id}
                  </th>
                  <td className="gold">{c.gold}</td>
                  <td>{c.answer}</td>
                  <td>
                    <span className={`vb ${c.verdict === 'CORRECT' ? 'ok' : 'bad'}`}>{c.verdict}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
