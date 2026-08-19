'use client';

import { useEffect, useRef, useState } from 'react';
import { loadChain } from '../../lib/chain';
import type { ChainClaim } from '../../lib/chain';
import { citeLabel, monthStamp, prefersReducedMotion, provenanceLabel } from '../../lib/format';
import { IconReplay } from '../icons';
import { CONSTELLATION_ATTRIBUTES, DEMO_HISTORY_ID, DEMO_SUBJECT } from '../../config/demo';

const W = 1000;
const H = 470;
const NS = 'http://www.w3.org/2000/svg';

interface Node {
  id: string;
  kind: 'you' | 'claim';
  claim?: ChainClaim;
  label: string;
  meta: string;
  birth: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  pin: number;
  w: number;
  el: SVGGElement;
  strike?: SVGLineElement;
}

interface Edge {
  a: string;
  b: string;
  birth: number;
  el: SVGElement;
  label?: SVGTextElement;
}

const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

const trunc = (s: string, n = 26) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The Constellation tab: the prototype's ~40 lines of physics, unchanged in spirit,
 * driven by real claims — subject-scoped to the attributes in the demo config, never the whole
 * graph. SVG, no graph library. Added over the prototype: a label collision nudge, because two red
 * SUPERSEDES labels converging on one node overlapped in the browser review.
 */
