'use strict';
const assert = require('node:assert/strict');
const CT = require('../engine.js'), G = require('../graph-board.js'), N = require('../networks.js');
const vm = require('node:vm'), fs = require('node:fs'), crypto = require('node:crypto');
const ctx = { window: {}, crypto, CT };
vm.runInNewContext(fs.readFileSync(require.resolve('../samples.js'), 'utf8'), ctx);
const Samples = ctx.window.Samples;

let count = 0;
function test(name, fn) {
  fn();
  count++;
  console.log('✓ ' + name);
}
const task = (id, duration, deps = '') => ({ id, name: 'Công việc ' + id, duration, minDuration: duration, deps: typeof deps === 'string' ? CT.parseDeps(deps) : deps, cost: 0, actualCost: 0, crashSlope: 0, progress: 0, workers: 2 });
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
}
/** Random network; `mixed` adds SS/FF/SF relations. Successors are drawn from the previous 8 tasks. */
function randomTasks(seed, n, mixed) {
  const random = rng(seed), tasks = [];
  for (let i = 0; i < n; i++) {
    const deps = [], used = new Set(), want = i ? 1 + Math.floor(random() * 2.2) : 0;
    for (let j = 0; j < want; j++) {
      const from = i - 1 - Math.floor(random() * Math.min(i, 8));
      if (used.has(from)) continue;
      used.add(from);
      const type = mixed && random() < 0.25 ? ['SS', 'FF', 'SF'][Math.floor(random() * 3)] : 'FS';
      deps.push({ id: 'T' + from, type, lag: random() < 0.2 ? Math.floor(random() * 3) : 0 });
    }
    tasks.push(task('T' + i, 1 + Math.floor(random() * 9), deps));
  }
  return tasks;
}

const segmentsOf = (route) => route.points.slice(1).map((b, i) => {
  const a = route.points[i];
  return { key: route.key, from: route.from, to: route.to, first: i === 0, last: i === route.points.length - 2, h: Math.abs(a.y - b.y) < 0.01, v: Math.abs(a.x - b.x) < 0.01, x1: Math.min(a.x, b.x), x2: Math.max(a.x, b.x), y1: Math.min(a.y, b.y), y2: Math.max(a.y, b.y) };
});

/**
 * Route quality: orthogonal, inside the SVG with label margin, never through a node shape other
 * than the own end stubs (so backward links never cross their target), and no two links sharing a
 * collinear run longer than 4 px, except links of a crowded node side (> 6 links fan into one side).
 */
function checkRoutes(graph, p, style = 'circle') {
  const b = G.bounds(graph, p, style), routes = G.routes(graph, p, style), segs = routes.flatMap(segmentsOf);
  const core = (key) => {
    const q = p[key], aoa = graph.kind === 'aoa', card = style === 'card' && !aoa;
    return card ? { x1: q.x - 66, x2: q.x + 66, y1: q.y - 48, y2: q.y + 58 } : { x1: q.x - (aoa ? 27 : 28), x2: q.x + (aoa ? 27 : 28), y1: q.y - 28, y2: q.y + 28 };
  };
  for (const r of routes) {
    for (const pt of r.points) assert.ok(pt.x >= 16 && pt.y >= 16 && pt.x <= b.width - 16 && pt.y <= b.height - 16, `${r.key} out of bounds ${JSON.stringify(pt)}`);
    if (r.label.text) assert.ok(r.label.y - 12 >= 16 && r.label.y <= b.height - 16, `${r.key} label clipped`);
  }
  for (const s of segs) {
    assert.ok(s.h || s.v, `${s.key} not orthogonal`);
    for (const n of graph.nodes) {
      const c = core(n.key);
      if (!(s.x2 > c.x1 && s.x1 < c.x2 && s.y2 > c.y1 && s.y1 < c.y2)) continue;
      assert.ok((s.first && n.key === s.from) || (s.last && n.key === s.to), `${s.key} passes through ${n.key}`);
    }
  }
  const sideCount = new Map(), bump = (k) => sideCount.set(k, (sideCount.get(k) || 0) + 1);
  for (const e of graph.edges) {
    bump(e.from + (e.type === 'SS' || e.type === 'SF' ? '<' : '>'));
    bump(e.to + (e.type === 'FF' || e.type === 'SF' ? '>' : '<'));
  }
  const crowded = (key, side) => sideCount.get(key + side) > 6;
  const overlaps = [];
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++) {
      const s = segs[i], o = segs[j];
      if (s.key === o.key || s.h !== o.h) continue;
      const gap = s.h ? Math.abs(s.y1 - o.y1) : Math.abs(s.x1 - o.x1);
      const overlap = s.h ? Math.min(s.x2, o.x2) - Math.max(s.x1, o.x1) : Math.min(s.y2, o.y2) - Math.max(s.y1, o.y1);
      if (gap >= 2 || overlap <= 4) continue;
      const fan = (s.to === o.to && (crowded(s.to, '<') || crowded(s.to, '>'))) || (s.from === o.from && (crowded(s.from, '<') || crowded(s.from, '>')));
      if (!fan) overlaps.push(`${s.key} / ${o.key}`);
    }
  assert.deepEqual(overlaps, [], 'collinear overlaps');
  return { bounds: b, routes };
}

