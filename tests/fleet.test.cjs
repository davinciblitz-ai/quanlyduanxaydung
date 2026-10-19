// Site vehicle motion: geometry, routes, construction plan and full 60 fps simulations (pure node).
const assert = require('node:assert/strict');
const F = require('../fleet.js');
const S = require('../construction-sequence.js');
const steps = S.steps, DT = 1 / 60, DEG = Math.PI / 180;
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

/* ---------------------------------------------------------------- geometry */
{
  const path = F.polyline([[0, 0], [10, 0], [10, 6]], 2);
  // Corner replaced by a quarter circle: length = 8 + π + 4.
  assert.ok(Math.abs(path.length - (8 + Math.PI + 4)) < 1e-9);
  let prev = path.sample(0);
  for (let s = 0.01; s <= path.length; s += 0.01) {
    const p = path.sample(s);
    assert.ok(Math.hypot(p.x - prev.x, p.z - prev.z) <= 0.01 + 1e-9, 'arc-length parameterised');
    assert.ok(Math.abs(wrap(p.yaw - prev.yaw)) < 0.01 / 2 + 1e-6, 'tangent heading is continuous');
    prev = p;
  }
  assert.ok(Math.abs(path.sample(9).curv) === 0.5, 'curvature 1/r on the fillet');
  const back = path.reversed();
  assert.ok(Math.abs(back.sample(0).x - 10) < 1e-9 && Math.abs(back.sample(0).z - 6) < 1e-9);
  assert.throws(() => F.polyline([[0, 0], [1, 0], [1, 5]], 3), /too tight/);
  assert.equal(F.overlaps({ x: 0, z: 0, yaw: 0.6, length: 2, width: 1 }, { x: 0.1, z: 0.1, yaw: -0.3, length: 2, width: 1 }), true);
  assert.equal(F.overlaps({ x: 0, z: 0, yaw: 0, length: 2, width: 1 }, { x: 2.5, z: 0, yaw: 0, length: 2, width: 1 }, 0.6), true);
  assert.equal(F.overlaps({ x: 0, z: 0, yaw: 0, length: 2, width: 1 }, { x: 2.5, z: 0, yaw: 0, length: 2, width: 1 }, 0.4), false);
  console.log('✓ Tuyến gồm đoạn thẳng và cung tròn nối tiếp, tham số theo chiều dài, hướng xe theo tiếp tuyến.');
}

/* ---------------------------------------------------------------- routes */
{
  for (const { kind, route } of F.allRoutes()) {
    const spec = F.SPECS[kind], [lo, hi] = F.activeRange(kind);
    for (const leg of route.legs) {
      if (leg.kind === 'pivot') { assert.equal(spec.tracked, true, route.label + ': only the tracked excavator may pivot'); continue; }
      for (const { seg } of leg.path.segments) if (seg.type === 'arc') assert.ok(seg.r >= spec.minRadius - 1e-9, route.label + ': turning radius ' + seg.r);
    }
    for (const p of route.samples) {
      for (const o of F.OBSTACLES) if (o.from < hi && o.to > lo) assert.ok(!F.boxHitsRect(p.box, o.rect), `${route.label} hits ${o.name} at ${p.x.toFixed(2)},${p.z.toFixed(2)}`);
      const limit = p.gear < 0 ? spec.vReverse : p.gear === 0 ? spec.pivotRate : spec.vRoad;
      assert.ok(p.vmax <= limit + 1e-9, route.label + ' speed limit');
      if (p.curv) assert.ok(p.vmax <= Math.sqrt(F.constants.A_LAT / Math.abs(p.curv)) + 1e-9, route.label + ' curvature speed limit');
      if (p.gear > 0 && p.z <= 2.05) assert.ok(p.vmax <= spec.vSite + 1e-9, route.label + ' site speed limit');
    }
    // Gear changes only at full stops.
    route.legs.forEach((leg, i) => {
      const next = route.legs[i + 1];
      if (next && next.gear !== leg.gear) assert.ok(route.stops.some(s => Math.abs(s - (leg.start + leg.length)) < 1e-6), route.label + ': gear change without a stop');
    });
  }
  // Arrival heading is the parked heading: no pirouette at the bay.
  for (const kind of Object.keys(F.BAYS)) {
    const end = F.inboundRoute(kind).samples.at(-1), box = F.footprintAt(F.SPECS[kind], end.x, end.z, end.yaw), bay = F.BAYS[kind];
    assert.ok(Math.abs(wrap(end.yaw - bay.yaw)) < 1e-6, kind + ' arrives with its parked heading');
    assert.ok(Math.hypot(box.x - bay.x, box.z - bay.z) < 1e-6, kind + ' arrives at its bay');
  }
  // Pump and mixer stand rear to rear (hopper fed by the chute), clear of each other.
  const pump = F.BAYS.pump, mixer = F.BAYS.mixer, gap = (mixer.z - F.SPECS.mixer.length / 2) - (pump.z + F.SPECS.pump.length / 2);
  assert.ok(Math.abs(wrap(pump.yaw - mixer.yaw - Math.PI)) < 1e-9 && gap > 0 && gap < 0.2, 'rear-to-rear docking');
  console.log('✓ Mọi tuyến tránh rào, hố móng, kho vật liệu; bán kính quay tối thiểu theo từng xe; chỉ đổi số khi dừng; đến nơi đúng hướng đỗ.');
}

