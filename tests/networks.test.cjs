'use strict';
const assert = require('node:assert/strict');
const N = require('../networks.js');
const CT = require('../engine.js');

let count = 0;
function test(name, fn) {
  fn();
  count++;
  console.log('✓ ' + name);
}
const close = (a, b, eps = 1e-9, label = '') => assert.ok(Math.abs(a - b) <= eps, `${label} ${a} ≠ ${b}`);
const task = (id, duration, deps = '', extra = {}) => ({
  id,
  name: id,
  duration,
  minDuration: duration,
  deps: typeof deps === 'string' ? CT.parseDeps(deps) : deps,
  cost: 0,
  actualCost: 0,
  crashSlope: 0,
  progress: 0,
  workers: 0,
  ...extra,
});
const textbook = () => [task('A', 3), task('B', 6, 'A'), task('C', 10, 'A'), task('D', 11, 'A'), task('E', 8, 'B'), task('F', 5, 'C,D'), task('G', 6, 'E,F')];

/** Deterministic PRNG (LCG) so the property tests are reproducible. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
}

/** Structural checks shared by all AOA tests; returns helpers for further assertions. */
function checkAoa(tasks, g) {
  const r = CT.schedule(tasks), rows = new Map(r.rows.map((t) => [t.id, t]));
  const ids = g.nodes.map((n) => n.id), byId = new Map(g.nodes.map((n) => [n.id, n]));
  assert.deepEqual([...ids].sort((a, b) => a - b), ids.map((_, i) => i + 1), 'events numbered 1..n');
  assert.equal(new Set(g.nodes.map((n) => n.key)).size, g.nodes.length, 'stable keys are unique');
  for (const a of g.arrows) assert.ok(a.from < a.to, `tail < head for ${a.key}`);
  const out = new Map(ids.map((i) => [i, []]));
  for (const a of g.arrows) out.get(a.from).push(a);
  assert.equal(ids.filter((i) => !g.arrows.some((a) => a.to === i)).length, 1, 'one source');
  assert.equal(ids.filter((i) => !out.get(i).length).length, 1, 'one sink');
  const pairs = g.arrows.map((a) => a.from + '>' + a.to);
  assert.equal(new Set(pairs).size, pairs.length, 'no two arrows between the same events');
  for (const a of g.arrows) if (a.dummy) assert.equal(a.duration, 0, 'dummies take no time');
  // Every task exactly once as a real arrow; one waiting arrow per positive FS lag.
  const activities = g.arrows.filter((a) => a.kind === 'activity');
  assert.deepEqual(activities.map((a) => a.task).sort(), tasks.map((t) => t.id).sort());
  assert.equal(g.arrows.filter((a) => a.kind === 'lag').length, r.edges.filter((e) => e.lag > 0).length);
  for (const a of g.arrows.filter((x) => x.kind === 'lag')) assert.ok(!a.dummy && a.duration > 0 && a.task === '');
  // Event times agree with CPM: TE(tail) = ES, TL(head) = LF, activity TF = CPM TF, TE(sink) = T.
  for (const a of activities) {
    const row = rows.get(a.task);
    close(byId.get(a.from).early, row.es, 1e-9, a.task + ' ES');
    close(byId.get(a.to).late, row.lf, 1e-9, a.task + ' LF');
    close(a.tf, row.tf, 1e-9, a.task + ' TF');
    assert.equal(a.critical, row.critical, a.task + ' critical');
  }
  close(byId.get(ids.length).early, r.duration, 1e-9, 'TE(sink)');
  for (const n of g.nodes) assert.ok(n.early <= n.late + 1e-9);
  // Reachability between events.
  const reach = new Map();
  for (const i of [...ids].reverse()) {
    const set = new Set();
    for (const a of out.get(i)) {
      set.add(a.to);
      for (const k of reach.get(a.to)) set.add(k);
    }
    reach.set(i, set);
  }
  const head = new Map(activities.map((a) => [a.task, a.to])), tail = new Map(activities.map((a) => [a.task, a.from]));
  const aoaBefore = (x, y) => head.get(x) === tail.get(y) || reach.get(head.get(x)).has(tail.get(y));
  return { r, reach, out, aoaBefore, byId };
}