test('AON mẫu thi công: mạch găng chính trên một hàng, nhánh trên/dưới, không đổi CPM', () => {
  const tasks = Samples.construction().tasks, s = CT.schedule(tasks), g = G.build(s), p = G.positions(g);
  const spine = ['@start', 'A', 'B', 'C', 'D', 'E', 'F', 'N', 'G', 'H', 'I', 'K', 'L', '@finish'];
  assert.deepEqual([...new Set(spine.map((k) => p[k].y))].length, 1, 'critical chain on one straight row');
  for (let i = 1; i < spine.length; i++) assert.ok(p[spine[i]].x > p[spine[i - 1]].x);
  assert.notEqual(p.M.y, p.A.y);
  assert.notEqual(p.J.y, p.A.y);
  const svg = G.svg(g, p);
  assert.ok(svg.includes('graph-edge') && !svg.includes('NaN') && !svg.includes('C385'));
  assert.equal(s.duration, CT.schedule(tasks).duration);
  checkRoutes(g, p, 'circle');
  checkRoutes(G.build(s, 'aon', { style: 'card' }), G.positions(G.build(s, 'aon', { style: 'card' })), 'card');
  checkRoutes(g, p, 'card'); // card nodes shrink to fit the circle spacing
});

test('AON: I→J SS+3, J→K FF+3, C→M SF+4, M→KT không chồng nhau và không bị cắt ở mép trên', () => {
  const g = G.build(CT.schedule(Samples.construction().tasks)), p = G.positions(g), { routes } = checkRoutes(g, p);
  const pick = (from, to) => routes.find((r) => r.from === from && r.to === to);
  const chosen = [pick('I', 'J'), pick('J', 'K'), pick('C', 'M'), pick('M', '@finish')];
  for (const r of chosen) assert.ok(Math.min(...r.points.map((q) => q.y)) >= 40, r.key + ' too close to the top');
  const runs = chosen.flatMap(segmentsOf).filter((s) => s.h);
  for (let i = 0; i < runs.length; i++)
    for (let j = i + 1; j < runs.length; j++)
      if (runs[i].key !== runs[j].key && Math.abs(runs[i].y1 - runs[j].y1) < 2) assert.ok(Math.min(runs[i].x2, runs[j].x2) - Math.max(runs[i].x1, runs[j].x1) <= 4, `${runs[i].key} overlaps ${runs[j].key}`);
  const labels = chosen.map((r) => r.label.text);
  assert.deepEqual(labels, ['SS+3', 'FF+3', 'SF+4', '']);
  assert.ok(!g.edges.some((e) => e.label === 'FS+0'), 'the default FS+0 relation is not labelled');
});