/* ---------------------------------------------------------------- construction plan */
{
  const P = F.PLAN, pourSteps = steps.map((s, i) => i).filter(i => /Đổ bê tông|Bê tông lót/.test(steps[i].name));
  assert.equal(P.length, 131);
  for (let i = 0; i < P.length; i++) {
    const n = P[i], name = steps[i].name;
    assert.equal(n.pour, pourSteps.includes(i), 'pour window = pour steps: ' + name);
    assert.equal(n.mixer === 'pour', n.pour);
    assert.equal(n.dumper !== null, /Đào đất|Rải và san/.test(name), 'dump trucks: ' + name);
    if (/Đào đất/.test(name)) assert.equal(n.excavator, 'dig');
    if (/Rải và san/.test(name)) assert.equal(n.excavator, 'spread', 'spreading fill has a machine');
    assert.equal(n.roller === 'compact', /Lu\/đầm/.test(name), 'roller compacts only compaction steps');
    if (n.pump) assert.ok(pourSteps.some(j => j >= i && j - i <= 2) || pourSteps.some(j => j < i && i - j <= 2), 'pump never idles far from a pour: ' + name);
  }
  assert.equal(P[3].mixer, 'pour', 'blinding concrete gets a mixer');
  // No machine sits through dozens of steps: longest presence runs are short.
  for (const key of ['pump', 'mixer', 'excavator', 'roller', 'dumper']) {
    let run = 0, longest = 0;
    for (const n of P) { run = n[key] ? run + 1 : 0; longest = Math.max(longest, run); }
    assert.ok(longest <= 8, key + ' present for ' + longest + ' consecutive steps');
  }
  const status = F.plan(steps[6].p);
  assert.deepEqual([status.pump, status.mixer, status.excavator, status.roller, status.dumpTruck], [true, true, false, false, false]);
  console.log('✓ Điều xe theo bước thi công: đào–xe ben, bê tông lót, bơm + bồn đúng các bước đổ, xe lu khi đầm, không xe nào chờ hàng chục bước.');
}

