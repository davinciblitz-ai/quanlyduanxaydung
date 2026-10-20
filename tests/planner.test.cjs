const assert = require("node:assert/strict"), P = require("../planner.js"), CT = require("../engine.js");
const fs = require("node:fs"), vm = require("node:vm"), crypto = require("node:crypto");
const sampleContext = { window: {}, crypto, CT };
vm.runInNewContext(fs.readFileSync(require.resolve("../samples.js"), "utf8"), sampleContext);
const Samples = sampleContext.window.Samples;
const t = (id, duration, workers, deps = "") => ({
  id, name: id, duration, minDuration: duration, workers, deps: CT.parseDeps(deps),
  cost: 100, actualCost: 0, progress: 0, crashSlope: 0,
});
const tasks = [t("A", 2, 5), t("B", 2, 1, "A"), t("C", 2, 5, "B"), t("D", 2, 4)];
const project = { tasks, capacity: 9 };
let tests = 0;
function test(name, fn) {
  fn();
  tests++;
  console.log("✓ " + name);
}

/** Duyệt độc lập mọi mốc bắt đầu nguyên (và mọi thời lượng nếu cho rút) để lấy phương án tốt nhất. */
function bruteForce(ts, o) {
  const floors = ts.map((x) => (o.allowCrash ? Math.max(x.minDuration, x.duration ? 1 : 0) : x.duration));
  let best = null;
  const durations = {};
  (function durationsWalk(k) {
    if (k < ts.length) {
      for (let d = ts[k].duration; d >= floors[k]; d--) {
        durations[ts[k].id] = d;
        durationsWalk(k + 1);
      }
      return;
    }
    const eff = P.effective(ts, durations), starts = {};
    (function startsWalk(i) {
      if (i === eff.length) {
        const q = P.candidate(ts, durations, starts, o);
        if (q.valid && (!best || P.compare(q, best, o) < 0)) best = q;
        return;
      }
      for (let s = 0; s + eff[i].duration <= o.maxDuration; s++) {
        starts[eff[i].id] = s;
        startsWalk(i + 1);
      }
    })(0);
  })(0);
  return best;
}

function randomInstance(random, n) {
  const types = ["FS", "SS", "FF", "SF"], list = [];
  for (let i = 0; i < n; i++) {
    const deps = [];
    for (let j = 0; j < i; j++)
      if (random() < 0.3)
        deps.push(String.fromCharCode(65 + j) + ":" + types[Math.floor(random() * 4)] + (random() < 0.5 ? "+" : "-") + Math.floor(random() * 2));
    const d = 1 + Math.floor(random() * 3);
    list.push({ ...t(String.fromCharCode(65 + i), d, 1 + Math.floor(random() * 5), deps.join(",")), minDuration: Math.max(1, d - 1), crashSlope: Math.floor(random() * 30) });
  }
  return list;
}
function seeded(seed) {
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
}

test("Chỉ tiêu biểu đồ: đơn đỉnh, K1 = Rmax/Rtb, K2 = Sdư/S", () => {
  assert.equal(P.metrics([1, 2, 4, 4, 3, 1]).unimodal, true);
  assert.equal(P.metrics([3, 1, 4]).unimodal, false);
  assert.equal(P.metrics([]).valley, 0);
  const m = P.metrics([2, 4, 6]);
  assert.equal(m.average, 4);
  assert.equal(m.k1, 1.5);
  assert.ok(Math.abs(m.k2 - 2 / 12) < 1e-12);
  assert.equal(m.sumSquares, 4 + 16 + 36);
  assert.equal(m.mobilizations, 6);
});

test("Điều hòa nhân lực nhỏ: duyệt đầy đủ, giảm đỉnh và chi phí huy động", () => {
  const o = P.solve(project, { strategy: "algorithm", goal: "optimize", priority: "workforce", maxDuration: 6, capacity: 9, mobilizationRate: 10 });
  assert.equal(o.complete, true);
  assert.equal(o.method, "exhaustive");
  assert.equal(o.best.valid, true);
  assert.equal(o.best.starts.D, 2);
  assert.equal(o.best.metrics.peak, 5);
  assert.equal(o.best.metrics.unimodal, true);
  assert.ok(o.best.costs.total < o.basic.costs.total);
  assert.equal(o.best.metrics.work, o.basic.metrics.work);
});

