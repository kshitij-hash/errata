'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, usd } from '../../lib/api';
import type { AskResponse } from '../../lib/api';
import { citeLabel, citeMark, prefersReducedMotion, sameValue } from '../../lib/format';
import { ASK_EVENT } from '../../lib/askbus';
import { readParam, writeParams } from '../../lib/urlstate';
import { CHIPS, DEMO_HISTORY_ID, DEMO_SUBJECT, FULL_CONTEXT_USD, HISTORY_TOKEN_COUNT } from '../../config/demo';
import { CypherDisclosure } from '../CypherDisclosure';
import { ErratumSlip } from './ErratumSlip';
import type { SlipState } from './ErratumSlip';
import { Refusal } from './Refusal';
import { SessionSpine } from './SessionSpine';
import { SourceColumn } from './SourceColumn';

const DEFAULT_QUESTION = CHIPS[0]!.question;

export function AskSpread() {
  const [question, setQuestion] = useState(DEFAULT_QUESTION);
  const [free, setFree] = useState('');
  const [resp, setResp] = useState<AskResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [swept, setSwept] = useState(false);
  const [replay, setReplay] = useState(0);

  // the live-correction beat
  const [corrOpen, setCorrOpen] = useState(false);
  const [corrValue, setCorrValue] = useState('');
  const [struck, setStruck] = useState(false);
  const [slip, setSlip] = useState<SlipState | null>(null);

  const sweepTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback(async (q: string) => {
    setQuestion(q);
    writeParams({ q });
    setPending(true);
    setError(null);
    setSwept(false);
    setStruck(false);
    setSlip(null);
    setCorrOpen(false);
    try {
      const r = await api.ask(q, DEMO_HISTORY_ID);
      setResp(r);
      setCorrValue(r.answer ?? '');
      // ?correct=1 arrives with the correction bar already open (stage-mode beat 3)
      if (readParam('correct') === '1' && !r.abstained) setCorrOpen(true);
      if (sweepTimer.current) clearTimeout(sweepTimer.current);
      // the highlighter sweep — the standing grace note on every cited answer
      sweepTimer.current = setTimeout(() => setSwept(true), prefersReducedMotion() ? 0 : 380);
    } catch (e) {
      setResp(null);
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setPending(false);
    }
  }, []);

  // URL-addressable: ?q=… replays any question; the first chip otherwise
  useEffect(() => {
    void run(readParam('q') ?? DEFAULT_QUESTION);
  }, [run]);

  // the hero band's refusal beat asks through this same path, so its card and this one cannot
  // disagree about what the history says
  useEffect(() => {
    const onAsk = (e: Event) => {
      const q = (e as CustomEvent<string>).detail;
      if (typeof q === 'string' && q.trim()) void run(q);
    };
    window.addEventListener(ASK_EVENT, onAsk);
    return () => window.removeEventListener(ASK_EVENT, onAsk);
  }, [run]);

  // keyboard demo mode (add-on №5): '.' re-runs the current choreography
  useEffect(() => {
    if (readParam('stage') == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '.') return;
      setSwept(false);
      setReplay((n) => n + 1);
      setTimeout(() => setSwept(true), prefersReducedMotion() ? 0 : 380);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const fileErratum = useCallback(async () => {
    if (!resp || !corrValue.trim()) return;
    const value = corrValue.trim();
    const supersedes = resp.citations[0];
    setCorrOpen(false);
    setStruck(true);
    setSlip({
      value,
      caption: `appending… · SUPERSEDES ${supersedes ? citeLabel(supersedes.session_id, supersedes.turn_index) : '—'} · source: you`,
      nonce: Date.now(),
    });
    try {
      const out = await api.correct({
        history_id: DEMO_HISTORY_ID,
        subject: resp.subject ?? DEMO_SUBJECT,
        attribute: resp.attribute ?? '',
        value,
        ...(supersedes?.claim_id != null ? { supersedes_claim_id: supersedes.claim_id } : {}),
      });
      setSlip((s) =>
        s
          ? {
              ...s,
              caption: `appended, not edited · claim ${out.claim_id} SUPERSEDES ${
                supersedes ? citeLabel(supersedes.session_id, supersedes.turn_index) : '—'
              } · source: you`,
            }
          : s,
      );
    } catch (e) {
      setSlip((s) =>
        s
          ? {
              ...s,
              error: true,
              caption: `not appended — the API has no write route yet (${String(e instanceof Error ? e.message : e).slice(0, 60)}). nothing was mutated; nothing was deleted.`,
            }
          : s,
      );
    }
  }, [resp, corrValue]);

  const stet = useCallback(() => {
    setStruck(false);
    setSlip(null);
    setCorrOpen(false);
  }, []);

  const predecessors = useMemo(() => {
    if (!resp?.answer) return [];
    const seen = new Set<string>();
    return (resp.superseded ?? [])
      .filter((s) => !sameValue(s.value, resp.answer ?? ''))
      .filter((s) => !seen.has(s.value) && seen.add(s.value));
  }, [resp]);

  const citedSessions = resp?.citations.map((c) => c.session_id) ?? [];
  const oldSessions = predecessors.map((s) => s.citation.session_id);

  return (
    <>
      <div className="chips">
        {CHIPS.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`chip${c.abstains ? ' gold' : ''}`}
            aria-pressed={question === c.question}
            onClick={() => void run(c.question)}
          >
            {c.label}
          </button>
        ))}
      </div>
      <form
        className="freetext"
        onSubmit={(e) => {
          e.preventDefault();
          if (free.trim()) void run(free.trim());
        }}
      >
        <input
          value={free}
          onChange={(e) => setFree(e.target.value)}
          placeholder="…or free-text, scoped to this history"
          aria-label="Ask a free-text question about this history"
        />
        <button type="submit">ask ↵</button>
      </form>

      <div className="card">
        <div className="spread">
          <div className="leftcol">
            <p className="q">{question}</p>
            {pending && <div className="hairline" aria-label="answering" />}
            {error && (
              <div className="slip in err" role="alert">
                <div className="sh">THE API DID NOT ANSWER</div>
                <div className="st" style={{ fontSize: '1rem' }}>
                  {error}
                </div>
                <div className="sc errline">nothing was mutated · retry, or check that apps/api is up</div>
              </div>
            )}

            {resp && !resp.abstained && (
              <>
                <div className="answer">
                  <span className="claimline">
                    <span className="cur">{resp.answer}</span>
                    <span className="stk" style={{ '--sx': struck ? 1 : 0 } as CSSProperties} />
                  </span>
                  {resp.citations.map((c, i) => (
                    <span className="fn" key={i} title={citeLabel(c.session_id, c.turn_index)}>
                      {citeMark(c.session_id, c.turn_index)}
                    </span>
                  ))}
                  {predecessors.map((s, i) => (
                    <span className="pred" key={i}>
                      <span className="claimline">
                        {s.value}
                        <span className="stk" style={{ '--sx': 1 } as CSSProperties} />
                      </span>
                      <span className="fn">{citeLabel(s.citation.session_id, s.citation.turn_index)}</span>
                    </span>
                  ))}
                </div>

                {/*
                  Two numbers, two labels (both scales, labelled). `claim` is the head claim's own confidence;
                  `evidence` is the calibrated answer-evidence score E that decided answer-vs-
                  abstain against τ. They live on different scales — E is bounded by how much of
                  the question resolved to entities and how often the fact was restated, so a
                  perfectly cited single-statement fact tops out well below 1 — and collapsing
                  them under one word made a confident answer read as a weak one.
                */}
                <div className="ansmeta">
                  <span
                    className="conf"
                    title={`claim = the head claim's own confidence; evidence = the calibrated answer-evidence score E, which answered because it cleared τ ${(resp.evidence?.tau ?? 0).toFixed(2)}`}
                  >
                    {resp.claim_confidence != null ? `claim ${resp.claim_confidence.toFixed(2)} · ` : ''}
                    evidence {resp.confidence.toFixed(2)}
                  </span>
                  <span>{resp.corroboration ?? resp.citations.length} supporting</span>
                  <span className="sup">{predecessors.length} superseded</span>
                  <span>{resp.latency_ms.toFixed(0)} ms</span>
                </div>

                <div className="econ">
                  this answer {resp.cost > 0 ? `≈ ${usd(resp.cost)}` : '$0 — a graph fold, no model call'} · full
                  context ({HISTORY_TOKEN_COUNT.toLocaleString('en-US')} tokens) would have been ≈{' '}
                  {usd(FULL_CONTEXT_USD)} · <span style={{ opacity: 0.75 }}>≈ estimate</span>
                </div>

                {/*
                  The losing pane, inline. Every /api/ask response already carries `vector_baseline`
                  — the highest-cosine candidate from the committed bge-small measurement — and it
                  was only ever visible on /compare. Beside the answer it costs one line and makes
                  the whole thesis legible without a page change: same question, what similarity
                  ranks first, and the fact that it is the retired value.
                */}
                {resp.vector_baseline && (
                  <div className="vbase">
                    a vector store would have returned{' '}
                    <span className="vv">&ldquo;{resp.vector_baseline.answer}&rdquo;</span> @ cos{' '}
                    {resp.vector_baseline.cosine.toFixed(4)} · {resp.vector_baseline.embedder}
                  </div>
                )}

                <div className="corrbar">
                  <button type="button" className="act" onClick={() => setCorrOpen((v) => !v)}>
                    That&apos;s wrong — correct it
                  </button>
                  <button type="button" className="act ghosty" onClick={stet}>
                    stet · let it stand
                  </button>
                </div>

                {corrOpen && (
                  <div className="corrform">
                    <input
                      value={corrValue}
                      onChange={(e) => setCorrValue(e.target.value)}
                      aria-label="the corrected value"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void fileErratum();
                      }}
                    />
                    <button type="button" className="act" onClick={() => void fileErratum()}>
                      file the erratum
                    </button>
                  </div>
                )}

                <ErratumSlip slip={slip} />
                <CypherDisclosure statements={resp.cypher} defaultOpen />
              </>
            )}

            {resp && resp.abstained && (
              <>
                <Refusal resp={resp} replayKey={replay} />
                <CypherDisclosure statements={resp.cypher} />
              </>
            )}
          </div>

          <div className="rightcol">
            <SourceColumn resp={resp} swept={swept} predecessors={predecessors} />
            <SessionSpine current={citedSessions} old={oldSessions} />
          </div>
        </div>
      </div>
    </>
  );
}