/* ---------------------------------------------------------------- simulations */
function simulate(name, schedule, seconds, checks = {}) {
  const fleet = F.createFleet(), prev = new Map(), stopped = new Map(), queued = new Map();
  const report = { name, overlaps: [], slips: [], spins: [], stalls: [], queues: [], late: [], ghosts: [], pourSteps: [], jerks: [] };
  const speed = new Map();
  let t = 0, current = null;
  for (let frame = 0; frame < seconds / DT; frame++) {
    t += DT;
    const out = fleet.update(DT, { progress: schedule(t) });
    const visible = out.filter(v => v.visible);
    for (let a = 0; a < visible.length; a++) for (let b = a + 1; b < visible.length; b++)
      if (F.overlaps(visible[a], visible[b], 0)) report.overlaps.push({ t, a: visible[a].id, b: visible[b].id });
    for (const v of out) {
      const o = prev.get(v.id);
      if (o && o.visible && v.visible && v.mode === 'drive' && o.mode === 'drive' && v.gear) {
        const dx = v.refX - o.refX, dz = v.refZ - o.refZ;
        if (Math.hypot(dx, dz) > 1e-4) {
          const heading = v.gear < 0 ? v.yaw + Math.PI : v.yaw, slip = Math.abs(wrap(Math.atan2(-dz, dx) - heading));
          if (slip > 5 * DEG) report.slips.push({ t, id: v.id, slip: slip / DEG });
          const spun = v.odo - o.odo;
          if (Math.abs(spun) > 1e-6 && Math.sign(spun) !== Math.sign(v.gear)) report.spins.push({ t, id: v.id });
        }
      }
      prev.set(v.id, v);
    }
    for (const v of fleet.vehicles) {
      // Trapezoidal profile: never faster than the route allows, never accelerating harder than A_ACC.
      const last = speed.get(v.id);
      if (v.mode === 'drive') {
        if (last !== undefined && (v.v - last) / DT > F.constants.A_ACC + 1e-6) report.jerks.push({ t, id: v.id, accel: (v.v - last) / DT });
        const p = v.route.samples[v.k], limit = Math.max(p.vmax, v.route.samples[Math.min(v.k + 1, v.route.samples.length - 1)].vmax) + 0.06;
        if (v.v > limit) report.jerks.push({ t, id: v.id, v: v.v, limit });
      }
      speed.set(v.id, v.mode === 'drive' ? v.v : undefined);
      const moving = v.mode === 'drive' && (v.v > 0.01 || v.pause > 0), waiting = v.mode === 'drive' && !moving;
      // Stopped mid-route while holding site zones = gridlock symptom. Waiting at a queue/bay is fine (bounded below).
      const s = waiting && v.held.size && v.s > 1e-6 ? (stopped.get(v.id) || 0) + DT : 0;
      stopped.set(v.id, s);
      if (s > 10) report.stalls.push({ t, id: v.id, x: v.pose.x, z: v.pose.z, step: fleet.applied });
      const q = waiting ? (queued.get(v.id) || 0) + DT : 0;
      queued.set(v.id, q);
      if (q > 60) report.queues.push({ t, id: v.id });
    }
    // Per applied step: pump and a mixer in position within the time budget; something actually pours.
    if (fleet.applied !== current?.step) {
      if (current && F.PLAN[current.step].pour) report.pourSteps.push(current);
      current = { step: fleet.applied, start: t, pump: null, mixer: null, pouring: null, jump: fleet.events.at(-1)?.jump, kinds: null };
    }
    const age = t - current.start;
    if (F.PLAN[current.step].pour) {
      if (current.pump === null && out.some(v => v.kind === 'pump' && v.docked && v.alpha > 0.99)) current.pump = age;
      if (current.mixer === null && out.some(v => v.kind === 'mixer' && v.docked && v.alpha > 0.99)) current.mixer = age;
      if (current.pouring === null && fleet.pouringMixer) current.pouring = age;
    }
    // After a jump nothing replays: once fades are done only machines the step needs are on site.
    if (current.jump && age > 1 && age < 1.2 && !current.kinds) {
      current.kinds = true;
      const need = fleet.needs;
      for (const v of visible) if (!(v.kind === 'dumper' ? need.dumper : need[v.kind])) report.ghosts.push({ t, id: v.id, step: current.step });
    }
    checks.frame?.(fleet, out, t);
  }
  if (current && F.PLAN[current.step].pour) report.pourSteps.push({ ...current, end: true });
  report.late = report.pourSteps.filter(p => t - p.start > 3 && (p.pump === null || p.pump > F.constants.BUDGET + 0.6 || p.mixer === null || p.mixer > F.constants.BUDGET + 0.6));
  return report;
}
function expectClean(r) {
  const head = list => JSON.stringify(list.slice(0, 3));
  assert.equal(r.jerks.length, 0, r.name + ': speed/acceleration profile violated ' + head(r.jerks));
  assert.equal(r.overlaps.length, 0, r.name + ': vehicle footprints overlap ' + head(r.overlaps));
  assert.equal(r.slips.length, 0, r.name + ': slip angle over 5° ' + head(r.slips));
  assert.equal(r.spins.length, 0, r.name + ': wheel spin against the gear ' + head(r.spins));
  assert.equal(r.stalls.length, 0, r.name + ': vehicle stuck > 10 s inside the site ' + head(r.stalls));
  assert.equal(r.queues.length, 0, r.name + ': vehicle waiting > 60 s ' + head(r.queues));
  assert.equal(r.ghosts.length, 0, r.name + ': unneeded machines after a jump ' + head(r.ghosts));
  assert.equal(r.late.length, 0, r.name + ': pump/mixer not in position within the budget ' + head(r.late));
}

// 1. Jump from step 1 to every step: required machines appear at their work pose, nothing replays.
{
  let pours = 0;
  for (let target = 0; target < steps.length; target++) {
    const r = simulate('jump 1 → ' + (target + 1), t => (t < 3 ? steps[0].p : steps[target].p), 30);
    expectClean(r);
    for (const p of r.pourSteps) { pours++; assert.ok(p.pouring !== null && p.pouring <= 3, r.name + ': concrete flows within ~2 s'); }
  }
  assert.equal(pours, F.PLAN.filter(n => n.pour).length);
  console.log('✓ Nhảy từ bước 1 tới từng bước (131 lần): xe cần thiết đặt ngay vào vị trí làm việc, không chạy lại chuyến, đổ bê tông trong ~2 s.');
}

