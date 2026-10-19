// Xe không bao giờ chạm vào công trình đang hiện (giàn giáo, tháp cầu thang, chân cẩu, rào, vật tư).
// Lỗi gốc: bấm "Tiếp" nhanh/tua qua giai đoạn lấp đất → giàn giáo dựng ngay trong khi máy đào còn
// đứng ở chỗ đỗ (trùng chân tháp cầu thang) hoặc đang lái ra xuyên qua cầu thang.
const assert = require('node:assert/strict');
const F = require('../fleet.js');
const S = require('../construction-sequence.js');
const steps = S.steps, DT = 1 / 60;

const body = (v) => ({ x: v.x, z: v.z, yaw: v.yaw, length: v.length, width: v.width });
const rectBox = ([x0, x1, z0, z1]) => ({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, yaw: 0, length: x1 - x0, width: z1 - z0 });
const active = (p) => F.OBSTACLES.filter((o) => p >= o.from && p <= o.to);

/** Chạy mô phỏng 60 khung/giây; cảnh "đang hiển thị" trễ theo tiến trình đích như lerp trong webgl-scene. */
function run(name, schedule, seconds) {
  const fleet = F.createFleet();
  let view = schedule(0), frames = 0;
  for (let t = 0; t < seconds; t += DT) {
    const progress = schedule(t);
    view += (progress - view) * (1 - Math.exp(-6 * DT));
    const out = fleet.update(DT, { progress, view });
    const built = [...new Set([...active(progress), ...active(view)])];
    for (const v of out) {
      if (!v.visible) continue;
      const box = body(v);
      for (const o of built)
        assert.ok(!F.overlaps(box, rectBox(o.rect), 0), `${name}: ${v.kind} chạm ${o.name} lúc t=${t.toFixed(2)} s (p=${progress.toFixed(3)})`);
    }
    frames++;
  }
  return frames;
}

{
  const fleet = F.createFleet();
  for (let i = 0; i < 30 / DT; i++) fleet.update(DT, { progress: steps[2].p });
  assert.ok(fleet.update(DT, { progress: steps[2].p }).some((v) => v.kind === 'excavator' && v.visible), 'máy đào có mặt khi đào đất');
}

// 1) Chỗ làm việc của mọi xe cần cho một bước không nằm trong công trình đang hiện ở bước đó.
for (const [i, step] of steps.entries()) {
  const fleet = F.createFleet(), out = fleet.update(DT, { progress: step.p, reduced: true });
  for (const v of out) {
    if (!v.visible) continue;
    const box = body(v);
    for (const o of active(step.p))
      assert.ok(!F.overlaps(box, rectBox(o.rect), 0), `bước ${i + 1} (${step.name}): ${v.kind} đứng trong ${o.name}`);
  }
}
console.log('✓ Chỗ đỗ/làm việc của xe ở cả 131 bước không trùng giàn giáo, tháp cầu thang, chân cẩu hay vật tư.');

// 2) Bấm "Tiếp" nhanh qua giai đoạn lấp đất → dựng tầng (tình huống trong ảnh lỗi).
const earth = steps.findIndex((s) => /Rải và san đất · lớp 1/.test(s.name));
for (const gap of [0.4, 0.8, 1.5, 3]) {
  run('Tiếp mỗi ' + gap + ' s', (t) => steps[Math.min(steps.length - 1, earth + Math.floor(t / gap))].p, 40);
}
// 3) Tua thẳng từ đào đất / lấp đất sang tầng 1, tầng 5 và tua lùi.
for (const [from, to] of [[2, 23], [9, 18], [15, 40], [40, 12], [60, 2], [16, 17]]) {
  run('Tua ' + (from + 1) + '→' + (to + 1), (t) => steps[t < 20 ? from : to].p, 35);
}
// 4) Tự chạy liên tục toàn bộ trình tự, nhanh và chậm.
for (const per of [0.5, 2]) run('Tự chạy ' + per + ' s/bước', (t) => steps[Math.min(steps.length - 1, Math.floor(t / per))].p, steps.length * per + 10);
console.log('✓ Bấm Tiếp nhanh, tua tới/lui và tự chạy: không xe nào chạm công trình đang hiện ở bất kỳ khung hình nào.');