test('Mũi tên ngược (đích nằm bên trái nguồn) không đi xuyên qua nút đích', () => {
  const g = G.build(CT.schedule(Samples.textbook().tasks)), p = G.positions(g);
  const bottom = Math.max(...g.nodes.map((n) => p[n.key].y));
  p.F = { x: p.A.x - 20, y: bottom + 165 }; // F dragged left of its predecessors C and D
  p.E = { x: p.G.x + 190, y: p.A.y - 165 }; // E dragged right of its successor G
  const { routes } = checkRoutes(g, p);
  for (const r of routes.filter((x) => x.to === 'F')) {
    const last = r.points.at(-1), before = r.points.at(-2);
    assert.ok(before.x < last.x && Math.abs(before.y - last.y) < 0.01, r.key + ' enters F from its left side');
  }
});

test('Bố trí gọn: chuỗi 14 công việc ≤ 190 px/cột; nhánh độc lập dùng chung hàng', () => {
  const chain = Array.from({ length: 14 }, (_, i) => task('C' + i, 2, i ? 'C' + (i - 1) : ''));
  const g = G.build(CT.schedule(chain)), xs = g.nodes.map((n) => n.x).sort((a, b) => a - b);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] <= 190);
  assert.ok(G.bounds(g, G.positions(g)).width <= 16 * 190 + 200);
  assert.equal(new Set(g.nodes.map((n) => n.y)).size, 1);
  const word = G.build(CT.schedule(Samples.group().tasks));
  assert.ok(Math.max(...word.nodes.map((n) => n.y)) <= 500, 'Nhánh độc lập dùng chung hàng khi khác cột');
});

test('Giảm giao cắt: thứ tự nhập không quyết định thứ tự hàng', () => {
  // Input order lists X before Y, but X follows the lower branch and Y the upper one.
  const tasks = [task('A', 2), task('B', 9), task('X', 2, 'B'), task('Y', 2, 'A'), task('Q', 3, 'A'), task('Z', 1, 'X,Y')];
  const g = G.build(CT.schedule(tasks)), p = G.positions(g);
  assert.equal(Math.sign(p.A.y - p.B.y), Math.sign(p.Y.y - p.X.y), 'branches keep their side: no crossing');
  checkRoutes(g, p);
});

test('AOA trên bảng: 7 sự kiện đánh số 1–7, giả nét đứt, chờ có nhãn, khóa vị trí ổn định', () => {
  const tb = Samples.textbook().tasks, g = G.build(CT.schedule(tb), 'aoa'), p = G.positions(g);
  assert.deepEqual(g.nodes.map((n) => n.label), ['1', '2', '3', '4', '5', '6', '7']);
  for (const n of g.nodes) assert.ok(n.key.startsWith('event:'));
  for (const e of g.edges) assert.ok(p[e.from].x < p[e.to].x, 'events left to right');
  assert.deepEqual([...new Set(g.nodes.filter((n) => n.critical).map((n) => p[n.key].y))].length, 1, 'critical events on one row');
  const svg = G.svg(g, p);
  assert.equal((svg.match(/stroke-dasharray="6 4"/g) || []).length, 1);
  assert.ok(svg.includes('D (11, 0)') && !svg.includes('Giả 0'));
  assert.equal((svg.match(/fill="#fff1e9"/g) || []).length, 5, 'critical events filled');
  checkRoutes(g, p);
  // Saved positions follow the event, not its index, when a task is added.
  const saved = { 'event:end:B': { x: 777, y: 333 } };
  const more = G.build(CT.schedule([...tb, task('H', 2, 'B')]), 'aoa');
  assert.deepEqual(G.positions(more, saved)['event:end:B'], { x: 777, y: 333 });
  const lag = G.build(CT.schedule([task('A', 3), task('B', 2, 'A:FS+2')]), 'aoa');
  assert.deepEqual(lag.edges.map((e) => e.label), ['A (3, 2)', 'Chờ 2', 'B (2, 2)']);
  assert.ok(G.svg(lag, G.positions(lag)).includes('graph-lag'));
});

