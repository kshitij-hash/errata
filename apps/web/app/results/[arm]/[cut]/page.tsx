import type { Metadata } from 'next';
import Link from 'next/link';
import { IconCaretLeft, IconCheck, IconX } from '../../../../components/icons';
import { notFound } from 'next/navigation';
import { SeedMarks, Verdict } from '../../../../components/results/Cells';
import {
  ARMS,
  type ArmKey,
  CUTS,
  PROVENANCE,
  type Question,
  SEEDS,
  armLabel,
  cell,
  cut as findCut,
  isRight,
  pct,
  questionsIn,
  row,
} from '../../../../lib/results';

const ARM_KEYS: ArmKey[] = ['errata', 'full_context', 'naive'];

export function generateStaticParams() {
  return ARM_KEYS.flatMap((arm) => CUTS.map((c) => ({ arm, cut: c.slug })));
}

type Params = { params: Promise<{ arm: string; cut: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { arm, cut } = await params;
  const c = findCut(cut);
  if (!c || !ARM_KEYS.includes(arm as ArmKey)) return { title: 'Results' };
  return {
    title: `${c.label} · ${armLabel(arm as ArmKey)}`,
    description: `Every judged row behind the ${c.label} cell for the ${armLabel(arm as ArmKey)} arm.`,
  };
}

function otherArms(arm: ArmKey): ArmKey[] {
  return ARM_KEYS.filter((a) => a !== arm);
}

/** Failures first: an audit page that buries them is a marketing page. */
function order(arm: ArmKey, qs: Question[]): Question[] {
  return [...qs].sort((a, b) => {
    const ra = SEEDS.filter((_, i) => isRight(arm, a, i)).length;
    const rb = SEEDS.filter((_, i) => isRight(arm, b, i)).length;
    return ra - rb || a.id.localeCompare(b.id);
  });
}

export default async function DrillPage({ params }: Params) {
  const p = await params;
  const arm = p.arm as ArmKey;
  const c = findCut(p.cut);
  if (!c || !ARM_KEYS.includes(arm)) notFound();

  const qs = order(arm, questionsIn(c));
  const stat = cell(arm, c);
  const run = ARMS.find((a) => a.key === arm)!.run;

  return (
    <main className="route res drill">
      <p className="crumb mono">
        <Link href="/results" className="backlink"><IconCaretLeft /> results</Link> · {armLabel(arm)} · <span className="mono">{run}</span>
      </p>
      <h1 className="rtitle">
        {c.label} <span className="hscore">{pct(stat.pct)}</span>
      </h1>
      <div className="prov mono">
        <span>
          {stat.right} of {stat.rows} rows right — {stat.questions} questions × {SEEDS.length} seeds (
          {PROVENANCE.seeds.join('/')})
        </span>
        <span>{c.rule}</span>
        <span>
          same arm, by ability:{' '}
          {CUTS.filter((x) => x.kind !== 'type' && x.slug !== c.slug).map((x) => (
            <Link key={x.slug} href={`/results/${arm}/${x.slug}`} className="cutlink">
              {x.label}
            </Link>
          ))}
        </span>
        <span>
          same arm, by question_type:{' '}
          {CUTS.filter((x) => x.kind === 'type' && x.slug !== c.slug).map((x) => (
            <Link key={x.slug} href={`/results/${arm}/${x.slug}`} className="cutlink">
              {x.label}
            </Link>
          ))}
        </span>
        <span>
          the same cut, other arms:{' '}
          {otherArms(arm).map((a) => (
            <Link key={a} href={`/results/${a}/${c.slug}`} className="cutlink">
              {armLabel(a)} {pct(cell(a, c).pct)}
            </Link>
          ))}
        </span>
      </div>

      <ol className="rows">
        {qs.map((q) => {
          const r = row(arm, q.id);
          const marks = SEEDS.map((_, i) => isRight(arm, q, i));
          const right = marks.filter(Boolean).length;
          return (
            <li
              key={q.id}
              id={q.id}
              className={`rowcard ${right === SEEDS.length ? 'good' : right === 0 ? 'bad' : 'split'}`}
            >
              <div className="rhead">
                <Verdict v={r.verdicts[0] ?? null} abstained={r.abstained[0] === true} />
                <SeedMarks marks={marks} />
                <span className="mono qid">{q.id}</span>
                <span className="mono qtype">{q.type}</span>
                <span className="mono qdate">asked {q.date}</span>
                <span className="mono qtok">{r.tok.toLocaleString('en-US')} ctx tok</span>
                {r.conf !== undefined && <span className="mono qconf">E {r.conf.toFixed(3)}</span>}
              </div>

              <p className="qtext">{q.question}</p>

              <dl className="ab">
                <dt>{ARMS.find((a) => a.key === arm)!.short}</dt>
                <dd className={r.abstained[0] ? 'abstained' : undefined}>
                  {r.abstained[0] ? 'ABSTAINED — not in the history' : r.answer || '—'}
                  {r.seed_variants && (
                    <span className="variants">
                      other seeds:{' '}
                      {r.seed_variants.map((v, i) => (
                        <i key={i}>{v || '—'}</i>
                      ))}
                    </span>
                  )}
                </dd>
                <dt>gold</dt>
                <dd className="gold">{q.abstention ? 'ABSTAIN — the history never says' : q.gold}</dd>
                {!q.abstention && r.reason && (
                  <>
                    <dt>judge</dt>
                    <dd className="jreason">{r.reason}</dd>
                  </>
                )}
              </dl>

              {r.cites && r.cites.length > 0 && (
                <details className="cites">
                  <summary>
                    {r.cites.length} citation{r.cites.length === 1 ? '' : 's'} — session · turn · the span it was read
                    from
                  </summary>
                  <ul>
                    {r.cites.map((ct, i) => (
                      <li key={i}>
                        <span className="cref mono">
                          {ct.s}:t{ct.t}
                        </span>
                        <span className="cspan">“{ct.q}”</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              <div className="cross mono">
                {otherArms(arm).map((a) => {
                  const or = row(a, q.id);
                  const ok = isRight(a, q, 0);
                  return (
                    <Link key={a} href={`/results/${a}/${c.slug}#${q.id}`} className={ok ? 'y' : 'n'}>
                      {ARMS.find((x) => x.key === a)!.short} {ok ? <IconCheck /> : <IconX />}
                      <span>{or.abstained[0] ? 'abstained' : or.answer.slice(0, 90) || '—'}</span>
                    </Link>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ol>
    </main>
  );
}
