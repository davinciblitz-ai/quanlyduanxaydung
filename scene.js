/* Lightweight isometric construction illustration. Geometry is schematic, not a BIM model. */
window.BuildScene = class BuildScene {
  constructor(canvas, getProgress) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.getProgress = getProgress;
    this.detailMode = "auto";
    this.pointer = 0;
    this.touchYaw = 0;
    this.angle = -0.61;
    this.running = true;
    this.visible = true;
    this.dirty = true;
    this.lastTime = performance.now();
    if (!this.ctx) {
      canvas.insertAdjacentHTML(
        "afterend",
        '<p style="padding:40px;color:#c5d7af">Mô phỏng: hạ tầng → mặt bằng → phần ngầm → móng → kết cấu → hoàn thiện → bàn giao. Bạn vẫn có thể dùng thanh thời gian và các công cụ tính.</p>',
      );
      this.running = false;
      return;
    }
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.onMove = (e) => {
      if (this.reduced || e.pointerType === "touch") return;
      const r = canvas.getBoundingClientRect();
      this.pointer = (e.clientX - r.left) / r.width - 0.5;
      this.dirty = true;
    };
    this.onLeave = () => {
      this.pointer = 0;
    };
    canvas.addEventListener("pointermove", this.onMove);
    canvas.addEventListener("pointerleave", this.onLeave);
    if (window.PhyTouch) {
      this.orbit = { value: 0 };
      this.phy = new PhyTouch({
        touch: canvas,
        vertical: false,
        target: this.orbit,
        property: "value",
        value: 0,
        min: -260,
        max: 260,
        sensitivity: 0.85,
        maxSpeed: 0.5,
        preventDefault: false,
        lockDirection: true,
        inertia: !this.reduced,
        change: (value) => {
          this.touchYaw = Math.max(-0.8, Math.min(0.8, value / 360));
          this.dirty = true;
        },
      });
    }
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    this.resize();
    this.visibility = new IntersectionObserver((entries) => {
      this.visible = entries[0].isIntersecting;
      this.dirty = true;
    });
    this.visibility.observe(canvas);
    BuildScene.instances.add(this);
    BuildScene.start();
  }
  static instances = new Set();
  static frame = null;
  static paused = false;
  static heldTime = 0;
  static phaseBounds = [0, 0.1, 0.18, 0.26, 0.4, 0.72, 0.98, 1];
  static phaseAt(progress) {
    return Math.max(
      0,
      Math.min(
        6,
        BuildScene.phaseBounds.slice(1).findIndex((b) => progress < b) === -1
          ? 6
          : BuildScene.phaseBounds.slice(1).findIndex((b) => progress < b),
      ),
    );
  }
  static phaseMiddle(index) {
    return (
      (BuildScene.phaseBounds[index] + BuildScene.phaseBounds[index + 1]) / 2
    );
  }
  static start() {
    if (BuildScene.frame !== null) return;
    const tick = (time) => {
      for (const s of BuildScene.instances) {
        const progress = s.getProgress();
        if (
          s.running &&
          s.visible &&
          ((!s.reduced && !BuildScene.paused) ||
            s.dirty ||
            s.lastProgress !== progress ||
            Math.abs(s.angle - (-0.61 + s.pointer * 0.65 + s.touchYaw)) > 0.001)
        ) {
          s.dt = Math.min(0.05, (time - s.lastTime) / 1000);
          s.lastTime = time;
          s.draw();
          s.dirty = false;
          s.lastProgress = progress;
        }
      }
      if (BuildScene.instances.size)
        BuildScene.frame = requestAnimationFrame(tick);
      else BuildScene.frame = null;
    };
    BuildScene.frame = requestAnimationFrame(tick);
  }
  destroy() {
    this.running = false;
    BuildScene.instances.delete(this);
    this.observer?.disconnect();
    this.visibility?.disconnect();
    this.phy?.destory();
    this.canvas.removeEventListener("pointermove", this.onMove);
    this.canvas.removeEventListener("pointerleave", this.onLeave);
  }
  resize() {
    const r = this.canvas.getBoundingClientRect(),
      d = Math.min(2, devicePixelRatio || 1);
    this.width = r.width;
    this.height = r.height;
    this.canvas.width = Math.max(1, r.width * d);
    this.canvas.height = Math.max(1, r.height * d);
    this.ctx.setTransform(d, 0, 0, d, 0, 0);
    this.dirty = true;
  }
  project([x, y, z]) {
    const a = this.angle;
    return [
      this.cx + (x * Math.cos(a) - z * Math.sin(a)) * this.s,
      this.cy +
        (x * Math.sin(a) + z * Math.cos(a)) * 0.42 * this.s -
        y * 0.83 * this.s,
    ];
  }
  polygon(points, fill, stroke = "#4e739030", line = 0.6) {
    const c = this.ctx;
    c.beginPath();
    points.forEach((p, i) => {
      const q = this.project(p);
      i ? c.lineTo(...q) : c.moveTo(...q);
    });
    c.closePath();
    c.fillStyle = fill;
    c.fill();
    if (stroke) {
      c.strokeStyle = stroke;
      c.lineWidth = line;
      c.stroke();
    }
  }
  line(points, color = "#8bac6d55", width = 1, dash = []) {
    const c = this.ctx;
    c.beginPath();
    points.forEach((p, i) => {
      const q = this.project(p);
      i ? c.lineTo(...q) : c.moveTo(...q);
    });
    c.strokeStyle = color;
    c.lineWidth = width;
    c.setLineDash(dash);
    c.stroke();
    c.setLineDash([]);
  }
  box(x, y, z, w, h, d, color, alpha = 1) {
    if (h <= 0 || alpha <= 0) return;
    const hex = color.replace("#", ""),
      rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const shade = (f) =>
      `rgba(${rgb.map((v) => Math.min(255, Math.floor(v * f))).join(",")},${alpha})`;
    const faces = [
      {
        n: [0, 1, 0],
        p: [
          [x, y + h, z],
          [x + w, y + h, z],
          [x + w, y + h, z + d],
          [x, y + h, z + d],
        ],
        f: 1.12,
      },
      {
        n: [1, 0, 0],
        p: [
          [x + w, y, z],
          [x + w, y, z + d],
          [x + w, y + h, z + d],
          [x + w, y + h, z],
        ],
        f: 0.72,
      },
      {
        n: [-1, 0, 0],
        p: [
          [x, y, z + d],
          [x, y, z],
          [x, y + h, z],
          [x, y + h, z + d],
        ],
        f: 0.8,
      },
      {
        n: [0, 0, 1],
        p: [
          [x + w, y, z + d],
          [x, y, z + d],
          [x, y + h, z + d],
          [x + w, y + h, z + d],
        ],
        f: 0.9,
      },
      {
        n: [0, 0, -1],
        p: [
          [x, y, z],
          [x + w, y, z],
          [x + w, y + h, z],
          [x, y + h, z],
        ],
        f: 0.7,
      },
    ];
    faces
      .filter(
        (f) =>
          f.n[1] > 0 ||
          f.n[0] * Math.sin(this.angle) + f.n[2] * Math.cos(this.angle) > 0,
      )
      .forEach((f) => {
        let depth = 0;
        f.p.forEach(
          ([a, b, c]) =>
            (depth +=
              a * Math.sin(this.angle) + c * Math.cos(this.angle) + b * 0.65),
        );
        this.faces.push({ p: f.p, fill: shade(f.f), depth: depth / 4 });
      });
  }
  draw() {
    const c = this.ctx,
      w = this.width,
      h = this.height;
    if (!w || !h) return;
    c.clearRect(0, 0, w, h);
    const target = -0.61 + this.pointer * 0.65 + this.touchYaw;
    this.angle = this.reduced
      ? target
      : this.angle +
        (target - this.angle) * (1 - Math.exp(-7 * (this.dt || 0.016)));
    const detail =
        ConstructionRebar.details[this.detailMode] ||
        ConstructionRebar.details.auto,
      inspection = this.detailMode !== "auto";
    this.s = Math.min(w / 10.6, h / 8.0) * (detail.zoom || 1);
    this.cx = w * 0.52;
    this.cy = h * (this.canvas.id === "hero-canvas" ? 0.61 : 0.67);
    if (detail.focus) {
      const [x, y, z] = detail.focus;
      this.cx =
        w * 0.51 -
        (x * Math.cos(this.angle) - z * Math.sin(this.angle)) * this.s;
      this.cy =
        h * 0.55 -
        (x * Math.sin(this.angle) + z * Math.cos(this.angle)) * 0.42 * this.s +
        y * 0.83 * this.s;
    }
    const sourceProgress = Math.max(0, Math.min(1, this.getProgress()));
    const p = ConstructionRebar.progressFor(this.detailMode, sourceProgress),
      time = this.reduced
        ? 0
        : (BuildScene.paused ? BuildScene.heldTime : performance.now()) / 1000;
    const glow = c.createRadialGradient(
      w * 0.53,
      h * 0.55,
      0,
      w * 0.53,
      h * 0.55,
      w * 0.5,
    );
    glow.addColorStop(0, "#2b73c218");
    glow.addColorStop(1, "#eaf4ff00");
    c.fillStyle = glow;
    c.fillRect(0, 0, w, h);
    for (let x = -7; x <= 7; x++)
      this.line(
        [
          [x, -0.48, -7],
          [x, -0.48, 7],
        ],
        "#32609c18",
        0.6,
      );
    for (let z = -7; z <= 7; z++)
      this.line(
        [
          [-7, -0.48, z],
          [7, -0.48, z],
        ],
        "#32609c18",
        0.6,
      );
    this.faces = [];
    const excavating = p >= 0.18 && p < 0.4,
      dig = Math.max(0, Math.min(1, (p - 0.18) / 0.04)),
      backfill = ConstructionEquipment.earthwork(p).backfill,
      pitDepth = excavating ? 0.85 * dig * (1 - backfill) : 0;
    const earth = (x, z, w, d) => {
      this.box(x, -1.45, z, w, 0.9, d, "#756344");
      this.box(x, -0.55, z, w, 0.18, d, "#a58b68");
    };
    if (excavating) {
      earth(-4, -3.5, 2, 6.7);
      earth(2, -3.5, 2, 6.7);
      earth(-2, -3.5, 4, 1.85);
      earth(-2, 1.75, 4, 1.45);
      const floor = -0.37 - pitDepth,
        ring = [
          [-2, -1.65],
          [2, -1.65],
          [2, 1.75],
          [-2, 1.75],
        ],
        C = ConstructionEquipment;
      C.face(
        this,
        ring.map(([x, z]) => [x, floor, z]),
        "#5c523b",
      );
      for (let i = 0; i < 4; i++) {
        const a = ring[i],
          b = ring[(i + 1) % 4],
          middle = Math.max(floor, -0.76);
        C.face(
          this,
          [
            [a[0], -0.37, a[1]],
            [b[0], -0.37, b[1]],
            [b[0], middle, b[1]],
            [a[0], middle, a[1]],
          ],
          i % 2 ? "#9f875d" : "#b19667",
        );
        if (floor < middle)
          C.face(
            this,
            [
              [a[0], middle, a[1]],
              [b[0], middle, b[1]],
              [b[0], floor, b[1]],
              [a[0], floor, a[1]],
            ],
            i % 2 ? "#756044" : "#8c7350",
          );
      }
      C.mound(this, 2.65, -2.35, 0.65, 0.5 * dig * (1 - backfill));
      C.mound(this, 1.55, -2.7, 0.44, 0.33 * dig * (1 - backfill));
      for (let x = -1.9; x < 2; x += 0.55) {
        this.box(x, -0.34, 1.77, 0.28, 0.035, 0.06, "#d1bd73");
        this.box(x + 0.28, -0.34, 1.77, 0.26, 0.035, 0.06, "#4b5135");
      }
      for (let z = -1.6; z < 1.6; z += 0.6)
        this.box(-2.04, -0.34, z, 0.05, 0.035, 0.28, "#d1bd73");
    } else earth(-4, -3.5, 8, 6.7);
    // External road and service trench precede internal works.
    this.box(-4, -0.35, 2.12, 8, 0.025, 1.02, "#536149");
    for (let x = -3.7; x < 4; x += 0.8)
      this.box(x, -0.318, 2.77, 0.38, 0.008, 0.025, "#becb9e");
    if (p > 0.04) {
      this.box(-3.7, -0.35, -3.2, 0.08, 0.05, 5.6, "#aaba71");
      this.box(-3.45, -0.35, -3.2, 0.045, 0.04, 5.6, "#788ec1");
    }
    if (p > 0.12) {
      this.box(2.4, -0.35, 1.0, 1.0, 0.7, 1.0, "#72836a");
      this.box(2.34, 0.35, 0.94, 1.12, 0.07, 1.12, "#b4c69c");
      this.box(2.5, -0.05, 2.005, 0.25, 0.25, 0.01, "#253d35");
    }
    if (p > 0.26) {
      let footingIndex = 0;
      const foundationPour = Math.max(0, Math.min(1, (p - 0.285) / 0.035));
      for (let x of [-1.6, 0, 1.6])
        for (let z of [-1.2, 0, 1.2]) {
          this.box(x - 0.26, -1.235, z - 0.26, 0.52, 0.045, 0.52, "#a5afae");
          const poured = Math.max(
            0,
            Math.min(1, foundationPour * 9 - footingIndex++),
          );
          this.box(
            x - 0.23,
            -1.18,
            z - 0.23,
            0.46,
            0.2 * poured,
            0.46,
            "#c3c9c9",
          );
          this.box(
            x - 0.085,
            -0.98,
            z - 0.085,
            0.17,
            1.1 * poured,
            0.17,
            "#c2cdd2",
          );
        }
      if (p >= 0.4) this.box(-1.8, -0.11, -1.4, 3.6, 0.1, 2.8, "#8b9a7c");
    }
    const structure = Math.max(0, Math.min(1, (p - 0.4) / 0.32)),
      finish = Math.max(0, Math.min(1, (p - 0.72) / 0.26));
    // Columns and slabs rise from the ground; the facade completes from the roof down.
    for (let floor = 0; floor < 3; floor++) {
      const q = Math.max(0, Math.min(1, structure * 3 - floor));
      if (q === 0) continue;
      const y = floor * 1.08;
      const columnPour = Math.max(0, Math.min(1, (q - 0.26) / 0.3)),
        concreteAlpha = this.detailMode === "frame" ? 0.18 : 1;
      for (let x of [-1.6, 0, 1.6])
        for (let z of [-1.2, 1.2])
          this.box(
            x - 0.07,
            y,
            z - 0.07,
            0.14,
            1.0 * columnPour,
            0.14,
            "#d0dce5",
            concreteAlpha,
          );
      if (q > 0.52 && q < 0.97) {
        this.box(
          -1.8,
          y + 0.975,
          -1.4,
          3.6,
          0.025,
          2.8,
          "#aa8e62",
          this.detailMode === "frame" ? 0.35 : 1,
        );
        for (const x of [-1.4, 1.4])
          for (const z of [-1.0, 1.0])
            this.box(x, y + 0.05, z, 0.035, 0.92, 0.035, "#85775a");
      }
      if (q > 0.72) {
        const fill = Math.max(0, Math.min(1, (q - 0.72) / 0.22)),
          left = Math.min(1, fill * 2),
          right = Math.max(0, fill * 2 - 1);
        if (left > 0)
          this.box(
            -1.82,
            y + 1.0,
            -1.42,
            1.82 * left,
            0.13,
            2.84,
            "#b8c8d4",
            concreteAlpha,
          );
        if (right > 0)
          this.box(
            0,
            y + 1.0,
            -1.42,
            1.82 * right,
            0.13,
            2.84,
            "#d1dde5",
            concreteAlpha,
          );
        this.box(
          -1.7,
          y + 1.0,
          -1.35,
          3.4 * fill,
          0.02,
          0.08,
          "#d5e1e9",
          concreteAlpha,
        );
      }
      const clad = Math.max(0, Math.min(1, finish * 3 - (2 - floor)));
      if (clad > 0) {
        for (let x of [-1.5, -0.65, 0.2, 1.05]) {
          this.box(x, y + 0.13, -1.3, 0.65, 0.76, 0.08, "#c5dae9", clad);
          this.box(
            x + 0.06,
            y + 0.28,
            -1.35,
            0.52,
            0.47,
            0.025,
            "#2e69a2",
            clad,
          );
          this.box(x, y + 0.13, 1.23, 0.65, 0.76, 0.08, "#dce7f0", clad);
          this.box(
            x + 0.06,
            y + 0.28,
            1.315,
            0.52,
            0.47,
            0.025,
            "#3c79af",
            clad,
          );
        }
        for (let z of [-1.1, -0.1, 0.9]) {
          this.box(-1.67, y + 0.13, z, 0.08, 0.76, 0.65, "#c5d8e7", clad);
          this.box(1.59, y + 0.13, z, 0.08, 0.76, 0.65, "#c5d8e7", clad);
          this.box(
            1.675,
            y + 0.28,
            z + 0.08,
            0.025,
            0.47,
            0.5,
            "#447eae",
            clad,
          );
        }
      }
    }
    if (p > 0.1 && p < 0.98 && !inspection) {
      const towerX = -2.85,
        towerZ = -1.9;
      this.box(towerX - 0.2, -0.3, towerZ - 0.2, 0.4, 0.2, 0.4, "#708161");
      for (let y = 0; y < 4.7; y += 0.45) {
        this.box(
          towerX - 0.07,
          y,
          towerZ - 0.07,
          0.035,
          0.46,
          0.035,
          "#d5b65f",
        );
        this.box(towerX + 0.1, y, towerZ + 0.1, 0.035, 0.46, 0.035, "#d5b65f");
        this.box(towerX - 0.07, y, towerZ - 0.07, 0.21, 0.025, 0.21, "#bb9343");
      }
      this.box(towerX - 0.13, 4.7, towerZ - 0.13, 0.35, 0.22, 0.35, "#ead8a7");
      this.box(towerX - 1.1, 4.92, towerZ - 0.06, 5.1, 0.065, 0.12, "#e1bf66");
      this.box(towerX - 0.8, 4.7, towerZ - 0.18, 0.55, 0.18, 0.36, "#748b56");
    }
    // Materials and small site equipment.
    if (p > 0.13 && p < 0.95 && !inspection) {
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 2; j++)
          this.box(
            2.4 + i * 0.23,
            -0.3 + j * 0.12,
            -2.3,
            0.21,
            0.105,
            0.5,
            "#b29b68",
          );
    }
    if (p > 0.94) {
      this.box(1.75, -0.25, 1.75, 1.1, 0.09, 0.55, "#768e5a");
      for (let x of [-2.7, 2.8]) {
        this.box(x, -0.3, 1.6, 0.08, 0.7, 0.08, "#799b5a");
        this.box(x - 0.25, 0.35, 1.35, 0.55, 0.55, 0.55, "#7f9f61");
      }
    }
    const rebar = ConstructionRebar.draw(this, p);
    const machines = inspection
      ? {
          roller: false,
          excavator: false,
          dumpTruck: false,
          mixer: false,
          pump: false,
          pouring: false,
        }
      : ConstructionEquipment.draw(this, p, time, pitDepth);
    this.lastScene = {
      progress: p,
      pitDepth,
      backfill,
      earthwork: window.ConstructionEquipment.earthwork(p),
      phase: BuildScene.phaseAt(p),
      machines,
      rebar,
      sourceProgress,
      inspection,
    };
    this.faces
      .sort((a, b) => a.depth - b.depth)
      .forEach((f) =>
        f.isRod ? this.line(f.p, f.color, f.width) : this.polygon(f.p, f.fill),
      );
    if (p > 0.1 && p < 0.98 && !inspection) {
      const x = -2.85,
        z = -1.9;
      for (let y = 0; y < 4.5; y += 0.45) {
        this.line(
          [
            [x - 0.07, y, z - 0.07],
            [x + 0.12, y + 0.45, z + 0.12],
          ],
          "#b8995599",
          0.9,
        );
        this.line(
          [
            [x + 0.12, y, z + 0.12],
            [x - 0.07, y + 0.45, z - 0.07],
          ],
          "#b8995577",
          0.9,
        );
      }
      this.line(
        [
          [x - 1.05, 4.93, z],
          [x, 5.4, z],
          [x + 3.7, 4.93, z],
        ],
        "#bc9c5a99",
        0.8,
      );
      const hookX = x + 2.3 + Math.sin(time * 0.45) * 0.4;
      this.line(
        [
          [hookX, 4.93, z],
          [hookX, 2.7 + Math.sin(time * 0.8) * 0.15, z],
        ],
        "#ba9c5a",
        1,
      );
      this.line(
        [
          [hookX, 2.72, z],
          [hookX + 0.08, 2.62, z],
          [hookX + 0.16, 2.72, z],
        ],
        "#ac8d50",
        1.5,
      );
    }
    this.line(
      [
        [-4, -0.36, -3.5],
        [4, -0.36, -3.5],
        [4, -0.36, 3.2],
        [-4, -0.36, 3.2],
        [-4, -0.36, -3.5],
      ],
      "#9ebc6550",
      0.8,
    );
    const north = this.project([-3, -0.35, -4.1]);
    c.fillStyle = "#4b6a8c99";
    c.font = "9px Segoe UI";
    c.fillText("N ↑", north[0], north[1]);
    const measure = this.project([2.1, 0, -1.3]);
    this.line(
      [
        [2.05, 0, -1.3],
        [2.05, 3.36, -1.3],
      ],
      "#b2cf7040",
      0.6,
      [3, 3],
    );
    c.fillStyle = "#526f8e99";
    c.font = "8px Segoe UI";
    c.fillText("MÔ HÌNH MINH HỌA", measure[0] + 8, measure[1] - 45);
  }
};