test("Đỉnh thấp hơn luôn thắng khi điều hòa (lỗi cũ: chia cho đỉnh)", () => {
  const ts = [t("A", 3, 5), t("B", 3, 5), t("C", 3, 5)];
  const r = P.solve({ tasks: ts }, { strategy: "algorithm", goal: "optimize", priority: "workforce", capacity: 15, maxDuration: 9 });
  assert.equal(r.best.metrics.peak, 5);
  const two = [t("A", 2, 4), t("B", 2, 4)];
  const r2 = P.solve({ tasks: two }, { strategy: "algorithm", goal: "optimize", priority: "workforce", capacity: 8, maxDuration: 4 });
  assert.equal(r2.best.metrics.peak, 4);
});

test("Xếp tay kiểm tra đủ FS SS FF SF và lag, không tự sửa mốc đã nhập", () => {
  for (const type of ["FS", "SS", "FF", "SF"]) {
    const ts = [t("A", 3, 2), t("B", 4, 2, "A:" + type + "+1")], b = CT.schedule(ts);
    const starts = Object.fromEntries(b.rows.map((x) => [x.id, x.es + 2]));
    const r = P.solve({ tasks: ts }, { strategy: "manual", maxDuration: 30, capacity: 10 }, starts);
    assert.equal(r.best.valid, true);
    assert.deepEqual(r.best.starts, starts);
    const edge = b.edges[0], bad = { ...starts, B: starts.A + edge.w - 1 };
    if (bad.B >= 0) assert.equal(P.inspect(ts, bad, r.options).issues.some((x) => x.kind === "relation"), true);
  }
});

test("Lịch đã bố trí: đường găng theo mốc bố trí, CPM thuần giữ riêng", () => {
  const r = P.result(tasks, { starts: { A: 0, B: 2, C: 4, D: 2 } });
  assert.ok(r.critical.length);
  assert.equal(r.duration, 6);
  assert.equal(r.cpmDuration, 6);
  const delayed = P.result(tasks, { starts: { A: 3, B: 5, C: 7, D: 0 } });
  assert.ok(delayed.critical.includes("C"));
  assert.equal(delayed.rows.find((x) => x.id === "A").cpmEs, 0);
  assert.equal(delayed.rows.find((x) => x.id === "A").es, 3);
});

test("Dự trữ có xét năng lực: hai việc nối nhau vì thiếu người đều là găng", () => {
  const ts = [t("A", 2, 5), t("B", 2, 5)], plan = { starts: { A: 0, B: 2 } };
  assert.deepEqual(P.result(ts, plan).critical, ["B"]);
  const limited = P.result(ts, plan, 5);
  assert.deepEqual(limited.critical.sort(), ["A", "B"]);
  assert.equal(limited.rows.find((x) => x.id === "A").tf, 0);
});

test("Giới hạn năng lực, hạn và công tác quá lớn không được gọi là khả thi", () => {
  const a = P.solve(project, { strategy: "algorithm", capacity: 3, maxDuration: 6 });
  assert.equal(a.best, null);
  assert.equal(a.method, "infeasible");
  const b = P.inspect(tasks, { A: 0, B: 2, C: 4, D: 0 }, P.options({ capacity: 5, maxDuration: 5 }, project));
  assert.ok(b.issues.some((i) => i.kind === "capacity"));
  assert.ok(b.issues.some((i) => i.kind === "deadline"));
  assert.equal(P.inspect(tasks, { A: 0, B: 2, C: 4 }, P.options({}, project)).valid, false);
  const late = P.solve(project, { strategy: "algorithm", capacity: 9, maxDuration: 5 });
  assert.equal(late.best, null);
  assert.match(late.reason, /cận dưới 6 ngày/);
});

test("Rút ngắn giữ hao phí, tăng nhân công và chi phí; không sửa đầu vào", () => {
  const ts = [{ ...t("A", 4, 3), minDuration: 2, crashSlope: 20 }], before = JSON.stringify(ts);
  const r = P.solve({ tasks: ts }, { strategy: "algorithm", goal: "optimize", allowCrash: true, capacity: 6, maxDuration: 4, indirectPerDay: 100, priority: "cost" });
  assert.equal(r.best.durations.A, 2);
  assert.equal(r.best.metrics.peak, 6);
  assert.equal(r.best.costs.direct, 140);
  assert.equal(JSON.stringify(ts), before);
  assert.throws(() => P.effective(ts, { A: 0 }));
});

