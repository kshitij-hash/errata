import Link from 'next/link';
import { type ArmKey, type Cut, cell, pct } from '../../lib/results';

/**
 * One score in the published table. It is a link, always: the number and the rows it was counted
 * from are the same arithmetic (lib/results.ts), so every cell can open its own evidence.
 */
export function ScoreCell({
  arm,
  cut,
  arms,
  withSd = true,
  withFrac = true,
}: {
  arm: ArmKey;
  cut: Cut;
  /** the arms this cell competes against, for the win/lose mark */
  arms: ArmKey[];
  withSd?: boolean;
  withFrac?: boolean;
}) {
  const c = cell(arm, cut);
  const others = arms.map((a) => cell(a, cut).pct);
  const best = Math.max(...others);
  const worst = Math.min(...others);
  const cls = c.pct === best ? 'win' : c.pct === worst ? 'lose' : '';
  return (
    <Link href={`/results/${arm}/${cut.slug}`} className={`scell ${cls}`}>
      <b>{pct(c.pct)}</b>
      {withSd && <span className="sd"> ± {pct(c.sd)}</span>}
      {withFrac && (
        <span className="frac">
          {c.right}/{c.rows}
        </span>
      )}
    </Link>
  );
}

export function Verdict({ v, abstained }: { v: string | null; abstained: boolean }) {
  if (abstained) return <span className="vb abst-v">ABSTAINED</span>;
  if (v === 'CORRECT') return <span className="vb ok">CORRECT</span>;
  if (v === 'UNPARSEABLE') return <span className="vb unp">UNPARSEABLE</span>;
  return <span className="vb bad">INCORRECT</span>;
}

/** ✓ / ✗ per seed — the ± in the table, made concrete. */
export function SeedMarks({ marks }: { marks: boolean[] }) {
  return (
    <span className="seeds" title="seeds 11 / 22 / 33">
      {marks.map((m, i) => (
        <i key={i} className={m ? 'y' : 'n'}>
          {m ? '✓' : '✗'}
        </i>
      ))}
    </span>
  );
}
