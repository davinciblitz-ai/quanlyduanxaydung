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
  // Circle rows leave room for a two-line task name under the node plus a few routing lanes.
  const LAYOUT = {
    circle: { col: 190, row: 175, left: 110, top: 125 },
    card: { col: 265, row: 150, left: 130, top: 125 },
    aoa: { col: 165, row: 115, left: 90, top: 100 },
  };
  const TRACK_X = 7; // spacing of parallel vertical rails
  const TRACK_Y = 9; // spacing of parallel horizontal lanes
  const CLEAR = 6; // minimum gap between a node footprint and a rail
  const TOP_LABELLED = 40; // highest lane for an edge with a label (label sits ~16 px above it)
  const TOP_PLAIN = 24;
  const EDGE_MARGIN = 16;
  // Arrowheads have a fixed size (markerUnits="userSpaceOnUse"), so the ports of one node side are
  // spaced at least PORT_GAP apart and two arrowheads entering the same side never touch.
  const HEAD = { normal: { len: 9, half: 4 }, critical: { len: 10, half: 4.5 } };
  const PORT_GAP = 11;
  const NEAR_PORT = 3 * TRACK_X + CLEAR; // a crossing this close to where a link leaves/enters a node is confusing
  const PORT_CROSS = 600;

  // ---------------------------------------------------------------------------------------------
  // Node text (shared by the footprint/label-avoidance geometry and the markup).

  /** Task name shown under the node; '' when it only repeats the id (exercise tasks named "A"). */
  const shownName = (n) => {
    const name = String(n.name ?? '').trim();
    return name && name !== String(n.id ?? n.label ?? '').trim() ? name : '';
  };

  /** Word-wrapped lines of at most `max` characters; an ellipsis only when more than `count` lines are needed. */
  function wrapName(text, max, count = 2) {
    const words = String(text).split(/\s+/).filter(Boolean), lines = [];
    let line = '';
    for (let word of words) {
      while (word.length > max) {
        // A single word longer than a line (rare): break it hard.
        if (line) lines.push(line);
        lines.push(word.slice(0, max - 1) + '-');
        word = word.slice(max - 1);
        line = '';
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= max) line += ' ' + word;
      else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    if (lines.length <= count) return lines;
    const kept = lines.slice(0, count), last = kept[count - 1];
    kept[count - 1] = (last.length >= max ? last.slice(0, max - 1).trimEnd() : last) + '…';
    return kept;
  }

  const NAME_CHARS = 24; // circle style: characters per name line (font-size 10, ≈ 134 px)
  const textWidth = (text, size) => String(text).length * size * 0.56;

  /** Circle-style task node: the four corner values, the float line, the duration line and the name. */
  function circleText(n) {
    return {
      corners: [['ES', n.es, -50, -19], ['EF', n.ef, 50, -19], ['LS', n.ls, -50, 29], ['LF', n.lf, 50, 29]].map(([label, value, x, y]) => [label + ' ' + number(value), x, y]),
      float: `TF ${number(n.tf)} · FF ${number(n.ff)}`,
      // "3 ngày · 8 người": never the bare letter "D" (it reads like activity D) nor "NC".
      duration: `${number(n.duration)} ngày${n.crew === false ? '' : ' · ' + number(n.workers || 0) + ' người'}`,
      name: wrapName(shownName(n), NAME_CHARS),
    };
  }

  /** Card-style header and name lines for a card of half-width h. */
  function cardText(n, h) {
    const head = `${n.label} · ${number(n.duration)}`, room = 2 * h - 20;
    return {
      head: textWidth(head + ' ngày', 15) <= room ? head + ' ngày' : head + ' ng',
      name: wrapName(shownName(n), Math.max(10, Math.floor((2 * h - 16) / 5.6))),
    };
  }

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

  // (thời lượng, người/ngày); dự án không nhập nhân công thì chỉ ghi thời lượng.
  const arrowLabel = (a, crew) =>
    a.kind === 'dummy' ? '' : a.kind === 'lag' ? 'Chờ ' + number(a.duration) : a.task + ' (' + number(a.duration) + (crew ? ', ' + number(a.workers || 0) : '') + ')';

  function buildAoa(schedule) {
    const g = Networks.aoa(schedule.rows), grid = LAYOUT.aoa, keyOf = new Map(g.nodes.map((n) => [n.id, n.key]));
    const minRow = Math.min(0, ...g.nodes.map((n) => n.row));
    const nodes = g.nodes.map((n) => ({ ...n, x: grid.left + n.level * grid.col, y: grid.top + (n.row - minRow) * grid.row }));
    const crew = schedule.rows.some((t) => t.workers > 0);
    const edges = g.arrows.map((a) => ({ ...a, event: { from: a.from, to: a.to }, from: keyOf.get(a.from), to: keyOf.get(a.to), label: arrowLabel(a, crew) }));
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
    const crew = schedule.rows.some((t) => t.workers > 0);
    const nodes = [terminal('@start', 'BĐ', 0), ...schedule.rows.map((t) => ({ ...t, key: t.id, label: t.id, crew })), terminal('@finish', 'KT', T)];
    // The default relation FS+0 is implied by the arrow itself; label only lags and SS/FF/SF.
    const edges = schedule.edges.map((e, i) => ({ ...e, key: 'edge:' + i, label: e.type === 'FS' && e.lag === 0 ? '' : e.type + (e.lag >= 0 ? '+' : '') + e.lag }));
    const hasIn = new Set(schedule.edges.map((e) => e.to)), hasOut = new Set(schedule.edges.map((e) => e.from));
    // A critical task that starts later than its predecessors allow is held by a start constraint
    // (resource levelling in an applied plan). It is drawn as a dashed "wait" link from BĐ with
    // its reason, never as a critical dependency with a lag.
    const release = (t) => ({ label: (schedule.resourceAware ? 'Chờ nhân lực · bắt đầu ngày ' : 'Ràng buộc bắt đầu ngày ') + number(t.es), release: true, critical: false });
    for (const t of schedule.rows) {
      if (!hasIn.has(t.id)) edges.push({ key: 'start:' + t.id, from: '@start', to: t.id, label: '', critical: t.critical && t.es === 0, ...(t.critical && t.es > 0 ? release(t) : {}) });
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
    // A task whose start follows a drawn relation exactly (slack 0, e.g. after a finished,
    // non-critical predecessor) is not held by a constraint: no wait link for it.
    const tight = new Set(schedule.edges.filter((e) => Number.isFinite(e.slack) && e.slack <= 0).map((e) => e.to));
    for (const t of schedule.rows)
      if (t.critical && !criticalEdges.some((e) => e.to === t.id) && !edges.some((e) => e.from === '@start' && e.to === t.id) && !(t.es > 0 && tight.has(t.id)))
        edges.push({ key: 'release:' + t.id, from: '@start', to: t.id, ...(t.es > 0 ? release(t) : { label: '', critical: true }) });
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
      else {
        // Circle + ES/EF/LS/LF labels (ports stay between the label rows, |dy| ≤ 15), then the
        // TF line, the duration line and up to two name lines.
        const lines = circleText(n).name.length;
        s = { l: 68, r: 68, t: 36, b: lines > 1 ? 98 : lines ? 86 : 72, radius: 30, band: 15 };
      }
      map.set(n.key, { key: n.key, node: n, x, y, x1: x - s.l, x2: x + s.r, y1: y - s.t, y2: y + s.b, radius: s.radius || 0, side: s.side || 0, band: s.band });
    }
    return { map, half };
  }

  /** Absolute rectangles covered by a node's own drawing and text (edge labels must stay clear). */
  function inkOf(g, kind, style, half) {
    if (g.ink) return g.ink;
    const n = g.node, box = (text, size, x, y) => {
      const w = textWidth(text, size);
      return [x - w / 2 - 2, y - size * 0.8 - 1, x + w / 2 + 2, y + 3];
    };
    let list;
    if (kind === 'aoa') list = [[-30, -30, 30, 30]];
    else if (style === 'card') list = [[-half - 1, -51, half + 1, 61]];
    else if (n.virtual) list = [[-31, -31, 31, 31], box('T = ' + number(n.es), 11, 0, 50)];
    else {
      const t = circleText(n);
      list = [[-31, -31, 31, 31], ...t.corners.map(([text, x, y]) => box(text, 10, x, y)), box(t.float, 11, 0, 50), box(t.duration, 11.5, 0, 66), ...t.name.map((line, i) => box(line, 10, 0, 81 + 12 * i))];
    }
    return (g.ink = list.map(([x1, y1, x2, y2]) => ({ x1: g.x + x1, y1: g.y + y1, x2: g.x + x2, y2: g.y + y2 })));
  }

  /**
   * Port points. Each node side spreads its links vertically (sorted by the y each route heads to
   * after its stub — the other end's y until routes exist — so links of one side do not cross at
   * the stub); the link to a level neighbour keeps offset 0. Ports are PORT_GAP apart when the
   * side's band allows it.
   * @param heading optional (edgeKey, end) → y of the route's first/last turn, or undefined
   */
  function assignPorts(graph, geo, p, heading = null) {
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
        for (const item of list) {
          const h = heading ? heading(item.e.key, item.end) : undefined;
          item.toward = Number.isFinite(h) ? h : p[item.other].y;
        }
        // Same heading: outgoing and incoming links stay grouped so one link's stub never sits
        // between another link's stub and its rail.
        list.sort((a, b) => a.toward - b.toward || p[a.other].y - p[b.other].y || (a.end === b.end ? 0 : a.end === 's' ? -1 : 1) || p[a.other].x - p[b.other].x || (a.e.key < b.e.key ? -1 : 1));
        let centre = -1, nearest = Infinity;
        list.forEach((item, i) => {
          const o = p[item.other];
          if (item.straight && Math.abs(o.y - node.y) < 0.5 && Math.abs(o.x - node.x) < nearest) {
            nearest = Math.abs(o.x - node.x);
            centre = i;
          }
        });
        if (centre < 0) centre = (list.length - 1) / 2;
        const reach = Math.max(centre, list.length - 1 - centre), step = reach ? Math.min(PORT_GAP, node.band / reach) : 0, dir = side === 'R' ? 1 : -1;
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
    const n = points.length, A = st.geo.get(ctx.from), B = st.geo.get(ctx.to);
    // Footprint edge where the route leaves its source / reaches its target (see anchorsOf).
    const fromAnchor = A && n > 1 ? (points[1].x >= points[0].x ? A.x2 : A.x1) : undefined;
    const toAnchor = B && n > 1 ? (points[n - 1].x >= points[n - 2].x ? B.x1 : B.x2) : undefined;
    for (let i = 1; i < points.length; i++) {
      const s = segment(points[i - 1], points[i]), first = i === 1, last = i === points.length - 1;
      const anchors = s.h ? [first ? fromAnchor : undefined, last ? toAnchor : undefined].filter((a) => a !== undefined) : [];
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
          if (vs.x1 > hs.x1 + 1 && vs.x1 < hs.x2 - 1 && hs.y1 > vs.y1 + 1 && hs.y1 < vs.y2 - 1) {
            // A crossing right next to a port makes it unclear which arrowhead belongs to which link.
            const near = (list) => list && list.some((a) => Math.abs(vs.x1 - a) < NEAR_PORT);
            penalty += near(s.h ? anchors : o.anchors) ? PORT_CROSS : 40;
          }
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

    // (D) Wrapped report layout only (fitWidth), for a link spanning several bands: around the
    // right of every node — exit → X1 → lane next to the source → gutter G → lane next to the
    // target → X2 → entry.
    if (st.wrapped && bestPenalty >= 500) {
      const gutter = st.maxX + CLEAR, X1 = dS > 0 ? A.x2 + CLEAR + TRACK_X : A.x1 - CLEAR - TRACK_X, X2 = dT > 0 ? B.x1 - CLEAR - TRACK_X : B.x2 + CLEAR + TRACK_X;
      const lanes = (node, X) => {
        const list = freeIntervals(st, false, Math.min(node.x1, X) - 20, gutter + 60, ctx.top, st.maxY + 2000);
        const above = list.filter((c) => c[1] <= node.y1 + 0.01).pop(), under = list.find((c) => c[0] >= node.y2 - 0.01);
        return [above, under].filter(Boolean);
      };
      for (const c1 of lanes(A, X1))
        for (const c2 of lanes(B, X2)) {
          const x1 = tracks(st, true, s.y, (c1[0] + c1[1]) / 2, X1, dS > 0 ? X1 : X1 - 60, dS > 0 ? X1 + 60 : X1, 0, stubCheck(st, s.y, s.x, Math.min(X1, X1 + dS * 60), Math.max(X1, X1 + dS * 60)))[0];
          const x2 = tracks(st, true, t.y, (c2[0] + c2[1]) / 2, X2, dT > 0 ? X2 - 60 : X2, dT > 0 ? X2 : X2 + 60, 0, stubCheck(st, t.y, t.x, Math.min(X2, X2 - dT * 60), Math.max(X2, X2 - dT * 60)))[0];
          const lane = (c, xa) => tracks(st, false, xa, gutter, c[1] > st.maxY + 100 ? c[0] + TRACK_Y : (c[0] + c[1]) / 2, c[0] + 3, Math.min(c[1], st.maxY + 400) - 3)[0];
          const Y1 = lane(c1, x1), Y2 = lane(c2, x2), G = tracks(st, true, Y1, Y2, gutter + TRACK_X, gutter, gutter + 400, 1)[0];
          consider([s, { x: x1, y: s.y }, { x: x1, y: Y1 }, { x: G, y: Y1 }, { x: G, y: Y2 }, { x: x2, y: Y2 }, { x: x2, y: t.y }, t]);
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
    out.anchors = [q.dirS > 0 ? A.x2 : A.x1];
    into.anchors = [q.dirT > 0 ? B.x1 : B.x2];
    for (const s of [out, into]) st.segs.insert(s, s.x1, s.y1, s.x2, s.y2);
    st.reserved.set(e.key, [out, into]);
  }

  function unreserve(st, key) {
    for (const s of st.reserved.get(key) || []) st.segs.remove(s);
    st.reserved.delete(key);
  }

  function commit(st, e, points) {
    unreserve(st, e.key);
    const segs = [], n = points.length, A = st.geo.get(e.from), B = st.geo.get(e.to);
    for (let i = 1; i < points.length; i++) {
      const s = segment(points[i - 1], points[i], e.key);
      s.first = i === 1;
      s.last = i === points.length - 1;
      if (s.h) s.anchors = [...(s.first ? [points[1].x >= points[0].x ? A.x2 : A.x1] : []), ...(s.last ? [points[n - 1].x >= points[n - 2].x ? B.x1 : B.x2] : [])];
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
    st.maxX = Math.max(...[...st.geo.values()].map((g) => g.x2));
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

  const samePort = (a, b) => a.s.x === b.s.x && a.s.y === b.s.y && a.t.x === b.t.x && a.t.y === b.t.y;

  /** y of each route's first turn after its source stub ('|s') and last turn before its target stub ('|t'). */
  function headingsOf(st, edges) {
    const map = new Map();
    for (const e of edges) {
      const pts = st.routes.get(e.key).points;
      if (pts.length < 3) continue; // straight link: sorted by the other end
      map.set(e.key + '|s', pts[2].y);
      map.set(e.key + '|t', pts[pts.length - 3].y);
    }
    return map;
  }

  function routeAll(graph, p, style, headings) {
    const { map: geo, half } = shapes(graph, p, style);
    const heading = headings ? (key, end) => headings.get(key + '|' + end) : null;
    const st = { style, half, kind: graph.kind, wrapped: wrappedLayouts.has(p), geo, headings, ports: assignPorts(graph, geo, p, heading), boxes: new Grid(128), segs: new Grid(64), routes: new Map(), reserved: new Map(), pos: snapshot(graph, p) };
    for (const g of geo.values()) st.boxes.insert(g, g.x1, g.y1, g.x2, g.y2);
    setExtent(st);
    for (const e of graph.edges) reserve(st, e);
    const order = [...graph.edges].sort(priority(st));
    for (const e of order) commit(st, e, routeEdge(e, st));
    improve(st, order);
    st.order = order;
    return st;
  }

  const totalCost = (st, edges) => edges.reduce((sum, e) => sum + cost(st.routes.get(e.key).points, contextOf(e), st).total, 0);

  /**
   * Routes everything with ports sorted by the other end; then, when the routes head elsewhere
   * (detours above/below), sorts each side's ports by the routes' real headings and routes again,
   * keeping the cheaper result. Deterministic.
   */
  function fullPlan(graph, p, style) {
    let st = routeAll(graph, p, style, null);
    const headings = headingsOf(st, graph.edges), trial = assignPorts(graph, st.geo, p, (key, end) => headings.get(key + '|' + end));
    if (graph.edges.some((e) => !samePort(st.ports.get(e.key), trial.get(e.key)))) {
      const again = routeAll(graph, p, style, headings);
      if (totalCost(again, graph.edges) < totalCost(st, graph.edges)) st = again;
    }
    placeLabels(st, st.order);
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
    // Keep the heading order the current ports were assigned with; links of moved nodes fall back
    // to the other end's y.
    const movedSet = new Set(moved), touching = new Set(graph.edges.filter((e) => movedSet.has(e.from) || movedSet.has(e.to)).map((e) => e.key));
    const heading = st.headings ? (key, end) => (touching.has(key) ? undefined : st.headings.get(key + '|' + end)) : null;
    const ports = assignPorts(graph, st.geo, p, heading), dirty = new Set();
    for (const e of graph.edges) if (!samePort(st.ports.get(e.key), ports.get(e.key))) dirty.add(e.key);
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
  const wrappedLayouts = new WeakSet(); // positions returned by fitWidth (banded report layout)
  let lastStyle = 'circle';

  function plan(graph, p, style) {
    let st = plans.get(graph);
    if (st && st.style === style && st.routes.size === graph.edges.length && st.wrapped === wrappedLayouts.has(p)) {
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

  const overlaps = (a, b) => a.x2 > b.x1 && a.x1 < b.x2 && a.y2 > b.y1 && a.y1 < b.y2;

  /** Box around the (fixed-size) arrowhead at the end of a route, with a 2 px margin. */
  function headBox(points, e) {
    const tip = points[points.length - 1], prev = points[points.length - 2] || tip, size = e.critical ? HEAD.critical : HEAD.normal, pad = 2;
    const dx = Math.sign(tip.x - prev.x), dy = Math.sign(tip.y - prev.y);
    if (dx || !dy) {
      const x0 = tip.x - (dx || 1) * size.len;
      return { x1: Math.min(x0, tip.x) - pad, x2: Math.max(x0, tip.x) + pad, y1: tip.y - size.half - pad, y2: tip.y + size.half + pad };
    }
    const y0 = tip.y - dy * size.len;
    return { x1: tip.x - size.half - pad, x2: tip.x + size.half + pad, y1: Math.min(y0, tip.y) - pad, y2: Math.max(y0, tip.y) + pad };
  }

  /**
   * Edge labels. Candidates: above/below the horizontal runs (longest first; the run into the
   * target is shortened by the arrowhead), then beside the vertical runs, then further out. The
   * first spot that clears node footprints, node text, arrowheads, earlier labels and other routes
   * wins, else the least bad one; covering node text (ES/EF/LS/LF, TF, duration, name) or an
   * arrowhead is penalised far more than sitting in a node's empty footprint.
   */
  function placeLabels(st, list) {
    const placed = new Grid(64), heads = new Grid(64);
    st.labels = new Map();
    for (const e of list) {
      const box = headBox(st.routes.get(e.key).points, e);
      heads.insert(box, box.x1, box.y1, box.x2, box.y2);
    }
    for (const e of list) {
      if (!e.label) continue;
      const points = st.routes.get(e.key).points, w = labelWidth(e.label), runs = [], candidates = [];
      const head = (e.critical ? HEAD.critical : HEAD.normal).len + 4;
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        if (Math.abs(a.y - b.y) >= 0.01) continue;
        let x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
        if (i === points.length - 1) {
          if (b.x > a.x) x2 = Math.max(x1, x2 - head);
          else x1 = Math.min(x2, x1 + head);
        }
        runs.push([x1, x2, a.y]);
      }
      if (!runs.length) runs.push([points[0].x, points[0].x, (points[0].y + points[points.length - 1].y) / 2]);
      runs.sort((x, y) => y[1] - y[0] - (x[1] - x[0]));
      for (const [x1, x2, y] of runs) {
        const xs = [(x1 + x2) / 2], short = x2 - x1 < w ? 30 : 0;
        if (x2 - x1 > w + 16) xs.push(x2 - w / 2 - 8, x1 + w / 2 + 8);
        for (const x of xs) candidates.push({ x, base: y - 7, extra: short }, { x, base: y + 15, extra: short + 2 });
      }
      // Beside vertical runs (e.g. a link that drops into its target with only a short stub).
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i], y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
        if (Math.abs(a.x - b.x) >= 0.01 || y2 - y1 < 30) continue;
        for (const y of [(y1 + y2) / 2, y1 + (y2 - y1) / 4, y2 - (y2 - y1) / 4])
          for (const side of [1, -1]) candidates.push({ x: a.x + side * (w / 2 + 6), base: y + 4, extra: 3 });
      }
      for (const [x1, x2, y] of runs.slice(0, 2)) for (const base of [y - 19, y + 27]) candidates.push({ x: (x1 + x2) / 2, base, extra: 8 + (x2 - x1 < w ? 30 : 0) });
      let best = null, bestScore = Infinity;
      for (const c of candidates) {
        const box = { x1: c.x - w / 2, x2: c.x + w / 2, y1: c.base - 11, y2: c.base + 3 };
        let score = c.extra;
        if (box.y1 < EDGE_MARGIN || box.x1 < 4) score += 1000;
        st.boxes.query(box.x1, box.y1, box.x2, box.y2, (g) => {
          if (!overlaps(g, box)) return;
          score += 100;
          for (const r of inkOf(g, st.kind, st.style, st.half)) if (overlaps(r, box)) score += 400;
        });
        heads.query(box.x1, box.y1, box.x2, box.y2, (h) => {
          if (overlaps(h, box)) score += 150;
        });
        placed.query(box.x1, box.y1, box.x2, box.y2, (o) => {
          if (overlaps(o, box)) score += 60;
        });
        st.segs.query(box.x1, box.y1, box.x2, box.y2, (o) => {
          if (overlaps(o, box)) score += o.edge !== e.key ? 4 : 6; // own bends too
        });
        if (score < bestScore) {
          bestScore = score;
          best = { x: c.x, y: c.base, box };
        }
        if (!score) break;
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

  /** Rank columns of a layout: nodes sharing an x (auto layout); a dragged node forms its own. */
  function columnsOf(graph, p) {
    const keys = graph.nodes.map((n) => n.key).sort((a, b) => p[a].x - p[b].x || p[a].y - p[b].y || (a < b ? -1 : 1)), cols = [];
    for (const key of keys) {
      const last = cols[cols.length - 1];
      if (last && p[key].x - last.x < 1) last.keys.push(key);
      else cols.push({ x: p[key].x, keys: [key] });
    }
    return cols;
  }

  /** Greedy bands of consecutive columns whose x-span stays within `limit`. */
  function bandsOf(cols, limit) {
    const bands = [];
    for (const col of cols) {
      const band = bands[bands.length - 1];
      if (band && col.x - band[0].x <= limit) band.push(col);
      else bands.push([col]);
    }
    return bands;
  }

  /**
   * Report layout for a very wide network (static export): when the laid-out width exceeds
   * maxWidth by more than 10 %, the left-to-right rank columns are re-flowed into stacked bands
   * ("continued rows") of at most maxWidth each, in reading order — band 1 left → right, then band 2
   * below it, … — so the start stays first and the finish last. Rows keep their relative height
   * inside a band (the critical chain stays on one line per band); the gap between bands leaves
   * lanes for the links that continue into the next band. Deterministic.
   * @param options {maxWidth = 1450, style = the style last rendered ('circle' | 'card')}
   * @returns positions with the same keys (the input object itself when it already fits)
   */
  function fitWidth(graph, p, options = {}) {
    const maxWidth = Number(options.maxWidth) > 0 ? Number(options.maxWidth) : 1450, style = options.style || lastStyle;
    const before = bounds(graph, p, style);
    if (before.width <= maxWidth * 1.1) return p;
    const cols = columnsOf(graph, p);
    if (cols.length < 3) return p;
    const st = plan(graph, p, style), geo = [...st.geo.values()];
    const first = cols[0].x, last = cols[cols.length - 1].x, total = last - first, pad = 4 * TRACK_X;
    const half = Math.max(...geo.map((g) => g.x2 - g.x));
    // Room right of a band's last column: its node, the rails of links leaving it and the margin.
    const right = Math.max(before.width - last, half + 24 + EDGE_MARGIN) + 6 * TRACK_X;
    // Route/label extent above the top row and below the bottom row of the original layout.
    let minY = Infinity, maxY = -Infinity;
    for (const e of graph.edges) {
      for (const pt of st.routes.get(e.key).points) {
        minY = Math.min(minY, pt.y);
        maxY = Math.max(maxY, pt.y);
      }
      if (e.label) minY = Math.min(minY, labelPoint(st, e).y - 12);
    }
    const above = Math.max(0, Math.min(...geo.map((g) => g.y1)) - minY), below = Math.max(0, maxY - Math.max(...geo.map((g) => g.y2)));
    const widest = Math.max(...cols.slice(1).map((c, i) => c.x - cols[i].x));
    let limit = Math.max(widest, maxWidth - first - pad - right), result = p;
    for (let attempt = 0; attempt < 4; attempt++) {
      // Balanced bands: the smallest span that still needs no more bands than the limit allows.
      const count = bandsOf(cols, limit).length;
      let span = Math.max(widest, total / count);
      while (bandsOf(cols, span).length > count) span += 5;
      const bands = bandsOf(cols, span), bandOf = new Map();
      bands.forEach((band, i) => band.forEach((col) => col.keys.forEach((key) => bandOf.set(key, i))));
      const q = Object.create(null);
      let bottom = -Infinity;
      bands.forEach((band, i) => {
        const keys = band.flatMap((col) => col.keys), boxes = keys.map((key) => st.geo.get(key));
        const top = Math.min(...boxes.map((g) => g.y1)), low = Math.max(...boxes.map((g) => g.y2));
        let dy = 0;
        if (i) {
          // Links continuing from earlier bands into this one or later ones each need a lane.
          const crossing = graph.edges.filter((e) => Math.min(bandOf.get(e.from), bandOf.get(e.to)) < i && Math.max(bandOf.get(e.from), bandOf.get(e.to)) >= i);
          const labelled = crossing.some((e) => e.label) ? 18 : 0;
          dy = bottom + Math.max(70, Math.min(above, 70) + Math.min(below, 70) + crossing.length * TRACK_Y + labelled + 2 * CLEAR) - top;
        }
        for (const key of keys) q[key] = { x: fixed(first + pad + p[key].x - band[0].x), y: fixed(p[key].y + dy) };
        bottom = low + dy;
      });
      result = q;
      wrappedLayouts.add(q);
      const after = bounds(graph, q, style);
      if (after.width <= maxWidth * 1.05 || count >= cols.length) break;
      limit = Math.max(widest, limit - (after.width - maxWidth) - TRACK_X);
    }
    return result;
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
    const points = st.routes.get(e.key).points, d = rounded(points);
    // A release link (BĐ → task held by levelling / a start constraint) is a dashed "wait" link
    // like an AOA lag arrow, never a solid critical dependency.
    const lag = e.kind === 'lag' || e.release === true, color = e.critical ? '#bd623f' : lag ? '#9a6b1f' : '#7194b9';
    const marker = e.critical ? '-red' : lag ? '-lag' : '';
    const dash = e.dummy ? ' stroke-dasharray="6 4"' : e.release ? ' stroke-dasharray="5 4"' : '';
    return (
      `<g class="graph-edge${e.dummy ? ' graph-dummy' : ''}${lag ? ' graph-lag' : ''}${e.release ? ' graph-release' : ''}" data-edge-key="${esc(e.key)}">` +
      `<path d="${d}" fill="none" stroke="#fff" stroke-width="5" stroke-linejoin="round"/>` +
      `<path d="${d}" fill="none" stroke="${color}" stroke-width="${e.critical ? 2.7 : 1.6}" stroke-linejoin="round"${dash} marker-end="url(#graph-arrow${marker})"/>` +
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
      const h = st.half, text = cardText(n, h), two = text.name.length > 1;
      content =
        `<rect x="${-h}" y="-50" width="${2 * h}" height="110" rx="8" fill="${fill}" stroke="${color}"/>` +
        `<text x="${10 - h}" y="-32" font-size="11" fill="#3e648e">ES ${number(n.es)}</text><text x="${h - 10}" y="-32" text-anchor="end" font-size="11" fill="#3e648e">EF ${number(n.ef)}</text>` +
        `<text y="-11" text-anchor="middle" font-size="15" font-weight="600" fill="#173f73">${esc(text.head)}</text>` +
        (text.name.length ? `<text y="${two ? 3 : 6}" text-anchor="middle" font-size="10" fill="#3e648e">${text.name.map((line, i) => `<tspan x="0"${i ? ' dy="12"' : ''}>${esc(line)}</tspan>`).join('')}</text>` : '') +
        `<text x="${10 - h}" y="27" font-size="11" fill="#3e648e">LS ${number(n.ls)}</text><text x="${h - 10}" y="27" text-anchor="end" font-size="11" fill="#3e648e">LF ${number(n.lf)}</text>` +
        `<text x="${10 - h}" y="46" font-size="10" fill="#3e648e">TF ${number(n.tf)}</text><text x="${h - 10}" y="46" text-anchor="end" font-size="10" fill="#3e648e">FF ${number(n.ff)}</text>`;
    } else if (n.virtual) {
      content =
        `<circle r="30" fill="${fill}" stroke="${color}" stroke-width="2"/><text y="6" text-anchor="middle" font-size="16" font-weight="600" fill="#173e72">${esc(n.label)}</text>` +
        `<text y="50" text-anchor="middle" font-size="11" fill="#345f8c">T = ${number(n.es)}</text>`;
    } else {
      const text = circleText(n);
      content =
        `<circle r="30" fill="${fill}" stroke="${color}" stroke-width="2"/><text y="6" text-anchor="middle" font-size="17" font-weight="600" fill="#173e72">${esc(n.label)}</text>` +
        text.corners.map(([value, x, y]) => `<text x="${x}" y="${y}" text-anchor="middle" font-size="10" fill="#345f8c">${value}</text>`).join('') +
        `<text y="50" text-anchor="middle" font-size="11" fill="#345f8c">${text.float}</text>` +
        `<text y="66" text-anchor="middle" font-size="11" font-weight="600" fill="#315b87">${text.duration}</text>` +
        (text.name.length ? `<text y="81" text-anchor="middle" font-size="10" fill="#557493">${text.name.map((line, i) => `<tspan x="0"${i ? ' dy="12"' : ''}>${esc(line)}</tspan>`).join('')}</text>` : '');
    }
    // Full task name on hover (the drawn name may be wrapped or, beyond two lines, shortened).
    const name = graph.kind === 'aoa' || n.virtual ? '' : shownName(n);
    const title = n.virtual || graph.kind === 'aoa' ? 'Sự kiện ' + n.label : name ? n.label + ' · ' + name : n.label;
    const aria = n.virtual ? 'Sự kiện ' + n.label : n.name || 'Sự kiện ' + n.label;
    return `<g class="graph-node" data-node-key="${esc(n.key)}" tabindex="0" role="button" aria-label="${esc(aria)}" transform="translate(${pos.x} ${pos.y})"><title>${esc(title)}</title>${content}</g>`;
  }

  // Fixed-size arrowheads (user space, not scaled by the stroke width): see HEAD and PORT_GAP.
  const DEFS =
    '<defs>' +
    '<marker id="graph-arrow" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0 0L9 4L0 8z" fill="#7194b9"/></marker>' +
    '<marker id="graph-arrow-red" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="9" refX="10" refY="4.5" orient="auto"><path d="M0 0L10 4.5L0 9z" fill="#bd623f"/></marker>' +
    '<marker id="graph-arrow-lag" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0 0L9 4L0 8z" fill="#9a6b1f"/></marker>' +
    '</defs>';

  // Nhãn quan hệ (FS+1, SS+5…) vẽ thành một lớp riêng trên mọi đường nối để không đường nào che mất chữ.
  function edgeLabelMarkup(e, st) {
    if (!e.label) return '';
    const label = labelPoint(st, e), lag = e.kind === 'lag' || e.release === true;
    return `<text class="graph-edge-label" data-edge-label="${esc(e.key)}" x="${fixed(label.x)}" y="${fixed(label.y)}" text-anchor="middle" font-size="12" fill="${lag ? '#7a5418' : '#385e88'}" stroke="#fff" stroke-width="4" paint-order="stroke">${esc(e.label)}</text>`;
  }
  function contents(graph, p, style = 'circle') {
    lastStyle = style;
    const st = plan(graph, p, style);
    // Critical links are drawn last so they stay on top.
    const edges = [...graph.edges.filter((e) => !e.critical), ...graph.edges.filter((e) => e.critical)];
    return DEFS + edges.map((e) => edgeMarkup(e, st)).join('') + `<g class="graph-edge-labels">${edges.map((e) => edgeLabelMarkup(e, st)).join('')}</g>` + graph.nodes.map((n) => nodeMarkup(n, graph, style, st)).join('');
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

  return { build, positions, bounds, fitWidth, contents, svg, validateLayouts, routes, cyclogram };
});