test("Kế hoạch lưu phát hiện dữ liệu cũ; mục tiêu cũ 'balanced' vẫn đọc được", () => {
  const options = P.options({ strategy: "manual", capacity: 9, maxDuration: 6, priority: "balanced" }, project);
  assert.equal(options.priority, "workforce");
  const p = { ...project, planning: { ...options, selected: { fingerprint: P.fingerprint(tasks), durations: {}, starts: { A: 0, B: 2, C: 4, D: 2 } } } };
  P.validate(p);
  assert.equal(P.active(p).rows.find((x) => x.id === "D").es, 2);
  p.tasks = tasks.map((x) => (x.id === "D" ? { ...x, duration: 1, minDuration: 1 } : x));
  assert.equal(P.active(p).rows.find((x) => x.id === "D").es, 0);
});

test("Không tuyên bố tối ưu toàn cục khi giới hạn tìm kiếm dừng sớm", () => {
  const r = P.solve(project, { strategy: "algorithm", capacity: 9, maxDuration: 15 }, {}, { maxMs: 0, maxEvaluations: 1 });
  assert.equal(r.complete, false);
  assert.equal(r.method, "heuristic");
  assert.ok(r.best && r.best.valid, "vẫn trả về lịch khả thi từ bước xếp nối tiếp");
});

test("Kết quả 'duyệt đầy đủ' khớp phép liệt kê độc lập (3 mục tiêu, có rút ngắn)", () => {
  const random = seeded(7);
  let checked = 0;
  for (let k = 0; k < 36; k++) {
    const ts = randomInstance(random, 3 + (k % 2));
    const base = CT.schedule(ts).duration;
    const objective = ["time", "workforce", "cost"][k % 3];
    const input = {
      strategy: "algorithm", goal: objective === "time" ? "analyze" : "optimize", priority: objective === "time" ? "workforce" : objective,
      capacity: 6 + (k % 3), maxDuration: base + 2, indirectPerDay: 15, mobilizationRate: 7, allowCrash: k % 4 === 0,
    };
    // Ví dụ lẻ: gián tiếp theo dự án (offset âm) để kiểm cận dưới chi phí của nhánh-cận.
    const proj = k % 2 ? { tasks: ts, indirectBase: 40, dailySaving: 15 } : { tasks: ts };
    const o = P.options(input, proj), r = P.solve(proj, o), brute = bruteForce(ts, o);
    assert.equal(o.indirectSource, k % 2 ? "project" : "manual");
    if (!r.complete) continue;
    checked++;
    if (!brute) {
      assert.equal(r.best, null);
      continue;
    }
    assert.ok(r.best, "bỏ sót lời giải ở ví dụ " + k);
    assert.equal(P.compare(r.best, brute, o), 0, "ví dụ " + k + ": " + JSON.stringify([r.best.rank, brute.rank]));
  }
  assert.ok(checked >= 30);
});

test("Heuristic bài vừa: luôn khả thi, không có ngày trống đầu, sát cận dưới", () => {
  const random = seeded(11);
  for (let k = 0; k < 6; k++) {
    const ts = randomInstance(random, 14).map((x) => ({ ...x, minDuration: x.duration }));
    const base = CT.schedule(ts).duration;
    for (const goal of ["analyze", "optimize"]) {
      const o = P.options({ strategy: "algorithm", goal, priority: "workforce", capacity: 9, maxDuration: Math.ceil(base * 1.6) + 6 }, { tasks: ts });
      const r = P.solve({ tasks: ts }, o, {}, { maxMs: 600 });
      assert.ok(r.best && r.best.valid, "phải có lịch khả thi");
      assert.ok(Math.min(...Object.values(r.best.starts)) === 0 || ts.every((x) => x.deps.length), "không mở đầu bằng ngày trống");
      assert.ok(r.best.metrics.peak >= r.bounds.peak - 1e-9);
      assert.ok(r.best.metrics.duration >= r.bounds.duration);
      if (goal === "analyze") assert.ok(r.best.metrics.duration <= r.basic.metrics.duration + 40);
    }
  }
});