/** Transitive closure of the FS precedence relation on the tasks. */
function precedence(tasks) {
  const succ = new Map(tasks.map((t) => [t.id, []]));
  for (const t of tasks) for (const d of t.deps) succ.get(d.id).push(t.id);
  const memo = new Map();
  const after = (id) => {
    if (memo.has(id)) return memo.get(id);
    const set = new Set();
    for (const s of succ.get(id)) {
      set.add(s);
      for (const k of after(s)) set.add(k);
    }
    memo.set(id, set);
    return set;
  };
  return (x, y) => after(x).has(y);
}

test('AOA bài A–G: 7 sự kiện, 1 công việc giả (C ‖ D trước F), TE/TL, đường găng A–D–F–G', () => {
  const tasks = textbook(), g = N.aoa(tasks), { byId } = checkAoa(tasks, g);
  assert.equal(g.duration, 25);
  assert.equal(g.events, 7);
  assert.equal(g.dummies, 1);
  const times = Object.fromEntries(g.nodes.map((n) => [n.id, [n.early, n.late]]));
  assert.deepEqual(times, { 1: [0, 0], 2: [3, 3], 3: [9, 11], 4: [13, 14], 5: [14, 14], 6: [19, 19], 7: [25, 25] });
  assert.deepEqual(g.nodes.filter((n) => n.critical).map((n) => n.id), [1, 2, 5, 6, 7]);
  const arrow = (task) => g.arrows.find((a) => a.task === task);
  assert.deepEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((t) => [arrow(t).from, arrow(t).to]), [[1, 2], [2, 3], [2, 4], [2, 5], [3, 6], [5, 6], [6, 7]]);
  assert.deepEqual(g.arrows.filter((a) => a.critical && !a.dummy).map((a) => a.task), ['A', 'D', 'F', 'G']);
  const dummy = g.arrows.find((a) => a.dummy);
  assert.deepEqual([dummy.from, dummy.to, dummy.critical], [4, 5, false]);
  // Textbook float: C has TF = TL5 − TE2 − 10 = 1, FF = TE4 − TE2 − 10 = 0; E has TF = FF = 2.
  assert.deepEqual([arrow('C').tf, arrow('C').ff, arrow('E').tf, arrow('E').ff], [1, 0, 2, 2]);
  assert.equal(byId.get(6).key, 'event:end:E,F');
});

test('AOA mạng 4 công việc: sự kiện gộp, chỉ một công việc giả cho B ‖ C', () => {
  const tasks = [task('A', 3), task('B', 2, 'A'), task('C', 4, 'A'), task('D', 1, 'B,C')], g = N.aoa(tasks);
  checkAoa(tasks, g);
  assert.equal(g.duration, 8);
  assert.equal(g.nodes.length, 5);
  assert.equal(g.dummies, 1);
  assert.equal(g.arrows.find((a) => a.dummy).critical, false, 'the dummy belongs to the non-critical B');
});

test('AOA: FS có lag là mũi tên chờ (có thời lượng), không phải công việc giả', () => {
  const tasks = [task('A', 3), task('B', 2, 'A:FS+2')], g = N.aoa(tasks);
  checkAoa(tasks, g);
  assert.equal(g.nodes.length, 4);
  assert.equal(g.dummies, 0);
  const wait = g.arrows.find((a) => a.kind === 'lag');
  assert.deepEqual([wait.from, wait.to, wait.duration, wait.dummy, wait.after, wait.before, wait.critical], [2, 3, 2, false, 'A', 'B', true]);
  assert.equal(g.nodes.at(-1).early, 7);
});

test('AOA từ chối SS/FF/SF và lag âm với thông báo cũ', () => {
  assert.throws(() => N.aoa([task('A', 2), task('B', 2, 'A:SS+1')]), /AOA cổ điển chỉ biểu diễn trực tiếp FS với lag không âm/);
  assert.throws(() => N.aoa([task('A', 2), task('B', 2, 'A:FS-1')]), /A→B FS-1/);
  const empty = N.aoa([]);
  assert.deepEqual([empty.nodes.length, empty.arrows.length, empty.duration], [1, 0, 0]);
});

