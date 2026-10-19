/*
 * Construction-site vehicle motion (pure JS, no three.js; runs in the browser and in node tests).
 *
 *  - Routes are straight lines + tangent arcs (filleted corners), parameterised by arc length.
 *    The route point is the vehicle's rear axle (pivot centre for the tracked excavator),
 *    heading = path tangent (+π while reversing); gear changes only at explicit stops.
 *  - Speed follows a trapezoidal profile: accel/brake limits, road/site/reverse limits,
 *    curvature limit, and v <= sqrt(2·a·distance-to-stop).
 *  - Right of way: the site and the lane in front of it are a grid of zones. A vehicle reserves
 *    every zone its footprint will touch up to the next safe stop (free road or its bay) in one
 *    atomic, first-come-first-served grant and releases zones behind its tail. Vehicles only wait
 *    while holding nothing (free road) or while parked in their own bay, so no circular wait can
 *    form. Car following (≥0.6 gap) keeps the free road queues apart.
 *  - Missions come from the TARGET construction step (debounced), never from smoothed progress.
 *
 * Coordinates: x east, z south (toward the public road), units ≈ 3.2 m. three.js yaw convention:
 * rotation.y = yaw and the vehicle front is local +x, so forward = (cos yaw, -sin yaw).
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FleetMotion = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  /* ------------------------------------------------------------------ helpers */
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
  const smooth = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  const yawOf = (dx, dz) => Math.atan2(-dz, dx);
  const forward = yaw => [Math.cos(yaw), -Math.sin(yaw)];
  const approach = (value, target, rate) => value + clamp(target - value, -rate, rate);

  /* ------------------------------------------------------------------ geometry */
  function line(x0, z0, x1, z1) {
    const dx = x1 - x0, dz = z1 - z0, length = Math.hypot(dx, dz), ux = length ? dx / length : 1, uz = length ? dz / length : 0, yaw = yawOf(ux, uz);
    return {
      type: 'line', length, x0, z0, x1, z1,
      at: t => ({ x: x0 + ux * t, z: z0 + uz * t, yaw, curv: 0 }),
      reversed: () => line(x1, z1, x0, z0),
      slice: (a, b) => line(x0 + ux * a, z0 + uz * a, x0 + ux * b, z0 + uz * b),
    };
  }
  // Arc around (cx, cz); a0 is the polar angle (atan2(z-cz, x-cx)) of the start, sweep is signed.
  function arc(cx, cz, r, a0, sweep) {
    const dir = Math.sign(sweep) || 1, length = Math.abs(sweep) * r;
    return {
      type: 'arc', length, cx, cz, r, a0, sweep,
      at: t => {
        const a = a0 + dir * t / r;
        return { x: cx + r * Math.cos(a), z: cz + r * Math.sin(a), yaw: yawOf(-Math.sin(a) * dir, Math.cos(a) * dir), curv: -dir / r };
      },
      reversed: () => arc(cx, cz, r, a0 + sweep, -sweep),
      slice: (a, b) => arc(cx, cz, r, a0 + dir * a / r, dir * (b - a) / r),
    };
  }
  class Path {
    constructor(segments) {
      this.segments = [];
      let s = 0;
      for (const seg of segments) { if (seg.length < 1e-7) continue; this.segments.push({ seg, start: s }); s += seg.length; }
      this.length = s;
    }
    sample(s) {
      const list = this.segments;
      if (!list.length) return null;
      let i = 0;
      while (i < list.length - 1 && s > list[i].start + list[i].seg.length) i++;
      return list[i].seg.at(clamp(s - list[i].start, 0, list[i].seg.length));
    }
    reversed() { return new Path(this.segments.slice().reverse().map(({ seg }) => seg.reversed())); }
    slice(a, b) {
      const out = [];
      for (const { seg, start } of this.segments) {
        const lo = Math.max(a, start), hi = Math.min(b, start + seg.length);
        if (hi - lo > 1e-7) out.push(seg.slice(lo - start, hi - start));
      }
      return new Path(out);
    }
    static concat(...paths) { return new Path(paths.flatMap(p => p.segments.map(e => e.seg))); }
  }
  // Polyline through `points` with every corner replaced by a tangent arc of `radius`.
  function polyline(points, radius) {
    const segs = [];
    let cur = points[0];
    for (let i = 1; i < points.length; i++) {
      const p = points[i], q = points[i + 1];
      if (!q) { segs.push(line(cur[0], cur[1], p[0], p[1])); break; }
      const ul = Math.hypot(p[0] - cur[0], p[1] - cur[1]), wl = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const ux = (p[0] - cur[0]) / ul, uz = (p[1] - cur[1]) / ul, wx = (q[0] - p[0]) / wl, wz = (q[1] - p[1]) / wl;
      const turn = Math.atan2(ux * wz - uz * wx, ux * wx + uz * wz);
      if (Math.abs(turn) < 1e-6) continue;
      const t = radius * Math.tan(Math.abs(turn) / 2);
      if (t > ul + 1e-6 || t > wl + 1e-6) throw new Error('Corner too tight for radius ' + radius + ' at ' + p);
      const a = [p[0] - ux * t, p[1] - uz * t], sgn = Math.sign(turn);
      const cx = a[0] - uz * sgn * radius, cz = a[1] + ux * sgn * radius;
      segs.push(line(cur[0], cur[1], a[0], a[1]));
      segs.push(arc(cx, cz, radius, Math.atan2(a[1] - cz, a[0] - cx), sgn * Math.abs(turn)));
      cur = [p[0] + wx * t, p[1] + wz * t];
    }
    return new Path(segs);
  }

  // Oriented rectangle overlap (separating axis test). Each box grows by gap/2 on every side.
  function overlaps(a, b, gap = 0.04) {
    if (a.visible === false || b.visible === false) return false;
    const axes = p => [[Math.cos(p.yaw || 0), -Math.sin(p.yaw || 0)], [Math.sin(p.yaw || 0), Math.cos(p.yaw || 0)]];
    const aa = axes(a), bb = axes(b), dx = b.x - a.x, dz = b.z - a.z;
    for (const axis of [...aa, ...bb]) {
      const radius = (p, ax) => (p.length + gap) / 2 * Math.abs(ax[0][0] * axis[0] + ax[0][1] * axis[1]) + (p.width + gap) / 2 * Math.abs(ax[1][0] * axis[0] + ax[1][1] * axis[1]);
      if (Math.abs(dx * axis[0] + dz * axis[1]) >= radius(a, aa) + radius(b, bb)) return false;
    }
    return true;
  }
  function turnAngle(current, target, dt, speed = 2.4) {
    const delta = wrap(target - current);
    return current + Math.sign(delta) * Math.min(Math.abs(delta), Math.max(0, dt) * speed);
  }
  // Rectangle (axis aligned, [x0, x1, z0, z1]) against an oriented box.
  function boxHitsRect(box, rect, margin = 0) {
    const [x0, x1, z0, z1] = rect;
    return overlaps(box, { x: (x0 + x1) / 2, z: (z0 + z1) / 2, yaw: 0, length: x1 - x0, width: z1 - z0 }, margin * 2);
  }

  /* ------------------------------------------------------------------ site layout */
  const LANE_Z = 2.5;           // westbound lane next to the site (right-hand traffic)
  const SITE_EDGE_Z = 2.0;      // site boundary / kerb
  const GRID = { x0: -5, z0: -4, size: 0.5, nx: 31, nz: 16 };   // reservation zones
  const DS = 0.05;              // route sampling step
  const PIVOT_ARM = 0.45;       // a pivot of 1 rad counts as 0.45 units of travel
  const A_ACC = 0.8, A_DEC = 0.8, A_HARD = 3, A_LAT = 0.45;
  const GEAR_PAUSE = 0.6, DEBOUNCE = 0.5, BUDGET = 2, FADE = 0.3;
  const ROAD_GAP = 0.6, SITE_GAP = 0.05;

  const SPECS = {
    excavator: { kind: 'excavator', length: 1.3, width: 1.0, rearOverhang: 0.65, wheelbase: 0, tracked: true, minRadius: 1.0, vRoad: 1.0, vSite: 0.6, vReverse: 0.35, pivotRate: 0.7, wheelRadius: 0.075, trackHalf: 0.38, spawnX: 15, despawnX: -14 },
    dumper: { kind: 'dumper', length: 2.3, width: 0.8, rearOverhang: 0.55, wheelbase: 1.3, minRadius: 2.3, vRoad: 1.8, vSite: 0.6, vReverse: 0.4, wheelRadius: 0.168, spawnX: 30, despawnX: -30 },
    mixer: { kind: 'mixer', length: 2.4, width: 0.8, rearOverhang: 0.55, wheelbase: 1.4, minRadius: 2.3, vRoad: 1.8, vSite: 0.6, vReverse: 0.4, wheelRadius: 0.168, spawnX: 30, despawnX: -30 },
    pump: { kind: 'pump', length: 3.0, width: 0.82, rearOverhang: 0.75, wheelbase: 1.85, minRadius: 2.6, vRoad: 1.6, vSite: 0.55, vReverse: 0.4, wheelRadius: 0.168, spawnX: 30, despawnX: -30 },
    roller: { kind: 'roller', length: 1.7, width: 0.85, rearOverhang: 0.41, wheelbase: 0.94, minRadius: 1.5, vRoad: 0.8, vSite: 0.5, vReverse: 0.35, compactSpeed: 0.42, wheelRadius: 0.19, drumRadius: 0.28, spawnX: 15, despawnX: -14 },
  };
  const centerOffset = spec => spec.length / 2 - spec.rearOverhang;
  function footprintAt(spec, x, z, yaw) {
    const [fx, fz] = forward(yaw), off = centerOffset(spec);
    return { x: x + fx * off, z: z + fz * off, yaw, length: spec.length, width: spec.width };
  }
  function refFromCenter(spec, cx, cz, yaw) {
    const [fx, fz] = forward(yaw), off = centerOffset(spec);
    return [cx - fx * off, cz - fz * off];
  }

  const NORTH = Math.PI / 2, SOUTH = -Math.PI / 2, WEST = Math.PI, EAST = 0;
  // Work poses (vehicle centres). Pump and mixer stand rear to rear: hopper fed by the chute.
  const BAYS = {
    pump: { x: 6.7, z: -2.05, yaw: NORTH },     // rear at z -0.55 ...
    mixer: { x: 6.7, z: 0.75, yaw: SOUTH },     // ... mixer rear at z -0.45 (zone rows split at -0.5)
    dumper: { x: 5.45, z: -0.9, yaw: SOUTH },
    excavator: { x: 3.3, z: -0.9, yaw: WEST },
    roller: { x: 1.6 + centerOffset(SPECS.roller) * -1, z: -2.55, yaw: WEST },   // rear axle at x 1.6
  };
  const ROLLER_LINE = { z: -2.55, east: 1.6, west: -1.3, exitX: -2.85 };
  const PIT = [-2.0, 2.0, -1.7, 1.7];

  // Static obstacles: [x0, x1, z0, z1] with the progress range in which they exist.
  const OBSTACLES = [
    { name: 'east fence', rect: [8.4, 8.5, -3.92, 1.3], from: 0.1, to: 0.985 },
    { name: 'west fence', rect: [-3.96, -3.86, -3.92, 1.3], from: 0.1, to: 0.985 },
    { name: 'back fence', rect: [-3.96, 8.5, -3.93, -3.83], from: 0.1, to: 0.985 },
    { name: 'pit / footings', rect: PIT, from: 0, to: 1 },
    { name: 'scaffold', rect: [-2.4, 2.4, -2.05, 2.05], from: 0.4, to: 0.98 },
    { name: 'stair tower', rect: [2.6, 3.7, -1.05, 1.05], from: 0.4, to: 0.98 },
    { name: 'crane base', rect: [-3.05, -2.45, -2.2, -1.6], from: 0.4, to: 0.98 },
    { name: 'site office', rect: [-3.85, -2.85, -3.82, -3.15], from: 0.1, to: 0.985 },
    { name: 'rebar stock', rect: [-0.85, 0.55, -3.75, -3.4], from: 0.1, to: 0.985 },
    { name: 'timber (north)', rect: [1.0, 1.9, -3.8, -3.35], from: 0.1, to: 0.985 },
    { name: 'timber (east)', rect: [7.62, 8.36, -1.95, -1.0], from: 0.1, to: 0.985 },
    { name: 'steel bars', rect: [7.85, 8.3, -3.65, -2.35], from: 0.1, to: 0.985 },
    { name: 'concrete blocks', rect: [7.7, 8.3, -0.7, -0.15], from: 0.1, to: 0.985 },
    { name: 'spoil heap', rect: [4.5, 5.55, -3.85, -3.1], from: 0.19, to: 0.4 },
  ];

  /* ------------------------------------------------------------------ zones */
  // The lane in front of the building only carries westbound traffic (no turns, reversing or
  // merging), so it needs no reservation: plain car following, and a safe place to wait.
  const FLOW = new Set();
  for (let ix = 0; ix < GRID.nx; ix++) for (let iz = 0; iz < GRID.nz; iz++) {
    const x = GRID.x0 + (ix + 0.5) * GRID.size, z = GRID.z0 + (iz + 0.5) * GRID.size;
    if (x > -2.0 && x < 1.5 && z > 2.0 && z < 3.0) FLOW.add(ix + iz * GRID.nx);
  }
  function cellsOfBox(b) {
    const out = [], [fx, fz] = forward(b.yaw), sx = -fz, sz = fx, hl = b.length / 2, hw = b.width / 2, h = GRID.size / 2, EPS = 1e-4;
    const ex = Math.abs(fx) * hl + Math.abs(sx) * hw, ez = Math.abs(fz) * hl + Math.abs(sz) * hw;
    const ix0 = Math.max(0, Math.floor((b.x - ex - GRID.x0) / GRID.size)), ix1 = Math.min(GRID.nx - 1, Math.floor((b.x + ex - GRID.x0) / GRID.size));
    const iz0 = Math.max(0, Math.floor((b.z - ez - GRID.z0) / GRID.size)), iz1 = Math.min(GRID.nz - 1, Math.floor((b.z + ez - GRID.z0) / GRID.size));
    for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) {
      const cx = GRID.x0 + (ix + 0.5) * GRID.size, cz = GRID.z0 + (iz + 0.5) * GRID.size, dx = cx - b.x, dz = cz - b.z;
      if (Math.abs(dx) >= ex + h - EPS || Math.abs(dz) >= ez + h - EPS) continue;
      if (Math.abs(dx * fx + dz * fz) >= hl + h * (Math.abs(fx) + Math.abs(fz)) - EPS) continue;
      if (Math.abs(dx * sx + dz * sz) >= hw + h * (Math.abs(sx) + Math.abs(sz)) - EPS) continue;
      const id = ix + iz * GRID.nx;
      if (!FLOW.has(id)) out.push(id);
    }
    return out;
  }

  /* ------------------------------------------------------------------ routes */
  // legs: [{ path, gear }] or [{ pivot: { x, z, from, to } }]. Consecutive drive legs with the
  // same gear flow without stopping; any gear change or pivot is a full stop.
  function buildRoute(spec, legs, { flowEnd = false, label = '', speed = Infinity } = {}) {
    const route = { spec, label, legs: [], samples: [], stops: [], cells: new Map(), length: 0, flowEnd };
    let s = 0;
    for (const leg of legs) {
      if (leg.pivot) {
        const delta = wrap(leg.pivot.to - leg.pivot.from), length = Math.abs(delta) * PIVOT_ARM;
        if (length < 1e-6) continue;
        route.legs.push({ kind: 'pivot', ...leg.pivot, delta, gear: 0, start: s, length });
        s += length;
      } else {
        if (leg.path.length < 1e-6) continue;
        route.legs.push({ kind: 'drive', path: leg.path, gear: leg.gear, start: s, length: leg.path.length });
        s += leg.path.length;
      }
    }
    route.length = s;
    // Samples (uniform per leg, always including leg ends).
    route.legs.forEach((leg, li) => {
      const n = Math.max(1, Math.ceil(leg.length / DS));
      for (let k = li ? 1 : 0; k <= n; k++) {
        const local = leg.length * k / n, pose = poseOnLeg(leg, local);
        route.samples.push({ s: leg.start + local, leg: li, ...pose });
      }
    });
    // Stop points: gear changes, pivots and the end.
    route.legs.forEach((leg, li) => {
      const next = route.legs[li + 1];
      if (next && (next.kind !== leg.kind || next.gear !== leg.gear)) route.stops.push(leg.start + leg.length);
    });
    if (!flowEnd) route.stops.push(route.length);
    // Speed limit profile, then a backward pass so the vehicle can always brake in time.
    const samples = route.samples, stopSet = new Set(route.stops.map(v => v.toFixed(5)));
    for (const p of samples) {
      const leg = route.legs[p.leg];
      let v = leg.kind === 'pivot' ? spec.pivotRate * PIVOT_ARM : leg.gear < 0 ? spec.vReverse : (p.z > SITE_EDGE_Z + 0.05 ? spec.vRoad : spec.vSite);
      if (p.curv) v = Math.min(v, Math.sqrt(A_LAT / Math.abs(p.curv)));
      v = Math.min(v, speed);
      p.vmax = stopSet.has(p.s.toFixed(5)) ? 0 : v;
    }
    for (let i = samples.length - 2; i >= 0; i--) samples[i].vmax = Math.min(samples[i].vmax, Math.sqrt(samples[i + 1].vmax ** 2 + 2 * A_DEC * (samples[i + 1].s - samples[i].s)));
    // Rough time to the end of the route (for the time budget).
    samples[samples.length - 1].eta = 0;
    for (let i = samples.length - 2; i >= 0; i--) {
      const a = samples[i], b = samples[i + 1], v = Math.max(0.12, (a.vmax + b.vmax) / 2);
      a.eta = b.eta + (b.s - a.s) / v + (stopSet.has(b.s.toFixed(5)) && i + 1 < samples.length - 1 ? GEAR_PAUSE : 0);
    }
    // Zone occupancy: first and last sample touching each grid cell.
    samples.forEach((p, i) => {
      p.box = footprintAt(spec, p.x, p.z, p.yaw);
      p.cells = cellsOfBox(p.box);
      for (const c of p.cells) { const r = route.cells.get(c); if (r) r[1] = i; else route.cells.set(c, [i, i]); }
    });
    return route;
  }
  function poseOnLeg(leg, local) {
    if (leg.kind === 'pivot') {
      const yaw = wrap(leg.from + leg.delta * (leg.length ? local / leg.length : 1));
      return { x: leg.x, z: leg.z, yaw, curv: 0, gear: 0 };
    }
    const p = leg.path.sample(local);
    return { x: p.x, z: p.z, yaw: leg.gear < 0 ? wrap(p.yaw + Math.PI) : p.yaw, curv: p.curv, gear: leg.gear };
  }
  function poseOnRoute(route, s) {
    s = clamp(s, 0, route.length);
    let li = route.legs.length - 1;
    while (li > 0 && route.legs[li].start >= s) li--;   // a leg boundary belongs to the leg just driven
    const leg = route.legs[li];
    return { ...poseOnLeg(leg, s - leg.start), leg: li };
  }
  // Drive back along `route` from distance `from` to distance `to` with every gear flipped.
  function retraceLegs(route, from, to) {
    const legs = [];
    for (let li = route.legs.length - 1; li >= 0; li--) {
      const leg = route.legs[li], a = Math.max(leg.start, to), b = Math.min(leg.start + leg.length, from);
      if (b - a < 1e-6) continue;
      if (leg.kind === 'pivot') legs.push({ pivot: { x: leg.x, z: leg.z, from: poseOnLeg(leg, b - leg.start).yaw, to: poseOnLeg(leg, a - leg.start).yaw } });
      else legs.push({ path: leg.path.slice(a - leg.start, b - leg.start).reversed(), gear: -leg.gear });
    }
    return legs;
  }
  const laneWest = (spec, x) => ({ path: new Path([line(x, LANE_Z, spec.despawnX, LANE_Z)]), gear: 1 });

  // Inbound routes: [lane leg from the spawn point to the junction] + site legs.
  function inboundRoute(kind) {
    const spec = SPECS[kind], bay = BAYS[kind], [rx, rz] = refFromCenter(spec, bay.x, bay.z, bay.yaw);
    let legs, junctionX;
    if (kind === 'mixer' || kind === 'dumper') {
      // Drive past the gate, stop, then back in on one arc so the rear faces the work point.
      junctionX = rx - spec.minRadius;
      legs = [
        { path: new Path([line(spec.spawnX, LANE_Z, junctionX, LANE_Z)]), gear: 1 },
        { path: polyline([[junctionX, LANE_Z], [rx, LANE_Z], [rx, rz]], spec.minRadius), gear: -1 },
      ];
    } else if (kind === 'pump') {
      // Right turn through the gate, nose to the back fence; it later backs out.
      const full = polyline([[spec.spawnX, LANE_Z], [rx, LANE_Z], [rx, rz]], spec.minRadius);
      junctionX = rx + spec.minRadius;
      const sj = spec.spawnX - junctionX;
      legs = [{ path: full.slice(0, sj), gear: 1 }, { path: full.slice(sj, full.length), gear: 1 }];
    } else if (kind === 'excavator') {
      const full = polyline([[spec.spawnX, LANE_Z], [rx, LANE_Z], [rx, rz]], spec.minRadius);
      junctionX = rx + spec.minRadius;
      const sj = spec.spawnX - junctionX;
      legs = [{ path: full.slice(0, sj), gear: 1 }, { path: full.slice(sj, full.length), gear: 1 }, { pivot: { x: rx, z: rz, from: NORTH, to: bay.yaw } }];
    } else {
      // Roller: right turn into the east corridor, left turn onto the compaction strip.
      const cx = 4.5, full = polyline([[spec.spawnX, LANE_Z], [cx, LANE_Z], [cx, ROLLER_LINE.z], [ROLLER_LINE.east, ROLLER_LINE.z]], spec.minRadius);
      junctionX = cx + spec.minRadius;
      const sj = spec.spawnX - junctionX;
      legs = [{ path: full.slice(0, sj), gear: 1 }, { path: full.slice(sj, full.length), gear: 1 }];
    }
    const route = buildRoute(spec, legs, { label: kind + ' in' });
    route.junction = route.legs[0].length;
    route.junctionX = junctionX;
    route.inbound = true;
    return route;
  }
  // Leaving from a pose on an inbound route: retrace to the lane, then continue west.
  function retraceOut(spec, route, s) {
    if (s <= route.junction + 1e-6) {
      const p = poseOnRoute(route, s);
      return buildRoute(spec, [laneWest(spec, p.x)], { flowEnd: true, label: spec.kind + ' pass' });
    }
    return buildRoute(spec, [...retraceLegs(route, s, route.junction), laneWest(spec, route.junctionX)], { flowEnd: true, label: spec.kind + ' out' });
  }
  function excavatorOut(spec, x, z, yaw) {
    const legs = [];
    if (Math.abs(wrap(yaw - SOUTH)) > 1e-3) legs.push({ pivot: { x, z, from: yaw, to: SOUTH } });
    legs.push({ path: polyline([[x, z], [x, LANE_Z], [spec.despawnX, LANE_Z]], spec.minRadius), gear: 1 });
    return buildRoute(spec, legs, { flowEnd: true, label: 'excavator out' });
  }
  // Roller leaves forward round the west side of the building (no long reverse).
  function rollerOut(spec, x) {
    const path = polyline([[x, ROLLER_LINE.z], [ROLLER_LINE.exitX, ROLLER_LINE.z], [ROLLER_LINE.exitX, LANE_Z], [spec.despawnX, LANE_Z]], spec.minRadius);
    return buildRoute(spec, [{ path, gear: 1 }], { flowEnd: true, label: 'roller out' });
  }
  // One compaction pass: forward west to the end of the strip, back east to the start.
  function rollerPass(spec, x) {
    const z = ROLLER_LINE.z, legs = [];
    if (x - ROLLER_LINE.west > 0.05) legs.push({ path: new Path([line(x, z, ROLLER_LINE.west, z)]), gear: 1 });
    legs.push({ path: new Path([line(ROLLER_LINE.west, z, ROLLER_LINE.east, z)]), gear: -1 });
    return buildRoute(spec, legs, { label: 'roller pass', speed: spec.compactSpeed });
  }

  /* ------------------------------------------------------------------ construction steps → machines */
  const Sequence = root.ConstructionSequence || (typeof require === 'function' ? require('./construction-sequence.js') : null);
  const STEPS = Sequence ? Sequence.steps : [];
  function stepKind(step) {
    const n = step.name;
    if (/Đào đất/.test(n)) return 'excavate';
    if (/Bê tông lót/.test(n)) return 'blinding';
    if (/Đổ bê tông/.test(n)) return 'pour';
    if (/Rải và san/.test(n)) return 'spread';
    if (/Lu\/đầm/.test(n)) return 'compact';
    return null;
  }
  // Which machines each step needs. Windows merge across short gaps; one step of lookahead lets a
  // machine arrive and set up before its work starts (not after earthwork steps, to keep the yard clear).
  function buildPlan(steps) {
    const kinds = steps.map(stepKind), n = steps.length;
    const isPour = i => kinds[i] === 'pour' || kinds[i] === 'blinding';
    const presence = (test, gap, lookahead, ahead = 1) => {
      const on = kinds.map((_, i) => test(i));
      for (let i = 0; i < n; i++) if (on[i]) for (let j = i + 1; j <= Math.min(n - 1, i + gap + 1); j++) if (test(j)) { for (let k = i + 1; k < j; k++) on[k] = true; break; }
      const out = on.slice();
      if (lookahead) for (let i = 0; i < n - 1; i++) {
        if (on[i]) continue;
        for (let d = 1; d <= ahead && i + d < n; d++) if (on[i + d]) { if (lookahead(i)) out[i] = true; break; }
      }
      return out;
    };
    const earthwork = i => ['excavate', 'spread', 'compact'].includes(kinds[i]);
    const excavatorOn = presence(i => kinds[i] === 'excavate' || kinds[i] === 'spread', 1, () => true);
    const rollerOn = presence(i => kinds[i] === 'compact', 1, () => true);
    // The pump comes two steps early: it must pass through the mixer dock before the first mixer can back in.
    const pumpOn = presence(isPour, 2, i => !earthwork(i) && !earthwork(i + 1), 2);
    return kinds.map((kind, i) => {
      const pour = isPour(i), prestage = !pour && i + 1 < n && isPour(i + 1) && pumpOn[i];
      return {
        index: i, kind, pour,
        excavator: excavatorOn[i] ? (kind === 'excavate' ? 'dig' : kind === 'spread' ? 'spread' : 'idle') : null,
        dumper: kind === 'excavate' ? 'haul' : kind === 'spread' ? 'tip' : null,
        roller: rollerOn[i] ? (kind === 'compact' ? 'compact' : 'rest') : null,
        pump: pumpOn[i] ? (pour ? 'pour' : prestage ? 'setup' : 'standby') : null,
        // A stand-by mixer waits at the pump whenever the pump is set up between pours.
        mixer: pour ? 'pour' : pumpOn[i] ? 'standby' : null,
      };
    });
  }
  const PLAN = buildPlan(STEPS);
  function nearestStep(p) {
    if (Sequence) return Sequence.nearest(p);
    return 0;
  }
  // Machines actually working at progress p (labels and the canvas fallback).
  function plan(p) {
    const need = PLAN[nearestStep(clamp(p, 0, 1))] || {};
    return {
      roller: need.roller === 'compact',
      excavator: need.excavator === 'dig' || need.excavator === 'spread',
      dumpTruck: !!need.dumper,
      mixer: need.mixer === 'pour',
      pump: need.pump === 'pour',
      step: need.index ?? 0,
    };
  }

  /* ------------------------------------------------------------------ vehicles */
  const DISCHARGE = 20, LOAD_TIME = 20, DIG_CYCLE = 6, BUCKETS = 3;
  const isInside = v => v.held.size > 0;

  class Vehicle {
    constructor(fleet, id, kind) {
      this.fleet = fleet; this.id = id; this.kind = kind; this.spec = SPECS[kind];
      this.inbound = fleet.routes[kind];
      this.held = new Set();
      this.odo = 0; this.odoL = 0; this.odoR = 0; this.steer = 0; this.task = null;
      this.reset();
    }
    reset() {
      this.release();
      this.mode = 'off';          // off | wait-spawn | placing | drive | work | fade-out
      this.route = null; this.s = 0; this.k = 0; this.v = 0; this.stopIndex = 0; this.pause = 0;
      this.granted = -1; this.request = null; this.alpha = 0; this.fade = null;
      this.leaving = false; this.purpose = null; this.switchTo = null; this.placeAfter = null;
      this.load = 0; this.bed = 0; this.legs = 0; this.boom = 0; this.work = 0; this.stalled = 0;
      this.dig = { t: 0, cycle: 0, dumped: false, slew: 0, reach: 1.25, height: 0.15, curl: 0 };
    }
    get active() { return this.mode === 'drive' || this.mode === 'work' || this.mode === 'fade-out'; }
    get pose() { return this.route ? poseOnRoute(this.route, this.s) : null; }
    box() { const p = this.pose; return p ? footprintAt(this.spec, p.x, p.z, p.yaw) : null; }
    get docked() { return this.mode === 'work' && !this.leaving && !this.switchTo; }
    eta() { return this.route ? this.route.samples[this.k].eta + Math.max(0, this.pause) : Infinity; }
    get gear() { const p = this.pose; if (!p) return 0; const leg = this.route.legs[p.leg]; return leg.kind === 'pivot' ? 0 : leg.gear; }
    get motionGear() { return this.moved ? this.lastGear : this.gear; }   // gear of this frame's motion

    /* --- zone reservations */
    release() {
      for (const c of this.held) if (this.fleet.owner.get(c) === this) this.fleet.owner.delete(c);
      this.held = new Set(); this.request = null;
    }
    // Keep only zones under the footprint now and up to the granted sample (release behind the tail).
    refreshHeld() {
      const keep = new Set(), from = this.k, to = Math.max(this.granted, this.k);
      for (const [c, [a, b]] of this.route.cells) if (b >= from && a <= to) keep.add(c);
      for (const c of this.route.samples[this.k].cells) keep.add(c);
      for (const c of this.held) if (!keep.has(c) && this.fleet.owner.get(c) === this) this.fleet.owner.delete(c);
      this.held = new Set();
      for (const c of keep) {
        const o = this.fleet.owner.get(c);
        if (o && o !== this) continue;
        this.fleet.owner.set(c, this); this.held.add(c);
      }
    }
    // Close to the end of the grant: extend over free road, or ask (atomically) for every zone up
    // to the next place where waiting is harmless — the free road beyond the zones, or the bay.
    wantMore() {
      const samples = this.route.samples, last = samples.length - 1, start = Math.max(this.granted, this.k);
      if (start >= last || this.request) return;
      if (samples[start].s - this.s > this.v * this.v / (2 * A_DEC) + 1.2) return;
      let j = start + 1;
      if (!samples[j].cells.length) {
        while (j < last && !samples[j + 1].cells.length) j++;
        this.granted = j;
        return;
      }
      while (j < last && samples[j].cells.length) j++;
      const needs = [];
      for (const [c, [a, b]] of this.route.cells) if (a <= j && b >= this.k && !this.held.has(c)) needs.push(c);
      if (!needs.length) { this.granted = j; return; }
      this.request = { cells: needs, upto: j, since: this.fleet.time };
    }
    claim(cells, partial = false) {
      if (!partial) for (const c of cells) { const o = this.fleet.owner.get(c); if (o && o !== this) return false; }
      for (const c of cells) { const o = this.fleet.owner.get(c); if (!o || o === this) { this.fleet.owner.set(c, this); this.held.add(c); } }
      return true;
    }

    /* --- route control */
    setRoute(route, purpose, keepSpeed = false) {
      const start = new Set(route.samples[0].cells);
      for (const c of this.held) if (!start.has(c) && this.fleet.owner.get(c) === this) this.fleet.owner.delete(c);
      this.held = new Set([...this.held].filter(c => start.has(c)));
      this.claim(route.samples[0].cells, true);
      this.route = route; this.s = 0; this.k = 0; this.stopIndex = 0; this.pause = 0; this.purpose = purpose;
      this.request = null; this.granted = 0;
      if (!keepSpeed) this.v = 0;
    }
    spawn() {
      const start = this.inbound.samples[0].box;
      for (const o of this.fleet.vehicles) if (o !== this && o.active && overlaps(start, o.box(), ROAD_GAP + 0.6)) { this.mode = 'wait-spawn'; return false; }
      const task = this.task;
      this.reset(); this.task = task;
      this.mode = 'drive'; this.setRoute(this.inbound, 'in');
      this.load = this.kind === 'mixer' || this.kind === 'dumper' && task === 'tip' ? 1 : 0;
      return true;
    }
    // Put the vehicle straight into its work pose (jump / time budget). Waits while the bay is taken.
    place(instant) {
      const route = this.inbound, end = route.samples[route.samples.length - 1];
      const blockers = new Set();
      for (const c of end.cells) { const o = this.fleet.owner.get(c); if (o && o !== this) blockers.add(o); }
      for (const o of this.fleet.vehicles) if (o !== this && o.active && overlaps(end.box, o.box(), SITE_GAP)) blockers.add(o);
      if (blockers.size) {
        // A vehicle that is only leaving must never hold up a required machine: it fades away instead.
        for (const o of blockers) if (o.leaving && o.mode === 'drive' && o.purpose === 'out') o.remove(false);
        if (this.mode !== 'placing') { const task = this.task; this.reset(); this.task = task; this.mode = 'placing'; }
        return false;
      }
      const task = this.task;
      this.reset(); this.task = task;
      this.route = route; this.s = route.length; this.k = route.samples.length - 1; this.granted = this.k; this.stopIndex = route.stops.length;
      this.claim(end.cells);
      this.alpha = instant ? 1 : 0; this.fade = instant ? null : { dir: 1 };
      this.arrive(true);
      return true;
    }
    remove(instant) {
      if (this.mode === 'off') return;
      if (instant || this.alpha <= 0 || !this.route) { const after = this.placeAfter; this.reset(); if (after) { this.task = after; this.place(instant); } return; }
      this.mode = 'fade-out'; this.fade = { dir: -1 }; this.request = null; this.switchTo = null;
    }
    // Leave the site: pass by on the lane, back out along the way in, or the machine's own exit.
    leave() {
      if (this.leaving || this.mode === 'off' || this.mode === 'fade-out') return;
      if (this.mode === 'placing' || this.mode === 'wait-spawn') { this.reset(); return; }
      this.leaving = true;
      if (this.purpose === 'return') return;   // finish turning back first, then leave from the bay
      if (this.mode === 'drive' && this.purpose === 'in' && this.s <= this.route.junction - 0.05) {
        this.setRoute(retraceOut(this.spec, this.route, this.s), 'out', true);   // still on the lane: keep going
        return;
      }
      if (this.mode === 'drive' && this.purpose === 'out') return;
      this.switchTo = 'exit';   // once stopped (and, for the pump, folded)
    }
    // Needed again while leaving: turn back to the bay if still inside the site.
    recall() {
      if (!this.leaving) return true;
      if (this.switchTo === 'exit') { this.switchTo = null; this.leaving = false; return true; }
      if (this.purpose === 'return') { this.leaving = false; return true; }
      // Turn back only while still inside the fence; once on the public lane it carries on.
      if (this.mode === 'drive' && this.purpose === 'out' && this.pose.z < SITE_EDGE_Z - 0.1 && !/pass$/.test(this.route.label)) { this.switchTo = 'return'; this.leaving = false; return true; }
      return false;
    }
    // Cancel a departure that has not started moving yet: back to work at the bay.
    canResume() {
      if (!this.leaving) return false;
      if (this.mode === 'work') return true;
      return this.mode === 'drive' && this.purpose === 'out' && this.s < 1e-6 && this.v < 1e-3 && this.route.label.endsWith(' out') && Math.hypot(this.pose.x - this.inbound.samples.at(-1).x, this.pose.z - this.inbound.samples.at(-1).z) < 1e-3;
    }
    resume() {
      if (this.mode === 'drive') {
        const route = this.inbound;
        this.route = route; this.s = route.length; this.k = route.samples.length - 1; this.granted = this.k; this.stopIndex = route.stops.length;
        this.mode = 'work'; this.purpose = 'work'; this.request = null;
      }
      this.leaving = false; this.switchTo = null;
    }
    exitRoute() {
      const p = this.pose;
      if (this.kind === 'roller' && this.purpose !== 'in') return rollerOut(this.spec, Math.max(p.x, ROLLER_LINE.west));
      if (this.kind === 'excavator' && this.purpose !== 'in') return excavatorOut(this.spec, p.x, p.z, p.yaw);
      if (this.purpose === 'in') return retraceOut(this.spec, this.route, this.s);
      return retraceOut(this.spec, this.inbound, this.inbound.length);
    }
    performSwitch() {
      const kind = this.switchTo; this.switchTo = null;
      this.mode = 'drive';
      if (kind === 'exit') { this.leaving = true; this.setRoute(this.exitRoute(), 'out'); }
      else if (kind === 'return') {
        const legs = retraceLegs(this.route, this.s, 0);
        if (!legs.length) { this.arrive(); return; }
        this.setRoute(buildRoute(this.spec, legs, { label: this.kind + ' return' }), 'return');
      }
    }

    /* --- per-frame motion */
    move(dt) {
      if (this.mode === 'work') {
        if (this.switchTo && !(this.kind === 'pump' && (this.boom > 0 || this.legs > 0))) this.performSwitch();
        return;
      }
      this.moved = false;
      if (this.mode !== 'drive') return;
      if (this.switchTo && this.v < 1e-3) { this.performSwitch(); return; }
      const route = this.route, samples = route.samples;
      let limit = Math.min(route.stops[this.stopIndex] ?? route.length, samples[Math.max(this.granted, this.k)].s);
      const block = this.lookAhead();
      if (block) limit = Math.min(limit, block.s);
      const toStop = Math.max(0, limit - this.s);
      let target = Math.min(this.profileAt(), Math.sqrt((block ? block.v * block.v : 0) + 2 * A_DEC * toStop));
      if (this.pause > 0) { this.pause -= dt; target = 0; }
      if (this.switchTo) target = 0;   // turning back / leaving: brake firmly, then switch route
      this.v = this.v < target ? Math.min(target, this.v + A_ACC * dt) : Math.max(target, this.v - A_HARD * dt);
      let ds = this.v * dt;
      if (this.s + ds >= limit) { ds = Math.max(0, limit - this.s); if (toStop < 2e-3) this.v = 0; }
      if (this.switchTo && this.v < 0.02) this.v = 0;
      this.moved = ds > 0;
      this.advance(ds);
      if (this.stopIndex < route.stops.length && this.s >= route.stops[this.stopIndex] - 1e-6) {
        this.s = route.stops[this.stopIndex]; this.v = 0; this.stopIndex++;
        if (this.s < route.length - 1e-6) this.pause = GEAR_PAUSE;
      }
      const steerTarget = this.spec.wheelbase && this.gear ? Math.atan(this.spec.wheelbase * this.curvature() * this.gear) : 0;
      this.steer = approach(this.steer, steerTarget, 1.5 * dt);
      this.stalled = this.v < 0.01 && this.pause <= 0 && this.s < route.length - 1e-6 ? this.stalled + dt : 0;
    }
    curvature() { const p = this.pose; return p ? p.curv || 0 : 0; }
    advance(ds) {
      if (ds <= 0) return;
      const before = this.pose;
      this.s = Math.min(this.route.length, this.s + ds);
      const samples = this.route.samples;
      while (this.k < samples.length - 1 && samples[this.k + 1].s <= this.s + 1e-9) this.k++;
      const after = this.pose, leg = this.route.legs[after.leg];
      if (leg.kind === 'pivot') {
        const turn = wrap(after.yaw - before.yaw), arm = this.spec.trackHalf || 0.4;
        this.odoL -= turn * arm; this.odoR += turn * arm;
        this.lastGear = 0;
      } else {
        this.lastGear = leg.gear;
        const signed = ds * leg.gear, turn = wrap(after.yaw - before.yaw), arm = this.spec.trackHalf || 0.35;
        this.odo += signed; this.odoL += signed - turn * arm; this.odoR += signed + turn * arm;
      }
    }
    profileAt() {
      const samples = this.route.samples, a = samples[this.k], b = samples[Math.min(samples.length - 1, this.k + 1)];
      const v = b === a || b.s === a.s ? a.vmax : lerp(a.vmax, b.vmax, clamp((this.s - a.s) / (b.s - a.s), 0, 1));
      return v + 0.03;   // tiny floor so the profile's own zeros never trap the vehicle between samples
    }
    // Car following and safety net: stop short of anything our footprint would touch further on.
    lookAhead() {
      const samples = this.route.samples, reach = this.s + this.v * this.v / (2 * A_DEC) + 0.7;
      const here = samples[this.k].box, others = [];
      for (const o of this.fleet.vehicles) if (o !== this && o.active && o.route) others.push({ o, box: o.box() });
      if (!others.length) return null;
      const myGear = Math.sign(this.gear || 1);
      for (let i = this.k + 1; i < samples.length && samples[i].s <= reach; i += 2) {
        const p = samples[i], gap = p.cells.length ? SITE_GAP : ROAD_GAP;
        for (const { o, box } of others) {
          // Already closer than the gap (e.g. just placed): still never allow actual contact.
          if (!overlaps(p.box, box, overlaps(here, box, gap * 0.5) ? 0.02 : gap)) continue;
          const [fx, fz] = forward(p.yaw), op = o.pose, [ox, oz] = forward(op.yaw), og = Math.sign(o.gear || 1);
          const lead = o.mode === 'drive' ? Math.max(0, o.v * (fx * ox + fz * oz) * og * myGear) : 0;
          return { s: Math.max(this.s, samples[Math.max(this.k, i - 2)].s), v: lead, other: o };
        }
      }
      return null;
    }

    /* --- arrival and work */
    arrive(placed = false) {
      this.mode = 'work'; this.purpose = 'work'; this.v = 0; this.work = 0; this.request = null;
      const need = this.fleet.needs || {};
      if (placed && this.kind === 'pump') { this.legs = 1; this.boom = need.pump === 'pour' || need.pump === 'setup' ? 1 : 0; }
      if (placed && this.kind === 'mixer') this.load = need.mixer === 'pour' ? 0.8 : 1;
      if (placed && this.kind === 'dumper') this.load = this.task === 'tip' ? 1 : 0.4;
      if (this.kind === 'excavator') this.dig.t = 0;
      if (this.leaving) { this.leaving = false; this.leave(); }
    }
    update(dt) {
      if (this.fade) {
        this.alpha = clamp(this.alpha + this.fade.dir * dt / FADE, 0, 1);
        if (this.fade.dir > 0 && this.alpha >= 1) this.fade = null;
        else if (this.fade.dir < 0 && this.alpha <= 0) { this.remove(true); return; }
      }
      if (this.mode === 'fade-out') return;
      if (this.mode === 'drive') {
        const r = this.route;
        if (!this.fade) {
          const fromSpawn = this.purpose === 'in' && r === this.inbound ? clamp(this.s / 2.2, 0, 1) : 1;
          const toEnd = r.flowEnd ? clamp((r.length - this.s) / 2.5, 0, 1) : 1;
          this.alpha = Math.min(fromSpawn, toEnd);
        }
        if (this.s >= r.length - 1e-6 && (this.v < 1e-3 || r.flowEnd)) {
          if (this.purpose === 'out') { this.reset(); return; }
          if (this.purpose === 'in' || this.purpose === 'return') { this.arrive(); return; }
        }
      }
      if (this.mode === 'work' || this.purpose === 'pass') this.workUpdate(dt);
    }
    workUpdate(dt) {
      const need = this.fleet.needs || {};
      this.work += dt;
      if (this.kind === 'pump') {
        if (this.leaving || this.switchTo) {
          this.boom = approach(this.boom, 0, dt / 3.5);
          if (this.boom <= 0) this.legs = approach(this.legs, 0, dt / 1.5);
        } else {
          this.legs = approach(this.legs, 1, dt / 1.5);
          if (this.legs >= 1) this.boom = approach(this.boom, need.pump === 'pour' || need.pump === 'setup' ? 1 : 0, dt / 3.5);
        }
        return;
      }
      if (this.kind === 'mixer') {
        if (this.fleet.pouringMixer === this) this.load = Math.max(0, this.load - dt / DISCHARGE);
        if (this.load <= 0 && !this.leaving) this.leave();
        return;
      }
      if (this.kind === 'dumper') {
        if (this.leaving) { this.bed = approach(this.bed, 0, dt / 2); return; }
        if (this.task === 'tip') {
          // Raise the body, let the load slide out, lower it again, drive off.
          if (this.load > 0) { this.bed = approach(this.bed, 1, dt / 2.5); if (this.bed >= 1) this.load = Math.max(0, this.load - dt / 2.5); }
          else { this.bed = approach(this.bed, 0, dt / 2); if (this.bed <= 0) this.leave(); }
        } else {
          const ex = this.fleet.byKind('excavator')[0];
          const digging = ex && ex.mode === 'work' && !ex.leaving && need.excavator === 'dig';
          if (!digging) this.load = Math.min(1, this.load + dt / LOAD_TIME);
          if (this.load >= 1) this.leave();
        }
        return;
      }
      if (this.kind === 'excavator') { this.digCycle(dt, this.leaving || this.switchTo ? null : need.excavator); return; }
      if (this.kind === 'roller') {
        if (this.leaving || this.switchTo) return;
        const atRest = this.mode === 'work' || this.purpose === 'pass' && this.s >= this.route.length - 1e-6 && this.v < 1e-3;
        if (atRest && need.roller === 'compact') {
          const pass = rollerPass(this.spec, this.pose.x);
          if ([...pass.cells.keys()].every(c => { const o = this.fleet.owner.get(c); return !o || o === this; })) { this.mode = 'drive'; this.setRoute(pass, 'pass'); }
        } else if (atRest) this.mode = 'work';
      }
    }
    // Excavator: scoop, lift, slew to the dump point, dump, slew back (all relative to the tracks).
    digCycle(dt, mode) {
      const d = this.dig;
      let target = { slew: 0, reach: 1.25, height: 0.15, curl: 0 };
      if (mode === 'dig' || mode === 'spread') {
        d.t += dt / DIG_CYCLE;
        if (d.t >= 1) { d.t -= 1; d.cycle++; d.dumped = false; }
        const truck = mode === 'dig' ? this.fleet.loadingDumper() : this.fleet.tippingDumper();
        const pit = { slew: 0, reach: 2.05, height: mode === 'dig' ? -0.95 : -0.55 };
        const toTruck = truck ? this.relativeTo(truck.bedPoint()) : null;
        const side = { slew: -1.45, reach: 1.75, height: mode === 'dig' ? 0.45 : -0.15 };
        const scoop = mode === 'dig' ? pit : toTruck ? { ...toTruck, height: -0.15 } : side;
        const drop = mode === 'dig' ? toTruck || side : pit;
        const t = d.t, mix = (a, b, u) => ({ slew: a.slew + wrap(b.slew - a.slew) * u, reach: lerp(a.reach, b.reach, u), height: lerp(a.height, b.height, u) });
        if (t < 0.28) target = { ...scoop, curl: smooth(t / 0.28) * 0.9 };
        else if (t < 0.42) target = { ...scoop, height: lerp(scoop.height, 0.95, smooth((t - 0.28) / 0.14)), curl: 0.9 };
        else if (t < 0.62) target = { ...mix({ ...scoop, height: 0.95 }, { ...drop, height: 0.95 }, smooth((t - 0.42) / 0.2)), curl: 0.9 };
        else if (t < 0.76) target = { ...drop, height: Math.max(drop.height + 0.5, 0.5), curl: lerp(0.9, -0.7, smooth((t - 0.62) / 0.1)) };
        else target = { ...mix({ ...drop, height: 0.9 }, { ...scoop, height: 0.9 }, smooth((t - 0.76) / 0.24)), curl: -0.2 };
        if (t >= 0.7 && !d.dumped) {
          d.dumped = true;
          if (mode === 'dig' && truck) truck.load = Math.min(1, truck.load + 1 / BUCKETS + 1e-9);
        }
      }
      const k = 1 - Math.exp(-8 * dt);
      d.slew += wrap(target.slew - d.slew) * k;
      d.reach = lerp(d.reach, target.reach, k); d.height = lerp(d.height, target.height, k); d.curl = lerp(d.curl, target.curl, k);
    }
    relativeTo([x, z]) {
      const p = this.pose, dx = x - p.x, dz = z - p.z;
      return { slew: wrap(yawOf(dx, dz) - p.yaw), reach: clamp(Math.hypot(dx, dz), 1.2, 2.6), height: 0.75 };
    }
    bedPoint() { const b = this.box(), [fx, fz] = forward(b.yaw); return [b.x - fx * 0.55, b.z - fz * 0.55]; }
  }

  /* ------------------------------------------------------------------ fleet */
  class Fleet {
    constructor({ counts = { excavator: 1, roller: 1, pump: 1, mixer: 3, dumper: 3 } } = {}) {
      this.time = 0; this.owner = new Map(); this.vehicles = [];
      this.routes = Object.fromEntries(Object.keys(SPECS).map(kind => [kind, inboundRoute(kind)]));
      for (const [kind, n] of Object.entries(counts)) for (let i = 0; i < n; i++) this.vehicles.push(new Vehicle(this, kind + i, kind));
      this.applied = null; this.pending = null; this.pendingFor = 0; this.needs = PLAN[0] || {}; this.sinceApply = 0;
      this.pouringMixer = null; this.events = [];
    }
    byKind(kind) { return this.vehicles.filter(v => v.kind === kind); }
    loadingDumper() { return this.vehicles.find(v => v.kind === 'dumper' && v.docked && v.task === 'haul' && v.load < 1) || null; }
    tippingDumper() { return this.vehicles.find(v => v.kind === 'dumper' && v.mode === 'work' && v.task === 'tip') || null; }

    // Công trình đang hiện (giàn giáo, tháp cầu thang, chân cẩu, rào…) luôn thắng: xe nào chạm vào thì
    // rời cảnh ngay thay vì lái xuyên qua. Xét cả tiến trình đích lẫn tiến trình cảnh đang hiển thị
    // (cảnh trễ hơn khi chuyển bước) để không lọt khe lúc giàn giáo đang hiện dần hoặc tắt dần.
    clearBuilt(progresses) {
      const built = OBSTACLES.filter(o => progresses.some(p => p >= o.from && p <= o.to));
      for (const v of this.vehicles) {
        if (v.mode === 'off' || !v.pose) continue;
        const box = footprintAt(v.spec, v.pose.x, v.pose.z, v.pose.yaw);
        if (built.some(o => boxHitsRect(box, o.rect))) { v.placeAfter = null; v.remove(true); this.cleared = (this.cleared || 0) + 1; }
      }
    }
    update(dt, { progress = 0, view = progress, paused = false, reduced = false } = {}) {
      dt = paused ? 0 : clamp(dt, 0, 0.1);
      this.time += dt;
      const target = nearestStep(clamp(progress, 0, 1));
      if (reduced || paused || this.applied === null) {
        // Static view (reduced motion, paused or first frame): the step's machines simply stand in place.
        if (target !== this.applied) this.applyStep(target, true, true);
        this.pending = target; this.pendingFor = 0;
      } else {
        if (target !== this.pending) { this.pending = target; this.pendingFor = 0; } else this.pendingFor += dt;
        if (this.pending !== this.applied && this.pendingFor >= DEBOUNCE) {
          const delta = this.pending - this.applied;
          this.applyStep(this.pending, delta < -1 || delta > 3, false);
        }
      }
      this.sinceApply += dt;
      if (reduced) { this.settle(); this.clearBuilt([progress, view]); return this.output(); }
      if (dt > 0) {
        if (this.sinceApply <= BUDGET) this.placeRequired(false, false);
        this.dispatch();
        for (const v of this.vehicles) if (v.mode === 'drive') { v.refreshHeld(); v.wantMore(); }
        this.grant();
        for (const v of this.vehicles) v.move(dt);
        this.pouringMixer = this.findPouringMixer();
        for (const v of this.vehicles) if (v.mode !== 'off') v.update(dt);
        for (const v of this.vehicles) if (v.mode === 'placing') v.place(false);
        for (const v of this.vehicles) if (v.mode === 'wait-spawn') v.spawn();
      }
      this.clearBuilt([progress, view]);
      // Tính sau khi mọi xe đã cập nhật: xe bồn vừa xả hết và tách ra thì bơm ngừng ngay trong khung này.
      this.pouringMixer = this.findPouringMixer();
      return this.output();
    }
    // First come, first served: a request is granted only when all of its zones are free. A request
    // waiting for more than 8 s keeps later requests off its free zones, except requests from the
    // vehicles that hold what it is waiting for (they must be able to move away).
    grant() {
      const requests = this.vehicles.filter(v => v.request).sort((a, b) => a.request.since - b.request.since);
      const reserved = new Map();
      for (const v of requests) {
        const ok = v.request.cells.every(c => {
          const o = this.owner.get(c);
          if (o && o !== v) return false;
          const r = reserved.get(c);
          return !r || r === v || r.request.cells.some(x => v.held.has(x));
        });
        if (ok) { v.claim(v.request.cells); v.granted = v.request.upto; v.request = null; }
        else if (this.time - v.request.since > 8) for (const c of v.request.cells) if (!this.owner.get(c) && !reserved.has(c)) reserved.set(c, v);
      }
    }
    findPouringMixer() {
      if (!this.needs.pour) return null;
      const pump = this.byKind('pump')[0];
      if (!pump || !pump.docked || pump.boom < 0.98) return null;
      return this.vehicles.find(v => v.kind === 'mixer' && v.docked && v.load > 0) || null;
    }
    applyStep(step, jump, instant) {
      this.applied = step; this.needs = PLAN[step] || {}; this.sinceApply = 0;
      this.events.push({ t: this.time, step, jump, instant });
      if (this.events.length > 64) this.events.shift();
      if (jump) {
        // No replayed trips: keep machines already working where needed, remove the rest, place the needed ones.
        for (const v of this.vehicles) if (v.mode !== 'off' && !this.keeps(v)) { v.placeAfter = null; v.remove(instant); }
        this.placeRequired(instant, true);
      } else this.placeRequired(false, false);
    }
    keeps(v) {
      const n = this.needs;
      if (v.leaving || v.switchTo) return false;
      const working = v.mode === 'work' || v.kind === 'roller' && v.purpose === 'pass';
      if (!working) return false;
      if (v.kind === 'mixer') return !!n.mixer;
      if (v.kind === 'dumper') return !!n.dumper && v.task === n.dumper;
      return !!n[v.kind];
    }
    // Time budget: a machine that must work in this step and cannot be there within ~2 s is
    // placed straight at its work pose (fading in). Vehicles already manoeuvring on site finish.
    placeRequired(instant, jumped) {
      const n = this.needs, want = {
        excavator: jumped ? !!n.excavator : n.excavator === 'dig' || n.excavator === 'spread',
        roller: jumped ? !!n.roller : n.roller === 'compact',
        pump: jumped ? !!n.pump : n.pump === 'pour',
        mixer: jumped ? !!n.mixer : n.mixer === 'pour',
        dumper: jumped && !!n.dumper,
      };
      for (const kind of Object.keys(want)) {
        if (!want[kind]) continue;
        const units = this.byKind(kind), task = kind === 'dumper' ? n.dumper : kind === 'mixer' ? 'cycle' : 'present';
        const sameTask = v => kind !== 'dumper' || v.task === task;
        if (units.some(v => sameTask(v) && (v.placeAfter || v.mode === 'placing' || !v.leaving && (v.mode === 'work' || v.purpose === 'pass')))) continue;
        // Almost there (inside the site and due within the budget, with a safety margin): let it finish.
        if (!jumped && units.some(v => sameTask(v) && v.mode === 'drive' && !v.leaving && (v.purpose === 'in' || v.purpose === 'return') && isInside(v) && v.eta() * 1.3 + 0.3 <= BUDGET)) continue;
        // Reuse a unit that is coming (or still on the public road going away), else an idle one, else one fading out.
        const far = units.find(v => v.mode === 'drive' && sameTask(v) && !v.leaving && (v.purpose === 'in' || v.purpose === 'return')) ||
          units.find(v => v.mode === 'drive' && sameTask(v) && v.leaving && !isInside(v));
        const idle = units.find(v => v.mode === 'off' || v.mode === 'wait-spawn');
        const fading = units.find(v => v.mode === 'fade-out' && !v.placeAfter);
        const unit = far || idle || fading;
        if (!unit) continue;
        if (unit.mode === 'drive' && !instant && unit.alpha > 0) { unit.placeAfter = task; unit.remove(false); continue; }
        if (unit.mode === 'fade-out') { unit.placeAfter = task; continue; }
        unit.reset(); unit.task = task; unit.place(instant);
      }
    }
    dispatch() {
      const n = this.needs;
      for (const kind of ['excavator', 'roller', 'pump']) {
        const v = this.byKind(kind)[0];
        if (!v || v.placeAfter) continue;
        if (n[kind]) {
          if (v.mode === 'off') { v.task = 'present'; v.spawn(); }
          // Needed again: turn back if still inside, otherwise fade out on the road and reappear at the
          // bay rather than driving off-site and all the way back.
          else if (v.leaving && !v.recall() && v.mode === 'drive') { v.placeAfter = 'present'; v.remove(false); }
        } else if (v.mode !== 'off' && !v.leaving) v.leave();
      }
      this.cycle('mixer', n.mixer === 'pour' ? 2 : n.mixer === 'standby' ? 1 : 0, 'cycle');
      this.cycle('dumper', n.dumper ? 2 : 0, n.dumper);
    }
    // Keep `count` units of a cycling role in service: one working, the next queued at the gate.
    cycle(kind, count, task) {
      const units = this.byKind(kind);
      const live = v => v.mode !== 'off' && v.mode !== 'fade-out' && !v.leaving;
      for (const v of units) if (live(v) && !v.placeAfter && (!count || v.task !== task)) v.leave();
      if (!count) return;
      const serving = units.filter(v => (live(v) || v.placeAfter) && v.task === task);
      // Needed again before it actually drove off: stay (a mixer with concrete left, a dumper not yet tipped/full).
      for (const v of units) if (serving.length < count && v.task === task && v.canResume() && (kind === 'mixer' ? v.load > 0.05 : task === 'tip' ? v.load > 0.05 : v.load < 0.95)) { v.resume(); serving.push(v); }
      if (serving.length > count) {
        const extra = serving.filter(v => v.mode === 'drive' && v.purpose === 'in').sort((a, b) => a.s - b.s)[0];
        if (extra) extra.leave();
      } else if (serving.length < count) {
        const starting = units.some(v => v.mode === 'wait-spawn' || v.mode === 'drive' && v.purpose === 'in' && v.route === v.inbound && v.s < 5);
        const idle = units.find(v => v.mode === 'off');
        if (idle && !starting) { idle.task = task; idle.spawn(); }
      }
    }
    // Reduced motion: whatever the step needs stands at its work pose; nothing moves.
    settle() {
      for (const v of this.vehicles) {
        if (v.mode !== 'off' && !this.keeps(v)) v.reset();
        if (v.mode === 'work') { v.alpha = 1; v.fade = null; }
      }
      this.placeRequired(true, true);
      for (const v of this.vehicles) if (v.kind === 'pump' && v.mode === 'work') { v.legs = 1; v.boom = this.needs.pump === 'pour' || this.needs.pump === 'setup' ? 1 : 0; }
      this.pouringMixer = this.findPouringMixer();
    }
    output() {
      return this.vehicles.map(v => {
        const p = v.pose, box = p ? footprintAt(v.spec, p.x, p.z, p.yaw) : null;
        return {
          id: v.id, kind: v.kind, mode: v.mode, purpose: v.purpose, task: v.task, leaving: v.leaving,
          visible: v.active && v.alpha > 0.001, alpha: v.alpha,
          x: box ? box.x : 0, z: box ? box.z : 0, yaw: p ? p.yaw : 0, refX: p ? p.x : 0, refZ: p ? p.z : 0,
          length: v.spec.length, width: v.spec.width, gear: v.motionGear, speed: v.v, odo: v.odo, odoL: v.odoL, odoR: v.odoR, steer: v.steer,
          docked: v.docked, load: v.load, bed: v.bed, legs: v.legs, boom: v.boom, dig: { ...v.dig }, stalled: v.stalled,
          pouring: this.pouringMixer === v || v.kind === 'pump' && !!this.pouringMixer && v.docked,
        };
      });
    }
    snapshot() { return { step: this.applied, needs: this.needs, pouring: !!this.pouringMixer, vehicles: this.output() }; }
  }

  /* ------------------------------------------------------------------ validation helpers (tests) */
  function allRoutes() {
    const out = [];
    for (const kind of Object.keys(SPECS)) {
      const spec = SPECS[kind], r = inboundRoute(kind);
      out.push({ kind, route: r });
      out.push({ kind, route: retraceOut(spec, r, r.length) });
      out.push({ kind, route: retraceOut(spec, r, r.junction + (r.length - r.junction) / 2) });
    }
    const ex = SPECS.excavator, exBay = inboundRoute('excavator'), end = exBay.samples.at(-1);
    out.push({ kind: 'excavator', route: excavatorOut(ex, end.x, end.z, end.yaw) });
    out.push({ kind: 'roller', route: rollerOut(SPECS.roller, ROLLER_LINE.east) });
    out.push({ kind: 'roller', route: rollerOut(SPECS.roller, ROLLER_LINE.west) });
    out.push({ kind: 'roller', route: rollerPass(SPECS.roller, ROLLER_LINE.east) });
    return out;
  }
  // Progress range in which a machine kind can be on site, from the step plan.
  function activeRange(kind) {
    let lo = 1, hi = 0;
    PLAN.forEach((need, i) => {
      const on = kind === 'mixer' ? need.mixer : kind === 'dumper' ? need.dumper : need[kind];
      if (!on) return;
      const w = Sequence.window(i);
      lo = Math.min(lo, w.from); hi = Math.max(hi, w.to);
    });
    return [lo, hi];
  }

  return {
    // geometry
    line, arc, polyline, Path, overlaps, turnAngle, footprintAt, boxHitsRect, cellsOfBox,
    // layout and routes
    SPECS, BAYS, OBSTACLES, GRID, LANE_Z, ROLLER_LINE, buildRoute, inboundRoute, retraceOut, excavatorOut, rollerOut, rollerPass, poseOnRoute, allRoutes, activeRange,
    // construction plan
    PLAN, plan, nearestStep, stepKind,
    // simulation
    Fleet, createFleet: options => new Fleet(options),
    constants: { A_ACC, A_DEC, A_LAT, DEBOUNCE, BUDGET, ROAD_GAP, SITE_GAP, DS },
  };
});