test("Bài lớn chạy trong giới hạn thời gian và không làm xấu hơn lịch cơ bản khả thi", () => {
  const random = seeded(3), ts = [];
  for (let i = 0; i < 120; i++) {
    const deps = [];
    for (let j = Math.max(0, i - 6); j < i; j++) if (random() < 0.25) deps.push("T" + j);
    ts.push(t("T" + i, 1 + Math.floor(random() * 8), 1 + Math.floor(random() * 8), deps.join(",")));
  }
  const started = Date.now();
  const r = P.solve({ tasks: ts }, { strategy: "algorithm", goal: "optimize", priority: "workforce", capacity: 1000, maxDuration: CT.schedule(ts).duration }, {}, { maxMs: 1500 });
  assert.ok(Date.now() - started < 3500);
  assert.ok(r.best.valid);
  assert.ok(r.best.metrics.peak <= r.basic.metrics.peak);
  assert.ok(r.best.metrics.sumSquares <= r.basic.metrics.sumSquares);
});

test("K1, K2 không xác định (null, không phải 0) khi không có nhân công", () => {
  for (const crew of [[0, 0, 0], []]) {
    const m = P.metrics(crew);
    assert.equal(m.k1, null);
    assert.equal(m.k2, null);
  }
  const r = P.solve(Samples.group(), { strategy: "basic" });
  assert.equal(r.best.metrics.k1, null);
  assert.equal(r.best.metrics.k2, null);
});

test("Gián tiếp theo dự án: indirectBase tại CPM ± dailySaving/ngày, khớp CT.optimize (bài A–G)", () => {
  const ag = Samples.group(), o = P.options({}, ag);
  assert.equal(o.indirectSource, "project");
  assert.equal(o.indirectPerDay, 50);
  assert.equal(o.indirectOffset, 400 - 50 * 25);
  assert.equal(P.indirectAt(o, 25), 400);
  assert.equal(P.indirectAt(o, 22), 250);
  assert.equal(P.options(o, ag).indirectSource, "project", "đọc lại cấu hình giữ nguồn dự án");
  assert.equal(P.options({ indirectPerDay: 0 }, ag).indirectSource, "project", "bản lưu cũ để 0 → lấy theo dự án");
  const manual = P.options({ indirectPerDay: 10 }, ag);
  assert.deepEqual([manual.indirectSource, manual.indirectOffset, P.indirectAt(manual, 25)], ["manual", 0, 250]);
  const same = P.options({ ...o, indirectSource: "manual" }, ag);
  assert.deepEqual([same.indirectSource, same.indirectOffset, P.indirectAt(same, 25)], ["manual", 0, 1250]);
  const basic = P.solve(ag, { strategy: "basic" }).best;
  assert.deepEqual([basic.metrics.duration, basic.costs.direct, basic.costs.indirect, basic.costs.total], [25, 450, 400, 850]);
  const r = P.solve(ag, { strategy: "algorithm", goal: "optimize", priority: "cost", allowCrash: true }, {}, { maxMs: 3000 });
  const c = r.best.costs, opt = CT.optimize(ag.tasks, ag.indirectBase, ag.dailySaving).best;
  assert.deepEqual([r.best.metrics.duration, c.direct, c.indirect, c.total], [22, 525, 250, 775]);
  assert.deepEqual([opt.duration, opt.total], [22, 775]);
  const toa = P.options({}, Samples.construction());
  assert.equal(P.indirectAt(toa, 55), 30000000);
  assert.equal(P.indirectAt(toa, 64), 39000000);
});

test("Tiến độ thực tế: việc đã xong/đang làm giữ mốc, việc chưa làm từ ngày báo cáo (tòa 12 tầng)", () => {
  const p = Samples.construction(), cpm = CT.schedule(p.tasks);
  const r = P.solve(p, { strategy: "algorithm", goal: "optimize", priority: "workforce" }, {}, { maxMs: 1500 });
  assert.equal(r.progress.applied, true);
  assert.equal(r.progress.statusDay, 12);
  assert.ok(r.best && r.best.valid);
  assert.equal(r.best.starts.M, 5, "M đã xong 100%: giữ mốc CPM 5, không dời sang 13");
  for (const t of p.tasks)
    if (t.progress > 0) assert.equal(r.best.starts[t.id], cpm.rows.find((x) => x.id === t.id).es, t.id);
    else assert.ok(r.best.starts[t.id] >= 12, t.id + " chưa làm không được xếp trước ngày báo cáo");
  const s = P.result(P.effective(p.tasks, r.best.durations), r.best, r.options.capacity);
  for (const row of s.rows)
    if (p.tasks.find((t) => t.id === row.id).progress >= 100)
      assert.deepEqual([row.done, row.tf, row.ff, row.critical], [true, 0, 0, false], row.id);
    else assert.equal(row.done, undefined);
  assert.ok(!s.critical.some((id) => ["A", "B", "C", "D", "M"].includes(id)));
  const crash = P.solve(p, { strategy: "algorithm", goal: "optimize", priority: "cost", allowCrash: true }, {}, { maxMs: 800 });
  for (const t of p.tasks) if (t.progress > 0) assert.equal(crash.best.durations[t.id], t.duration, t.id + " đã làm: không rút");
  // Không có tiến độ và ngày báo cáo 0 (bài tập): không ràng buộc gì.
  assert.equal(P.progressLimits({ ...p, statusDay: 0, tasks: p.tasks.map((t) => ({ ...t, progress: 0 })) }), null);
  assert.equal(P.solve(Samples.group(), { strategy: "algorithm" }).progress, null);
});