test('AOA khóa sự kiện ổn định khi thêm công việc', () => {
  const before = N.aoa(textbook()).nodes.map((n) => n.key);
  const after = N.aoa([...textbook(), task('H', 2, 'B')]).nodes.map((n) => n.key);
  for (const key of before) assert.ok(after.includes(key), key + ' kept');
});

test('AOA ngẫu nhiên (FS, lag ≥ 0): đúng quan hệ trước–sau, thời điểm CPM, giả đều cần thiết', () => {
  const random = rng(20261019);
  let dummies = 0, events = 0;
  for (let k = 0; k < 250; k++) {
    const n = 2 + Math.floor(random() * 24), tasks = [];
    for (let i = 0; i < n; i++) {
      const deps = [], used = new Set(), want = i ? Math.floor(random() * 4) : 0;
      for (let j = 0; j < want; j++) {
        const from = Math.floor(random() * i);
        if (used.has(from)) continue;
        used.add(from);
        deps.push({ id: 'T' + from, type: 'FS', lag: random() < 0.2 ? 1 + Math.floor(random() * 3) : 0 });
      }
      tasks.push(task('T' + i, Math.floor(random() * 10), deps));
    }
    const g = N.aoa(tasks), { aoaBefore, out } = checkAoa(tasks, g), before = precedence(tasks);
    for (const x of tasks) for (const y of tasks) if (x !== y) assert.equal(aoaBefore(x.id, y.id), before(x.id, y.id), `seed ${k}: ${x.id} before ${y.id}`);
    // Removing any dummy must break some precedence (no redundant dummies).
    for (const d of g.arrows.filter((a) => a.dummy)) {
      const reachWithout = (from, to) => {
        const seen = new Set([from]), stack = [from];
        while (stack.length) {
          const v = stack.pop();
          if (v === to) return true;
          for (const a of out.get(v)) if (a !== d && !seen.has(a.to)) seen.add(a.to), stack.push(a.to);
        }
        return false;
      };
      assert.ok(!reachWithout(d.from, d.to), `seed ${k}: dummy ${d.from}→${d.to} is redundant`);
    }
    dummies += g.dummies;
    events += g.events;
  }
  assert.ok(dummies < events, 'dummies stay a minority of the events');
});

test('PERT bài A–G: Te = 26, Σσ² = 3,444, σ = 1,856, P(T ≤ 26) = 0,5, P(T ≤ 28) ≈ 0,859', () => {
  const est = { A: [2, 3, 4], B: [4, 6, 10], C: [8, 10, 12], D: [9, 11, 19], E: [6, 8, 10], F: [3, 5, 7], G: [5, 6, 7] };
  const tasks = textbook().map((t) => ({ ...t, pert: { a: est[t.id][0], m: est[t.id][1], b: est[t.id][2] } }));
  const p = N.pert(tasks);
  close(p.duration, 26);
  assert.deepEqual(p.critical, ['A', 'D', 'F', 'G']);
  close(p.project.variance, 31 / 9, 1e-9);
  close(p.project.sigma, 1.8559214542766742, 1e-9);
  assert.deepEqual(p.project.path, ['A', 'D', 'F', 'G']);
  assert.deepEqual(p.project.warnings, []);
  assert.equal(N.pertProbability(p, 26).probability, 0.5);
  const at28 = N.pertProbability(tasks, 28);
  close(at28.z, 2 / Math.sqrt(31 / 9), 1e-12);
  close(at28.probability, 0.8594, 5e-4);
  close(at28.p90, 26 + 1.2815515655446004 * Math.sqrt(31 / 9), 1e-9);
  close(at28.p95, 26 + 1.6448536269514722 * Math.sqrt(31 / 9), 1e-9);
  assert.throws(() => N.pertProbability(p, -1), /Thời hạn mục tiêu/);
});