export function Constellation({ attribute }: { attribute: string }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [t, setT] = useState(100);
  const [dateLabel, setDateLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef<{ nodes: Node[]; edges: Edge[]; reds: Edge[]; setTime: (v: number) => void } | null>(null);
  const replayRaf = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    let raf = 0;
    const svg = svgRef.current;
    if (!svg) return;

    // the attribute the History tab is on leads; the rest of the subject's chains orbit with it
    const attrs = [attribute, ...CONSTELLATION_ATTRIBUTES.filter((a) => a !== attribute)];

    Promise.all(attrs.map((a) => loadChain(DEMO_SUBJECT, a, DEMO_HISTORY_ID).catch(() => null)))
      .then((chains) => {
        if (!alive) return;
        const claims: ChainClaim[] = [];
        const revs: { newerId: number; olderId: number; at: number }[] = [];
        // claims the fold sets aside without an explicit edge — they must still go
        // dim once something later exists, or two "current" cards contradict each other on screen
        const foldAside = new Set<string>();
        for (const c of chains) {
          if (!c) continue;
          claims.push(...c.claims);
          revs.push(...c.revisions);
          for (const id of c.supersededIds) foldAside.add(String(id));
        }
        if (claims.length === 0) {
          setError('no claims about this subject in the demo history');
          return;
        }

        const lo = Math.min(...claims.map((c) => c.event_time));
        const hi = Math.max(...claims.map((c) => c.event_time));
        const pad = Math.max((hi - lo) * 0.1, 86_400 * 14);
        const t0 = lo - pad;
        const t1 = hi + pad;
        const birth = (time: number) => ((time - t0) / (t1 - t0)) * 100;
        const timeAt = (v: number) => t0 + ((t1 - t0) * v) / 100;

        const gE = svg.querySelector('#cs-e')!;
        const gR = svg.querySelector('#cs-r')!;
        const gN = svg.querySelector('#cs-n')!;
        for (const g of [gE, gR, gN]) g.replaceChildren();

        const nodes: Node[] = [];
        const you: Node = {
          id: 'you',
          kind: 'you',
          label: 'you',
          meta: '',
          birth: 0,
          x: W / 2,
          y: H / 2,
          vx: 0,
          vy: 0,
          pin: 0.9,
          w: 48,
          el: el('g', { class: 'gnode you' }),
        };
        you.el.append(el('circle', { class: 'body', r: 24 }));
        const yt = el('text', { y: 5, 'text-anchor': 'middle' });
        yt.textContent = 'you';
        you.el.append(yt);
        gN.append(you.el);
        nodes.push(you);

        claims.forEach((c, i) => {
          const label = trunc(c.value);
          const metaText = trunc(
            `${c.attribute.replace(/_/g, ' ')} · ${monthStamp(c.event_time)} · ${citeLabel(c.session_id, c.turn_index)}`,
            42,
          );
          // the box has to hold the wider of the two lines, or the meta line bleeds past the rule
          const w = Math.max(118, label.length * 7.2 + 20, metaText.length * 5.05 + 16);
          const g = el('g', { class: 'gnode claimN' });
          g.append(el('rect', { class: 'body', x: -w / 2, y: -21, width: w, height: 42 }));
          const v = el('text', { class: 'val', y: -3, 'text-anchor': 'middle' });
          v.textContent = label;
          g.append(v);
          const m = el('text', { class: 'metaT', y: 13, 'text-anchor': 'middle' });
          m.textContent = metaText;
          g.append(m);
          const strike = el('line', {
            class: 'strikeline',
            x1: -w / 2 + 8,
            x2: w / 2 - 8,
            y1: -5,
            y2: -7,
            'stroke-dasharray': w - 16,
            'stroke-dashoffset': w - 16,
          });
          g.append(strike);
          gN.append(g);
          const angle = (i / claims.length) * Math.PI * 2;
          nodes.push({
            id: String(c.id),
            kind: 'claim',
            claim: c,
            label,
            meta: metaText,
            birth: birth(c.event_time),
            x: W / 2 + Math.cos(angle) * 260,
            y: H / 2 + Math.sin(angle) * 150,
            vx: 0,
            vy: 0,
            pin: 0.06,
            w,
            el: g,
            strike,
          });
        });

        const byId = new Map(nodes.map((n) => [n.id, n]));
        const edges: Edge[] = claims.map((c) => {
          const line = el('line', { class: 'edgeG' });
          gE.append(line);
          return { a: 'you', b: String(c.id), birth: birth(c.event_time), el: line };
        });
        const reds: Edge[] = revs
          .filter((r) => byId.has(String(r.newerId)) && byId.has(String(r.olderId)))
          .map((r) => {
            const path = el('path', { class: 'redgeG' });
            const label = el('text', { class: 'elabelG', 'text-anchor': 'middle' });
            label.textContent = 'SUPERSEDES';
            gR.append(path);
            gR.append(label);
            return { a: String(r.newerId), b: String(r.olderId), birth: birth(r.at), el: path, label };
          });

        let drag: Node | null = null;

        const pull = (a: Node, b: Node, len: number) => {
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          const d = Math.hypot(dx, dy) || 1;
          const f = (d - len) * 0.02;
          dx /= d;
          dy /= d;
          a.vx += dx * f;
          a.vy += dy * f;
          b.vx -= dx * f;
          b.vy -= dy * f;
        };

        const tick = () => {
          for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
              const a = nodes[i]!;
              const b = nodes[j]!;
              let dx = b.x - a.x;
              let dy = b.y - a.y;
              const d2 = dx * dx + dy * dy || 1;
              const d = Math.sqrt(d2);
              const f = 24000 / d2;
              dx /= d;
              dy /= d;
              a.vx -= dx * f * 0.016;
              a.vy -= dy * f * 0.016;
              b.vx += dx * f * 0.016;
              b.vy += dy * f * 0.016;
            }
          }
          for (const e of edges) pull(byId.get(e.a)!, byId.get(e.b)!, 205);
          for (const e of reds) pull(byId.get(e.a)!, byId.get(e.b)!, 225);
          for (const n of nodes) {
            n.vx += (W / 2 - n.x) * 0.012 * n.pin;
            n.vy += (H / 2 - n.y) * 0.012 * n.pin;
            if (n !== drag) {
              n.vx *= 0.86;
              n.vy *= 0.86;
              n.x += n.vx;
              n.y += n.vy;
            }
          }
          // box separation: the prototype's point repulsion cannot keep wide claim cards apart, and
          // real values are much wider than the demo strings were. Push overlapping boxes out along
          // their least-penetrating axis — two passes settle it without visible jitter.
          for (let pass = 0; pass < 2; pass++) {
            for (let i = 0; i < nodes.length; i++) {
              for (let j = i + 1; j < nodes.length; j++) {
                const a = nodes[i]!;
                const b = nodes[j]!;
                if (a === drag || b === drag) continue;
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const minX = (a.w + b.w) / 2 + 16;
                const minY = 54;
                const ox = minX - Math.abs(dx);
                const oy = minY - Math.abs(dy);
                if (ox <= 0 || oy <= 0) continue;
                if (ox < oy) {
                  const s = ((dx < 0 ? -1 : 1) * ox) / 2;
                  a.x -= s;
                  b.x += s;
                } else {
                  const s = ((dy < 0 ? -1 : 1) * oy) / 2;
                  a.y -= s;
                  b.y += s;
                }
              }
            }
          }
          for (const n of nodes) {
            const half = n.w / 2 + 8;
            n.x = Math.max(half, Math.min(W - half, n.x));
            n.y = Math.max(30, Math.min(H - 30, n.y));
          }
          for (const e of edges) {
            const a = byId.get(e.a)!;
            const b = byId.get(e.b)!;
            e.el.setAttribute('x1', String(a.x));
            e.el.setAttribute('y1', String(a.y));
            e.el.setAttribute('x2', String(b.x));
            e.el.setAttribute('y2', String(b.y));
          }
          // label collision nudge: two red edges converging near one node overlapped their labels
          const placed: { x: number; y: number }[] = [];
          for (const e of reds) {
            const a = byId.get(e.a)!;
            const b = byId.get(e.b)!;
            const mx = (a.x + b.x) / 2;
            let my = (a.y + b.y) / 2 - 44;
            let guard = 0;
            while (placed.some((p) => Math.abs(p.x - mx) < 78 && Math.abs(p.y - my) < 13) && guard++ < 6) my -= 14;
            placed.push({ x: mx, y: my });
            e.el.setAttribute('d', `M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`);
            e.label?.setAttribute('x', String(mx));
            e.label?.setAttribute('y', String(my + 8));
          }
          for (const n of nodes) n.el.setAttribute('transform', `translate(${n.x},${n.y})`);
        };

        const setTime = (v: number) => {
          setDateLabel(monthStamp(timeAt(v)));
          const struck = new Set(reds.filter((e) => e.birth <= v).map((e) => e.b));
          for (const n of nodes) {
            if (n.kind !== 'claim' || !foldAside.has(n.id) || n.birth > v) continue;
            const later = nodes.some(
              (m) =>
                m.kind === 'claim' && m.claim!.attribute === n.claim!.attribute && m.birth > n.birth && m.birth <= v,
            );
            if (later) struck.add(n.id);
          }
          for (const n of nodes) {
            const on = n.birth <= v;
            n.el.style.opacity = on ? '1' : '0';
            n.el.style.pointerEvents = on ? 'auto' : 'none';
          }
          for (const e of edges) e.el.style.opacity = e.birth <= v ? '0.8' : '0';
          for (const n of nodes) {
            if (n.kind !== 'claim' || !n.strike) continue;
            const on = struck.has(n.id);
            n.strike.style.transition = 'stroke-dashoffset .5s ease-out';
            n.strike.style.strokeDashoffset = on ? '0' : String(n.w - 16);
            n.el.classList.toggle('struckN', on);
          }
          for (const e of reds) {
            const on = e.birth <= v;
            e.el.style.opacity = on ? '1' : '0';
            if (e.label) e.label.style.opacity = on ? '1' : '0';
          }
          const best = new Map<string, Node>();
          for (const n of nodes) {
            if (n.kind !== 'claim' || n.birth > v || struck.has(n.id)) continue;
            const a = n.claim!.attribute;
            const cur = best.get(a);
            if (!cur || n.birth > cur.birth) best.set(a, n);
          }
          for (const n of nodes) {
            if (n.kind !== 'claim') continue;
            n.el.classList.toggle('current', best.get(n.claim!.attribute) === n);
          }
        };

        // hover focus + receipt pop + drag
        const focus = (n: Node | null) => {
          if (!n) {
            for (const m of nodes) m.el.classList.remove('dim');
            for (const e of [...edges, ...reds]) {
              e.el.classList.remove('dim');
              e.label?.classList.remove('dim');
            }
            return;
          }
          const keep = new Set([n.id]);
          for (const e of [...edges, ...reds]) {
            if (e.a === n.id) keep.add(e.b);
            if (e.b === n.id) keep.add(e.a);
          }
          for (const m of nodes) m.el.classList.toggle('dim', !keep.has(m.id));
          for (const e of edges) e.el.classList.toggle('dim', !(e.a === n.id || e.b === n.id));
          for (const e of reds) {
            const on = e.a === n.id || e.b === n.id;
            e.el.classList.toggle('dim', !on);
            e.label?.classList.toggle('dim', !on);
          }
        };

        const showPop = (n: Node) => {
          const pop = popRef.current;
          const wrap = wrapRef.current;
          if (!pop || !wrap || !n.claim) return;
          const r = svg.getBoundingClientRect();
          const w = wrap.getBoundingClientRect();
          pop.replaceChildren();
          const cv = document.createElement('div');
          cv.className = 'cv';
          cv.textContent = n.claim.value;
          const quote = document.createElement('span');
          quote.className = 'hl2';
          quote.textContent = n.claim.span;
          const tail = document.createElement('div');
          tail.textContent = `confidence ${n.claim.confidence.toFixed(2)} · ${provenanceLabel(n.claim.provenance)} · event ${monthStamp(n.claim.event_time)}`;
          const body = document.createElement('div');
          body.append('«', quote, `» — ${citeLabel(n.claim.session_id, n.claim.turn_index)}`);
          pop.append(cv, body, tail);
          const px = (n.x * r.width) / W + r.left - w.left;
          const py = (n.y * r.height) / H + r.top - w.top;
          pop.style.left = `${Math.min(px + 18, w.width - 300)}px`;
          pop.style.top = `${Math.max(6, py - 90)}px`;
          pop.classList.add('show');
        };

        const point = (ev: PointerEvent) => {
          const r = svg.getBoundingClientRect();
          return { x: ((ev.clientX - r.left) * W) / r.width, y: ((ev.clientY - r.top) * H) / r.height };
        };
        for (const n of nodes) {
          n.el.addEventListener('pointerdown', (ev) => {
            drag = n;
            n.el.setPointerCapture((ev as PointerEvent).pointerId);
            ev.preventDefault();
          });
          n.el.addEventListener('pointermove', (ev) => {
            if (drag !== n) return;
            const p = point(ev as PointerEvent);
            n.x = p.x;
            n.y = p.y;
            n.vx = 0;
            n.vy = 0;
          });
          n.el.addEventListener('pointerup', () => {
            drag = null;
          });
          n.el.addEventListener('pointerenter', () => {
            focus(n);
            if (n.kind === 'claim') showPop(n);
          });
          n.el.addEventListener('pointerleave', () => {
            focus(null);
            popRef.current?.classList.remove('show');
          });
        }

        stateRef.current = { nodes, edges, reds, setTime };
        setTime(100);

        if (prefersReducedMotion()) {
          for (let i = 0; i < 260; i++) tick();
        } else {
          const loop = () => {
            tick();
            raf = requestAnimationFrame(loop);
          };
          raf = requestAnimationFrame(loop);
        }
      })
      .catch((e) => alive && setError(String(e instanceof Error ? e.message : e)));

    return () => {
      alive = false;
      if (raf) cancelAnimationFrame(raf);
      if (replayRaf.current) cancelAnimationFrame(replayRaf.current);
    };
  }, [attribute]);

  const replay = () => {
    if (replayRaf.current) cancelAnimationFrame(replayRaf.current);
    if (prefersReducedMotion()) {
      setT(100);
      stateRef.current?.setTime(100);
      return;
    }
    const t0 = performance.now();
    const frame = (now: number) => {
      const p = Math.min(1, (now - t0) / 4200);
      const eased = 1 - Math.pow(1 - p, 2.2);
      setT(eased * 100);
      stateRef.current?.setTime(eased * 100);
      if (p < 1) replayRaf.current = requestAnimationFrame(frame);
    };
    setT(0);
    stateRef.current?.setTime(0);
    replayRaf.current = requestAnimationFrame(frame);
  };

  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="bar" style={{ borderRadius: '8px 8px 0 0' }}>
        <button type="button" aria-label="replay the births" onClick={replay}>
          <IconReplay />
        </button>
        <input
          type="range"
          min={0}
          max={100}
          step={0.1}
          value={t}
          aria-label="playhead"
          onChange={(e) => {
            if (replayRaf.current) cancelAnimationFrame(replayRaf.current);
            const v = Number(e.target.value);
            setT(v);
            stateRef.current?.setTime(v);
          }}
        />
        <span className="date">{dateLabel}</span>
      </div>
      <div className="dotwrap" style={{ border: 0, borderRadius: '0 0 10px 10px' }} ref={wrapRef}>
        <div className="dotgrid" />
        <svg
          className="cs-stage"
          viewBox={`0 0 ${W} ${H}`}
          ref={svgRef}
          role="img"
          aria-label="claims about the user, over time"
        >
          <defs>
            <marker
              id="arrF"
              viewBox="0 0 10 10"
              refX="8.5"
              refY="5"
              markerWidth="6.5"
              markerHeight="6.5"
              orient="auto"
            >
              <path d="M0 0 L10 5 L0 10 z" fill="#B11742" />
            </marker>
          </defs>
          <g id="cs-e" />
          <g id="cs-r" />
          <g id="cs-n" />
        </svg>
        <div className="card-pop" ref={popRef} />
        {error && (
          <div className="mono" style={{ padding: '1rem', color: 'var(--red)' }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