test("Ngày báo cáo (khi đã ghi tiến độ): việc chưa làm không bắt đầu sớm hơn; số liệu ngược trình tự chỉ nới vừa đủ", () => {
  const two = { tasks: [t("A", 2, 1), t("B", 2, 1, "A")], capacity: 5, statusDay: 3 };
  const r = P.solve(two, { strategy: "algorithm", maxDuration: 10 });
  // Chưa ghi % hoàn thành nào: lập kế hoạch từ mốc 0, ngày báo cáo không dời lịch.
  assert.equal(r.progress, null);
  assert.deepEqual(r.best.starts, { A: 0, B: 2 });
  const live = { tasks: [{ ...t("A", 2, 1), progress: 100 }, t("B", 2, 1, "A"), t("C", 2, 1)], capacity: 5, statusDay: 3 };
  const w = P.solve(live, { strategy: "algorithm", maxDuration: 10 });
  assert.equal(w.method, "exhaustive");
  assert.equal(w.progress.applied, true);
  assert.deepEqual(w.best.starts, { A: 0, B: 3, C: 3 });
  assert.equal(w.bounds.duration, 5);
  const odd = { tasks: [t("A", 2, 1), { ...t("B", 2, 1, "A"), progress: 50 }], capacity: 5, statusDay: 5 };
  const q = P.solve(odd, { strategy: "algorithm", maxDuration: 10 });
  assert.deepEqual([q.progress.applied, q.progress.pinned, q.progress.early], [true, ["B"], ["A"]]);
  assert.deepEqual(q.best.starts, { A: 0, B: 2 });
});

test("Chứng minh tối ưu bằng cận dưới khi không duyệt đầy đủ (method 'bound')", () => {
  const ak = P.solve(Samples.exerciseAK(), { strategy: "algorithm" }, {}, { maxMs: 1500 });
  assert.equal(ak.complete, false);
  assert.equal(ak.method, "bound", "không có nhân công, thời gian bằng cận dưới CPM");
  assert.equal(ak.best.metrics.duration, ak.bounds.duration);
  const many = { tasks: Array.from({ length: 11 }, (_, i) => t("T" + i, 1, 1)), capacity: 11 };
  const r = P.solve(many, { strategy: "algorithm", goal: "optimize", priority: "workforce", maxDuration: 1 });
  assert.equal(r.method, "bound");
  assert.equal(P.solve(many, { strategy: "algorithm", maxDuration: 1, allowCrash: true }).method, "heuristic");
  const early = P.solve(project, { strategy: "algorithm", capacity: 9, maxDuration: 15 }, {}, { maxMs: 0, maxEvaluations: 1 });
  if (early.method === "bound") {
    assert.equal(early.best.metrics.peak, early.bounds.peak);
    assert.equal(early.best.metrics.duration, early.bounds.duration);
  } else assert.equal(early.method, "heuristic");
});

test("Hạn tự đặt 125% CPM được đánh dấu; hạn nhập tay thì không", () => {
  const a = P.options({}, project);
  assert.deepEqual([a.maxDuration, a.deadlineAuto, a.deadlineBase], [8, true, 6]);
  assert.equal(P.options(a, project).deadlineAuto, true, "đọc lại cấu hình vẫn là tự đặt");
  const b = P.options({ maxDuration: 8 }, project);
  assert.deepEqual([b.maxDuration, b.deadlineAuto, b.deadlineBase], [8, false, 6]);
  assert.equal(P.options({ ...a, maxDuration: 12, deadlineAuto: false }, project).maxDuration, 12);
});

console.log(tests + " nhóm kiểm thử bộ xếp lịch đạt.");