test('PERT: cảnh báo quan hệ không FS, đường găng song song và đường gần găng', () => {
  const pert = (a, m, b) => ({ pert: { a, m, b } });
  // Two tied critical paths: the larger variance (via C) is used.
  const tied = N.pert([task('A', 2, '', pert(1, 2, 3)), task('B', 4, 'A', pert(3, 4, 5)), task('C', 4, 'A', pert(1, 4, 7)), task('D', 1, 'B,C', pert(1, 1, 1))]);
  assert.equal(tied.project.paths, 2);
  assert.deepEqual(tied.project.path, ['A', 'C', 'D']);
  close(tied.project.variance, 1 / 9 + 1);
  assert.ok(tied.project.warnings.some((w) => /2 đường găng/.test(w)));
  // A path 0.5 day shorter than the critical one (σ ≈ 1.1) is near-critical.
  const near = N.pert([task('A', 2, '', pert(1, 2, 3)), task('B', 4, 'A', pert(2, 4, 8)), task('C', 3.5, 'A', pert(3.5, 3.5, 3.5))]);
  assert.deepEqual(near.project.nearCritical, ['C']);
  assert.ok(near.project.warnings.some((w) => /gần găng/.test(w)));
  const ss = N.pert([task('A', 2, '', pert(1, 2, 3)), task('B', 2, 'A:SS+1', pert(1, 2, 3))]);
  assert.equal(ss.project.nonFs, true);
  assert.ok(ss.project.warnings.some((w) => /SS\/FF\/SF/.test(w)));
  const fixed = N.pertProbability([task('A', 3), task('B', 2, 'A')], 5);
  assert.deepEqual([fixed.sigma, fixed.probability, fixed.p95], [0, 1, 5]);
});

test('PERT: kỳ vọng, phương sai và không còn "FF -0" do sai số dấu phẩy động', () => {
  const expected = N.pert([{ ...task('A', 3), pert: { a: 1, m: 2, b: 4 } }, { ...task('B', 2, 'A'), pert: { a: 1, m: 2, b: 3 } }]);
  close(expected.duration, 25 / 6);
  assert.equal(expected.critical.length, 2);
  assert.equal(N.pert([task('A', 3), task('B', 2, 'A'), task('C', 4, 'A'), task('D', 1, 'B,C')]).duration, 8);
  assert.throws(() => N.pert([{ ...task('A', 3), pert: { a: 3, m: 1, b: 4 } }]), /a ≤ m ≤ b/);
  // The engine leaves ff = -2.2e-16 for X2 here (tf is already rounded); pert() cleans it.
  const p = (a, m, b) => ({ pert: { a, m, b } });
  const tasks = [task('X0', 3, '', p(3, 3, 4)), task('X1', 2, 'X0', p(1, 2, 7)), task('X2', 1, 'X1,X0', p(1, 1, 3)), task('X3', 6, 'X0,X1', p(3, 6, 9)), task('X4', 6, 'X2,X0', p(5, 6, 8)), task('X5', 7, 'X2,X0', p(5, 7, 12))];
  const raw = CT.schedule(tasks.map((t) => ({ ...t, duration: (t.pert.a + 4 * t.pert.m + t.pert.b) / 6, minDuration: 0 })), { fractional: true });
  assert.ok(raw.rows.some((t) => t.ff !== 0 && Math.abs(t.ff) < 1e-8), 'reproduces the engine noise');
  for (const row of N.pert(tasks).rows)
    for (const key of ['es', 'ef', 'ls', 'lf', 'tf', 'ff']) assert.ok(row[key] === 0 ? !Object.is(row[key], -0) : Math.abs(row[key]) >= 1e-8, row.id + ' ' + key);
});

test('Phân phối chuẩn: Φ và Φ⁻¹ chính xác', () => {
  close(N.normalCdf(0), 0.5, 1e-15);
  close(N.normalCdf(1), 0.8413447460685429, 1e-12);
  close(N.normalCdf(1.96), 0.9750021048517795, 1e-12);
  close(N.normalCdf(-2.5), 0.0062096653257761, 1e-12);
  close(N.normalCdf(8), 1 - 6.22096057427178e-16, 1e-15);
  close(N.normalInv(0.95), 1.6448536269514722, 1e-12);
  close(N.normalInv(0.9), 1.2815515655446004, 1e-12);
  for (const q of [0.001, 0.02, 0.3, 0.7, 0.999]) close(N.normalCdf(N.normalInv(q)), q, 1e-12);
});

