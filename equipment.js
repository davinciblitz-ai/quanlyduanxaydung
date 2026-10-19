/* Schematic site equipment, drawn in the same world and depth order as the building. */
window.ConstructionEquipment = (() => {
  const clamp = (v) => Math.max(0, Math.min(1, v));
  const mix = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => {
    t = clamp(t);
    return t * t * (3 - 2 * t);
  };
  function face(s, points, color, alpha = 1) {
    const rgb = color
      .replace("#", "")
      .match(/../g)
      .map((x) => parseInt(x, 16));
    const fill = alpha < 1 ? `rgba(${rgb.join(",")},${alpha})` : color;
    let depth = 0;
    for (const [x, y, z] of points)
      depth += x * Math.sin(s.angle) + z * Math.cos(s.angle) + y * 0.65;
    s.faces.push({ p: points, fill, depth: depth / points.length });
  }
  function cylinder(s, a, b, r, color, segments = 10, alpha = 1) {
    const direction = b.map((v, i) => v - a[i]),
      length = Math.hypot(...direction);
    if (length < 0.001) return;
    const n = direction.map((v) => v / length),
      helper = Math.abs(n[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    let u = [
      n[1] * helper[2] - n[2] * helper[1],
      n[2] * helper[0] - n[0] * helper[2],
      n[0] * helper[1] - n[1] * helper[0],
    ];
    const ul = Math.hypot(...u);
    u = u.map((v) => v / ul);
    const v = [
      n[1] * u[2] - n[2] * u[1],
      n[2] * u[0] - n[0] * u[2],
      n[0] * u[1] - n[1] * u[0],
    ];
    const rings = [a, b].map((center) =>
      Array.from({ length: segments }, (_, i) =>
        center.map(
          (value, j) =>
            value +
            r *
              (u[j] * Math.cos((i / segments) * Math.PI * 2) +
                v[j] * Math.sin((i / segments) * Math.PI * 2)),
        ),
      ),
    );
    const rgb = color
      .replace("#", "")
      .match(/../g)
      .map((x) => parseInt(x, 16));
    const camera = [Math.sin(s.angle), 0.65, Math.cos(s.angle)];
    for (let i = 0; i < segments; i++) {
      const a = ((i + 0.5) / segments) * Math.PI * 2,
        normal = u.map((x, j) => x * Math.cos(a) + v[j] * Math.sin(a));
      if (normal.reduce((sum, x, j) => sum + x * camera[j], 0) <= 0) continue;
      const shade = 0.72 + 0.28 * (0.5 + 0.5 * Math.cos(a));
      const col =
        "#" +
        rgb
          .map((v) =>
            Math.round(v * shade)
              .toString(16)
              .padStart(2, "0"),
          )
          .join("");
      face(
        s,
        [
          rings[0][i],
          rings[1][i],
          rings[1][(i + 1) % segments],
          rings[0][(i + 1) % segments],
        ],
        col,
        alpha,
      );
    }
    const cap = n.reduce((sum, x, j) => sum + x * camera[j], 0);
    if (cap < 0) face(s, rings[0], color, alpha);
    else face(s, rings[1], color, alpha);
  }
  function wheel(s, x, y, z, r = 0.16, width = 0.11, alpha = 1) {
    cylinder(
      s,
      [x, y, z - width / 2],
      [x, y, z + width / 2],
      r,
      "#26322e",
      8,
      alpha,
    );
    cylinder(
      s,
      [x, y, z - width * 0.54],
      [x, y, z + width * 0.54],
      r * 0.44,
      "#9da78e",
      6,
      alpha,
    );
  }
  function mound(s, x, z, r, height, y = -0.36, color = "#9b8054") {
    const colors = [color, "#8e724c", "#aa8b5b", "#816a47"];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2,
        b = ((i + 1) / 12) * Math.PI * 2;
      face(
        s,
        [
          [x + Math.cos(a) * r, y, z + Math.sin(a) * r],
          [x + Math.cos(b) * r, y, z + Math.sin(b) * r],
          [x + r * 0.08, y + height, z - r * 0.1],
        ],
        colors[i % 4],
      );
    }
  }
  // dir = 1: cab towards +x; dir = -1: mirrored (cab towards -x).
  function vehicleBase(s, x, z, alpha = 1, color = "#e1e6cd", dir = 1) {
    const B = (a, b, c, w, h, d, col) =>
      s.box(x + (dir > 0 ? a : -(a + w)), b, z + c, w, h, d, col, alpha);
    B(-0.92, -0.17, -0.29, 1.88, 0.17, 0.58, "#48564b");
    for (const ax of [-0.63, -0.25, 0.65]) {
      wheel(s, x + dir * ax, -0.15, z + 0.34, 0.16, 0.11, alpha);
      s.box(x + dir * ax - 0.12, -0.29, z - 0.4, 0.24, 0.29, 0.13, "#26322e", alpha);
    }
    B(0.45, -0.02, -0.31, 0.52, 0.47, 0.62, color);
    B(0.48, 0.44, -0.34, 0.5, 0.06, 0.68, color);
    B(0.53, 0.2, 0.316, 0.28, 0.18, 0.012, "#345c50");
    B(0.53, 0.2, -0.328, 0.28, 0.18, 0.012, "#345c50");
    B(0.96, 0.17, -0.24, 0.014, 0.22, 0.47, "#47675a");
    B(0.95, -0.02, -0.33, 0.08, 0.1, 0.66, "#69775b");
    B(1.018, 0.035, -0.25, 0.015, 0.065, 0.13, "#f3e6a5");
    B(1.018, 0.035, 0.12, 0.015, 0.065, 0.13, "#f3e6a5");
    B(0.6, 0.08, 0.33, 0.08, 0.035, 0.012, "#8a977d");
    B(0.84, 0.39, 0.32, 0.025, 0.11, 0.04, "#bac6a4");
  }
  function mixer(s, x, z, time, alpha = 1, dir = 1) {
    vehicleBase(s, x, z, alpha, "#dde5cf", dir);
    s.box(dir > 0 ? x - 0.82 : x - 0.3, 0.0, z - 0.29, 1.12, 0.12, 0.58, "#638755", alpha);
    const rings = [
        [-0.78, 0.16],
        [-0.62, 0.32],
        [-0.08, 0.34],
        [0.24, 0.18],
      ],
      segments = 14,
      spin = time * 0.7;
    const points = rings.map(([dx, r]) =>
      Array.from({ length: segments }, (_, i) => {
        const a = (i / segments) * Math.PI * 2 + spin;
        return [
          x + dir * dx,
          0.42 + dx * 0.18 + Math.cos(a) * r,
          z + Math.sin(a) * r,
        ];
      }),
    );
    for (let row = 0; row < rings.length - 1; row++)
      for (let i = 0; i < segments; i++) {
        const col = i % 7 < 3 ? "#dce4cc" : "#779b62";
        face(
          s,
          [
            points[row][i],
            points[row + 1][i],
            points[row + 1][(i + 1) % segments],
            points[row][(i + 1) % segments],
          ],
          col,
          alpha,
        );
      }
    face(s, points[0], "#b4c59d", alpha);
    face(s, points.at(-1), "#d6dfc4", alpha);
    cylinder(
      s,
      [x - dir * 0.85, 0.3, z],
      [x - dir * 1.12, 0.02, z + 0.35],
      0.065,
      "#a2ae8a",
      7,
      alpha,
    );
    s.box(dir > 0 ? x - 0.44 : x + 0.08, -0.03, z + 0.3, 0.36, 0.08, 0.09, "#c0d293", alpha);
  }
  function dumper(s, x, z, time, alpha = 1) {
    vehicleBase(s, x, z, alpha, "#d8bd71");
    const tilt = Math.max(0, Math.sin(time * 0.38)) * 0.37,
      front = 0.15,
      back = -0.86,
      y = 0.07;
    const q = (dx, dz, up = 0) => [x + dx, y + (dx - back) * tilt + up, z + dz];
    face(
      s,
      [q(back, -0.33), q(front, -0.33), q(front, 0.33), q(back, 0.33)],
      "#8e764c",
      alpha,
    );
    for (const side of [-0.33, 0.33])
      face(
        s,
        [
          q(back, side),
          q(front, side),
          q(front, side, 0.33),
          q(back, side, 0.33),
        ],
        "#bb9e5f",
        alpha,
      );
    face(
      s,
      [
        q(front, -0.33),
        q(front, 0.33),
        q(front, 0.33, 0.33),
        q(front, -0.33, 0.33),
      ],
      "#c5a965",
      alpha,
    );
    face(
      s,
      [
        q(back, -0.33),
        q(back, 0.33),
        q(back, 0.33, 0.28),
        q(back, -0.33, 0.28),
      ],
      "#aa8a50",
      alpha,
    );
    const soilTop = 0.25 + tilt * 0.3;
    mound(s, x - 0.3, z, 0.39, 0.18, y + soilTop, "#9d7b4c");
  }
  function excavator(s, p, time, pitDepth) {
    const x = 2.65,
      z = -0.25;
    for (const side of [-0.43, 0.31]) {
      s.box(x - 0.58, -0.32, z + side, 1.15, 0.23, 0.22, "#334036");
      for (let i = 0; i < 7; i++)
        s.box(
          x - 0.56 + i * 0.16,
          -0.27,
          z + side + 0.23,
          0.025,
          0.12,
          0.015,
          "#77816c",
        );
    }
    s.box(x - 0.4, -0.08, z - 0.32, 0.88, 0.33, 0.64, "#c7aa5c");
    s.box(x - 0.37, 0.24, z - 0.28, 0.43, 0.43, 0.52, "#d9bd70");
    s.box(x - 0.33, 0.34, z + 0.25, 0.33, 0.23, 0.014, "#36584a");
    s.box(x - 0.35, 0.67, z - 0.31, 0.46, 0.045, 0.57, "#e4ce89");
    s.box(x + 0.25, 0.13, z - 0.35, 0.35, 0.2, 0.7, "#b49a51");
    const u = (Math.sin(time * 0.65) + 1) / 2,
      base = [x - 0.03, 0.35, z + 0.04],
      elbow = [x - 0.55 + u * 0.16, 1.18, z + 0.08 + u * 0.9],
      tip = [
        1.05 + u * 0.85,
        -0.25 - pitDepth * 0.7 + u * (1.18 + pitDepth * 0.7),
        0.12 + u * 2.53,
      ];
    cylinder(s, base, elbow, 0.075, "#d5b56b", 8);
    cylinder(s, elbow, tip, 0.06, "#cba85b", 8);
    cylinder(
      s,
      [base[0] + 0.1, base[1] + 0.06, base[2]],
      [
        (base[0] + elbow[0]) / 2 + 0.1,
        (base[1] + elbow[1]) / 2,
        elbow[2] - 0.06,
      ],
      0.024,
      "#a2ad8d",
      6,
    );
    cylinder(
      s,
      [elbow[0] + 0.07, elbow[1] - 0.05, elbow[2]],
      [(tip[0] + elbow[0]) / 2 + 0.08, (tip[1] + elbow[1]) / 2, tip[2]],
      0.022,
      "#bac3a7",
      6,
    );
    s.box(
      tip[0] - 0.17,
      tip[1] - 0.15,
      tip[2] - 0.15,
      0.32,
      0.17,
      0.3,
      "#4c5140",
    );
    for (let i = 0; i < 3; i++)
      s.box(
        tip[0] - 0.16 + i * 0.12,
        tip[1] - 0.21,
        tip[2] + 0.12,
        0.045,
        0.11,
        0.11,
        "#707159",
      );
    if (u > 0.12 && u < 0.9)
      mound(s, tip[0], tip[2], 0.14, 0.1, tip[1] + 0.02, "#a38659");
    if (u > 0.82)
      for (let i = 0; i < 5; i++) {
        const drop = (time * 1.7 + i * 0.17) % 0.7;
        s.box(
          tip[0] + Math.sin(i) * 0.07,
          tip[1] - drop,
          tip[2] + Math.cos(i) * 0.06,
          0.055,
          0.065,
          0.055,
          "#a58b5c",
        );
      }
  }
  function roller(s, p, time) {
    const x = Math.sin(time * 0.42) * 1.2 - .1,
      z = -2.65;
    s.box(-2.5, -0.355, z - 0.6, 5, 0.018, 1.2, "#a78960");
    cylinder(
      s,
      [x + 0.38, -0.09, z - 0.44],
      [x + 0.38, -0.09, z + 0.44],
      0.28,
      "#9ca486",
      14,
    );
    for (const side of [-0.35, 0.35])
      wheel(s, x - 0.48, -0.15, z + side, 0.18, 0.16);
    s.box(x - 0.68, -0.02, z - 0.32, 0.95, 0.27, 0.64, "#d1ad59");
    s.box(x - 0.22, 0.12, z - 0.26, 0.38, 0.2, 0.52, "#c19c4a");
    for (const ax of [-0.56, -0.05])
      for (const side of [-0.29, 0.29])
        s.box(x + ax, 0.23, z + side, 0.025, 0.55, 0.025, "#5c684d");
    s.box(x - 0.64, 0.77, z - 0.36, 0.7, 0.055, 0.72, "#e4cd87");
    s.box(x - 0.42, 0.29, z - 0.13, 0.17, 0.2, 0.23, "#596b45");
    s.box(x - 0.39, 0.5, z - 0.1, 0.12, 0.12, 0.16, "#c9ba8c");
    s.box(x - 0.4, 0.61, z - 0.12, 0.14, 0.045, 0.19, "#f0d98c");
    for (let i = 0; i < 3; i++)
      s.box(
        x - 0.82 - i * 0.16,
        -0.33,
        z - 0.14 + Math.sin(time + i) * 0.25,
        0.07,
        0.04,
        0.07,
        "#87906b",
        0.5,
      );
  }
  function truckX(time, period = 24, parking = 1.55) {
    const t = (((time % period) + period) % period) / period;
    return t < 0.25
      ? mix(-5.5, parking, smooth(t / 0.25))
      : t < 0.75
        ? parking
        : mix(parking, 5.6, smooth((t - 0.75) / 0.25));
  }
  function pump(s, p, time, docked, alpha = 1) {
    const x = -1.35,
      z = 2.62;
    vehicleBase(s, x, z, 1, "#d2dbbf");
    s.box(x - 0.65, 0.03, z - 0.27, 0.74, 0.37, 0.54, "#8fa371");
    for (const dx of [-0.65, 0.35])
      s.box(x + dx, -0.26, z - 0.65, 0.075, 0.15, 1.3, "#b9c798");
    const structure = clamp((p - 0.4) / 0.32),
      level =
        p < 0.34
          ? -0.92
          : Math.max(0.06, Math.floor(structure * 3) * 1.08 + 0.03),
      tip = [0.58, level + 0.4, 0.25];
    const chain = [
      [x - 0.25, 0.34, z],
      [x - 0.45, level + 1.46, z - 0.3],
      [1.45, level + 1.2, 0.8],
      tip,
    ];
    for (let i = 0; i < chain.length - 1; i++)
      cylinder(
        s,
        chain[i],
        chain[i + 1],
        0.049,
        i % 2 ? "#ced8b3" : "#b6c98a",
        7,
      );
    cylinder(s, tip, [tip[0], level + 0.3, tip[2]], 0.024, "#303e33", 7);
    const parked = docked;
    if (parked) {
      cylinder(
        s,
        [tip[0], level + 0.29, tip[2]],
        [tip[0], level + 0.015, tip[2]],
        0.018,
        "#d5d9bf",
        6,
      );
      for (let i = 0; i < 5; i++) {
        const y = level + 0.27 - ((time * 1.4 + i * 0.055) % 0.26);
        s.box(tip[0] - 0.014, y, tip[2] - 0.014, 0.028, 0.05, 0.028, "#d1d4bc");
      }
      if (p < 0.34)
        s.box(0.28, level - 0.03, -0.08, 0.62, 0.055, 0.65, "#b6bca2");
      else s.box(0.08, level - 0.03, -0.25, 1.05, 0.035, 1.0, "#aab69a");
      // Concrete running down the mixer chute into the pump hopper (rear to rear).
      cylinder(s, [x - 0.95, 0.06, z + 0.25], [x - 0.88, -0.12, z + 0.05], 0.03, "#b3b89e", 6);
    }
    return parked;
  }
  // Four illustrative lifts: spread each lift before compacting it.
  // Lift count/height are visual, never engineering quantities.
  function earthwork(p) {
    if (p < .32) return { backfill: 0, lift: 0, placing: false, compacting: false, complete: false };
    if (p >= .4) return { backfill: 1, lift: 4, placing: false, compacting: false, complete: true };
    const cycle = Math.min(3.999999, (p - .32) / .08 * 4), lift = Math.floor(cycle), within = cycle - lift;
    return { backfill: (lift + smooth(Math.min(1, within * 2))) / 4, lift: lift + 1, placing: within < .5, compacting: within >= .5, complete: false };
  }
  // Machines working at progress p. The step-based fleet plan (fleet.js) is authoritative; the
  // fallback below only applies if fleet.js is missing.
  function plan(p) {
    if (window.FleetMotion && window.FleetMotion.plan) return window.FleetMotion.plan(p);
    return {
      roller: earthwork(p).compacting,
      excavator: p >= 0.18 && p < 0.265,
      dumpTruck: (p >= 0.18 && p < 0.265) || earthwork(p).placing,
      mixer: (p >= 0.285 && p < 0.32) || (p >= 0.4 && p < 0.72),
      pump: (p >= 0.285 && p < 0.32) || (p >= 0.4 && p < 0.72),
    };
  }
  function draw(s, p, time, pitDepth) {
    const t = s.reduced ? 9 : time;
    const active = plan(p);
    if (active.roller) roller(s, p, t);
    if (active.excavator) excavator(s, p, t, pitDepth);
    if (active.dumpTruck) {
      const x = truckX(t, 19, 2.15),
        a = clamp((x + 5.5) / 0.7) * clamp((5.6 - x) / 0.7);
      dumper(s, x, 2.65, t, a);
    }
    let pouring = false,
      mixerX = null;
    if (active.mixer || active.pump) {
      // The pump stands at x -1.35 with its hopper at the rear (x ≈ -2.27). Each mixer backs up from
      // the west to rear-to-rear, discharges, then drives forward away again — never through the pump.
      const period = 24, q = ((t % period) + period) % period / period, dock = -3.27, start = -5.6;
      mixerX = q < 0.25 ? mix(start, dock, smooth(q / 0.25)) : q < 0.8 ? dock : mix(dock, start, smooth((q - 0.8) / 0.2));
      const a = clamp((mixerX - start) / 0.6);
      mixer(s, mixerX, 2.65, t, a, -1);
      pouring = pump(s, p, t, active.mixer && Math.abs(mixerX - dock) < 0.02, 1);
    }
    return { ...active, pouring, mixerX };
  }
  return { draw, face, cylinder, mound, plan, earthwork };
})();
