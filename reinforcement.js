/* Illustrative reinforcement only: no bar schedule, engineering dimensions or design positions. */
window.ConstructionRebar = (() => {
  const clamp = (value) => Math.max(0, Math.min(1, value));
  const STEEL = "#9c5d3b",
    TIES = "#54738b",
    STARTER = "#bd6c22",
    JOINT = "#b4842b";
  const details = {
    auto: { label: "Theo tiến độ", progress: null },
    foundation: {
      label: "Đi thép móng",
      progress: 0.279,
      zoom: 1.65,
      focus: [0, -0.48, 0.2],
      description:
        "Lưới thép móng, thép giằng và lồng thép chân cột trước đợt đổ bê tông.",
    },
    starters: {
      label: "Thép chờ · nối đợt tiếp theo",
      progress: 0.5116,
      zoom: 1.55,
      focus: [0, 1.05, 0.1],
      description:
        "Thép dọc nhô khỏi bê tông đã đổ; đai và các thanh nối được làm nổi bật để thấy phần chờ cho đợt tiếp theo.",
    },
    frame: {
      label: "Cốt thép cột · dầm · sàn",
      progress: 0.478,
      zoom: 1.55,
      focus: [0, 0.66, 0.05],
      description:
        "Lồng thép cột, thép dầm và hai lớp lưới thép sàn. Bê tông được làm mờ trong chế độ xem cấu tạo.",
    },
    joint: {
      label: "Mạch ngừng · hai đợt đổ",
      progress: 0.4896,
      zoom: 1.65,
      focus: [0, 0.76, 0.12],
      description:
        "Bê tông đợt 1 và đợt 2 khác sắc độ; ranh giới được đánh dấu, cốt thép liên tục đi qua hai vùng.",
    },
  };
  function rod(s, a, b, color = STEEL, width = 0.014) {
    let depth = 0;
    for (const p of [a, b])
      depth +=
        p[0] * Math.sin(s.angle) + p[2] * Math.cos(s.angle) + p[1] * 0.65;
    s.faces.push({
      p: [a, b],
      isRod: true,
      color,
      width: Math.max(0.8, s.s * width),
      depth: depth / 2 + 0.001,
    });
    s.rebarCount++;
  }
  function loop(s, x, y, z, w, d, color = TIES, width = 0.012) {
    const points = [
      [x, y, z],
      [x + w, y, z],
      [x + w, y, z + d],
      [x, y, z + d],
      [x, y, z],
    ];
    for (let i = 0; i < 4; i++) rod(s, points[i], points[i + 1], color, width);
  }
  function grid(s, x, z, width, depth, y, spacing = 0.18, color = STEEL) {
    for (let dx = 0; dx <= width + 0.001; dx += spacing)
      rod(s, [x + dx, y, z], [x + dx, y, z + depth], color);
    for (let dz = 0; dz <= depth + 0.001; dz += spacing)
      rod(s, [x, y + 0.007, z + dz], [x + width, y + 0.007, z + dz], color);
  }
  function cage(
    s,
    x,
    z,
    y0,
    y1,
    { width = 0.16, spacing = 0.22, starter = false, hook = false } = {},
  ) {
    const color = starter ? STARTER : STEEL,
      r = width / 2;
    for (const dx of [-r, r])
      for (const dz of [-r, r]) {
        rod(s, [x + dx, y0, z + dz], [x + dx, y1, z + dz], color, 0.017);
        if (hook)
          rod(
            s,
            [x + dx, y1, z + dz],
            [x + dx + (dx > 0 ? -0.07 : 0.07), y1 + 0.025, z + dz],
            color,
            0.017,
          );
      }
    for (let y = y0 + 0.05; y < y1 - 0.04; y += spacing)
      loop(
        s,
        x - r - 0.015,
        y,
        z - r - 0.015,
        width + 0.03,
        width + 0.03,
        TIES,
      );
  }
  function beamCage(s, a, b, y0, height = 0.16) {
    const alongX = Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]);
    for (const side of [-0.065, 0.065])
      for (const top of [0, height])
        rod(
          s,
          [a[0] + (alongX ? 0 : side), y0 + top, a[1] + (alongX ? side : 0)],
          [b[0] + (alongX ? 0 : side), y0 + top, b[1] + (alongX ? side : 0)],
          STEEL,
          0.016,
        );
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]),
      count = Math.max(1, Math.floor(length / (s.width < 600 ? 0.42 : 0.3)));
    for (let i = 0; i <= count; i++) {
      const t = i / count,
        x = a[0] + (b[0] - a[0]) * t,
        z = a[1] + (b[1] - a[1]) * t,
        points = alongX
          ? [
              [x, y0, z - 0.08],
              [x, y0 + height, z - 0.08],
              [x, y0 + height, z + 0.08],
              [x, y0, z + 0.08],
              [x, y0, z - 0.08],
            ]
          : [
              [x - 0.08, y0, z],
              [x - 0.08, y0 + height, z],
              [x + 0.08, y0 + height, z],
              [x + 0.08, y0, z],
              [x - 0.08, y0, z],
            ];
      for (let n = 0; n < 4; n++) rod(s, points[n], points[n + 1], TIES, 0.011);
    }
  }
  function draw(s, p) {
    const mode = s.detailMode || "auto",
      inspect = mode !== "auto",
      structure = clamp((p - 0.4) / 0.32),
      status = {
        mode,
        foundationGrids: 0,
        columnCages: 0,
        slabGrids: 0,
        starterGroups: 0,
        joints: 0,
        rods: 0,
      };
    s.rebarCount = 0;
    if (p > 0.26 && (p < 0.36 || mode === "foundation")) {
      const spacing = s.width < 600 ? 0.15 : 0.105;
      for (const x of [-1.6, 0, 1.6])
        for (const z of [-1.2, 0, 1.2]) {
          grid(s, x - 0.2, z - 0.2, 0.4, 0.4, -1.145, spacing);
          grid(s, x - 0.2, z - 0.2, 0.4, 0.4, -1.065, spacing, TIES);
          status.foundationGrids++;
          cage(s, x, z, -1.12, 0.38, {
            spacing: s.width < 600 ? 0.33 : 0.22,
            starter: true,
            hook: true,
          });
          status.starterGroups++;
          // Small corner chairs separate the two illustrative mesh layers.
          for (const dx of [-0.12, 0.12])
            rod(
              s,
              [x + dx, -1.145, z - 0.12],
              [x + dx, -1.065, z - 0.12],
              TIES,
              0.013,
            );
        }
      for (const z of [-1.2, 1.2])
        beamCage(s, [-1.6, z], [1.6, z], -0.49, 0.14);
      for (const x of [-1.6, 0, 1.6])
        beamCage(s, [x, -1.2], [x, 1.2], -0.49, 0.14);
    }
    for (let floor = 0; floor < 3; floor++) {
      const q = clamp(structure * 3 - floor);
      if (q <= 0) continue;
      const y = floor * 1.08,
        next = clamp(structure * 3 - floor - 1),
        exposed = q < 0.63 || inspect;
      if (exposed) {
        const height = Math.max(0.24, Math.min(1.1, (q / 0.24) * 1.1));
        for (const x of [-1.6, 0, 1.6])
          for (const z of [-1.2, 1.2]) {
            cage(s, x, z, y + 0.02, y + height, {
              spacing: s.width < 600 ? 0.3 : 0.22,
              hook: true,
            });
            status.columnCages++;
          }
      }
      if (q > 0.43 && (q < 0.96 || inspect)) {
        for (const z of [-1.2, 0, 1.2])
          beamCage(s, [-1.6, z], [1.6, z], y + 0.86, 0.15);
        for (const x of [-1.6, 0, 1.6])
          beamCage(s, [x, -1.2], [x, 1.2], y + 0.86, 0.15);
      }
      if (q > 0.55 && (q < 0.97 || inspect)) {
        const spacing = s.width < 600 ? 0.39 : 0.28;
        grid(s, -1.7, -1.3, 3.4, 2.6, y + 1.035, spacing);
        grid(s, -1.7, -1.3, 3.4, 2.6, y + 1.105, spacing, TIES);
        status.slabGrids++;
        // Reinforcement continues across the two pouring zones.
        if (mode === "joint")
          for (const z of [-1.04, -0.52, 0, 0.52, 1.04])
            rod(s, [-0.55, y + 1.15, z], [0.7, y + 1.15, z], STARTER, 0.019);
      }
      if (floor < 2 && q > 0.75 && next < 0.6) {
        for (const x of [-1.6, 0, 1.6])
          for (const z of [-1.2, 1.2]) {
            cage(s, x, z, y + 0.93, y + 1.53, {
              spacing: 0.22,
              starter: true,
              hook: true,
            });
            status.starterGroups++;
            if (mode === "starters")
              for (const dx of [-0.08, 0.08])
                rod(
                  s,
                  [x + dx + 0.035, y + 1.2, z + 0.08],
                  [x + dx + 0.035, y + 1.77, z + 0.08],
                  TIES,
                  0.015,
                );
          }
      }
      if ((q > 0.76 && q < 0.98) || mode === "joint") {
        const seamX = 0,
          top = y + 1.135;
        for (let z = -1.35; z < 1.36; z += 0.25)
          rod(
            s,
            [seamX, top, z],
            [seamX, top, Math.min(1.35, z + 0.15)],
            JOINT,
            0.021,
          );
        if (mode === "joint")
          for (let z = -1.28; z < 1.3; z += 0.24)
            rod(
              s,
              [0, y + 1.005, z],
              [0, y + 1.125, z + 0.055],
              "#847750",
              0.016,
            );
        status.joints++;
      }
    }
    status.rods = s.rebarCount;
    return status;
  }
  return {
    details,
    draw,
    clamp,
    progressFor: (mode, p) => details[mode]?.progress ?? p,
  };
})();
