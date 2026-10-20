"use strict";
const assert = require("node:assert/strict"),
  CT = require("../engine.js"),
  vm = require("node:vm"),
  fs = require("node:fs"),
  crypto = require("node:crypto");
const context = { window: {}, CT, crypto };
vm.runInNewContext(
  fs.readFileSync(require.resolve("../samples.js"), "utf8"),
  context,
);
const Samples = context.window.Samples;
let count = 0;
function test(name, fn) {
  fn();
  count++;
  console.log("✓ " + name);
}
const task = (id, duration, deps = "", cost = 0) => ({
  id,
  name: id,
  duration,
  minDuration: duration,
  deps: CT.parseDeps(deps),
  cost,
  actualCost: 0,
  workers: 0,
  progress: 0,
  crashSlope: 0,
});
const close = (a, b, e = 1e-7) =>
  assert.ok(Math.abs(a - b) <= e, `${a} ≠ ${b}`);
test("Bài A–G trong Word: 25 ngày, A–D–F–G găng", () => {
  const p = Samples.textbook(),
    r = CT.schedule(p.tasks);
  assert.equal(r.duration, 25);
  assert.equal(r.critical.join(","), "A,D,F,G");
  assert.equal(
    p.tasks.reduce((s, t) => s + t.cost, 0),
    450,
  );
});
test("Tìm kiếm đủ 360 tổ hợp: 22 ngày, trực tiếp 525, tổng 775", () => {
  const p = Samples.textbook(),
    o = CT.optimize(p.tasks, 400, 50);
  assert.equal(o.combinations, 360);
  assert.equal(o.best.duration, 22);
  assert.equal(o.best.direct, 525);
  assert.equal(o.best.indirect, 250);
  assert.equal(o.best.total, 775);
  assert.equal(o.scenarios.find((s) => s.duration === 21).direct, 610);
});
test("FS, SS, FF, SF và lag dương/âm độc lập", () => {
  for (const [type, lag, expected] of [
    ["FS", 2, 12],
    ["FS", -3, 7],
    ["SS", 2, 2],
    ["FF", 2, 8],
    ["SF", 7, 3],
    ["SF", 0, 0],
  ]) {
    const r = CT.schedule([
      task("A", 10),
      task("B", 4, `A:${type}${lag >= 0 ? "+" : ""}${lag}`),
    ]);
    assert.equal(r.rows[1].es, expected);
  }
});
test("SF thực sự có hiệu lực với predecessor bắt đầu sau mốc 0", () => {
  const r = CT.schedule([
    task("A", 8),
    task("B", 3, "A"),
    task("C", 4, "B:SF+2"),
  ]);
  assert.equal(r.rows[2].es, 6);
  assert.equal(r.rows[2].ef, 10);
});
test("Đa tiền nhiệm chọn ràng buộc lớn nhất và tính dự trữ", () => {
  const r = CT.schedule([task("A", 4), task("B", 7), task("C", 3, "A,B")]);
  assert.equal(r.duration, 10);
  assert.equal(r.rows[0].tf, 3);
  assert.equal(r.rows[0].ff, 3);
  assert.equal(r.rows[1].tf, 0);
});
test("Nhiều đường găng được giữ đồng thời", () => {
  const r = CT.schedule([task("A", 5), task("B", 5), task("C", 2, "A,B")]);
  assert.equal(r.critical.join(","), "A,B,C");
  assert.equal(r.edges.filter((e) => e.critical).length, 2);
});
test("Công việc độc lập, mốc 0 ngày và mạng rỗng", () => {
  assert.equal(CT.schedule([]).duration, 0);
  const r = CT.schedule([task("A", 3), task("B", 0, "A"), task("C", 5)]);
  assert.equal(r.duration, 5);
  assert.equal(r.rows[0].tf, 2);
  assert.equal(r.rows[1].duration, 0);
});
test("Chặn vòng, tự phụ thuộc, trùng mã, mã thiếu, thời lượng sai", () => {
  assert.throws(
    () => CT.schedule([task("A", 1, "B"), task("B", 1, "A")]),
    /vòng lặp/,
  );
  assert.throws(() => CT.schedule([task("A", 1, "A")]));
  assert.throws(() => CT.schedule([task("A", 1), task("A", 2)]));
  assert.throws(() => CT.schedule([task("A", 1, "Z")]));
  assert.throws(() => CT.schedule([task("A", -1)]));
  assert.throws(() => CT.schedule([task("A", 1.5)]));
  assert.throws(() => CT.schedule([{ ...task("A", 1), duration: null }]));
});
test("Cú pháp quan hệ, lag âm, mặc định FS và lỗi cú pháp", () => {
  assert.equal(
    CT.depText(CT.parseDeps("A; B:SS-2; C:FF+3")),
    "A:FS+0, B:SS-2, C:FF+3",
  );
  assert.throws(() => CT.parseDeps("A:FS+abc"));
  assert.throws(() => CT.parseDeps("A:XX"));
});
test("200 DAG: ES/LS khả thi, TF tối đa đối chiếu mọi lịch nguyên nhỏ", () => {
  let seed = 71;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let trial = 0; trial < 200; trial++) {
    const ts = [
      task("A", Math.floor(rnd() * 4)),
      task("B", Math.floor(rnd() * 4)),
      task("C", Math.floor(rnd() * 4)),
    ];
    for (let j = 1; j < 3; j++)
      for (let i = 0; i < j; i++)
        if (rnd() < 0.65)
          ts[j].deps.push({
            id: ts[i].id,
            type: ["FS", "SS", "FF", "SF"][Math.floor(rnd() * 4)],
            lag: Math.floor(rnd() * 5) - 2,
          });
    const r = CT.schedule(ts),
      latest = [0, 0, 0];
    let feasible = 0;
    for (let a = 0; a <= r.duration; a++)
      for (let b = 0; b <= r.duration; b++)
        for (let c = 0; c <= r.duration; c++) {
          const starts = [a, b, c];
          if (starts.some((v, i) => v + ts[i].duration > r.duration)) continue;
          if (
            r.edges.some(
              (e) =>
                starts[ts.findIndex((t) => t.id === e.to)] <
                starts[ts.findIndex((t) => t.id === e.from)] + e.w,
            )
          )
            continue;
          feasible++;
          starts.forEach((s, i) => (latest[i] = Math.max(latest[i], s)));
        }
    assert.ok(feasible);
    r.rows.forEach((t, i) => {
      assert.equal(t.ls, latest[i]);
      assert.ok(t.tf >= 0);
      assert.ok(t.ff >= 0);
    });
    r.edges.forEach((e) => {
      const a = r.rows.find((t) => t.id === e.from),
        b = r.rows.find((t) => t.id === e.to);
      assert.ok(b.es >= a.es + e.w);
      assert.ok(b.ls >= a.ls + e.w);
    });
  }
});
test("Đặt trần không gian tối ưu, chặn lãi NaN", () => {
  const t = task("A", 1000);
  t.minDuration = 0;
  assert.throws(() => CT.optimize([t], 0, 0, 100));
  assert.throws(() => CT.loan(10, NaN, 12));
});
test("BOQ: khối lượng × 3 thành phần, chi phí chung, dự phòng và thuế", () => {
  const e = CT.estimate([{ qty: 2, material: 100, labor: 30, machine: 20 }], {
    overhead: 10,
    other: 20,
    contingency: 5,
    vat: 8,
  });
  close(e.direct, 300);
  close(e.overhead, 30);
  close(e.contingency, 17.5);
  close(e.total, 396.9);
});
test("Khoản vay lãi 0, gốc đều và trả tổng đều", () => {
  const zero = CT.loan(1200, 0, 12);
  close(zero.interest, 0);
  close(zero.rows[0].payment, 100);
  const tiny = CT.loan(1200, 1e-14, 12);
  tiny.rows.forEach((row) => close(row.payment, 100, 1e-8));
  for (const method of ["annuity", "principal"]) {
    const r = CT.loan(100000000, 12, 24, method);
    close(
      r.rows.reduce((s, t) => s + t.capital, 0),
      100000000,
      0.01,
    );
    assert.equal(r.rows.at(-1).balance, 0);
    r.rows.forEach((t, i) => {
      close(t.interest, (i ? r.rows[i - 1].balance : 100000000) * 0.01, 0.001);
    });
    if (method === "annuity")
      close(r.rows[0].payment, r.rows[23].payment, 0.01);
    else close(r.rows[0].capital, r.rows[23].capital, 0.01);
  }
});
test("NPV/IRR nghiệm 10%, kiểm tra hoàn vốn và dòng đổi dấu nhiều lần", () => {
  const a = CT.appraisal([-100, 110], 10);
  close(a.npv, 0);
  close(a.irr, 0.1);
  close(a.payback, 100 / 110);
  const b = CT.appraisal([-100, 230, -132], 10);
  assert.equal(b.irr, null);
  assert.match(b.irrNote, /nhiều/);
  assert.equal(CT.appraisal([-100, -10], 10).irr, null);
});
test("EVM: PV, EV, AC, CPI, SPI, EAC; mẫu số 0", () => {
  const r = CT.schedule([
    { ...task("A", 10, "", 1000), progress: 40, actualCost: 500 },
  ]);
  const e = CT.evm(r.rows, 5);
  assert.equal(e.pv, 500);
  assert.equal(e.ev, 400);
  assert.equal(e.cpi, 0.8);
  assert.equal(e.spi, 0.8);
  assert.equal(e.eac, 1250);
  assert.equal(CT.evm([], 0).cpi, null);
});
test("Lịch 5/6/7 ngày, ngày nghỉ, năm nhuận và ngày không tồn tại", () => {
  assert.equal(CT.dateAt("2026-10-18", 0, [1, 2, 3, 4, 5]), "2026-10-19");
  assert.equal(CT.dateAt("2026-10-19", 5, [1, 2, 3, 4, 5]), "2026-10-26");
  assert.equal(CT.dateAt("2024-02-28", 1, [0, 1, 2, 3, 4, 5, 6]), "2024-02-29");
  assert.throws(() => CT.dateAt("2026-02-30", 0, [1]));
  assert.throws(() => CT.dateAt("2026-10-19", 0, []));
});
test("EVM mở rộng: ETC, VAC, TCPI, EAC theo ngân sách và theo CPI×SPI", () => {
  const r = CT.schedule([{ ...task("A", 10, "", 1000), progress: 40, actualCost: 500 }]);
  const e = CT.evm(r.rows, 5);
  assert.equal(e.etc, 750);
  assert.equal(e.vac, -250);
  close(e.tcpi, 600 / 500);
  assert.equal(e.eacBudget, 1100);
  close(e.eacCpiSpi, 500 + 600 / 0.64);
  assert.equal(e.percentComplete, 0.4);
});
test("Rút ngắn không biến công tác có thời lượng thành mốc 0 ngày", () => {
  const o = CT.optimize([{ ...task("A", 5, "", 100), minDuration: 0, crashSlope: 10 }], 1000, 100);
  assert.equal(Math.min(...o.scenarios.map((s) => s.duration)), 1);
  assert.equal(o.combinations, 5);
});
test("Dự toán có thu nhập chịu thuế tính trước: TL = (T + C) × %", () => {
  const e = CT.estimate([{ qty: 10, material: 50, labor: 30, machine: 20 }], { overhead: 6.5, contingency: 5, vat: 8, other: 0, profit: 6 });
  close(e.overhead, 65);
  close(e.profit, (1000 + 65) * 0.06);
  close(e.total, (1000 + 65 + 63.9) * 1.05 * 1.08);
  assert.equal(CT.estimate([], { overhead: 0, contingency: 0, vat: 0, other: 0 }).profit, 0);
});
test("Hoàn vốn có chiết khấu và chỉ số sinh lời PI", () => {
  const a = CT.appraisal([-1000, 600, 600], 10);
  close(a.payback, 1 + 400 / 600);
  const pv1 = 600 / 1.1, pv2 = 600 / 1.21;
  close(a.discountedPayback, 1 + (1000 - pv1) / pv2);
  close(a.pi, (pv1 + pv2) / 1000);
});
test("Hoàn vốn: phân biệt dòng tiền không hợp lệ/rỗng với dòng tiền không bao giờ hoàn vốn", () => {
  const empty = CT.appraisal([0, 0], 0);
  assert.equal(empty.valid, false);
  assert.equal(empty.empty, true);
  assert.equal(empty.payback, null);
  assert.equal(empty.discountedPayback, null);
  const allOut = CT.appraisal([-100, -10], 10);
  assert.equal(allOut.valid, false);
  assert.equal(allOut.empty, false);
  assert.equal(allOut.payback, null);
  const never = CT.appraisal([-1000, 100, 100], 10);
  assert.equal(never.valid, true);
  assert.equal(never.empty, false);
  assert.equal(never.payback, null);
  assert.equal(never.discountedPayback, null);
  const ok = CT.appraisal([-100, 110], 10);
  assert.equal(ok.valid, true);
  close(ok.discountedPayback, 1);
  close(CT.appraisal([-100, 230, -132], 10).payback, 100 / 230);
  close(CT.appraisal([0, -100, 200], 0).payback, 1.5);
  assert.equal(CT.appraisal([100, -50, 20], 0).payback, 0);
});
test("Mẫu công trình: cờ sample, AC riêng khác EV, công việc chưa bắt đầu AC = 0", () => {
  const p = Samples.construction();
  assert.equal(p.sample, true);
  const started = p.tasks.filter((t) => t.progress > 0);
  assert.ok(started.length > 0);
  started.forEach((t) => {
    assert.ok(t.actualCost > 0, t.id);
    assert.notEqual(t.actualCost, (t.cost * t.progress) / 100, t.id);
  });
  assert.ok(started.some((t) => t.actualCost > (t.cost * t.progress) / 100));
  assert.ok(started.some((t) => t.actualCost < (t.cost * t.progress) / 100));
  p.tasks.filter((t) => !t.progress).forEach((t) => assert.equal(t.actualCost, 0, t.id));
  const e = CT.evm(CT.schedule(p.tasks).rows, p.statusDay);
  assert.equal(e.ev, 96200000);
  assert.equal(e.ac, 101780000);
  close(e.cpi, 96200000 / 101780000);
  assert.ok(e.cpi > 0.9 && e.cpi < 1.05);
  for (const make of [Samples.textbook, Samples.group, Samples.exerciseAK, Samples.empty]) {
    const q = make();
    assert.equal(q.sample, undefined);
    q.tasks.forEach((t) => assert.equal(t.actualCost, 0));
  }
});
test("Lịch có ngày nghỉ lễ: bỏ qua ngày lễ và kiểm tra định dạng", () => {
  assert.equal(CT.dateAt("2026-04-29", 1, [1, 2, 3, 4, 5, 6], ["2026-04-30", "2026-05-01"]), "2026-05-02");
  assert.equal(CT.dateAt("2026-04-30", 0, [1, 2, 3, 4, 5, 6], ["2026-04-30", "2026-05-01"]), "2026-05-02");
  assert.throws(() => CT.dateAt("2026-04-29", 1, [1], ["30/04/2026"]));
});
console.log(`\n${count} nhóm kiểm thử đạt.`);
