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
  assert.ok(svg.includes('D (11)') && !svg.includes('D (11, 0)') && !svg.includes('Giả 0'));
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

/** ES/EF/LS/LF text rectangles of a circle-style task node (as drawn by nodeMarkup). */
const cornerBoxes = (g, p) => g.nodes.filter((n) => !n.virtual).flatMap((n) => [['ES', n.es, -50, -19], ['EF', n.ef, 50, -19], ['LS', n.ls, -50, 29], ['LF', n.lf, 50, 29]].map(([k, v, x, y]) => {
  const w = (k + ' ' + v).length * 5.6;
  return { what: n.key + ' ' + k, x1: p[n.key].x + x - w / 2, x2: p[n.key].x + x + w / 2, y1: p[n.key].y + y - 9, y2: p[n.key].y + y + 2 };
}));
const hit = (a, b) => a.x2 > b.x1 && a.x1 < b.x2 && a.y2 > b.y1 && a.y1 < b.y2;
const labelBox = (r) => {
  const w = r.label.text.length * 6.3 + 6;
  return { x1: r.label.x - w / 2, x2: r.label.x + w / 2, y1: r.label.y - 11, y2: r.label.y + 3 };
};

test('Nút mạng: tên đầy đủ xuống dòng, "3 ngày · 8 người", T = 0, không lặp tên = mã', () => {
  const s = CT.schedule(Samples.construction().tasks), g = G.build(s), svg = G.svg(g, G.positions(g));
  assert.ok(svg.includes('<tspan x="0">Đường tạm và điện nước</tspan><tspan x="0" dy="12">ngoài</tspan>'), 'name wrapped at a word boundary, never cut');
  assert.ok(svg.includes('<title>E · Cốt thép và ván khuôn móng</title>') && !svg.includes('…'));
  assert.ok(svg.includes('>3 ngày · 14 người<') && !/>D \d/.test(svg) && !svg.includes(' · NC '), 'duration in days, labour in people');
  assert.ok(svg.includes('>T = 0<') && svg.includes('>T = ' + s.duration + '<'));
  assert.equal((svg.match(/markerUnits="userSpaceOnUse"/g) || []).length, 3, 'fixed-size arrowheads');
  const card = G.build(s, 'aon', { style: 'card' }), cardSvg = G.svg(card, G.positions(card), 'card');
  assert.ok(cardSvg.includes('>E · 3 ngày<') && cardSvg.includes('Cốt thép và ván khuôn móng'));
  // A–G exercise: names equal ids and no labour → the letter is not repeated, no "người".
  const ex = G.build(CT.schedule(Samples.group().tasks)), exSvg = G.svg(ex, G.positions(ex));
  assert.ok(exSvg.includes('>3 ngày<') && !exSvg.includes('người') && !exSvg.includes('font-size="10" fill="#557493"'));
  // Long names: two lines, an ellipsis only beyond them; the full name stays in <title>.
  const long = 'Lắp dựng cốp pha, cốt thép và đổ bê tông sàn tầng điển hình khối nhà chính phía đông';
  const lg = G.build(CT.schedule([{ ...task('A', 2), name: long }])), lsvg = G.svg(lg, G.positions(lg));
  assert.equal((lsvg.match(/<tspan/g) || []).length, 2);
  assert.ok(lsvg.includes('…</tspan>') && lsvg.includes(`<title>A · ${long}</title>`));
});

test('Nhãn lag không đè chữ ES/EF/LS/LF; mũi tên vào cùng một cạnh tách rời nhau', () => {
  const check = (g, p, style = 'circle') => {
    const routes = G.routes(g, p, style), boxes = cornerBoxes(g, p);
    for (const r of routes.filter((x) => x.label.text)) for (const b of boxes) assert.ok(!hit(labelBox(r), b), `${r.label.text} (${r.key}) covers ${b.what}`);
    const tips = new Map();
    for (const r of routes) {
      const t = r.points.at(-1), side = r.to + (r.points.at(-2).x < t.x ? '<' : '>');
      tips.set(side, [...(tips.get(side) || []), t.y]);
    }
    for (const [side, ys] of tips) {
      ys.sort((a, b) => a - b);
      for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= 10, `arrowheads into ${side} touch`);
    }
  };
  const s = CT.schedule(Samples.construction().tasks), g = G.build(s), p = G.positions(g);
  check(g, p);
  const de = G.routes(g, p).find((r) => r.from === 'D' && r.to === 'E');
  assert.equal(de.label.text, 'FS+1');
  check(g, G.fitWidth(g, p, { maxWidth: 1450, style: 'circle' }));
  for (const sample of [Samples.group(), Samples.exerciseAK()]) {
    const x = G.build(CT.schedule(sample.tasks));
    check(x, G.positions(x));
  }
  // AOA: an activity label never touches its own arrowhead.
  const a = G.build(CT.schedule(Samples.exerciseAK().tasks), 'aoa');
  for (const r of G.routes(a, G.positions(a))) {
    if (!r.label.text) continue;
    const t = r.points.at(-1), head = { x1: t.x - 12, x2: t.x + 12, y1: t.y - 6, y2: t.y + 6 };
    assert.ok(!hit(labelBox(r), head), r.label.text + ' touches its arrowhead');
  }
});

