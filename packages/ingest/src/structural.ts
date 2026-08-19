// packages/ingest/src/structural.ts — the deterministic structural pass .
//
// Zero LLM. This pass alone makes a history queryable and citable — it is the zero-LLM floor made
// structural, and it must run before any budget is spent. Every row carries EVERY property (the
// graph is null-free; unknowns use typed sentinels), so a SET never writes a null.

import { keys, vid } from '@errata/graph';
import type { EdgeBatch, NodeBatch } from '@errata/graph';
import type { History } from './reader.js';
import { truncate } from './reader.js';
import { sessionSalience, tokenize } from './text.js';

const NA_CONF = -1.0;

export interface StructuralResult {
  nodes: NodeBatch[];
  edges: EdgeBatch[];
  /** turnId → salient, so the extractor and the graph agree on the gate. */
  salience: Map<string, boolean>;
  counts: { sessions: number; turns: number; speakers: number; salient: number };
}

export function buildStructural(history: History, runId: string, ingestTime: number): StructuralResult {
  const h = history.historyId;
  const sessionRows: Record<string, unknown>[] = [];
  const turnRows: Record<string, unknown>[] = [];
  const speakerRows: Record<string, unknown>[] = [];
  const toSession: Record<string, unknown>[] = [];
  const toSpeaker: Record<string, unknown>[] = [];
  const salience = new Map<string, boolean>();
  let salientN = 0;

  // two speakers per history
  for (const role of ['user', 'assistant'] as const) {
    const key = keys.speaker(h, role);
    speakerRows.push({
      id: vid(key), key, history_id: h, role, display: role === 'user' ? 'User' : 'Assistant',
      event_time: -1, event_time_iso: '', ingest_time: ingestTime, confidence: NA_CONF, provenance: 'EXTRACTED', run_id: runId,
    });
  }

  for (const session of history.sessions) {
    const sKey = keys.session(h, session.ordinal);
    const sId = vid(sKey);
    sessionRows.push({
      id: sId, key: sKey, history_id: h, session_id: session.sessionId, session_date_iso: session.dateIso,
      turn_count: session.turns.length, ordinal: session.ordinal,
      event_time: session.epoch, event_time_iso: session.dateIso, ingest_time: ingestTime,
      confidence: NA_CONF, provenance: 'EXTRACTED', run_id: runId,
    });

    const flags = sessionSalience(session.turns);
    for (const [i, turn] of session.turns.entries()) {
      const salient = flags[i]!;
      salience.set(turn.turnId, salient);
      if (salient) salientN++;

      const tKey = keys.turn(h, session.ordinal, turn.turnIdx);
      const tId = vid(tKey);
      turnRows.push({
        id: tId, key: tKey, history_id: h, session_id: session.sessionId, turn_id: turn.turnId, turn_idx: turn.turnIdx,
        role: turn.role, text: truncate(turn.text), token_count: tokenize(turn.text).length, salient,
        event_time: session.epoch, event_time_iso: session.dateIso, ingest_time: ingestTime,
        confidence: NA_CONF, provenance: 'EXTRACTED', run_id: runId,
      });

      // STATED_IN: Turn → Session and Turn → Speaker (tagged by destination, not index parity)
      const spKey = keys.speaker(h, turn.role);
      const statedRow = (dstKey: string, dstId: number): Record<string, unknown> => {
        const eKey = keys.edge('STATED_IN', tKey, dstKey);
        return {
          id: vid(eKey), src: tId, dst: dstId, key: eKey, history_id: h,
          event_time: session.epoch, event_time_iso: session.dateIso, ingest_time: ingestTime,
          confidence: NA_CONF, provenance: 'EXTRACTED', run_id: runId,
        };
      };
      toSession.push(statedRow(sKey, sId));
      toSpeaker.push(statedRow(spKey, vid(spKey)));
    }
  }

  const nodes: NodeBatch[] = [
    { label: 'Speaker', rows: speakerRows },
    { label: 'Session', rows: sessionRows },
    { label: 'Turn', rows: turnRows },
  ];
  // STATED_IN endpoints are polymorphic; each batch is one (type, srcLabel, dstLabel) triple.
  const edges: EdgeBatch[] = [
    { type: 'STATED_IN', srcLabel: 'Turn', dstLabel: 'Session', rows: toSession },
    { type: 'STATED_IN', srcLabel: 'Turn', dstLabel: 'Speaker', rows: toSpeaker },
  ];

  return {
    nodes,
    edges,
    salience,
    counts: { sessions: sessionRows.length, turns: turnRows.length, speakers: speakerRows.length, salient: salientN },
  };
}
