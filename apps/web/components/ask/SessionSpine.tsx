import { DEMO_SESSIONS } from '../../config/demo';
import { sessionOrdinal } from '../../lib/format';

/**
 * One tick per session of the pinned history. Cited sessions hold teal;
 * sessions that only carry a superseded claim hold red. Static ordering from the corpus config,
 * live hits from the answer's citations.
 */
export function SessionSpine({ current, old }: { current: string[]; old: string[] }) {
  const cur = new Set(current.map(sessionOrdinal).filter((o): o is number => o != null));
  const prev = new Set(old.map(sessionOrdinal).filter((o): o is number => o != null));
  return (
    <div className="spine" aria-hidden="true" title={`${DEMO_SESSIONS.length} sessions in this history`}>
      {DEMO_SESSIONS.map((s) => (
        <i key={s.ordinal} className={cur.has(s.ordinal) ? 'hit' : prev.has(s.ordinal) ? 'hit old' : ''} />
      ))}
    </div>
  );
}
