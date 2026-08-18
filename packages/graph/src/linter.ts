// packages/graph/src/linter.ts — the subset linter .
//
// HydraDB implements a DELIBERATE OpenCypher subset. Every builder's output is fed through this
// linter (a vitest property test asserts it). There is one mode: `assertCypher` throws, in dev and
// in prod alike — a violation is a build-time bug, not a runtime metric, and nothing counts or
// reports them. Messages are the engine's own error strings, so a violation reads the same in a
// log as it would at the server.

export interface LintFinding {
  rule: string;
  message: string;
}

const BATCH_LIMIT = 1024;

/** strip single/double-quoted string literals so patterns don't match inside data. */
function stripStrings(text: string): string {
  return text.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

interface Rule {
  rule: string;
  test: (t: string) => boolean;
  message: string;
}

const RULES: Rule[] = [
  {
    rule: 'IN',
    test: (t) => /\bIN\b\s*\[/i.test(t) || /\bIN\b\s*\$/i.test(t),
    message: 'WHERE currently supports boolean combinations of property comparisons',
  },
  {
    rule: 'CONTAINS',
    test: (t) => /\bCONTAINS\b/i.test(t),
    message: 'WHERE currently supports boolean combinations of property comparisons',
  },
  {
    rule: 'ENDS_WITH',
    test: (t) => /\bENDS\s+WITH\b/i.test(t),
    message: 'WHERE currently supports boolean combinations of property comparisons',
  },
  {
    rule: 'IS_NULL',
    test: (t) => /\bIS\s+(?:NOT\s+)?NULL\b/i.test(t),
    message: 'WHERE currently supports boolean combinations of property comparisons',
  },
  {
    rule: 'RETURN_STAR',
    test: (t) => /\bRETURN\s+\*/i.test(t),
    message: 'RETURN * is not executable in Query engine',
  },
  {
    rule: 'MIN_MAX',
    test: (t) => /\b(?:min|max)\s*\(/i.test(t),
    message: 'RETURN currently supports <binding>.<property> or count(*)',
  },
  {
    rule: 'WITH',
    // ban the WITH clause outright, but not the STARTS WITH / ENDS WITH string operators
    test: (t) => /(?<!STARTS )(?<!ENDS )\bWITH\b/i.test(t),
    message: 'WITH currently supports only pass-through identifiers; it is banned in Errata',
  },
  {
    rule: 'UNDIRECTED',
    // a relationship pattern -[...]- neither preceded by < nor followed by >
    test: (t) => /(?<!<)-\[[^\]]*\]-(?!>)/.test(t),
    message: 'undirected relationships are not executable in Query engine',
  },
  {
    rule: 'UNBOUNDED_VARLEN',
    // a variable-length spec `*` inside [] without an explicit upper bound digit
    test: (t) => {
      for (const m of t.matchAll(/\[[^\]]*\*[^\]]*\]/g)) {
        const inner = m[0];
        // acceptable forms: *N..M  (M required). Reject *, *.., *N, *N.., *..
        if (!/\*\s*\d*\s*\.\.\s*\d+/.test(inner)) return true;
      }
      return false;
    },
    message: 'unbounded variable-length MATCH requires an explicit max hop',
  },
  {
    rule: 'VERTEX_MERGE_PROPS',
    // node MERGE (var {...}) whose braces carry more than a single id property (a comma)
    test: (t) => {
      for (const m of t.matchAll(/MERGE\s*\(\s*\w*\s*(?::\w+)?\s*\{([^}]*)\}\s*\)/gi)) {
        if (/,/.test(m[1] ?? '')) return true; // more than one property folded into a vertex MERGE
      }
      return false;
    },
    message: 'folding properties into a vertex MERGE is rejected; MERGE on id, then SET',
  },
  {
    rule: 'ANON_INTERIOR',
    test: (t) => /\]\s*->\s*\(\s*\)/.test(t) || /\(\s*\)\s*<-\s*\[/.test(t),
    message: 'bug #95 — anonymous interior nodes return a cross product',
  },
  {
    rule: 'DDL_OR_PROC',
    test: (t) => /\bCREATE\s+INDEX\b/i.test(t) || /\bSHOW\b/i.test(t) || /\bCALL\s+db\./i.test(t) || /\bCALL\s+dbms\./i.test(t) || /\bapoc\./i.test(t),
    message: 'rejected at parse time (DDL / db.* / dbms.* / apoc.*)',
  },
  {
    rule: 'MULTI_STATEMENT',
    test: (t) => t.includes(';'),
    message: 'one statement per request',
  },
];

/** Lint a single Cypher statement against the subset. Returns [] when clean. */
export function lintCypher(text: string): LintFinding[] {
  const stripped = stripStrings(text);
  const findings: LintFinding[] = [];
  for (const r of RULES) {
    if (r.test(stripped)) findings.push({ rule: r.rule, message: r.message });
  }
  return findings;
}

/** Throw if a statement violates the subset (dev mode). */
export function assertCypher(text: string): void {
  const findings = lintCypher(text);
  if (findings.length > 0) {
    throw new Error(`Cypher subset violation: ${findings.map((f) => `${f.rule} (${f.message})`).join('; ')}\n${text}`);
  }
}

/** UNWIND batches are capped at 1024 rows — checked on params, not text. */
export function lintBatchSize(params: Record<string, unknown>): LintFinding[] {
  const rows = params['rows'];
  if (Array.isArray(rows) && rows.length > BATCH_LIMIT) {
    return [{ rule: 'BATCH_LIMIT', message: `client_query_batch_items rejected by admission control (>${BATCH_LIMIT})` }];
  }
  return [];
}