test('Mạng ngẫu nhiên 40–60 công việc (FS và SS/FF/SF): định tuyến hợp lệ cho AON và AOA', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    for (const [n, mixed] of [[40, true], [60, true], [60, false]]) {
      const g = G.build(CT.schedule(randomTasks(seed * 100 + n, n, mixed)));
      checkRoutes(g, G.positions(g));
    }
    const a = G.build(CT.schedule(randomTasks(seed * 7, 50, false)), 'aoa');
    checkRoutes(a, G.positions(a));
  }
});

test('Kéo nút: chỉ định tuyến lại mũi tên liên quan, nhanh với 150 công việc', () => {
  const g = G.build(CT.schedule(Samples.construction().tasks)), p = G.positions(g);
  const before = new Map(G.routes(g, p).map((r) => [r.key, JSON.stringify(r.points)]));
  const old = G.contents(g, p);
  p.M = { x: p.M.x + 40, y: p.M.y + 30 };
  assert.notEqual(G.contents(g, p), old);
  const after = G.routes(g, p);
  for (const r of after) if (r.from === 'M' || r.to === 'M') assert.notEqual(JSON.stringify(r.points), before.get(r.key), r.key + ' re-routed');
  assert.ok(after.filter((r) => JSON.stringify(r.points) === before.get(r.key)).length >= after.length - 4, 'unrelated routes are kept');
  checkRoutes(g, p);
  const big = G.build(CT.schedule(randomTasks(150, 150, true))), q = G.positions(big);
  let t = performance.now();
  G.svg(big, q, 'circle', true);
  const full = performance.now() - t, key = big.nodes[75].key;
  t = performance.now();
  for (let i = 0; i < 10; i++) {
    q[key] = { x: q[key].x + 6, y: q[key].y + 4 };
    G.bounds(big, q);
    G.contents(big, q, 'circle');
  }
  const drag = (performance.now() - t) / 10;
  assert.ok(full < 2000 && drag < 60, `150 tasks: full ${full.toFixed(0)} ms, drag ${drag.toFixed(1)} ms per move`);
  console.log(`  (150 công việc: dựng ${full.toFixed(0)} ms, kéo ${drag.toFixed(1)} ms/lần)`);
});

test('Kiểm tra vị trí lưu và sơ đồ tiến độ xiên', () => {
  assert.throws(() => G.validateLayouts({ aon: { M: { x: NaN, y: 125 } } }));
  const g = G.build(CT.schedule(Samples.construction().tasks));
  G.validateLayouts({ aon: G.positions(g) });
  const tasks = [
    { ...task('A', 2), segment: 1, process: 'Móng' },
    { ...task('B', 2, 'A'), segment: 2, process: 'Móng' },
    { ...task('C', 3, 'A'), segment: 1, process: 'Thân' },
    { ...task('D', 3, 'C,B'), segment: 2, process: 'Thân' },
  ];
  const plan = CT.schedule(tasks);
  plan.rows = plan.rows.map((t) => (t.id === 'D' ? { ...t, es: 3, ef: 6 } : t));
  const svg = G.cyclogram(N.linear(tasks, plan));
  assert.equal((svg.match(/class="cyclogram-line"/g) || []).length, 4);
  assert.ok(svg.includes('cyclogram-conflict') && !svg.includes('NaN'));
  assert.ok(/class="cyclogram-line" d="M\S+ (\S+)L\S+ (\S+)"/.test(svg), 'slanted line across a band');
});

console.log(count + ' nhóm kiểm thử bảng sơ đồ: bố trí phân lớp, định tuyến không chồng/không xuyên nút, AOA, kéo thả nhanh, tiến độ xiên.');
