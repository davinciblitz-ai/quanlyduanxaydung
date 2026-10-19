/*
 * Network diagram logic (plain UMD module, no build step).
 *  - aoa():             textbook activity-on-arrow network built from the FS precedence DAG.
 *  - pert():            three-point estimates scheduled with CPM (fractional durations).
 *  - pertProbability(): project-level Te, σ, completion probability and confidence durations.
 *  - linear():          data for the linear schedule / cyclogram (tiến độ xiên) plus sanity checks.
 *  - layered():         Sugiyama-style layered layout shared with graph-board.js.
 */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./engine.js') : root.CT);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Networks = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (CT) {
  'use strict';

  const EPS = 1e-8;
  const TIME_FIELDS = ['es', 'ef', 'ls', 'lf', 'tf', 'ff'];
  /** Rounds floating-point noise (|x| < 1e-8, including -0) to exactly 0. */
  const tidy = (x) => (typeof x === 'number' && Math.abs(x) < EPS ? 0 : x);

  function validateTasks(tasks) {
    for (const t of tasks) {
      if (t.pert) {
        for (const key of ['a', 'm', 'b']) CT.number(t.pert[key], t.id + ' PERT ' + key, 0, 3650);
        if (t.pert.a > t.pert.m || t.pert.m > t.pert.b) throw Error(t.id + ': PERT cần a ≤ m ≤ b.');
      }
      if (t.segment !== undefined) CT.number(t.segment, t.id + ' phân đoạn', 0, 100, true);
      if (t.process !== undefined && (typeof t.process !== 'string' || t.process.length > 80))
        throw Error(t.id + ': nhóm quá trình không hợp lệ.');
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Small graph helpers (nodes are integers 0..n-1, reachability kept in Uint32 bitsets).

  const words = (n) => (n + 31) >>> 5;
  const hasBit = (set, i) => (set[i >>> 5] >>> (i & 31)) & 1;
  const setBit = (set, i) => {
    set[i >>> 5] |= 1 << (i & 31);
  };

  /** Kahn topological order; succ[u] is any iterable of successor indices. */
  function topological(n, succ) {
    const degree = new Array(n).fill(0);
    for (let u = 0; u < n; u++) for (const v of succ[u]) degree[v]++;
    const order = [];
    for (let u = 0; u < n; u++) if (!degree[u]) order.push(u);
    for (let k = 0; k < order.length; k++) for (const v of succ[order[k]]) if (!--degree[v]) order.push(v);
    if (order.length !== n) throw Error('Quan hệ tạo vòng lặp.');
    return order;
  }

  /** reach[u] = bitset of all nodes reachable from u (u itself excluded). */
  function reachability(n, succ, order) {
    const reach = Array.from({ length: n }, () => new Uint32Array(words(n)));
    for (let k = order.length - 1; k >= 0; k--) {
      const u = order[k];
      for (const v of succ[u]) {
        setBit(reach[u], v);
        const target = reach[u], source = reach[v];
        for (let w = 0; w < target.length; w++) target[w] |= source[w];
      }
    }
    return reach;
  }

  // ---------------------------------------------------------------------------------------------
  // Layered (Sugiyama-style) layout.

  /** Least-squares non-decreasing fit (pool adjacent violators), unit weights. */
  function isotonic(values) {
    const blocks = [];
    for (const v of values) {
      blocks.push({ sum: v, count: 1 });
      while (blocks.length > 1) {
        const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
        if (a.sum / a.count <= b.sum / b.count) break;
        a.sum += b.sum;
        a.count += b.count;
        blocks.pop();
      }
    }
    const out = [];
    for (const b of blocks) for (let i = 0; i < b.count; i++) out.push(b.sum / b.count);
    return out;
  }

  /**
   * Integer rows r0 < r1 < ... (gap ≥ 1) closest to `want`, with r0 ≥ lo and r_last ≤ hi.
   * Substituting u_i = r_i − i turns the gap constraint into "u non-decreasing" (isotonic fit).
   */
  function fitRows(want, lo, hi) {
    const k = want.length;
    if (!k) return [];
    return isotonic(want.map((w, i) => w - i)).map((u, i) => {
      let x = Math.round(u);
      if (x < lo) x = lo;
      if (x > hi - (k - 1)) x = hi - (k - 1);
      return x + i;
    });
  }

  /**
   * Sugiyama-style layout of a DAG.
   * @param ids     node ids (any Map-able value), input order is used for tie-breaking
   * @param links   [{from, to}]
   * @param options.spine  ids of a path that should sit on one straight row (row 0)
   * @returns {layer: Map id→int, row: Map id→int, layers: [[ids top→bottom]], crossings}
   * Longest-path layering, dummy vertices for long links, barycentre sweeps + adjacent
   * transpositions for crossing reduction, then integer rows: the spine on row 0 and every other
   * node pulled toward the mean row of its neighbours while keeping the crossing-reduced order.
   */
  function layered(ids, links, options = {}) {
    const n = ids.length, index = new Map();
    ids.forEach((id, i) => index.set(id, i));
    const out = ids.map(() => []), inn = ids.map(() => []), linked = new Set();
    for (const link of links) {
      const a = index.get(link.from), b = index.get(link.to);
      if (a === undefined || b === undefined || a === b || linked.has(a + ':' + b)) continue;
      linked.add(a + ':' + b);
      out[a].push(b);
      inn[b].push(a);
    }
    const result = { layer: new Map(), row: new Map(), layers: [], crossings: 0 };
    if (!n) return result;

    // 1. Longest-path layering.
    const layer = new Array(n).fill(0);
    for (const u of topological(n, out)) for (const v of out[u]) layer[v] = Math.max(layer[v], layer[u] + 1);
    const L = Math.max(...layer) + 1;

    // Spine: keep the longest prefix whose layers strictly increase.
    const spine = [];
    for (const id of options.spine || []) {
      const i = index.get(id);
      if (i === undefined || (spine.length && layer[i] <= layer[spine[spine.length - 1]])) break;
      spine.push(i);
    }
    const onSpine = new Set(spine), spinePairs = new Set();
    for (let k = 1; k < spine.length; k++) spinePairs.add(spine[k - 1] + ':' + spine[k]);

    // 2. Proper layered graph: long links are split by dummy vertices (used for ordering only).
    const vLayer = layer.slice(), vReal = ids.map((_, i) => i), vSpine = ids.map((_, i) => onSpine.has(i));
    const up = ids.map(() => []), down = ids.map(() => []);
    const chain = (a, b, isSpine) => {
      let prev = a;
      for (let l = layer[a] + 1; l < layer[b]; l++) {
        const d = vLayer.length;
        vLayer.push(l);
        vReal.push(-1);
        vSpine.push(isSpine);
        up.push([prev]);
        down.push([]);
        down[prev].push(d);
        prev = d;
      }
      down[prev].push(b);
      up[b].push(prev);
    };
    for (let a = 0; a < n; a++) for (const b of out[a]) chain(a, b, spinePairs.has(a + ':' + b));
    // Consecutive spine nodes without a direct link still reserve row 0 between them.
    for (const key of spinePairs) if (!linked.has(key)) chain(...key.split(':').map(Number), true);

    // 3. Ordering. Initial order: depth-first from the sources in input order.
    const total = vLayer.length, pos = new Float64Array(total);
    let layers = Array.from({ length: L }, () => []);
    const visited = new Uint8Array(total), stack = [];
    for (let s = n - 1; s >= 0; s--) if (!up[s].length) stack.push(s);
    while (stack.length) {
      const v = stack.pop();
      if (visited[v]) continue;
      visited[v] = 1;
      layers[vLayer[v]].push(v);
      for (let k = down[v].length - 1; k >= 0; k--) if (!visited[down[v][k]]) stack.push(down[v][k]);
    }
    const sync = () => layers.forEach((list) => list.forEach((v, i) => (pos[v] = i)));
    sync();

    const crossings = () => {
      let count = 0;
      for (let l = 0; l + 1 < L; l++) {
        const pairs = [];
        for (const u of layers[l]) for (const v of down[u]) pairs.push([pos[u], pos[v]]);
        pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        // Count inversions of the lower endpoints with a Fenwick tree.
        const size = layers[l + 1].length, tree = new Int32Array(size + 1);
        pairs.forEach(([, v], seen) => {
          let notAbove = 0;
          for (let i = v + 1; i > 0; i -= i & -i) notAbove += tree[i];
          count += seen - notAbove;
          for (let i = v + 1; i <= size; i += i & -i) tree[i]++;
        });
      }
      return count;
    };
    const sweep = (downward) => {
      for (let step = 1; step < L; step++) {
        const l = downward ? step : L - 1 - step, list = layers[l];
        const ref = downward ? up : down, refSize = layers[downward ? l - 1 : l + 1].length || 1;
        const key = new Map();
        for (const v of list) {
          const nb = ref[v];
          key.set(v, nb.length ? nb.reduce((s, u) => s + (pos[u] + 0.5) / refSize, 0) / nb.length : (pos[v] + 0.5) / list.length);
        }
        list.sort((a, b) => key.get(a) - key.get(b) || pos[a] - pos[b]);
        list.forEach((v, i) => (pos[v] = i));
      }
    };
    // Crossings between the links of u and w (u placed left of w) toward both neighbour layers.
    const pairCost = (u, w) => {
      let c = 0;
      for (const a of up[u]) for (const b of up[w]) if (pos[a] > pos[b]) c++;
      for (const a of down[u]) for (const b of down[w]) if (pos[a] > pos[b]) c++;
      return c;
    };
    const transpose = () => {
      for (let round = 0; round < 6; round++) {
        let improved = false;
        for (const list of layers)
          for (let i = 0; i + 1 < list.length; i++) {
            const u = list[i], w = list[i + 1], before = pairCost(u, w), after = pairCost(w, u), centre = (list.length - 1) / 2;
            // On a tie, move the spine element toward the middle so branches spread above and below.
            const closer = (from, to) => Math.abs(to - centre) < Math.abs(from - centre);
            const balance = after === before && ((vSpine[u] && closer(i, i + 1)) || (vSpine[w] && closer(i + 1, i)));
            if (after < before || balance) {
              list[i] = w;
              list[i + 1] = u;
              pos[w] = i;
              pos[u] = i + 1;
              improved = true;
            }
          }
        if (!improved) break;
      }
    };
    transpose();
    let best = layers.map((list) => list.slice()), bestCount = crossings();
    for (let iter = 0; iter < 10 && bestCount > 0; iter++) {
      sweep(iter % 2 === 0);
      transpose();
      const c = crossings();
      if (c < bestCount) {
        bestCount = c;
        best = layers.map((list) => list.slice());
      }
    }
    layers = best;
    sync();

    // 4. Integer rows. Only real nodes and spine placeholders occupy rows.
    const row = new Float64Array(total);
    const slots = layers.map((list) => list.filter((v) => vReal[v] >= 0 || vSpine[v]));
    const pinned = slots.map((list) => list.findIndex((v) => vSpine[v]));
    slots.forEach((list, l) => {
      const centre = pinned[l] >= 0 ? pinned[l] : Math.floor((list.length - 1) / 2);
      list.forEach((v, i) => (row[v] = i - centre));
    });
    for (let iter = 0; iter < 9; iter++) {
      const mode = iter % 3; // 0: predecessors, 1: successors, 2: both
      for (let step = 0; step < L; step++) {
        const l = mode === 1 ? L - 1 - step : step, list = slots[l];
        if (!list.length) continue;
        const want = list.map((v) => {
          const r = vReal[v];
          if (r < 0) return 0;
          const nb = mode === 0 ? inn[r] : mode === 1 ? out[r] : inn[r].concat(out[r]);
          return nb.length ? nb.reduce((s, u) => s + row[u], 0) / nb.length : row[v];
        });
        const s = pinned[l];
        const rows = s < 0 ? fitRows(want, -Infinity, Infinity) : [...fitRows(want.slice(0, s), -Infinity, -1), 0, ...fitRows(want.slice(s + 1), 1, Infinity)];
        list.forEach((v, i) => (row[v] = rows[i]));
      }
    }

    for (let i = 0; i < n; i++) {
      result.layer.set(ids[i], layer[i]);
      result.row.set(ids[i], row[i]);
    }
    result.layers = slots.map((list) => list.filter((v) => vReal[v] >= 0).map((v) => ids[vReal[v]]));
    result.crossings = bestCount;
    return result;
  }

  // ---------------------------------------------------------------------------------------------
  // AOA (activity on arrow).

  /**
   * Builds a textbook AOA network from FS relations (lag ≥ 0).
   * Steps: transitive reduction of the precedence DAG → activities with the same successor set
   * share an end event, activities with the same predecessor set share a start event → each
   * predecessor set is covered by as few dummy sources as possible (other predecessor sets that
   * are subsets, or single end groups) → end/start events are merged where safe → redundant dummies
   * removed → parallel arrows split with one dummy. A positive FS lag becomes a "waiting" activity
   * arrow (kind 'lag'), never a dummy. Events are numbered 1..n in layout order, so tail < head.
   *
   * @returns {nodes: [{id, key, label, early, late, level, row, critical, ends, starts}],
   *           arrows: [{from, to, key, kind: 'activity'|'lag'|'dummy', task, name?, workers?,
   *                     after?, before?, duration, dummy, critical, es, ef, ls, lf, tf, ff}],
   *           duration, schedule, events, dummies}
   */
  function aoa(tasks) {
    const r = CT.schedule(tasks);
    const unsupported = r.edges.filter((e) => e.type !== 'FS' || e.lag < 0);
    if (unsupported.length)
      throw Error(
        'AOA cổ điển chỉ biểu diễn trực tiếp FS với lag không âm. Các quan hệ ' +
          unsupported.map((e) => e.from + '→' + e.to + ' ' + e.type + (e.lag >= 0 ? '+' : '') + e.lag).join(', ') +
          ' được giữ nguyên trong AON/PDM.',
      );
    const rowById = new Map(r.rows.map((t) => [t.id, t]));

    // Activities: every task plus one waiting activity per FS relation with a positive lag.
    const acts = [], at = new Map(), links = [];
    for (const id of r.order) {
      const t = rowById.get(id);
      at.set(id, acts.length);
      acts.push({ id, kind: 'activity', duration: t.duration, es: t.es, lf: t.lf, row: t });
    }
    for (const e of r.edges) {
      if (e.lag > 0) {
        const id = 'lag:' + e.from + '>' + e.to; // ':' never appears in task ids
        at.set(id, acts.length);
        acts.push({ id, kind: 'lag', duration: e.lag, es: rowById.get(e.from).ef, lf: rowById.get(e.to).ls, after: e.from, before: e.to });
        links.push([at.get(e.from), at.get(id)], [at.get(id), at.get(e.to)]);
      } else links.push([at.get(e.from), at.get(e.to)]);
    }
    for (const a of acts) a.tf = tidy(a.lf - a.es - a.duration);

    const n = acts.length;
    if (!n)
      return {
        nodes: [{ id: 1, key: 'event:source', label: '1', early: 0, late: 0, level: 0, row: 0, critical: true, ends: [], starts: [] }],
        arrows: [],
        duration: r.duration,
        schedule: r,
        events: 1,
        dummies: 0,
      };

    const succ = acts.map(() => new Set()), pred = acts.map(() => new Set());
    for (const [a, b] of links) {
      succ[a].add(b);
      pred[b].add(a);
    }
    const order = topological(n, succ);
    const reach = reachability(n, succ, order);

    // 1. Transitive reduction: a → b is implied when b is reachable through another successor of a.
    //    With lag ≥ 0 and durations ≥ 0 the implied path is never shorter, so CPM times are kept.
    for (const a of order)
      for (const b of [...succ[a]])
        for (const c of succ[a])
          if (c !== b && hasBit(reach[c], b)) {
            succ[a].delete(b);
            pred[b].delete(a);
            break;
          }

    // 2. Groups: identical successor sets share an end event, identical predecessor sets share a
    //    start event. Every predecessor set is a union of whole end groups.
    const setKey = (set) => [...set].sort((x, y) => x - y).join(',');
    const endGroups = new Map(), startGroups = new Map(), endOf = [], startOf = [];
    for (const a of order) {
      const ek = setKey(succ[a]), sk = setKey(pred[a]);
      if (!endGroups.has(ek)) endGroups.set(ek, { uses: [], event: null });
      if (!startGroups.has(sk)) startGroups.set(sk, { preds: [...pred[a]], pieces: [], event: null });
      endOf[a] = endGroups.get(ek);
      startOf[a] = startGroups.get(sk);
    }
    const starts = [...startGroups.values()];
    for (const q of starts) q.groups = new Set(q.preds.map((a) => endOf[a]));
    starts.sort((x, y) => x.groups.size - y.groups.size);

    // 3. Cover each predecessor set with few dummy sources. A smaller predecessor set's start event
    //    may feed a larger one (it is reached by exactly its own groups); otherwise single end events.
    for (const q of starts) {
      if (!q.groups.size) continue;
      const left = new Set(q.groups);
      const subsets = starts.filter((o) => o !== q && o.groups.size >= 2 && o.groups.size < q.groups.size && [...o.groups].every((g) => q.groups.has(g)));
      for (;;) {
        let pick = null, gain = 1;
        for (const o of subsets) {
          let k = 0;
          for (const g of o.groups) if (left.has(g)) k++;
          if (k > gain) {
            gain = k;
            pick = o;
          }
        }
        if (!pick) break;
        q.pieces.push({ start: pick });
        for (const g of pick.groups) left.delete(g);
      }
      // Drop subset pieces that later picks made redundant.
      for (let i = 0; i < q.pieces.length; i++) {
        const others = new Set(left);
        q.pieces.forEach((piece, j) => j !== i && piece.start.groups.forEach((g) => others.add(g)));
        if ([...q.pieces[i].start.groups].every((g) => others.has(g))) q.pieces.splice(i--, 1);
      }
      for (const g of left) q.pieces.push({ end: g });
    }

    // 4. Events and safe merges of an end event with a start event.
    const events = [];
    const newEvent = () => {
      const ev = { index: events.length };
      events.push(ev);
      return ev;
    };
    for (const q of starts) for (const piece of q.pieces) if (piece.end) piece.end.uses.push(q);
    // (b) the predecessor set is exactly one end group → that end event is the start event.
    for (const q of starts) if (q.pieces.length === 1 && q.pieces[0].end && !q.pieces[0].end.event) q.event = q.pieces[0].end.event = newEvent();
    // (a) an end event that feeds exactly one start event can be that start event.
    for (const g of endGroups.values()) if (!g.event && g.uses.length === 1 && !g.uses[0].event) g.event = g.uses[0].event = newEvent();
    for (const g of endGroups.values()) if (!g.event) g.event = newEvent();
    for (const q of starts) if (!q.event) q.event = newEvent();

    let arrows = order.map((a) => ({ act: a, from: startOf[a].event, to: endOf[a].event, dummy: false }));
    const seenDummy = new Set();
    for (const q of starts)
      for (const piece of q.pieces) {
        const from = (piece.end || piece.start).event, to = q.event, key = from.index + '>' + to.index;
        if (from === to || seenDummy.has(key)) continue;
        seenDummy.add(key);
        arrows.push({ act: -1, from, to, dummy: true });
      }

    // 5. Remove dummies implied by another path (keeps reachability between events unchanged).
    {
      const outs = events.map(() => []);
      for (const x of arrows) outs[x.from.index].push(x);
      const next = outs.map((list) => list.map((x) => x.to.index));
      const reachE = reachability(events.length, next, topological(events.length, next));
      arrows = arrows.filter((x) => !x.dummy || !outs[x.from.index].some((y) => y !== x && (y.to === x.to || hasBit(reachE[y.to.index], x.to.index))));
    }

    // 6. Parallel activities between the same two events: keep the most critical one, give the
    //    others their own head event plus one dummy.
    const byPair = new Map();
    for (const x of arrows)
      if (!x.dummy) {
        const key = x.from.index + '>' + x.to.index;
        if (!byPair.has(key)) byPair.set(key, []);
        byPair.get(key).push(x);
      }
    for (const list of byPair.values()) {
      if (list.length < 2) continue;
      const rank = (x) => acts[x.act];
      list.sort((x, y) => rank(x).tf - rank(y).tf || (rank(x).kind === 'lag') - (rank(y).kind === 'lag') || rank(y).duration - rank(x).duration || x.act - y.act);
      for (const x of list.slice(1)) {
        const ev = newEvent();
        arrows.push({ act: -1, from: ev, to: x.to, dummy: true });
        x.to = ev;
      }
    }

    // 7. Event times: TE_j = max(TE_i + d), TL_i = min(TL_j − d).
    const E = events.length, outs = events.map(() => []), ins = events.map(() => []);
    for (const x of arrows) {
      x.duration = x.dummy ? 0 : acts[x.act].duration;
      outs[x.from.index].push(x);
      ins[x.to.index].push(x);
    }
    const evOrder = topological(E, outs.map((list) => list.map((x) => x.to.index)));
    const source = evOrder.find((v) => !ins[v].length), sink = evOrder.find((v) => !outs[v].length);
    const te = new Float64Array(E), tl = new Float64Array(E).fill(Infinity);
    for (const v of evOrder) for (const x of outs[v]) te[x.to.index] = Math.max(te[x.to.index], te[v] + x.duration);
    for (let k = E - 1; k >= 0; k--) {
      const v = evOrder[k];
      tl[v] = outs[v].length ? Math.min(...outs[v].map((x) => tl[x.to.index] - x.duration)) : te[sink];
    }
    const slack = (x) => tl[x.to.index] - te[x.from.index] - x.duration;

    // 8. Layout order → numbering. Spine = critical chain with the most real activities.
    const score = new Float64Array(E).fill(-Infinity), back = new Array(E).fill(null);
    score[source] = 0;
    for (const v of evOrder) {
      if (score[v] === -Infinity) continue;
      for (const x of outs[v])
        if (Math.abs(slack(x)) < 1e-9 && score[v] + (x.dummy ? 1 : 1000) > score[x.to.index]) {
          score[x.to.index] = score[v] + (x.dummy ? 1 : 1000);
          back[x.to.index] = x;
        }
    }
    const spine = [];
    for (let v = sink; v !== null; v = back[v] ? back[v].from.index : null) spine.unshift(v);
    if (spine[0] !== source) spine.length = 0;
    const lay = layered(evOrder, arrows.map((x) => ({ from: x.from.index, to: x.to.index })), { spine });
    const sorted = [...evOrder].sort((a, b) => lay.layer.get(a) - lay.layer.get(b) || lay.row.get(a) - lay.row.get(b));
    const num = new Array(E);
    sorted.forEach((v, i) => (num[v] = i + 1));

    // Stable layout keys: activities ending at the event (or starting there if none end there).
    const endsAt = events.map(() => []), startsAt = events.map(() => []);
    for (const x of arrows)
      if (!x.dummy) {
        endsAt[x.to.index].push(acts[x.act].id);
        startsAt[x.from.index].push(acts[x.act].id);
      }
    const keyOf = (v) =>
      v === source ? 'event:source' : v === sink ? 'event:sink' : endsAt[v].length ? 'event:end:' + [...endsAt[v]].sort().join(',') : 'event:start:' + [...startsAt[v]].sort().join(',');

    const nodes = sorted.map((v) => ({
      id: num[v],
      key: keyOf(v),
      label: String(num[v]),
      early: tidy(te[v]),
      late: tidy(tl[v]),
      level: lay.layer.get(v),
      row: lay.row.get(v),
      critical: Math.abs(te[v] - tl[v]) < 1e-9,
      ends: endsAt[v].slice().sort(),
      starts: startsAt[v].slice().sort(),
    }));
    const result = arrows
      .map((x) => {
        const i = x.from.index, j = x.to.index, tf = tidy(slack(x)), base = {
          from: num[i],
          to: num[j],
          duration: x.duration,
          dummy: x.dummy,
          critical: Math.abs(tf) < 1e-9,
          es: tidy(te[i]),
          ef: tidy(te[i] + x.duration),
          ls: tidy(tl[j] - x.duration),
          lf: tidy(tl[j]),
          tf,
          ff: tidy(te[j] - te[i] - x.duration),
        };
        if (x.dummy) return { ...base, kind: 'dummy', task: '', key: 'dummy:' + keyOf(i) + '>' + keyOf(j) };
        const a = acts[x.act];
        if (a.kind === 'lag') return { ...base, kind: 'lag', task: '', after: a.after, before: a.before, key: a.id };
        return { ...base, kind: 'activity', task: a.id, name: a.row.name, workers: a.row.workers, key: 'task:' + a.id };
      })
      .sort((x, y) => x.from - y.from || x.to - y.to);
    return { nodes, arrows: result, duration: r.duration, schedule: r, events: nodes.length, dummies: result.filter((x) => x.dummy).length };
  }

  // ---------------------------------------------------------------------------------------------
  // PERT.

  /** Standard normal CDF Φ(x) (Hart 1968 / West 2005; double-precision accuracy). */
  function normalCdf(x) {
    const z = Math.abs(x);
    let c = 0;
    if (z <= 37) {
      const e = Math.exp((-z * z) / 2);
      if (z < 7.07106781186547) {
        let n = 3.52624965998911e-2 * z + 0.700383064443688;
        n = n * z + 6.37396220353165;
        n = n * z + 33.912866078383;
        n = n * z + 112.079291497871;
        n = n * z + 221.213596169931;
        n = n * z + 220.206867912376;
        let d = 8.83883476483184e-2 * z + 1.75566716318264;
        d = d * z + 16.064177579207;
        d = d * z + 86.7807322029461;
        d = d * z + 296.564248779674;
        d = d * z + 637.333633378831;
        d = d * z + 793.826512519948;
        d = d * z + 440.413735824752;
        c = (e * n) / d;
      } else {
        let b = z + 0.65;
        b = z + 4 / b;
        b = z + 3 / b;
        b = z + 2 / b;
        b = z + 1 / b;
        c = e / b / 2.506628274631;
      }
    }
    return x > 0 ? 1 - c : c;
  }

  /** Inverse standard normal CDF (Acklam's rational approximation + one Halley step). */
  function normalInv(p) {
    if (!(p > 0 && p < 1)) return p === 0 ? -Infinity : p === 1 ? Infinity : NaN;
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const tail = (q) => (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    let x;
    if (p < 0.02425) x = tail(Math.sqrt(-2 * Math.log(p)));
    else if (p > 1 - 0.02425) x = -tail(Math.sqrt(-2 * Math.log(1 - p)));
    else {
      const q = p - 0.5, r = q * q;
      x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    }
    const u = (normalCdf(x) - p) * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
    return x - u / (1 + (x * u) / 2);
  }

  /**
   * Expected durations te = (a + 4m + b) / 6 and variances ((b − a) / 6)², scheduled with CPM.
   * Rows have floating-point noise (|x| < 1e-8, -0) rounded to 0. `project` holds
   * pertProbability() without a target.
   */
  function pert(tasks) {
    validateTasks(tasks);
    const variance = {};
    const work = tasks.map((t) => {
      const p = t.pert || { a: t.duration, m: t.duration, b: t.duration }, duration = (p.a + 4 * p.m + p.b) / 6;
      variance[t.id] = ((p.b - p.a) / 6) ** 2;
      return { ...t, duration, minDuration: duration };
    });
    const result = CT.schedule(work, { fractional: true });
    const rows = result.rows.map((row) => {
      const copy = { ...row };
      for (const key of TIME_FIELDS) copy[key] = tidy(copy[key]);
      return copy;
    });
    const edges = result.edges.map((e) => ({ ...e, slack: tidy(e.slack) }));
    const estimate = { ...result, rows, edges, variance, deterministic: work.every((t) => variance[t.id] === 0) };
    estimate.project = pertProbability(estimate);
    return estimate;
  }

  /**
   * Project-level PERT analysis.
   * @param input   tasks (array, estimated with pert()) or a pert() result
   * @param target  optional deadline T
   * @returns {te, variance, sigma, path, paths, target, z, probability, p90, p95,
   *           nearCritical, nonFs, warnings}
   *   variance = Σσ² along the critical path (largest-variance path when several tie);
   *   z = (T − te)/σ, probability = Φ(z) (null without target); p90/p95 = te + z·σ.
   */
  function pertProbability(input, target) {
    const est = Array.isArray(input) ? pert(input) : input;
    if (!est || !Array.isArray(est.rows) || !Array.isArray(est.edges) || !est.variance) throw Error('Thiếu kết quả PERT.');
    const hasTarget = target !== undefined && target !== null && target !== '';
    if (hasTarget) CT.number(target, 'Thời hạn mục tiêu', 0, 1e6);
    const rows = new Map(est.rows.map((t) => [t.id, t])), te = est.duration, tol = 1e-6;
    const order = est.order || est.rows.map((t) => t.id);
    const incoming = new Map();
    for (const e of est.edges) if (e.critical) (incoming.get(e.to) || incoming.set(e.to, []).get(e.to)).push(e);

    // Longest-variance chain of critical relations from a task starting at 0 to one finishing at te.
    const best = new Map(), parent = new Map(), ways = new Map();
    for (const id of order) {
      const t = rows.get(id);
      if (!t || !t.critical) continue;
      let value = -Infinity, from = null, count = 0;
      if (Math.abs(t.es) < tol) {
        value = 0;
        count = 1;
      }
      for (const e of incoming.get(id) || []) {
        if (!best.has(e.from)) continue;
        count += ways.get(e.from);
        if (best.get(e.from) > value + 1e-12) {
          value = best.get(e.from);
          from = e.from;
        }
      }
      if (value === -Infinity) continue;
      best.set(id, value + (est.variance[id] || 0));
      parent.set(id, from);
      ways.set(id, count);
    }
    let end = null, paths = 0;
    for (const id of order)
      if (best.has(id) && Math.abs(rows.get(id).ef - te) < tol) {
        paths += ways.get(id);
        if (end === null || best.get(id) > best.get(end) + 1e-12) end = id;
      }
    const path = [];
    for (let id = end; id !== null && id !== undefined; id = parent.get(id)) path.unshift(id);
    const variance = end === null ? 0 : tidy(best.get(end)), sigma = Math.sqrt(variance);

    const nonFs = est.edges.some((e) => e.type !== 'FS');
    const nearCritical = sigma > 0 ? est.rows.filter((t) => t.tf > tol && t.tf <= sigma + tol).map((t) => t.id) : [];
    const warnings = [];
    if (nonFs) warnings.push('Mạng có quan hệ SS/FF/SF: PERT cổ điển chỉ cộng phương sai theo chuỗi FS nên xác suất chỉ mang tính tham khảo và thường lạc quan.');
    if (paths > 1) warnings.push('Có ' + paths + ' đường găng; đã lấy đường có phương sai lớn nhất (' + path.join('–') + '). Xác suất thực tế thấp hơn giá trị PERT cổ điển.');
    if (nearCritical.length)
      warnings.push('Có công việc gần găng (dự trữ ≤ 1σ ≈ ' + Math.round(sigma * 100) / 100 + ' ngày): ' + nearCritical.join(', ') + '. Xác suất PERT cổ điển có thể lạc quan.');

    let z = null, probability = null;
    if (hasTarget) {
      if (sigma > 0) {
        z = (target - te) / sigma;
        probability = normalCdf(z);
      } else probability = target >= te - tol ? 1 : 0;
    }
    return {
      te,
      variance,
      sigma,
      path,
      paths,
      target: hasTarget ? target : null,
      z,
      probability,
      p90: te + normalInv(0.9) * sigma,
      p95: te + normalInv(0.95) * sigma,
      nearCritical,
      nonFs,
      warnings,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Linear schedule / cyclogram.

  /**
   * Groups tasks that have a segment (phân đoạn) and a process (quá trình).
   * @param tasks     tasks or schedule rows (segment/process are read from here)
   * @param computed  optional already-computed schedule ({rows, duration}) or rows array, e.g. an
   *                  applied resource-levelled plan; when given, its es/ef are used as-is.
   * @returns {rows, groups: [{name, rows, lines: [{id, segment, start, finish, from:{t,s}, to:{t,s}}]}],
   *           duration, segments, order, warnings, conflicts, orderIssues}
   *   A line runs from (start, segment − 1) to (finish, segment): a slanted stroke across the band.
   */
  function linear(tasks, computed) {
    validateTasks(tasks);
    let source, duration;
    if (computed) {
      const given = Array.isArray(computed) ? computed : computed.rows;
      if (!Array.isArray(given)) throw Error('Lịch đã tính không hợp lệ.');
      const byId = new Map(given.map((t) => [t.id, t]));
      source = tasks.map((t) => {
        const c = byId.get(t.id);
        if (!c || !Number.isFinite(c.es) || !Number.isFinite(c.ef)) throw Error(t.id + ': lịch đã tính thiếu ES/EF.');
        const copy = { ...t };
        for (const key of [...TIME_FIELDS, 'critical']) if (c[key] !== undefined) copy[key] = c[key];
        return copy;
      });
      duration = Number.isFinite(computed.duration) ? computed.duration : Math.max(0, ...source.map((t) => t.ef));
    } else {
      const r = CT.schedule(tasks);
      source = r.rows;
      duration = r.duration;
    }
    const rows = source.filter((t) => t.segment > 0 && t.process?.trim()), groups = new Map();
    for (const t of rows) {
      const key = t.process.trim();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    for (const list of groups.values()) {
      const seen = new Set();
      for (const t of list) {
        if (seen.has(t.segment)) throw Error('Quá trình ' + t.process + ' có hai công tác cùng phân đoạn ' + t.segment + '.');
        seen.add(t.segment);
      }
      list.sort((a, b) => a.segment - b.segment);
    }
    // Reference process order: by earliest start (then input order).
    const names = [...groups.keys()];
    const firstStart = (name) => Math.min(...groups.get(name).map((t) => t.es));
    const orderNames = names.slice().sort((a, b) => firstStart(a) - firstStart(b) || names.indexOf(a) - names.indexOf(b));
    const rank = new Map(orderNames.map((name, i) => [name, i]));

    const warnings = [], conflicts = [], orderIssues = [];
    const segments = Math.max(0, ...rows.map((t) => t.segment));
    for (let s = 1; s <= segments; s++) {
      const here = rows.filter((t) => t.segment === s);
      // 1. Same process order in every segment.
      const actual = here.slice().sort((a, b) => a.es - b.es || a.ef - b.ef || rank.get(a.process.trim()) - rank.get(b.process.trim())).map((t) => t.process.trim());
      const expected = actual.slice().sort((a, b) => rank.get(a) - rank.get(b));
      if (actual.join('\n') !== expected.join('\n')) {
        orderIssues.push({ segment: s, expected, actual });
        warnings.push('Phân đoạn ' + s + ': thứ tự quá trình ' + actual.join(' → ') + ' khác thứ tự chung ' + expected.join(' → ') + '.');
      }
      // 2. Two processes working in the same segment at the same time (EF is exclusive).
      for (let i = 0; i < here.length; i++)
        for (let j = i + 1; j < here.length; j++) {
          const a = here[i], b = here[j], start = Math.max(a.es, b.es), finish = Math.min(a.ef, b.ef);
          if (finish - start > EPS) {
            conflicts.push({ segment: s, a: a.id, b: b.id, start, finish });
            warnings.push('Phân đoạn ' + s + ': ' + a.process.trim() + ' (' + a.id + ') và ' + b.process.trim() + ' (' + b.id + ') thi công đồng thời từ ngày ' + start + ' đến ' + finish + '.');
          }
        }
    }
    return {
      rows,
      groups: orderNames.map((name) => ({
        name,
        rows: groups.get(name),
        lines: groups.get(name).map((t) => ({ id: t.id, segment: t.segment, start: t.es, finish: t.ef, from: { t: t.es, s: t.segment - 1 }, to: { t: t.ef, s: t.segment } })),
      })),
      duration,
      segments,
      order: orderNames,
      warnings,
      conflicts,
      orderIssues,
    };
  }

  return { aoa, pert, pertProbability, linear, validateTasks, layered, normalCdf, normalInv };
});
