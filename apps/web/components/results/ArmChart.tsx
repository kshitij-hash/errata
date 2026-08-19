import Link from 'next/link';
import { type ArmKey, type Cut, cell, ctxTokens, pct } from '../../lib/results';

/**
 * The verdict, drawn before it is tabulated. Pure SVG in the server render — no chart library
 * (the repo's no-UI-dependency rule), no client JS: the same `cell()` reads the table below makes,
 * so the picture and the table cannot disagree. Every group links to the judged rows behind it.
 */
const ARM_KEYS: ArmKey[] = ['errata', 'full_context', 'naive'];
const ARM_FILL: Record<ArmKey, string> = {
  errata: 'var(--color-ink)',
  full_context: 'var(--color-faint)',
  naive: 'var(--color-rule2)',
};
const ARM_SHORT: Record<ArmKey, string> = {
  errata: 'Errata',
  full_context: 'full context',
  naive: 'naive RAG',
};

const BAR_W = 40;
const BAR_GAP = 8;
const CHART_H = 190;
const TOP = 26;
const BOTTOM = 40;

export function ArmChart({
  cuts,
  note = 'accuracy over the 120 non-abstention questions · tap a group for its judged rows',
  groupW = 168,
}: {
  cuts: Cut[];
  note?: string;
  groupW?: number;
}) {
  const GROUP_W = groupW;
  const width = cuts.length * GROUP_W;
  const height = TOP + CHART_H + BOTTOM;
  const y = (v: number) => TOP + CHART_H - (v / 100) * CHART_H;

  return (
    <figure className="armchart">
      <div className="ac-legend mono" aria-hidden="true">
        {ARM_KEYS.map((k) => (
          <span key={k}>
            <i style={{ background: ARM_FILL[k] }} /> {ARM_SHORT[k]}
          </span>
        ))}
        <span className="ac-note">{note}</span>
      </div>
      <div className="ac-scroll">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
          role="img"
          aria-label={`Accuracy by category: ${cuts
            .map((c) => `${c.short ?? c.label} — ${ARM_KEYS.map((k) => `${ARM_SHORT[k]} ${pct(cell(k, c).pct)}`).join(', ')}`)
            .join('; ')}`}
        >
          {[0, 25, 50, 75, 100].map((g) => (
            <g key={g}>
              <line x1={0} x2={width} y1={y(g)} y2={y(g)} stroke="var(--color-rule)" strokeWidth={g === 0 ? 1.5 : 1} />
              <text x={4} y={y(g) - 4} className="ac-grid">
                {g}
              </text>
            </g>
          ))}
          {cuts.map((c, gi) => {
            const x0 = gi * GROUP_W + (GROUP_W - (BAR_W * 3 + BAR_GAP * 2)) / 2;
            const errataLoses = cell('errata', c).pct < Math.max(...ARM_KEYS.map((k) => cell(k, c).pct));
            return (
              <g key={c.slug}>
                {ARM_KEYS.map((k, bi) => {
                  const v = cell(k, c).pct;
                  const bx = x0 + bi * (BAR_W + BAR_GAP);
                  const lost = k === 'errata' && errataLoses;
                  return (
                    <g key={k}>
                      <rect x={bx} y={y(v)} width={BAR_W} height={TOP + CHART_H - y(v)} fill={ARM_FILL[k]} rx={3} />
                      <text x={bx + BAR_W / 2} y={y(v) - 6} textAnchor="middle" className={`ac-val${lost ? ' lost' : ''}`}>
                        {pct(v)}
                      </text>
                    </g>
                  );
                })}
                <text x={gi * GROUP_W + GROUP_W / 2} y={TOP + CHART_H + 22} textAnchor="middle" className="ac-cat">
                  {(c.short ?? c.label).toLowerCase()}
                </text>
              </g>
            );
          })}
        </svg>
        {/* the click surface: one link per group, laid over the svg columns */}
        <div className="ac-links" style={{ width }}>
          {cuts.map((c) => (
            <Link key={c.slug} href={`/results/errata/${c.slug}`} style={{ width: GROUP_W }} aria-label={`Judged rows: ${c.label}`} />
          ))}
        </div>
      </div>
    </figure>
  );
}

/**
 * The asymmetry the table's last three columns carry, drawn to scale: what each arm reads per
 * question to produce the accuracies above. Log scale, because the honest ratio (1/43rd) is the
 * point and a linear bar would just be a sliver next to a wall.
 */
export function ContextChart() {
  const max = Math.log10(Math.max(...ARM_KEYS.map((k) => ctxTokens(k))));
  return (
    <figure className="ctxchart">
      {ARM_KEYS.map((k) => {
        const v = ctxTokens(k);
        const w = (Math.log10(v) / max) * 100;
        return (
          <div className="cc-row" key={k}>
            <span className="cc-arm mono">{ARM_SHORT[k]}</span>
            <span className="cc-track">
              <i style={{ width: `${w}%`, background: ARM_FILL[k] }} />
            </span>
            <span className="cc-val mono">{Math.round(v).toLocaleString('en-US')} tok/Q</span>
          </div>
        );
      })}
      <figcaption className="cc-cap">
        context read per question, log scale — Errata answers from{' '}
        {Math.round(ctxTokens('full_context') / ctxTokens('errata'))}× less material than reading the whole history
      </figcaption>
    </figure>
  );
}