test('Tiến độ xiên: nhóm quá trình, lịch đã áp dụng, nét xiên và cảnh báo', () => {
  const rows = [{ ...task('A', 2), segment: 1, process: 'Móng' }, { ...task('B', 2, 'A'), segment: 2, process: 'Móng' }];
  assert.equal(N.linear(rows).groups[0].rows.length, 2);
  assert.throws(() => N.linear([{ ...rows[0] }, { ...rows[1], segment: 1 }]), /cùng phân đoạn/);
  // Two processes over two segments; an applied (levelled) plan shifts B and D later.
  const tasks = [
    { ...task('A', 2), segment: 1, process: 'Móng' },
    { ...task('B', 2, 'A'), segment: 2, process: 'Móng' },
    { ...task('C', 3, 'A'), segment: 1, process: 'Thân' },
    { ...task('D', 3, 'C,B'), segment: 2, process: 'Thân' },
  ];
  const cpm = N.linear(tasks);
  assert.deepEqual(cpm.warnings, []);
  assert.deepEqual(cpm.order, ['Móng', 'Thân']);
  const applied = CT.schedule(tasks);
  applied.rows = applied.rows.map((t) => (t.id === 'B' ? { ...t, es: 5, ef: 7 } : t.id === 'D' ? { ...t, es: 7, ef: 10 } : t));
  applied.duration = 10;
  const levelled = N.linear(tasks, applied);
  assert.equal(levelled.duration, 10);
  assert.deepEqual(levelled.groups[0].lines[1], { id: 'B', segment: 2, start: 5, finish: 7, from: { t: 5, s: 1 }, to: { t: 7, s: 2 } });
  assert.deepEqual(N.linear(tasks, applied.rows).groups[1].rows.map((t) => t.es), [2, 7]);
  // In segment 2 Thân now starts before Móng finishes → overlap; order differs from segment 1.
  const clash = N.linear(tasks, { rows: applied.rows.map((t) => (t.id === 'D' ? { ...t, es: 4, ef: 7 } : t)), duration: 10 });
  assert.equal(clash.conflicts.length, 1);
  assert.deepEqual([clash.conflicts[0].segment, clash.conflicts[0].start, clash.conflicts[0].finish], [2, 5, 7]);
  assert.equal(clash.orderIssues.length, 1);
  assert.ok(clash.warnings.some((w) => /đồng thời/.test(w)) && clash.warnings.some((w) => /thứ tự quá trình/.test(w)));
  assert.throws(() => N.linear(tasks, { rows: [] }), /thiếu ES\/EF/);
});

test('Bố trí phân lớp: giảm giao cắt, đường chính trên một hàng', () => {
  // Input order puts the crossing first: a→d, b→c with layer order [c, d].
  const lay = N.layered(['s', 'a', 'b', 'c', 'd'], [{ from: 's', to: 'a' }, { from: 's', to: 'b' }, { from: 'b', to: 'c' }, { from: 'a', to: 'd' }]);
  assert.equal(lay.crossings, 0);
  const ids = ['s', 'x1', 'x2', 'y1', 'y2', 'z', 't'];
  const links = [['s', 'x1'], ['x1', 'x2'], ['x2', 'z'], ['s', 'y1'], ['y1', 'y2'], ['y2', 'z'], ['z', 't'], ['s', 't']].map(([from, to]) => ({ from, to }));
  const spine = N.layered(ids, links, { spine: ['s', 'y1', 'y2', 'z', 't'] });
  assert.deepEqual(['s', 'y1', 'y2', 'z', 't'].map((id) => spine.row.get(id)), [0, 0, 0, 0, 0]);
  assert.notEqual(spine.row.get('x1'), 0);
  assert.equal(spine.row.get('x1'), spine.row.get('x2'), 'a parallel branch stays straight too');
});

console.log(count + ' nhóm kiểm thử sơ đồ mạng: AOA đúng chuẩn (sự kiện gộp, giả tối thiểu, chờ cho lag), PERT xác suất, tiến độ xiên, bố trí phân lớp.');
