/*
 * Interactive AON / AOA network board (plain UMD module, no build step).
 *  - build():     graph model with a layered layout (Networks.layered: crossing reduction,
 *                 critical path on one straight row, compact spacing).
 *  - contents()/svg()/bounds(): orthogonal edge routing + SVG markup. Routes are cached per graph
 *                 object, so while a node is dragged only the edges around it are re-routed.
 *  - cyclogram(): SVG for the linear schedule data returned by Networks.linear().
 */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./networks.js') : root.Networks);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GraphBoard = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Networks) {
  'use strict';

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  // One shared formatter: Number#toLocaleString builds a new Intl formatter on every call, which
  // dominated the cost of re-rendering the board while dragging.
  const NUMBER = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 });
  const number = (n) => {
    const v = Number(n);
    return NUMBER.format(Math.abs(v) < 1e-9 ? 0 : v); // never print "-0"
  };
  const fixed = (v) => Math.round(v * 10) / 10;

  // Distance between layers (col) and rows (row) per node style, and the top-left node centre.
  const LAYOUT = {
    circle: { col: 190, row: 165, left: 110, top: 125 },
    card: { col: 265, row: 150, left: 130, top: 125 },
    aoa: { col: 165, row: 115, left: 90, top: 100 },
  };
  const TRACK_X = 7; // spacing of parallel vertical rails
  const TRACK_Y = 9; // spacing of parallel horizontal lanes
  const CLEAR = 6; // minimum gap between a node footprint and a rail
  const TOP_LABELLED = 40; // highest lane for an edge with a label (label sits ~16 px above it)
  const TOP_PLAIN = 24;
  const EDGE_MARGIN = 16;

  // ---------------------------------------------------------------------------------------------
  // Model + layout.

  function place(nodes, lay, grid) {
    const minRow = Math.min(0, ...nodes.map((n) => lay.row.get(n.key)));
    for (const n of nodes) {
      n.x = grid.left + lay.layer.get(n.key) * grid.col;
      n.y = grid.top + (lay.row.get(n.key) - minRow) * grid.row;
    }
  }

  /** Many links converge on the start/finish: widen those gaps so each link gets its own rail. */
  function widenTerminals(nodes, edges, startKey, finishKey) {
    const extra = (k) => Math.max(0, (k - 6) * TRACK_X);
    const out = extra(edges.filter((e) => e.from === startKey).length), inn = extra(edges.filter((e) => e.to === finishKey).length);
    for (const n of nodes) {
      if (n.key !== startKey) n.x += out;
      if (n.key === finishKey) n.x += inn;
    }
  }

  const arrowLabel = (a) =>
    a.kind === 'dummy' ? '' : a.kind === 'lag' ? 'Chờ ' + number(a.duration) : a.task + ' (' + number(a.duration) + ', ' + number(a.workers || 0) + ')';

  function buildAoa(schedule) {
    const g = Networks.aoa(schedule.rows), grid = LAYOUT.aoa, keyOf = new Map(g.nodes.map((n) => [n.id, n.key]));
    const minRow = Math.min(0, ...g.nodes.map((n) => n.row));
    const nodes = g.nodes.map((n) => ({ ...n, x: grid.left + n.level * grid.col, y: grid.top + (n.row - minRow) * grid.row }));
    const edges = g.arrows.map((a) => ({ ...a, event: { from: a.from, to: a.to }, from: keyOf.get(a.from), to: keyOf.get(a.to), label: arrowLabel(a) }));
    widenTerminals(nodes, edges, 'event:source', 'event:sink');
    return { kind: 'aoa', nodes, edges, duration: g.duration, dummies: g.dummies };
  }

  /**
   * @param schedule CT.schedule() result (or an applied plan with the same shape)
   * @param kind     'aon' (default) or 'aoa'
   * @param options  {style: 'circle' | 'card'} – spacing for AON node style (default circle)
   * @returns {kind, nodes: [{key, label, x, y, ...}], edges: [{key, from, to, label, critical, ...}]}
   */
  function build(schedule, kind = 'aon', options = {}) {
    if (kind === 'aoa') return buildAoa(schedule);
    const style = options.style === 'card' ? 'card' : 'circle', T = schedule.duration;
    const terminal = (key, label, time) => ({ key, label, virtual: true, es: time, ef: time, ls: time, lf: time, tf: 0, ff: 0, duration: 0, critical: true });
    const nodes = [terminal('@start', 'BĐ', 0), ...schedule.rows.map((t) => ({ ...t, key: t.id, label: t.id })), terminal('@finish', 'KT', T)];
    // The default relation FS+0 is implied by the arrow itself; label only lags and SS/FF/SF.
    const edges = schedule.edges.map((e, i) => ({ ...e, key: 'edge:' + i, label: e.type === 'FS' && e.lag === 0 ? '' : e.type + (e.lag >= 0 ? '+' : '') + e.lag }));
    const hasIn = new Set(schedule.edges.map((e) => e.to)), hasOut = new Set(schedule.edges.map((e) => e.from));
    for (const t of schedule.rows) {
      if (!hasIn.has(t.id)) edges.push({ key: 'start:' + t.id, from: '@start', to: t.id, label: '', critical: t.critical && t.es === 0 });
      if (!hasOut.has(t.id) || t.ef === T) edges.push({ key: 'finish:' + t.id, from: t.id, to: '@finish', label: '', critical: t.critical && t.ef === T });
    }
    // Primary critical chain (most tasks linked by critical relations) → one straight row.
    const criticalEdges = schedule.edges.filter((e) => e.critical), memo = new Map();
    const chain = (id) => {
      if (memo.has(id)) return memo.get(id);
      let best = [];
      for (const edge of criticalEdges) if (edge.from === id) {
        const candidate = chain(edge.to);
        if (candidate.length > best.length) best = candidate;
      }
      const result = [id, ...best];
      memo.set(id, result);
      return result;
    };
    let primary = [];
    for (const id of schedule.critical) {
      const candidate = chain(id);
      if (candidate.length > primary.length) primary = candidate;
    }
    for (const t of schedule.rows)
      if (t.critical && !criticalEdges.some((e) => e.to === t.id) && !edges.some((e) => e.from === '@start' && e.to === t.id))
        edges.push({ key: 'release:' + t.id, from: '@start', to: t.id, label: t.es ? 'Mốc ' + number(t.es) : '', critical: true });
    const lay = Networks.layered(nodes.map((n) => n.key), edges, { spine: ['@start', ...primary, '@finish'] });
    place(nodes, lay, LAYOUT[style]);
    widenTerminals(nodes, edges, '@start', '@finish');
    return { kind: 'aon', style, nodes, edges };
  }

  function positions(graph, saved = {}) {
    const p = Object.create(null);
    for (const node of graph.nodes) {
      const value = Object.hasOwn(saved, node.key) ? saved[node.key] : null;
      p[node.key] =
        value && Number.isFinite(value.x) && Number.isFinite(value.y) && value.x >= 70 && value.y >= 70 && value.x <= 20000 && value.y <= 20000
          ? { x: value.x, y: value.y }
          : { x: node.x, y: node.y };
    }
    return p;
  }

  // ---------------------------------------------------------------------------------------------
  // Geometry: node footprints (routing obstacles) and ports.

  /** Card half-width shrinks when card nodes sit closer than the card spacing (e.g. circle layout). */
  function cardHalf(graph, p) {
    let min = Infinity;
    const list = graph.nodes.map((n) => p[n.key]);
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++)
        if (Math.abs(list[i].y - list[j].y) < 118) min = Math.min(min, Math.abs(list[i].x - list[j].x));
    return Math.max(70, Math.min(103, Math.floor(min / 2) - 26));
  }

  function shapes(graph, p, style) {
    const half = graph.kind !== 'aoa' && style === 'card' ? cardHalf(graph, p) : 103, map = new Map();
    for (const n of graph.nodes) {
      const { x, y } = p[n.key];
      let s;
      if (graph.kind === 'aoa') s = { l: 31, r: 31, t: 31, b: 31, radius: 29, band: 25 };
      else if (style === 'card') s = { l: half + 3, r: half + 3, t: 54, b: 64, side: half, band: 30 };
      else if (n.virtual) s = { l: 34, r: 34, t: 34, b: 58, radius: 30, band: 27 };
      else s = { l: 68, r: 68, t: 36, b: 86, radius: 30, band: 12 }; // circle + ES/EF/LS/LF labels (ports stay between the label rows)
      map.set(n.key, { key: n.key, x, y, x1: x - s.l, x2: x + s.r, y1: y - s.t, y2: y + s.b, radius: s.radius || 0, side: s.side || 0, band: s.band });
    }
    return { map, half };
  }

  /**
   * Port points. Each node side spreads its links vertically (sorted by the other end's y) so
   * parallel links never share a segment; the link to a level neighbour keeps offset 0.
   */
  function assignPorts(graph, geo, p) {
    const sides = new Map(), ports = new Map();
    const push = (key, side, item) => {
      if (!sides.has(key)) sides.set(key, { L: [], R: [] });
      sides.get(key)[side].push(item);
    };
    for (const e of graph.edges) {
      const fromStart = e.type === 'SS' || e.type === 'SF', toFinish = e.type === 'FF' || e.type === 'SF';
      // Only a link whose ports face each other can be drawn as one straight segment.
      const straight = fromStart !== toFinish ? false : fromStart ? p[e.to].x < p[e.from].x : p[e.to].x > p[e.from].x;
      push(e.from, fromStart ? 'L' : 'R', { e, end: 's', other: e.to, straight });
      push(e.to, toFinish ? 'R' : 'L', { e, end: 't', other: e.from, straight });
      ports.set(e.key, {});
    }
    for (const [key, both] of sides) {
      const node = geo.get(key);
      for (const side of ['L', 'R']) {
        const list = both[side];
        if (!list.length) continue;
        list.sort((a, b) => p[a.other].y - p[b.other].y || p[a.other].x - p[b.other].x || (a.e.key < b.e.key ? -1 : 1));
        let centre = -1, nearest = Infinity;
        list.forEach((item, i) => {
          const o = p[item.other];
          if (item.straight && Math.abs(o.y - node.y) < 0.5 && Math.abs(o.x - node.x) < nearest) {
            nearest = Math.abs(o.x - node.x);
            centre = i;
          }
        });
        if (centre < 0) centre = (list.length - 1) / 2;
        const reach = Math.max(centre, list.length - 1 - centre), step = reach ? Math.min(8, node.band / reach) : 0, dir = side === 'R' ? 1 : -1;
        list.forEach((item, i) => {
          const dy = (i - centre) * step, dx = node.radius ? Math.sqrt(Math.max(0, node.radius ** 2 - dy ** 2)) : node.side;
          const point = { x: node.x + dir * dx, y: node.y + dy }, port = ports.get(item.e.key);
          if (item.end === 's') {
            port.s = point;
            port.dirS = dir; // travel direction when leaving
          } else {
            port.t = point;
            port.dirT = -dir; // travel direction when arriving
          }
        });
      }
    }
    return ports;
  }

  // ---------------------------------------------------------------------------------------------
  // Spatial hash for node boxes and route segments.

  class Grid {
    constructor(size) {
      this.size = size;
      this.cells = new Map();
      this.stamp = 0;
    }
    each(x1, y1, x2, y2, fn) {
      const s = this.size;
      for (let i = Math.floor(x1 / s), i2 = Math.floor(x2 / s); i <= i2; i++)
        for (let j = Math.floor(y1 / s), j2 = Math.floor(y2 / s); j <= j2; j++) fn(i * 100003 + j);
    }
    insert(item, x1, y1, x2, y2) {
      item.cells = [];
      this.each(x1, y1, x2, y2, (k) => {
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(item);
        item.cells.push(k);
      });
    }
    remove(item) {
      for (const k of item.cells || []) {
        const list = this.cells.get(k), i = list ? list.indexOf(item) : -1;
        if (i >= 0) list.splice(i, 1);
      }
      item.cells = [];
    }
    query(x1, y1, x2, y2, fn) {
      const stamp = ++this.stamp;
      this.each(x1, y1, x2, y2, (k) => {
        const list = this.cells.get(k);
        if (list) for (const item of list) if (item.seen !== stamp) {
          item.seen = stamp;
          fn(item);
        }
      });
    }
  }

  const segment = (a, b, edge) => ({ edge, h: Math.abs(a.y - b.y) < 0.01, x1: Math.min(a.x, b.x), x2: Math.max(a.x, b.x), y1: Math.min(a.y, b.y), y2: Math.max(a.y, b.y) });

  /** Removes repeated points and merges collinear runs. */
  function simplify(points) {
    const out = [];
    for (const pt of points) {
      const last = out[out.length - 1];
      if (last && Math.abs(last.x - pt.x) < 0.01 && Math.abs(last.y - pt.y) < 0.01) continue;
      if (out.length >= 2) {
        const a = out[out.length - 2];
        if ((Math.abs(a.x - last.x) < 0.01 && Math.abs(last.x - pt.x) < 0.01) || (Math.abs(a.y - last.y) < 0.01 && Math.abs(last.y - pt.y) < 0.01)) out.pop();
      }
      out.push({ x: pt.x, y: pt.y });
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Router.

  /**
   * Route cost: base (length, bends) + penalty (node hits, collinear overlaps and crossings with
   * routed edges, leaving the drawable area). Returns {total, penalty}.
   */
  function cost(points, ctx, st) {
    let base = (points.length - 2) * 6, penalty = 0;
    for (let i = 1; i < points.length; i++) {
      const s = segment(points[i - 1], points[i]), first = i === 1, last = i === points.length - 1;
      base += (s.x2 - s.x1 + s.y2 - s.y1) * 0.02;
      st.boxes.query(s.x1, s.y1, s.x2, s.y2, (box) => {
        // The first/last stub may run inside its own node's label area up to the port.
        if ((first && box.key === ctx.from) || (last && box.key === ctx.to)) return;
        if (s.x2 > box.x1 && s.x1 < box.x2 && s.y2 > box.y1 && s.y1 < box.y2) penalty += 50000; // never cut through a node
      });
      st.segs.query(s.x1 - 10, s.y1 - 10, s.x2 + 10, s.y2 + 10, (o) => {
        if (o.edge === ctx.key) return;
        if (o.h === s.h) {
          const gap = s.h ? Math.abs(o.y1 - s.y1) : Math.abs(o.x1 - s.x1);
          const overlap = s.h ? Math.min(s.x2, o.x2) - Math.max(s.x1, o.x1) : Math.min(s.y2, o.y2) - Math.max(s.y1, o.y1);
          if (gap < 3 && overlap > 3) penalty += 1500;
          else if (gap < 3 && overlap > -10) penalty += 300; // end-to-end on one track reads as one line
        } else {
          const hs = s.h ? s : o, vs = s.h ? o : s;
          if (vs.x1 > hs.x1 + 1 && vs.x1 < hs.x2 - 1 && hs.y1 > vs.y1 + 1 && hs.y1 < vs.y2 - 1) penalty += 40;
        }
      });
    }
    for (const pt of points) if (pt.y < ctx.top || pt.x < EDGE_MARGIN) penalty += 6000;
    return { total: base + penalty, penalty };
  }

  /**
   * Free intervals in [lo, hi] along x (vertical = true) or y, ignoring node boxes that do not
   * overlap the perpendicular span [a, b].
   */
  function freeIntervals(st, vertical, a, b, lo, hi) {
    const blocks = [];
    const visit = (g) => {
      if (vertical ? g.y2 <= a || g.y1 >= b : g.x2 <= a || g.x1 >= b) return;
      const s = vertical ? g.x1 : g.y1, e = vertical ? g.x2 : g.y2;
      if (e > lo && s < hi) blocks.push([s, e]);
    };
    if (vertical) st.boxes.query(lo, a, hi, b, visit);
    else st.boxes.query(a, lo, b, Math.min(hi, st.maxY + 10), visit);
    blocks.sort((x, y) => x[0] - y[0]);
    const out = [];
    let cur = lo;
    for (const [s, e] of blocks) {
      if (s - cur >= 6) out.push([cur, s]);
      cur = Math.max(cur, e);
      if (cur >= hi) break;
    }
    if (hi - cur >= 6) out.push([cur, hi]);
    return out;
  }

  /**
   * Up to `count` free tracks for a rail (vertical) or lane spanning [a, b], scanning from `start`
   * (alternating ±step, or only toward `dir`) inside [lo, hi]. A track is free when no routed
   * segment of the same orientation runs within one step over the span; `ok(c)` can veto a track
   * (e.g. when the stub leading to it would overlap another route). One spatial query per call.
   */
  function tracks(st, vertical, a, b, start, lo, hi, dir = 0, ok = null, count = 1) {
    const step = vertical ? TRACK_X : TRACK_Y, gap = step - 0.5, from = Math.min(a, b), to = Math.max(a, b), found = [], taken = [];
    const wLo = Math.max(lo, dir > 0 ? start : start - 40 * step) - gap, wHi = Math.min(hi, dir < 0 ? start : start + 40 * step) + gap;
    const visit = (o) => {
      if (o.h !== vertical) taken.push(vertical ? [o.x1, o.y1, o.y2] : [o.y1, o.x1, o.x2]);
    };
    if (wHi >= wLo) {
      if (vertical) st.segs.query(wLo, from - 10, wHi, to + 10, visit);
      else st.segs.query(from - 10, wLo, to + 10, wHi, visit);
    }
    const free = (c) => !taken.some(([q, x, y]) => Math.abs(q - c) < gap && Math.min(to, y) - Math.max(from, x) > -10);
    let fallback = null;
    for (let k = 0; k < 40 && found.length < count; k++) {
      const c = dir ? start + dir * k * step : start + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * step;
      if (c < lo || c > hi) {
        if (dir || (start - Math.ceil(k / 2) * step < lo && start + Math.ceil(k / 2) * step > hi)) break;
        continue;
      }
      if (!free(c)) continue;
      if (!ok || ok(c)) found.push(c);
      else if (fallback === null) fallback = c;
    }
    return found.length ? found : [fallback ?? Math.max(lo, Math.min(hi, start))];
  }

  /** ok(c) for a horizontal stub at height y from x0 to c (c within [lo, hi]): no collinear route. */
  function stubCheck(st, y, x0, lo, hi) {
    const list = [];
    st.segs.query(Math.min(x0, lo) - 12, y - 3, Math.max(x0, hi) + 12, y + 3, (o) => {
      if (o.h && Math.abs(o.y1 - y) < 3) list.push(o);
    });
    return (c) => {
      const a = Math.min(x0, c), b = Math.max(x0, c);
      return !list.some((o) => Math.min(b, o.x2) - Math.max(a, o.x1) > -10);
    };
  }

  function routeEdge(e, st) {
    const A = st.geo.get(e.from), B = st.geo.get(e.to), port = st.ports.get(e.key);
    const s = port.s, t = port.t, dS = port.dirS, dT = port.dirT;
    const ctx = contextOf(e);
    let best = null, bestCost = Infinity, bestPenalty = Infinity;
    const consider = (points, bias = 0) => {
      const pts = simplify(points), c = cost(pts, ctx, st);
      if (c.total + bias < bestCost) {
        bestCost = c.total + bias;
        bestPenalty = c.penalty;
        best = pts;
      }
    };

    // (A) Straight: level ports facing each other (never for backward links).
    if (Math.abs(s.y - t.y) < 0.5 && dS === dT && (t.x - s.x) * dS > 0) {
      consider([s, t]);
      if (bestPenalty === 0) return best;
    }

    // (B) One vertical rail between the exit side of the source and the entry side of the target.
    let lo = -Infinity, hi = Infinity;
    if (dS > 0) lo = A.x2 + CLEAR;
    else hi = A.x1 - CLEAR;
    if (dT > 0) hi = Math.min(hi, B.x1 - CLEAR);
    else lo = Math.max(lo, B.x2 + CLEAR);
    if (lo === -Infinity) lo = hi - 160;
    if (hi === Infinity) hi = lo + 160;
    if (lo <= hi && Math.abs(s.y - t.y) >= 0.5) {
      const ya = Math.min(s.y, t.y), yb = Math.max(s.y, t.y), home = dS > 0 ? lo : hi;
      let channels = freeIntervals(st, true, ya, yb, lo, hi);
      if (!channels.length) channels = [[lo, hi]];
      // Channels nearest the source first: the long run into the target then carries the label.
      channels.sort((x, y) => Math.abs((x[0] + x[1]) / 2 - home) - Math.abs((y[0] + y[1]) / 2 - home));
      const okS = stubCheck(st, s.y, s.x, lo, hi), okT = stubCheck(st, t.y, t.x, lo, hi);
      for (const [a, b] of channels.slice(0, 8)) {
        const start = dS > 0 ? a + (b - a) / 3 : b - (b - a) / 3;
        for (const X of tracks(st, true, ya, yb, start, a + 2, b - 2, 0, (c) => okS(c) && okT(c), 3))
          consider([s, { x: X, y: s.y }, { x: X, y: t.y }, t], Math.abs(X - home) * 0.002);
        if (bestPenalty === 0) return best;
      }
    }

    // (C) Detour through a horizontal corridor: exit → X1 → lane Y → X2 → entry.
    if (bestPenalty >= 500) {
      const xa = Math.min(A.x1, B.x1) - 20, xb = Math.max(A.x2, B.x2) + 20, mid = (s.y + t.y) / 2;
      const corridors = freeIntervals(st, false, xa, xb, ctx.top, st.maxY + 2000);
      const centre = (c) => (c[0] + Math.min(c[1], c[0] + 60)) / 2;
      const chosen = corridors.slice().sort((x, y) => Math.abs(centre(x) - mid) - Math.abs(centre(y) - mid)).slice(0, 6);
      for (const c of [corridors[0], corridors[corridors.length - 1]]) if (c && !chosen.includes(c)) chosen.push(c);
      // Stay within 60 px of the node so the rail hugs the side it serves.
      const near = (c, toward) => (toward > 0 ? [c[0] + 2, Math.min(c[1], c[0] + 60) - 2] : [Math.max(c[0], c[1] - 60) + 2, c[1] - 2]);
      for (const [ya, yb] of chosen) {
        const bottom = yb > st.maxY + 100, topmost = ya <= ctx.top + 0.01;
        const guess = bottom ? ya + TRACK_Y : topmost ? yb - TRACK_Y : (ya + yb) / 2;
        // X1: first channel beyond the source on its exit side; X2: last channel before the target.
        const x1s = freeIntervals(st, true, Math.min(s.y, guess), Math.max(s.y, guess), dS > 0 ? A.x2 + CLEAR : A.x1 - 400, dS > 0 ? A.x2 + 400 : A.x1 - CLEAR);
        const x2s = freeIntervals(st, true, Math.min(t.y, guess), Math.max(t.y, guess), dT > 0 ? B.x1 - 400 : B.x2 + CLEAR, dT > 0 ? B.x1 - CLEAR : B.x2 + 400);
        const c1 = (dS > 0 ? x1s[0] : x1s[x1s.length - 1]) || (dS > 0 ? [A.x2 + CLEAR, A.x2 + CLEAR + 30] : [A.x1 - CLEAR - 30, A.x1 - CLEAR]);
        const c2 = (dT > 0 ? x2s[x2s.length - 1] : x2s[0]) || (dT > 0 ? [B.x1 - CLEAR - 30, B.x1 - CLEAR] : [B.x2 + CLEAR, B.x2 + CLEAR + 30]);
        const r1 = near(c1, dS), r2 = near(c2, -dT);
        const X1 = tracks(st, true, s.y, guess, dS > 0 ? Math.min((c1[0] + c1[1]) / 2, c1[0] + 14) : Math.max((c1[0] + c1[1]) / 2, c1[1] - 14), r1[0], r1[1], 0, stubCheck(st, s.y, s.x, r1[0], r1[1]))[0];
        const X2 = tracks(st, true, t.y, guess, dT > 0 ? Math.max((c2[0] + c2[1]) / 2, c2[1] - 14) : Math.min((c2[0] + c2[1]) / 2, c2[0] + 14), r2[0], r2[1], 0, stubCheck(st, t.y, t.x, r2[0], r2[1]))[0];
        const Y = bottom
          ? tracks(st, false, X1, X2, ya + TRACK_Y, ya + 4, yb, 1)[0]
          : topmost
            ? tracks(st, false, X1, X2, yb - TRACK_Y, ya, yb - 4, -1)[0]
            : tracks(st, false, X1, X2, (ya + yb) / 2, ya + 3, yb - 3)[0];
        consider([s, { x: X1, y: s.y }, { x: X1, y: Y }, { x: X2, y: Y }, { x: X2, y: t.y }, t]);
        if (bestPenalty === 0) break;
      }
    }
    return best || [s, t];
  }

  /**
   * Every link must leave its source and reach its target through a fixed stub (port → just
   * outside the node). Those stubs are reserved before routing so earlier links avoid them.
   */
  function reserve(st, e) {
    const q = st.ports.get(e.key), A = st.geo.get(e.from), B = st.geo.get(e.to);
    const out = segment(q.s, { x: q.dirS > 0 ? A.x2 + CLEAR : A.x1 - CLEAR, y: q.s.y }, e.key);
    const into = segment({ x: q.dirT > 0 ? B.x1 - CLEAR : B.x2 + CLEAR, y: q.t.y }, q.t, e.key);
    out.first = into.last = true;
    for (const s of [out, into]) st.segs.insert(s, s.x1, s.y1, s.x2, s.y2);
    st.reserved.set(e.key, [out, into]);
  }

  function unreserve(st, key) {
    for (const s of st.reserved.get(key) || []) st.segs.remove(s);
    st.reserved.delete(key);
  }

  function commit(st, e, points) {
    unreserve(st, e.key);
    const segs = [];
    for (let i = 1; i < points.length; i++) {
      const s = segment(points[i - 1], points[i], e.key);
      s.first = i === 1;
      s.last = i === points.length - 1;
      st.segs.insert(s, s.x1, s.y1, s.x2, s.y2);
      segs.push(s);
    }
    st.routes.set(e.key, { points, segs });
  }

  function uncommit(st, e) {
    const route = st.routes.get(e.key);
    if (route) for (const s of route.segs) st.segs.remove(s);
    st.routes.delete(e.key);
    unreserve(st, e.key);
    reserve(st, e); // its stubs stay blocked until it is routed again
  }

  /** Level links first (they are the straight backbone), then critical, then short before long. */
  const priority = (st) => {
    const span = (e) => {
      const q = st.ports.get(e.key);
      return Math.abs(q.s.x - q.t.x) + Math.abs(q.s.y - q.t.y);
    };
    const level = (e) => {
      const q = st.ports.get(e.key);
      return Math.abs(q.s.y - q.t.y) < 0.5 && q.dirS === q.dirT && (q.t.x - q.s.x) * q.dirS > 0 ? 0 : 1;
    };
    return (a, b) => level(a) - level(b) || (b.critical === true) - (a.critical === true) || span(a) - span(b) || (a.key < b.key ? -1 : 1);
  };

  function snapshot(graph, p) {
    return new Map(graph.nodes.map((n) => [n.key, { x: p[n.key].x, y: p[n.key].y }]));
  }

  function setExtent(st) {
    st.minY = Math.min(...[...st.geo.values()].map((g) => g.y1));
    st.maxY = Math.max(...[...st.geo.values()].map((g) => g.y2));
  }

  const contextOf = (e) => ({ key: e.key, from: e.from, to: e.to, top: e.label ? TOP_LABELLED : TOP_PLAIN });

  /**
   * Rip-up and re-route: an edge that still overlaps or crosses a node is routed again together
   * with the edges it overlaps, this time first; the change is kept only if the total cost drops.
   */
  function improve(st, list) {
    const byKey = new Map(list.map((e) => [e.key, e]));
    const routeCost = (e) => cost(st.routes.get(e.key).points, contextOf(e), st).total;
    // Stubs fanning into (or out of) the same node side share its port area; re-routing cannot
    // remove that overlap, so such pairs are not treated as partners.
    // Likewise links of a crowded node side (a fan of more than 6 links) are left alone.
    const degree = new Map(), bump = (k) => degree.set(k, (degree.get(k) || 0) + 1);
    for (const e of list) {
      bump(e.from + '>' + st.ports.get(e.key).dirS);
      bump(e.to + '<' + st.ports.get(e.key).dirT);
    }
    const sharedPort = (s, o) => {
      const a = byKey.get(s.edge), b = byKey.get(o.edge), pa = st.ports.get(a.key), pb = st.ports.get(b.key);
      if (a.to === b.to && pa.dirT === pb.dirT && (degree.get(a.to + '<' + pa.dirT) > 6 || (s.last && o.last))) return true;
      return a.from === b.from && pa.dirS === pb.dirS && (degree.get(a.from + '>' + pa.dirS) > 6 || (s.first && o.first));
    };
    const reroute = (group) => {
      for (const x of group) uncommit(st, x);
      for (const x of group) commit(st, x, routeEdge(x, st));
      return group.reduce((sum, x) => sum + routeCost(x), 0);
    };
    const restore = (group, routes) => {
      for (const x of group) uncommit(st, x);
      group.forEach((x, i) => commit(st, x, routes[i]));
    };
    let budget = 4 * list.length + 40; // bounded work: a few extra routings per edge at most
    for (let pass = 0; pass < 2 && budget > 0; pass++) {
      let changed = false;
      for (const e of list) {
        if (budget <= 0) break;
        if (cost(st.routes.get(e.key).points, contextOf(e), st).penalty < 1000) continue;
        const partners = new Set();
        for (const s of st.routes.get(e.key).segs)
          st.segs.query(s.x1 - 3, s.y1 - 3, s.x2 + 3, s.y2 + 3, (o) => {
            if (o.edge !== e.key && o.h === s.h && byKey.has(o.edge) && !sharedPort(s, o)) partners.add(o.edge);
          });
        if (!partners.size) continue;
        const others = [...partners].map((k) => byKey.get(k)).sort(priority(st)).slice(0, 4);
        const group = [e, ...others];
        budget -= 2 * group.length;
        const original = group.map((x) => st.routes.get(x.key).points);
        let best = group.reduce((sum, x) => sum + routeCost(x), 0) - 1, bestRoutes = original;
        // Try the troubled edge first, then last (e.g. two Z routes crossing in one column gap
        // only separate when the rails are taken in the right order).
        for (const order of [group, [...others, e]]) {
          const total = reroute(order);
          if (total < best) {
            best = total;
            bestRoutes = group.map((x) => st.routes.get(x.key).points);
          }
        }
        restore(group, bestRoutes);
        if (bestRoutes !== original) changed = true;
      }
      if (!changed) break;
    }
  }

  function fullPlan(graph, p, style) {
    const { map: geo, half } = shapes(graph, p, style);
    const st = { style, half, geo, ports: assignPorts(graph, geo, p), boxes: new Grid(128), segs: new Grid(64), routes: new Map(), reserved: new Map(), pos: snapshot(graph, p) };
    for (const g of geo.values()) st.boxes.insert(g, g.x1, g.y1, g.x2, g.y2);
    setExtent(st);
    for (const e of graph.edges) reserve(st, e);
    const order = [...graph.edges].sort(priority(st));
    for (const e of order) commit(st, e, routeEdge(e, st));
    improve(st, order);
    placeLabels(st, order);
    return st;
  }

  /** Re-routes only links touching moved nodes, links whose ports shifted and links now blocked. */
  function updatePlan(st, graph, p, moved) {
    const fresh = shapes(graph, p, st.style);
    if (fresh.half !== st.half) return null; // card size changed: everything moves
    for (const key of moved) {
      st.boxes.remove(st.geo.get(key));
      const g = fresh.map.get(key);
      st.geo.set(key, g);
      st.boxes.insert(g, g.x1, g.y1, g.x2, g.y2);
    }
    setExtent(st);
    const ports = assignPorts(graph, st.geo, p), dirty = new Set();
    const same = (a, b) => a.s.x === b.s.x && a.s.y === b.s.y && a.t.x === b.t.x && a.t.y === b.t.y;
    for (const e of graph.edges) if (!same(st.ports.get(e.key), ports.get(e.key))) dirty.add(e.key);
    st.ports = ports;
    for (const key of moved) {
      const g = st.geo.get(key);
      st.segs.query(g.x1, g.y1, g.x2, g.y2, (s) => {
        if (s.x2 > g.x1 && s.x1 < g.x2 && s.y2 > g.y1 && s.y1 < g.y2) dirty.add(s.edge);
      });
    }
    const list = graph.edges.filter((e) => dirty.has(e.key));
    for (const e of list) uncommit(st, e);
    for (const e of list.sort(priority(st))) commit(st, e, routeEdge(e, st));
    improve(st, list);
    placeLabels(st, [...graph.edges].sort(priority(st)));
    st.pos = snapshot(graph, p);
    return st;
  }

  const plans = new WeakMap();
  let lastStyle = 'circle';

  function plan(graph, p, style) {
    let st = plans.get(graph);
    if (st && st.style === style && st.routes.size === graph.edges.length) {
      const moved = graph.nodes.filter((n) => {
        const a = st.pos.get(n.key), b = p[n.key];
        return !a || a.x !== b.x || a.y !== b.y;
      }).map((n) => n.key);
      if (!moved.length) return st;
      if (moved.length <= 3 && moved.length * 4 < graph.nodes.length && updatePlan(st, graph, p, moved)) return st;
    }
    st = fullPlan(graph, p, style);
    plans.set(graph, st);
    return st;
  }

  const labelWidth = (text) => text.length * 6.3 + 6;

  /**
   * Edge labels: candidates above/below the horizontal runs (longest first); the first spot that
   * clears node footprints, earlier labels and other routes wins, else the least bad one.
   */
  function placeLabels(st, list) {
    const placed = new Grid(64);
    st.labels = new Map();
    for (const e of list) {
      if (!e.label) continue;
      const points = st.routes.get(e.key).points, w = labelWidth(e.label), runs = [];
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        if (Math.abs(a.y - b.y) < 0.01) runs.push([Math.min(a.x, b.x), Math.max(a.x, b.x), a.y]);
      }
      if (!runs.length) runs.push([points[0].x, points[0].x, (points[0].y + points[points.length - 1].y) / 2]);
      runs.sort((x, y) => y[1] - y[0] - (x[1] - x[0]));
      let best = null, bestScore = Infinity;
      for (const [x1, x2, y] of runs) {
        const xs = [(x1 + x2) / 2];
        if (x2 - x1 > w + 16) xs.push(x2 - w / 2 - 8, x1 + w / 2 + 8);
        for (const x of xs)
          for (const base of [y - 7, y + 15]) {
            const box = { x1: x - w / 2, x2: x + w / 2, y1: base - 11, y2: base + 3 };
            let score = (x2 - x1 < w ? 30 : 0) + (base > y ? 2 : 0);
            if (box.y1 < EDGE_MARGIN || box.x1 < 4) score += 1000;
            st.boxes.query(box.x1, box.y1, box.x2, box.y2, (g) => {
              if (g.x2 > box.x1 && g.x1 < box.x2 && g.y2 > box.y1 && g.y1 < box.y2) score += 100;
            });
            placed.query(box.x1, box.y1, box.x2, box.y2, (o) => {
              if (o.x2 > box.x1 && o.x1 < box.x2 && o.y2 > box.y1 && o.y1 < box.y2) score += 60;
            });
            st.segs.query(box.x1, box.y1, box.x2, box.y2, (o) => {
              if (o.edge !== e.key && o.x2 > box.x1 && o.x1 < box.x2 && o.y2 > box.y1 && o.y1 < box.y2) score += 4;
            });
            if (score < bestScore) {
              bestScore = score;
              best = { x, y: base, box };
            }
            if (!score) break;
          }
        if (bestScore === 0) break;
      }
      placed.insert(best.box, best.box.x1, best.box.y1, best.box.x2, best.box.y2);
      st.labels.set(e.key, { x: best.x, y: best.y });
    }
  }
  const labelPoint = (st, e) => st.labels.get(e.key) || { x: st.routes.get(e.key).points[0].x, y: st.routes.get(e.key).points[0].y };

  /** Routed polylines: [{key, from, to, points, label: {x, y, text}}] (used by tests and exports). */
  function routes(graph, p, style = lastStyle) {
    const st = plan(graph, p, style);
    return graph.edges.map((e) => {
      const points = st.routes.get(e.key).points;
      return { key: e.key, from: e.from, to: e.to, points, label: { ...labelPoint(st, e), text: e.label || '' } };
    });
  }

  /** SVG size from the real extents of nodes, routes and labels (≥ 16 px margin). */
  function bounds(graph, p, style = lastStyle) {
    const st = plan(graph, p, style);
    let maxX = 0, maxY = 0;
    for (const g of st.geo.values()) {
      maxX = Math.max(maxX, g.x2);
      maxY = Math.max(maxY, g.y2);
    }
    for (const e of graph.edges) {
      const points = st.routes.get(e.key).points;
      for (const pt of points) {
        maxX = Math.max(maxX, pt.x);
        maxY = Math.max(maxY, pt.y);
      }
      if (e.label) {
        const at = labelPoint(st, e);
        maxX = Math.max(maxX, at.x + labelWidth(e.label) / 2);
        maxY = Math.max(maxY, at.y + 4);
      }
    }
    return { width: Math.max(640, Math.ceil(maxX + 24 + EDGE_MARGIN)), height: Math.max(300, Math.ceil(maxY + 24 + EDGE_MARGIN)) };
  }

  // ---------------------------------------------------------------------------------------------
  // Rendering.

  function rounded(points) {
    let d = `M${fixed(points[0].x)} ${fixed(points[0].y)}`;
    for (let i = 1; i < points.length - 1; i++) {
      const a = points[i - 1], b = points[i], c = points[i + 1], l1 = Math.hypot(b.x - a.x, b.y - a.y), l2 = Math.hypot(c.x - b.x, c.y - b.y);
      if (!l1 || !l2) continue;
      const r = Math.min(9, l1 / 3, l2 / 3);
      d += `L${fixed(b.x - ((b.x - a.x) / l1) * r)} ${fixed(b.y - ((b.y - a.y) / l1) * r)}Q${fixed(b.x)} ${fixed(b.y)} ${fixed(b.x + ((c.x - b.x) / l2) * r)} ${fixed(b.y + ((c.y - b.y) / l2) * r)}`;
    }
    const last = points[points.length - 1];
    return d + `L${fixed(last.x)} ${fixed(last.y)}`;
  }

  function edgeMarkup(e, st) {
    const points = st.routes.get(e.key).points, d = rounded(points), label = labelPoint(st, e);
    const lag = e.kind === 'lag', color = e.critical ? '#bd623f' : lag ? '#9a6b1f' : '#7194b9';
    const marker = e.critical ? '-red' : lag ? '-lag' : '';
    return (
      `<g class="graph-edge${e.dummy ? ' graph-dummy' : ''}${lag ? ' graph-lag' : ''}" data-edge-key="${esc(e.key)}">` +
      `<path d="${d}" fill="none" stroke="#fff" stroke-width="5" stroke-linejoin="round"/>` +
      `<path d="${d}" fill="none" stroke="${color}" stroke-width="${e.critical ? 2.7 : 1.6}" stroke-linejoin="round"${e.dummy ? ' stroke-dasharray="6 4"' : ''} marker-end="url(#graph-arrow${marker})"/>` +
      (e.label ? `<text x="${fixed(label.x)}" y="${fixed(label.y)}" text-anchor="middle" font-size="12" fill="${lag ? '#7a5418' : '#385e88'}" stroke="#fff" stroke-width="4" paint-order="stroke">${esc(e.label)}</text>` : '') +
      `</g>`
    );
  }

  function nodeMarkup(n, graph, style, st) {
    const pos = st.geo.get(n.key), critical = graph.kind === 'aoa' ? n.critical || Math.abs(n.early - n.late) < 1e-8 : n.critical;
    const color = critical ? '#bd623f' : '#3b78b2', fill = critical ? '#fff1e9' : '#f0f7fe';
    let content;
    if (graph.kind === 'aoa') {
      content =
        `<circle r="29" fill="${fill}" stroke="${color}" stroke-width="1.7"/><path d="M-28 0H28M0 0V28" stroke="${color}" fill="none"/>` +
        `<text y="-7" text-anchor="middle" font-size="14" font-weight="600" fill="#163f74">${esc(n.label)}</text>` +
        `<text x="-14" y="18" text-anchor="middle" font-size="11" fill="#315c88">${number(n.early)}</text>` +
        `<text x="14" y="18" text-anchor="middle" font-size="11" fill="#315c88">${number(n.late)}</text>`;
    } else if (style === 'card') {
      const h = st.half, chars = Math.max(10, Math.floor((2 * h - 16) / 5.6)), name = n.name || '';
      content =
        `<rect x="${-h}" y="-50" width="${2 * h}" height="110" rx="8" fill="${fill}" stroke="${color}"/>` +
        `<text x="${10 - h}" y="-32" font-size="11" fill="#3e648e">ES ${number(n.es)}</text><text x="${h - 10}" y="-32" text-anchor="end" font-size="11" fill="#3e648e">EF ${number(n.ef)}</text>` +
        `<text y="-11" text-anchor="middle" font-size="15" font-weight="600" fill="#173f73">${esc(n.label)} · ${number(n.duration)}n</text>` +
        `<text y="6" text-anchor="middle" font-size="10" fill="#3e648e">${esc(name.length > chars ? name.slice(0, chars - 1) + '…' : name)}</text>` +
        `<text x="${10 - h}" y="27" font-size="11" fill="#3e648e">LS ${number(n.ls)}</text><text x="${h - 10}" y="27" text-anchor="end" font-size="11" fill="#3e648e">LF ${number(n.lf)}</text>` +
        `<text x="${10 - h}" y="46" font-size="10" fill="#3e648e">TF ${number(n.tf)}</text><text x="${h - 10}" y="46" text-anchor="end" font-size="10" fill="#3e648e">FF ${number(n.ff)}</text>`;
    } else if (n.virtual) {
      content =
        `<circle r="30" fill="${fill}" stroke="${color}" stroke-width="2"/><text y="6" text-anchor="middle" font-size="16" font-weight="600" fill="#173e72">${esc(n.label)}</text>` +
        `<text y="50" text-anchor="middle" font-size="11" fill="#345f8c">${n.key === '@finish' ? 'T = ' + number(n.es) : number(n.es)}</text>`;
    } else {
      const name = n.name || '';
      content =
        `<circle r="30" fill="${fill}" stroke="${color}" stroke-width="2"/><text y="6" text-anchor="middle" font-size="17" font-weight="600" fill="#173e72">${esc(n.label)}</text>` +
        [['ES', n.es, -48, -15], ['EF', n.ef, 48, -15], ['LS', n.ls, -48, 25], ['LF', n.lf, 48, 25]]
          .map(([label, value, x, y]) => `<text x="${x}" y="${y}" text-anchor="middle" font-size="10" fill="#345f8c">${label} ${number(value)}</text>`)
          .join('') +
        `<text y="50" text-anchor="middle" font-size="11" fill="#345f8c">TF ${number(n.tf)} · FF ${number(n.ff)}</text>` +
        `<text y="66" text-anchor="middle" font-size="11" font-weight="600" fill="#315b87">D ${number(n.duration)} · NC ${number(n.workers || 0)}</text>` +
        (name ? `<text y="81" text-anchor="middle" font-size="10" fill="#557493">${esc(name.length > 24 ? name.slice(0, 23) + '…' : name)}</text>` : '');
    }
    const aria = n.virtual ? 'Sự kiện ' + n.label : n.name || 'Sự kiện ' + n.label;
    return `<g class="graph-node" data-node-key="${esc(n.key)}" tabindex="0" role="button" aria-label="${esc(aria)}" transform="translate(${pos.x} ${pos.y})">${content}</g>`;
  }

  const DEFS =
    '<defs>' +
    '<marker id="graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0 0L7 3L0 6z" fill="#7194b9"/></marker>' +
    '<marker id="graph-arrow-red" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0 0L7 3L0 6z" fill="#bd623f"/></marker>' +
    '<marker id="graph-arrow-lag" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0 0L7 3L0 6z" fill="#9a6b1f"/></marker>' +
    '</defs>';

  function contents(graph, p, style = 'circle') {
    lastStyle = style;
    const st = plan(graph, p, style);
    // Critical links are drawn last so they stay on top.
    const edges = [...graph.edges.filter((e) => !e.critical), ...graph.edges.filter((e) => e.critical)];
    return DEFS + edges.map((e) => edgeMarkup(e, st)).join('') + graph.nodes.map((n) => nodeMarkup(n, graph, style, st)).join('');
  }

  function svg(graph, p, style = 'circle', interactive = false) {
    lastStyle = style;
    const b = bounds(graph, p, style);
    return `<svg class="graph-board-svg" data-graph-kind="${graph.kind}" ${interactive ? 'data-draggable-graph="true"' : ''} width="${b.width}" height="${b.height}" viewBox="0 0 ${b.width} ${b.height}" role="img" aria-label="Sơ đồ ${graph.kind.toUpperCase()}">${contents(graph, p, style)}</svg>`;
  }

  function validateLayouts(value) {
    if (value === undefined) return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Bố trí sơ đồ không hợp lệ.');
    for (const key of ['aon', 'aoa'])
      if (value[key]) {
        if (typeof value[key] !== 'object' || Array.isArray(value[key]) || Object.keys(value[key]).length > 800) throw Error('Quá nhiều nút sơ đồ.');
        for (const pos of Object.values(value[key]))
          if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || pos.x < 70 || pos.y < 70 || pos.x > 20000 || pos.y > 20000)
            throw Error('Vị trí nút nằm ngoài vùng cho phép.');
      }
  }

  // ---------------------------------------------------------------------------------------------
  // Cyclogram (tiến độ xiên): time on x, segments on y; each task is a slanted stroke across its
  // segment band, connected to the same process in the next segment by a dashed line.

  function cyclogram(data) {
    const width = 1100, segments = Math.max(1, data.segments), height = Math.max(320, 110 + segments * 70), span = Math.max(1, data.duration);
    const x = (t) => fixed(110 + (t / span) * 910), y = (s) => fixed(height - 50 - (s / segments) * (height - 110));
    const colors = ['#1269b3', '#bd6e45', '#498978', '#7f6aa2', '#a2577a', '#5f7d1e'];
    let out = `<svg class="cyclogram-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Tiến độ xiên">`;
    for (let i = 1; i <= segments; i++) {
      out += `<rect x="100" y="${y(i)}" width="940" height="${fixed(y(i - 1) - y(i))}" fill="${i % 2 ? '#f6f9fc' : '#ffffff'}"/>`;
      out += `<path d="M100 ${y(i)}H1040" stroke="#d9e6f3"/><text x="90" y="${fixed((y(i) + y(i - 1)) / 2 + 4)}" font-size="12" text-anchor="end" fill="#315d8b">PĐ ${i}</text>`;
    }
    out += `<path d="M100 ${y(0)}H1040" stroke="#b9cde2"/>`;
    for (let i = 0; i <= 10; i++) {
      const t = (data.duration * i) / 10;
      out += `<path d="M${x(t)} ${y(segments)}V${y(0)}" stroke="#eef3f8"/><text x="${x(t)}" y="${height - 12}" font-size="11" text-anchor="middle" fill="#456d95">${number(t)}</text>`;
    }
    for (const c of data.conflicts || [])
      out += `<rect class="cyclogram-conflict" x="${x(c.start)}" y="${y(c.segment)}" width="${fixed(Math.max(2, x(c.finish) - x(c.start)))}" height="${fixed(y(c.segment - 1) - y(c.segment))}" fill="#d94a3a" opacity=".16"><title>${esc(c.a + ' / ' + c.b)}</title></rect>`;
    (data.groups || []).forEach((group, gi) => {
      const color = colors[gi % colors.length], lines = group.lines || group.rows.map((t) => ({ id: t.id, segment: t.segment, start: t.es, finish: t.ef }));
      lines.forEach((line, i) => {
        const next = lines[i + 1];
        if (next) out += `<path d="M${x(line.finish)} ${y(line.segment)}L${x(next.start)} ${y(next.segment - 1)}" stroke="${color}" stroke-width="1.2" stroke-dasharray="4 4" fill="none"/>`;
        out += `<path class="cyclogram-line" d="M${x(line.start)} ${y(line.segment - 1)}L${x(line.finish)} ${y(line.segment)}" stroke="${color}" stroke-width="3" stroke-linecap="round" fill="none"/>`;
        out += `<text x="${fixed((x(line.start) + x(line.finish)) / 2 + 5)}" y="${fixed((y(line.segment - 1) + y(line.segment)) / 2)}" font-size="11" fill="${color}" stroke="#fff" stroke-width="3" paint-order="stroke">${esc(line.id)}</text>`;
      });
      const last = lines[lines.length - 1];
      if (last) out += `<text x="${fixed(x(last.finish) + 6)}" y="${fixed(y(last.segment) - 4)}" font-size="12" font-weight="600" fill="${color}">${esc(group.name)}</text>`;
    });
    return out + '</svg>';
  }

  return { build, positions, bounds, contents, svg, validateLayouts, routes, cyclogram };
});