test('Mũi tên chờ từ BĐ: nét đứt, ghi rõ lý do, không phải quan hệ găng', () => {
  const base = CT.schedule([task('A', 3), task('B', 2), task('C', 2, 'A')]);
  const held = { ...base, placement: true, resourceAware: true, rows: base.rows.map((t) => (t.id === 'B' ? { ...t, es: 5, ef: 7, ls: 5, lf: 7, tf: 0, critical: true } : t)) };
  const g = G.build(held), edge = g.edges.find((e) => e.from === '@start' && e.to === 'B');
  assert.deepEqual([edge.label, edge.release, edge.critical], ['Chờ nhân lực · bắt đầu ngày 5', true, false]);
  const svg = G.svg(g, G.positions(g));
  assert.ok(svg.includes('graph-release') && svg.includes('stroke-dasharray="5 4"') && !svg.includes('Mốc'));
  assert.equal(G.build({ ...held, resourceAware: false }).edges.find((e) => e.to === 'B' && e.from === '@start').label, 'Ràng buộc bắt đầu ngày 5');
  // C held later than A allows (slack 2) → wait link; started right after A (slack 0) → none.
  const later = { ...base, placement: true, resourceAware: true, rows: base.rows.map((t) => (t.id === 'C' ? { ...t, es: 5, ef: 7, ls: 5, lf: 7, critical: true } : { ...t, critical: false })), edges: base.edges.map((e) => ({ ...e, slack: 2, critical: false })) };
  assert.equal(G.build(later).edges.find((e) => e.key === 'release:C').label, 'Chờ nhân lực · bắt đầu ngày 5');
  const tight = { ...later, edges: base.edges.map((e) => ({ ...e, slack: 0, critical: false })) };
  assert.ok(!G.build(tight).edges.some((e) => e.key === 'release:C'), 'a start that follows its predecessor is not a wait');
});

test('Xuất báo cáo: fitWidth chia mạng rộng thành các dải ≤ maxWidth, định tuyến vẫn hợp lệ', () => {
  const project = Samples.construction(), s = CT.schedule(project.tasks);
  for (const style of ['circle', 'card']) {
    const g = G.build(s, 'aon', { style }), p = G.positions(g);
    assert.ok(G.bounds(g, p, style).width > 2000, 'the sample network is wide');
    const q = G.fitWidth(g, p, { maxWidth: 1450, style });
    assert.deepEqual(Object.keys(q).sort(), Object.keys(p).sort());
    const { bounds, routes } = checkRoutes(g, q, style);
    assert.ok(bounds.width <= 1500, style + ' width ' + bounds.width);
    assert.equal(routes.length, g.edges.length);
    for (const r of routes) assert.ok(r.points.length >= 2 && r.points.every((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y)), r.key + ' has a route');
    // Reading order: the start is in the first band, the finish in the last, bands stack downward.
    const ys = Object.values(q).map((v) => v.y);
    assert.equal(q['@start'].x, Math.min(...Object.values(q).map((v) => v.x)));
    assert.ok(q['@start'].y <= Math.min(...ys) + 200 && q['@finish'].y >= Math.max(...ys) - 200);
    assert.deepEqual(G.fitWidth(g, q, { maxWidth: 1450, style }), q, 'already fits');
    assert.ok(!G.svg(g, q, style).includes('NaN'));
  }
  const again = () => {
    const g = G.build(s);
    return JSON.stringify(G.fitWidth(g, G.positions(g), { maxWidth: 1450, style: 'circle' }));
  };
  assert.equal(again(), again(), 'deterministic');
  // Applied plan (Planner.active) and AOA, and a small network that already fits (unchanged).
  const ga = G.build(require('../planner.js').active(project)), pa = G.positions(ga);
  checkRoutes(ga, G.fitWidth(ga, pa, { maxWidth: 1450, style: 'circle' }));
  const aoa = G.build(CT.schedule(randomTasks(21, 50, false)), 'aoa'), pAoa = G.positions(aoa), fAoa = G.fitWidth(aoa, pAoa, { maxWidth: 1450 });
  assert.ok(checkRoutes(aoa, fAoa).bounds.width <= 1500);
  const small = G.build(CT.schedule(Samples.textbook().tasks)), sp = G.positions(small);
  assert.equal(G.fitWidth(small, sp, { maxWidth: 1450 }), sp);
  // Dense random networks: every link still routed without collinear overlaps or node hits.
  for (const seed of [1, 2, 4, 6]) {
    const big = G.build(CT.schedule(randomTasks(seed * 100 + 60, 60, seed % 2 === 0))), bp = G.positions(big);
    assert.ok(checkRoutes(big, G.fitWidth(big, bp, { maxWidth: 1450, style: 'circle' })).bounds.width <= 1530);
  }
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

console.log(count + ' nhóm kiểm thử bảng sơ đồ: bố trí phân lớp, định tuyến không chồng/không xuyên nút, nhãn nút và nhãn lag, AOA, kéo thả nhanh, xuất dải (fitWidth), tiến độ xiên.');