// 2. Clicking "Tiếp" every 2–4 s through the whole sequence, and a slower 12 s pace.
{
  const times = [];
  let t = 1;
  for (let i = 0; i < steps.length; i++) { times.push(t); t += 2 + ((i * 7) % 3); }
  const at = time => { let i = 0; while (i < times.length - 1 && times[i + 1] <= time) i++; return steps[i].p; };
  const fast = simulate('next every 2-4 s', at, times.at(-1) + 40);
  expectClean(fast);
  assert.equal(fast.pourSteps.length, F.PLAN.filter(n => n.pour).length);
  const slow = simulate('next every 12 s', time => steps[Math.min(steps.length - 1, Math.floor(time / 12))].p, 12 * 60);
  expectClean(slow);
  assert.ok(slow.pourSteps.every(p => p.pouring !== null), 'every pour step pours');
  console.log('✓ Bấm "Tiếp" liên tục mỗi 2–4 s và mỗi 12 s: không kẹt xe, không va chạm, bơm + bồn luôn sẵn sàng ở bước đổ.');
}

// 3. Autoplay of a 300-day project with the same progress formula as app.js (one day per 0.5 s).
{
  const bounds = [0, 0.1, 0.18, 0.26, 0.4, 0.72, 0.98, 1], tasks = [];
  let day = 0;
  const add = (stage, duration, lag = 0) => { day += lag; tasks.push({ stage, es: day, duration }); day += duration; };
  add(0, 8); add(1, 10); add(2, 18); add(3, 4); add(3, 12, 1); add(3, 3); add(3, 12, 3);
  for (let i = 0; i < 12; i++) add(4, 15);
  add(5, 40); add(6, 9);
  assert.ok(day >= 300 && day < 310);
  const progress = d => {
    let w = 0;
    for (let i = 0; i < 7; i++) {
      const rows = tasks.filter(t => t.stage === i);
      const v = rows.reduce((s, t) => s + Math.max(0, Math.min(1, (d - t.es) / t.duration)), 0) / rows.length;
      if (v > 0) w = Math.max(w, bounds[i] + (bounds[i + 1] - bounds[i]) * v);
    }
    return w;
  };
  const seen = new Set();
  const r = simulate('autoplay ' + day + ' days', t => progress(Math.min(day, Math.floor(t / 0.5))), day * 0.5 + 40, {
    frame(fleet, out) {
      if (fleet.pouringMixer) seen.add('pour' + fleet.applied);
      if (out.some(v => v.kind === 'roller' && v.purpose === 'pass')) seen.add('roll');
      if (out.some(v => v.kind === 'excavator' && v.mode === 'work') && fleet.needs.excavator === 'dig') seen.add('dig');
    },
  });
  expectClean(r);
  assert.ok(seen.has('pour6'), 'the footing pour is shown during autoplay');
  assert.ok(seen.has('roll') && seen.has('dig'), 'excavation and compaction are shown');
  console.log('✓ Tự chạy dự án ' + day + ' ngày: thấy đào đất, đổ móng, lu đầm và đổ bê tông các tầng; không kẹt, không va chạm.');
}

// 4. Work cycles: the excavator fills a dump truck, mixers queue and swap at the pump, the pump never stretches its stay.
{
  let loaded = false, queued = false, tipped = false;
  simulate('excavation', () => steps[2].p, 90, { frame(fleet) { if (fleet.vehicles.some(v => v.kind === 'dumper' && v.task === 'haul' && v.purpose === 'out' && v.load >= 0.99)) loaded = true; } });
  simulate('pour', () => steps[6].p, 120, { frame(fleet) { const docked = fleet.vehicles.find(v => v.kind === 'mixer' && v.docked); if (docked && fleet.vehicles.some(v => v.kind === 'mixer' && v !== docked && v.mode === 'drive' && v.purpose === 'in')) queued = true; } });
  simulate('spreading', () => steps[9].p, 60, { frame(fleet) { if (fleet.vehicles.some(v => v.kind === 'dumper' && v.bed > 0.95)) tipped = true; } });
  assert.ok(loaded, 'excavator loads the dump truck to full');
  assert.ok(queued, 'next mixer queues while one discharges');
  assert.ok(tipped, 'dump truck tips fill on site, not on the road');
  // Leaving the pour: everything drives out and the site empties without help.
  const fleet = F.createFleet();
  for (let i = 0; i < 40 / DT; i++) fleet.update(DT, { progress: steps[6].p });
  for (let i = 0; i < 90 / DT; i++) fleet.update(DT, { progress: steps[7].p });
  assert.deepEqual(fleet.vehicles.filter(v => v.mode !== 'off').map(v => v.id), [], 'machines leave when the step no longer needs them');
  console.log('✓ Xe đào đổ đầy xe ben; xe bồn xếp hàng và thay nhau cấp cho xe bơm; xe ben đổ đất trong công trường; xe rời đi khi hết việc.');
}
