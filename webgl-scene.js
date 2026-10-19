import * as THREE from "./vendor/three.module.js";
import { RoundedBoxGeometry } from "./vendor/RoundedBoxGeometry.js";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { RoomEnvironment } from "./vendor/RoomEnvironment.js";

const clamp = THREE.MathUtils.clamp,
  lerp = THREE.MathUtils.lerp,
  ease = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const FLOOR_COUNT = 12, FLOOR_HEIGHT = 1.08, TOWER_HEIGHT = FLOOR_COUNT * FLOOR_HEIGHT + 1.8;
const V = THREE.Vector3,
  UP = new V(0, 1, 0),
  temp = new THREE.Object3D(),
  a = new V(),
  b = new V(),
  dir = new V();
const DEFAULTS = {
  auto: { label: "Tiến độ" },
  foundation: {
    p: 0.279,
    target: [0, -0.45, 0],
    bounds: [
      [-2.3, -1.3, -1.8],
      [2.3, 0.72, 1.8],
    ],
    direction: [1.05, 1.2, 1.3],
  },
  starters: {
    p: 0.428,
    target: [0, 0.9, 0],
    bounds: [
      [-2.1, -0.1, -1.6],
      [2.1, 1.9, 1.6],
    ],
    direction: [1.1, 0.8, 1.4],
  },
  frame: {
    p: 0.4194666667,
    target: [0, 0.65, 0],
    bounds: [
      [-2.1, -0.1, -1.6],
      [2.1, 1.6, 1.6],
    ],
    direction: [1.15, 0.95, 1.3],
  },
  joint: {
    p: 0.4224,
    target: [0, 0.65, 0],
    bounds: [
      [-2.1, -0.1, -1.6],
      [2.1, 1.7, 1.6],
    ],
    direction: [1.1, 1.1, 1.25],
  },
};

export class WebGLConstructionScene {
  static instances = new Set();
  static frame = null;
  static paused = false;
  static heldTime = 0;
  static phaseBounds = [0, 0.1, 0.18, 0.26, 0.4, 0.72, 0.98, 1];
  static phaseAt(p) {
    for (let i = 0; i < 7; i++)
      if (p < WebGLConstructionScene.phaseBounds[i + 1]) return i;
    return 6;
  }
  static phaseMiddle(i) {
    return (this.phaseBounds[i] + this.phaseBounds[i + 1]) / 2;
  }
  constructor(canvas, getProgress) {
    this.canvas = canvas;
    this.getProgress = getProgress;
    this.detailMode = "auto";
    this.dirty = true;
    this.visible = true;
    this.running = true;
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(
      Math.min(devicePixelRatio || 1, innerWidth < 700 ? 1.25 : 1.6),
    );
    this.renderer.setClearColor("#ffffff");
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color("#ffffff");
    this.scene.fog = new THREE.Fog("#edf3f9", 24, 100);
    this.scene.environmentIntensity = 0.36;
    this.camera = new THREE.PerspectiveCamera(33, 1, 0.1, 180);
    this.camera.position.set(11, 9, 13);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.enablePan = false;
    this.controls.enableZoom = false;
    this.controls.minDistance = 7;
    this.controls.maxDistance = 80;
    this.controls.maxPolarAngle = Math.PI * 0.43;
    canvas.style.touchAction = "pan-y";
    this.controls.addEventListener("start", () => {
      this.manual = true;
      this.dirty = true;
    });
    this.onContextLost = event => { event.preventDefault(); this.contextLost = true; canvas.parentElement.classList.remove('scene-rendered'); };
    this.onContextRestored = () => { this.contextLost = false; this.dirty = true; canvas.parentElement.classList.add('scene-rendered'); };
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    this.resources = new Set();
    this.mat = new Map();
    this.geo = new Map();
    this.root = new THREE.Group();
    this.scene.add(this.root);
    const ambient = new THREE.HemisphereLight("#dcecff", "#c9bca4", 1.05);
    this.scene.add(ambient);
    const sun = new THREE.DirectionalLight("#fff6e6", 3.1);
    sun.position.set(-5, 12, 7);
    sun.castShadow = true;
    sun.shadow.mapSize.set(
      innerWidth < 700 ? 768 : 1536,
      innerWidth < 700 ? 768 : 1536,
    );
    Object.assign(sun.shadow.camera, {
      left: -9,
      right: 9,
      top: 9,
      bottom: -9,
      near: 1,
      far: 35,
    });
    sun.shadow.bias = -0.00035;
    sun.shadow.normalBias = 0.035;
    sun.shadow.radius = 4;
    this.scene.add(sun);
    const rim = new THREE.DirectionalLight("#8db9f2", 0.75);
    rim.position.set(7, 7, -7);
    this.scene.add(rim);
    const envScene = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = pmrem.fromScene(envScene, 0.04);
    this.scene.environment = env.texture;
    this.environment = env;
    pmrem.dispose();
    envScene.dispose?.();
    this.materials();
    this.buildSky();
    this.build();
    this.currentP = clamp(getProgress(), 0, 1);
    this.inspect = 0;
    this.previousMode = "auto";
    this.lastTime = performance.now();
    this.targetPosition = new V();
    this.targetLook = new V();
    this.fitTarget = new V();
    this.stats = {};
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
    this.visibilityObserver = new IntersectionObserver((e) => {
      this.visible = e[0].isIntersecting;
      this.dirty = true;
    });
    this.visibilityObserver.observe(canvas);
    this.setShot(this.currentP, true);
    this.draw(performance.now());
    canvas.classList.add("webgl-ready");
    canvas.dataset.renderer = "webgl";
    canvas.parentElement.classList.add("scene-rendered");
    WebGLConstructionScene.instances.add(this);
    WebGLConstructionScene.start();
  }
  static start() {
    if (this.frame !== null) return;
    const tick = (now) => {
      for (const s of this.instances) if (s.running && s.visible && !s.contextLost) s.draw(now);
      this.frame = this.instances.size ? requestAnimationFrame(tick) : null;
    };
    this.frame = requestAnimationFrame(tick);
  }
  material(name, color, options = {}) {
    const m = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.68,
      metalness: 0,
      transparent: true,
      ...options,
    });
    this.resources.add(m);
    this.mat.set(name, m);
    return m;
  }
  materials() {
    this.material("terrain", "#b8a183", { roughness: 0.95 });
    this.material("earth", "#9a8060", { roughness: 1 });
    this.material("floor", "#e5edf4", { roughness: 0.9 });
    this.material("road", "#7d8f96", { roughness: 0.95 });
    this.material("mark", "#e6edf4");
    this.material("concrete", "#d2dce5", { roughness: 0.87 });
    this.material("steel", "#656b72", { metalness: 0.72, roughness: 0.38 });
    this.material("ties", "#93694b", { metalness: 0.62, roughness: 0.45 });
    this.material("starter", "#b57438", { metalness: 0.65, roughness: 0.38 });
    this.material("wood", "#b7935f", { roughness: 0.88 });
    this.material("yellow", "#e4b94f", { metalness: 0.22, roughness: 0.43 });
    this.material("blue", "#1b56a4", { metalness: 0.2, roughness: 0.38 });
    this.material("white", "#edf3f7", { metalness: 0.2, roughness: 0.34 });
    this.material("rubber", "#202a31", { roughness: 0.92 });
    this.material("chrome", "#a7b6c3", { metalness: 0.85, roughness: 0.25 });
    this.material("glass", "#225b8c", {
      metalness: 0.35,
      roughness: 0.15,
      opacity: 0.9,
      depthWrite: false,
    });
    this.material("soilLoad", "#94754f", { roughness: 1 });
    this.material("grass", "#708b76", { roughness: .95 });
    this.material("leaf", "#4f7568", { roughness: .92 });
    this.material("bark", "#81664c", { roughness: 1 });
    this.material("pad", "#a78960", { roughness: 1 });
    this.material("joint", "#baa17a", { roughness: 1 });
    this.material("curing", "#69adc7", {opacity:.5,roughness:1});
    this.material("facade", "#e7eef4", { roughness: 0.82 });
    for (let i = 0; i < FLOOR_COUNT; i++) {
      this.material("col" + i, "#d8e2e9", { roughness: 0.86 });
      this.material("slabA" + i, "#c4d3df", { roughness: 0.85 });
      this.material("slabB" + i, "#e1e8ec", { roughness: 0.9 });
    }
    // Fine, deterministic grain gives concrete a surface without loading external textures.
    const cv = document.createElement("canvas");
    cv.width = cv.height = 128;
    const ctx = cv.getContext("2d"),
      pixels = ctx.createImageData(128, 128);
    let seed = 41;
    for (let i = 0; i < pixels.data.length; i += 4) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const c = 220 + (seed % 17);
      pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = c;
      pixels.data[i + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(3, 3);
    this.resources.add(tex);
    for (const [name, m] of this.mat)
      if (/concrete|col|slab|facade/.test(name)) m.map = tex;
  }
  buildSky() {
    const cv=document.createElement('canvas');cv.width=2048;cv.height=1024;const ctx=cv.getContext('2d');
    const sky=ctx.createLinearGradient(0,0,0,1024);sky.addColorStop(0,'#77b5e5');sky.addColorStop(.45,'#c1dff2');sky.addColorStop(.56,'#e9f2f8');sky.addColorStop(1,'#eef3f7');ctx.fillStyle=sky;ctx.fillRect(0,0,2048,1024);
    for(let i=0;i<24;i++){const x=(i*277+80)%2048,y=190+(i%5)*58,r=90+(i%3)*35;const cloud=ctx.createRadialGradient(x,y,5,x,y,r);cloud.addColorStop(0,'rgba(255,255,255,.65)');cloud.addColorStop(.5,'rgba(255,255,255,.25)');cloud.addColorStop(1,'rgba(255,255,255,0)');ctx.fillStyle=cloud;ctx.fillRect(x-r,y-r,2*r,2*r);}
    const texture=new THREE.CanvasTexture(cv);texture.mapping=THREE.EquirectangularReflectionMapping;texture.colorSpace=THREE.SRGBColorSpace;this.scene.background=texture;this.resources.add(texture);this.skyTexture=texture;
  }
  geometry(key, make) {
    if (!this.geo.has(key)) {
      const g = make();
      this.geo.set(key, g);
      this.resources.add(g);
    }
    return this.geo.get(key);
  }
  group(parent = this.root) {
    const g = new THREE.Group();
    parent.add(g);
    return g;
  }
  box(parent, x, y, z, w, h, d, material, round = 0) {
    const key = ["box", w, h, d, round].join("/"),
      g = this.geometry(key, () =>
        round
          ? new RoundedBoxGeometry(
              w,
              h,
              d,
              2,
              Math.min(round, w / 4, h / 4, d / 4),
            )
          : new THREE.BoxGeometry(w, h, d),
      ),
      m = new THREE.Mesh(g, this.mat.get(material));
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }
  sphere(parent, x, y, z, r, material) {
    const g = this.geometry(
        "sphere" + r,
        () => new THREE.SphereGeometry(r, 12, 8),
      ),
      m = new THREE.Mesh(g, this.mat.get(material));
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }
  beam(parent, p0, p1, r, material, segments = 7) {
    const mesh = new THREE.Mesh(
      this.geometry(
        "cyl" + r + "/" + segments,
        () => new THREE.CylinderGeometry(r, r, 1, segments),
      ),
      this.mat.get(material),
    );
    mesh.castShadow = r > 0.025;
    mesh.receiveShadow = true;
    parent.add(mesh);
    this.placeBeam(mesh, p0, p1);
    return mesh;
  }
  placeBeam(mesh, p0, p1) {
    a.fromArray(p0);
    b.fromArray(p1);
    dir.subVectors(b, a);
    const len = dir.length();
    mesh.position.copy(a).addScaledVector(dir, 0.5);
    mesh.scale.set(1, Math.max(0.001, len), 1);
    mesh.quaternion.setFromUnitVectors(UP, dir.normalize());
  }
  alpha(name, value) {
    const m = this.mat.get(name);
    if (m) {
      m.opacity = clamp(value, 0, 1);
      m.depthWrite = value > 0.98;
    }
  }
  batch(parent, segments, material, r = 0.012) {
    if (!segments.length) return null;
    const mesh = new THREE.InstancedMesh(
      this.geometry("rod" + r, () => new THREE.CylinderGeometry(r, r, 1, 5)),
      this.mat.get(material),
      segments.length,
    );
    for (let i = 0; i < segments.length; i++) {
      const [p0, p1] = segments[i];
      a.fromArray(p0);
      b.fromArray(p1);
      dir.subVectors(b, a);
      temp.position.copy(a).addScaledVector(dir, 0.5);
      temp.quaternion.setFromUnitVectors(UP, dir.clone().normalize());
      temp.scale.set(1, dir.length(), 1);
      temp.updateMatrix();
      mesh.setMatrixAt(i, temp.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    parent.add(mesh);
    return mesh;
  }
  cageSegments(x, z, y0, y1, w = 0.17, spacing = 0.22) {
    const rods = [],
      ties = [],
      r = w / 2;
    for (const dx of [-r, r])
      for (const dz of [-r, r]) {
        rods.push([
          [x + dx, y0, z + dz],
          [x + dx, y1, z + dz],
        ]);
        rods.push([
          [x + dx, y1, z + dz],
          [x + dx * 0.4, y1 + 0.025, z + dz],
        ]);
      }
    for (let y = y0 + 0.06; y < y1 - 0.03; y += spacing) {
      const p = [
        [x - r, y, z - r],
        [x + r, y, z - r],
        [x + r, y, z + r],
        [x - r, y, z + r],
        [x - r, y, z - r],
      ];
      for (let i = 0; i < 4; i++) ties.push([p[i], p[i + 1]]);
    }
    return { rods, ties };
  }
  gridSegments(x, z, w, d, y, step = 0.23) {
    const rods = [];
    for (let dx = 0; dx <= w + 0.01; dx += step)
      rods.push([
        [x + dx, y, z],
        [x + dx, y, z + d],
      ]);
    for (let dz = 0; dz <= d + 0.01; dz += step)
      rods.push([
        [x, y + 0.01, z + dz],
        [x + w, y + 0.01, z + dz],
      ]);
    return rods;
  }
  build() {
    const studio = this.box(this.scene, 0, -1.52, 0, 200, 0.1, 200, "floor");
    studio.castShadow = false;
    const grid = new THREE.GridHelper(36, 36, "#d9e6f3", "#e5edf7");
    grid.position.y = -1.455;
    grid.material.transparent = true;
    grid.material.opacity = 0.48;
    this.scene.add(grid);
    this.resources.add(grid.geometry);
    this.resources.add(grid.material);
    this.terrain = this.group();
    // One continuous ground datum, with a real central opening for the excavation.
    for (const [x,z,w,d] of [[-51,0,98,200],[51,0,98,200],[0,-50.85,4,98.3],[0,50.85,4,98.3]]) {
      this.box(this.terrain,x,-.9,z,w,1.05,d,"earth");
      this.box(this.terrain,x,-.365,z,w,.06,d,"floor");
    }
    for(const [x,z,w,d] of [[-3,-.95,2,5.9],[5.25,-.95,6.5,5.9],[0,-2.8,4,2.2],[0,1.85,4,.3]]) this.box(this.terrain,x,-.329,z,w,.012,d,"terrain");
    this.box(this.terrain, 0, -1.38, 0, 4, 0.16, 3.4, "earth");
    this.fill = this.box(this.terrain, 0, -0.85, 0, 4, 1, 3.4, "earth");
    this.road = this.buildRoadNetwork();
    this.utilities=this.group(this.road);
    for(const[x,col]of[[-3.8,"blue"],[-3.72,"chrome"]]) this.beam(this.utilities,[x,-.3,-2.8],[x,-.3,1.2],.025,col,8);
    this.footings = [];
    this.blinding = [];
    this.foundationBars = this.group();
    this.foundationForms=this.group();
    const foundationRod = [],
      foundationTies = [];
    for (const x of [-1.6, 0, 1.6])
      for (const z of [-1.2, 0, 1.2]) {
        this.blinding.push(this.box(this.root, x, -1.235, z, 0.54, 0.045, 0.54, "concrete"));
        const f = this.box(
            this.root,
            x,
            -1.08,
            z,
            0.46,
            0.2,
            0.46,
            "concrete",
            0.018,
          ),
          ped = this.box(
            this.root,
            x,
            -0.43,
            z,
            0.18,
            1.1,
            0.18,
            "concrete",
            0.01,
          );
        for(const side of[-1,1]){this.box(this.foundationForms,x+side*.27,-1.06,z,.035,.28,.57,'wood');this.box(this.foundationForms,x,-1.06,z+side*.27,.5,.28,.035,'wood');}
        this.footings.push({ f, ped });
        foundationRod.push(
          ...this.gridSegments(x - 0.2, z - 0.2, 0.4, 0.4, -1.15, 0.1),
          ...this.gridSegments(x - 0.2, z - 0.2, 0.4, 0.4, -1.055, 0.1),
        );
        const c = this.cageSegments(x, z, -1.14, 0.45, 0.16, 0.22);
        foundationRod.push(...c.rods);
        foundationTies.push(...c.ties);
      }
    this.batch(this.foundationBars, foundationRod, "steel", 0.01);
    this.batch(this.foundationBars, foundationTies, "ties", 0.008);
    this.plinth = this.box(
      this.root,
      0,
      -0.05,
      0,
      3.7,
      0.12,
      2.9,
      "concrete",
      0.025,
    );
    this.floors = [];
    for (let floor = 0; floor < FLOOR_COUNT; floor++) {
      const group = this.group();
      group.position.y = floor * 1.08;
      const cols = [];
      for (const x of [-1.6, 0, 1.6])
        for (const z of [-1.2, 1.2])
          cols.push(
            this.box(group, x, 0.5, z, 0.15, 1, 0.15, "col" + floor, 0.012),
          );
      const columnForm=this.group(group);
      for(const x of[-1.6,0,1.6])for(const z of[-1.2,1.2]){
        for(const side of[-1,1]){this.box(columnForm,x+side*.135,.52,z,.035,1.04,.29,"wood");this.box(columnForm,x,.52,z+side*.135,.24,1.04,.035,"wood");}
        for(const y of[.18,.45,.72,.98])for(const side of[-1,1]){this.box(columnForm,x+side*.16,y,z,.025,.035,.35,'chrome');this.box(columnForm,x,y,z+side*.16,.35,.035,.025,'chrome');}
      }
      const barGroup = this.group(group),
        long = [],
        ties = [];
      for (const x of [-1.6, 0, 1.6])
        for (const z of [-1.2, 1.2]) {
          const c = this.cageSegments(x, z, 0.02, 1.12, 0.17, 0.22);
          long.push(...c.rods);
          ties.push(...c.ties);
        }
      this.batch(barGroup, long, "steel");
      this.batch(barGroup, ties, "ties", 0.009);
      const beamBars = this.group(group),
        beamRods = [],
        beamTies = [];
      for (const z of [-1.2, 0, 1.2])
        for (const up of [0.88, 1.01])
          for (const dz of [-0.065, 0.065])
            beamRods.push([
              [-1.65, up, z + dz],
              [1.65, up, z + dz],
            ]);
      for (const x of [-1.6, 0, 1.6])
        for (const up of [0.88, 1.01])
          for (const dx of [-0.065, 0.065])
            beamRods.push([
              [x + dx, up, -1.25],
              [x + dx, up, 1.25],
            ]);
      for (const z of [-1.2, 0, 1.2])
        for (let x = -1.6; x <= 1.6; x += 0.3) {
          const p = [
            [x, 0.87, z - 0.085],
            [x, 1.02, z - 0.085],
            [x, 1.02, z + 0.085],
            [x, 0.87, z + 0.085],
            [x, 0.87, z - 0.085],
          ];
          for (let i = 0; i < 4; i++) beamTies.push([p[i], p[i + 1]]);
        }
      this.batch(beamBars, beamRods, "steel");
      this.batch(beamBars, beamTies, "ties", 0.008);
      const mesh = this.group(group);
      this.batch(
        mesh,
        [
          ...this.gridSegments(-1.7, -1.3, 3.4, 2.6, 1.035, 0.24),
          ...this.gridSegments(-1.7, -1.3, 3.4, 2.6, 1.105, 0.24),
        ],
        "steel",
        0.011,
      );
      const starter = this.group(group),
        starterR = [],
        starterT = [];
      for (const x of [-1.6, 0, 1.6])
        for (const z of [-1.2, 1.2]) {
          const c = this.cageSegments(x, z, 0.96, 1.55, 0.16, 0.22);
          starterR.push(...c.rods);
          starterT.push(...c.ties);
        }
      this.batch(starter, starterR, "starter", 0.013);
      this.batch(starter, starterT, "ties", 0.009);
      const form = this.group(group);
      this.box(form, 0, 0.987, 0, 3.62, 0.027, 2.82, "wood");
      for(const x of[-1.4,-.7,0,.7,1.4])for(const z of[-1,-.3,.4,1.1]){
        this.box(form,x,.48,z,.032,.94,.032,"chrome");this.box(form,x,.035,z,.16,.04,.16,"wood");
      }
      for(const z of[-1.42,1.42])this.box(form,0,1.06,z,3.68,.18,.035,"wood");
      for(const x of[-1.84,1.84])this.box(form,x,1.06,0,.035,.18,2.88,"wood");
      for(const z of[-1.2,0,1.2])for(const side of[-1,1])this.box(form,0,.91,z+side*.12,3.5,.17,.025,"wood");
      const slabA = this.box(
          group,
          -0.91,
          1.065,
          0,
          1.82,
          0.13,
          2.84,
          "slabA" + floor,
          0.014,
        ),
        slabB = this.box(
          group,
          0.91,
          1.065,
          0,
          1.82,
          0.13,
          2.84,
          "slabB" + floor,
          0.014,
        );
      const curing=this.box(group,0,1.14,0,3.5,.009,2.68,"curing");
      const joint = this.group(group);
      this.box(joint, 0, 1.065, 0, 0.012, 0.135, 2.82, "joint");
      const seams = [];
      for (let z = -1.3; z < 1.3; z += 0.24)
        seams.push([
          [0, 1.14, z],
          [0, 1.14, z + 0.14],
        ]);
      this.batch(joint, seams, "starter", 0.012);
      const facade = this.group(group);
      for (const side of [-1, 1])
        for (const x of [-1.35, -0.45, 0.45, 1.35]) {
          this.box(
            facade,
            x,
            0.53,
            side * 1.27,
            0.73,
            0.82,
            0.1,
            "facade",
            0.014,
          );
          this.box(
            facade,
            x,
            0.57,
            side * 1.325,
            0.55,
            0.51,
            0.018,
            "glass",
            0.01,
          );
        }
      for (const side of [-1, 1])
        for (const z of [-0.85, 0, 0.85]) {
          this.box(
            facade,
            side * 1.65,
            0.53,
            z,
            0.1,
            0.82,
            0.69,
            "facade",
            0.015,
          );
          this.box(
            facade,
            side * 1.705,
            0.57,
            z,
            0.018,
            0.51,
            0.5,
            "glass",
            0.008,
          );
        }
      this.floors.push({
        group,
        cols,
        barGroup,
        columnForm,
        beamBars,
        mesh,
        starter,
        form,
        slabA,
        slabB,
        curing,
        joint,
        facade,
      });
    }
    this.deliveredPallet=this.group();for(let i=0;i<3;i++)this.box(this.deliveredPallet,0,i*.055,0,.75,.045,.45,'wood');this.deliveredPallet.visible=false;
    this.scaffold=this.buildScaffold();
    this.crane = this.buildCrane();
    this.root.add(this.crane);
    // Site office in the north-west corner, clear of every vehicle route (see FleetMotion.OBSTACLES).
    this.cabin = this.group();
    this.box(this.cabin, -3.35, -0.02, -3.49, 0.98, 0.62, 0.62, "white", 0.035);
    this.box(this.cabin, -3.35, 0.31, -3.49, 1.06, 0.06, 0.7, "blue", 0.025);
    this.box(this.cabin, -3.3, 0.0, -3.172, 0.42, 0.28, 0.014, "glass");
    // Spoil heaps from the excavation, kept for backfill (north-east of the yard, off the roller corner).
    this.mounds = [];
    for (const [x, z, r] of [
      [5.15, -3.45, 0.36],
      [4.8, -3.6, 0.25],
    ]) {
      const mound = this.sphere(this.root, x, -0.3, z, r, "soilLoad");
      mound.scale.set(1, 0.6, 1);
      this.mounds.push(mound);
    }
    this.context = this.buildContext();
    this.neighborhood = this.buildNeighborhood();
    this.ambientCars = this.buildAmbientCars();
    this.compactionPad = this.group();
    this.box(this.compactionPad, -.1, -.332, -2.55, 4.6, .055, 1.18, "soilLoad", .025);
    for (let z = -2.98; z < -2.05; z += .11) this.box(this.compactionPad, -.1, -.301, z, 4.35, .006, .023, "pad");
    this.buildFleet();
    this.survey=this.group();
    for(const a of[0,Math.PI*2/3,Math.PI*4/3])this.beam(this.survey,[.8+Math.cos(a)*.24,-.29,1.0+Math.sin(a)*.24],[.8,.4,1.0],.025,'yellow',6);
    this.box(this.survey,.8,.46,1,.18,.15,.16,'blue',.02);
    for(const x of[-1.7,1.7])for(const z of[-1.3,1.3])this.beam(this.survey,[x,-.3,z],[x,.05,z],.018,'wood',6);
  }
  labelBoard(text,w=3,h=.5,color='#032b91',background='#f2f6fc') {
    const cv=document.createElement('canvas');cv.width=1536;cv.height=256;const ctx=cv.getContext('2d');ctx.fillStyle=background;ctx.fillRect(0,0,1536,256);ctx.fillStyle=color;ctx.font='600 78px "BeVietnam",Arial,sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(text,768,135,1450);
    const texture=new THREE.CanvasTexture(cv);texture.colorSpace=THREE.SRGBColorSpace;this.resources.add(texture);const material=new THREE.MeshBasicMaterial({map:texture,side:THREE.DoubleSide});this.resources.add(material);const mesh=new THREE.Mesh(this.geometry('label-'+w+'-'+h,()=>new THREE.PlaneGeometry(w,h)),material);return mesh;
  }
  buildAmbientCars() {
    const cars=[];
    for(let i=0;i<8;i++){
      const g=this.group(),wheels=[];
      this.box(g,0,.2,0,.92,.2,.43,i%3?'blue':'white',.07);this.box(g,-.03,.36,0,.48,.18,.38,'glass',.06);
      for(const x of[-.28,.28])for(const z of[-.2,.2]){const spin=this.group(g);spin.position.set(x,.089,z);const wheel=new THREE.Mesh(this.geometry('ambient-tire',()=>new THREE.TorusGeometry(.065,.024,6,10)),this.mat.get('rubber'));spin.add(wheel);this.box(spin,0,.03,0,.02,.05,.03,'chrome');wheels.push(spin);}
      cars.push({group:g,wheels});
    }
    return cars;
  }
  buildScaffold() {
    const levels=[];this.material('scaffoldSteel','#6485a2',{metalness:.5,roughness:.45});
    for(let level=0;level<FLOOR_COUNT;level++){
      const g=this.group();g.position.y=level*FLOOR_HEIGHT;const frame=[],braces=[];
      for(const z of[-1.75,1.75])for(const x of[-2.12,-.7,.7,2.12]){frame.push([[x,-.11,z],[x,1.28,z]]);if(!level)this.box(g,x,-.11,z,.16,.04,.16,'steel');}
      for(const z of[-1.75,1.75]){
        this.box(g,0,.97,z,4.5,.045,.5,'wood');
        for(const y of[.06,.95,1.12,1.28])frame.push([[-2.12,y,z],[2.12,y,z]]);
        for(const x of[-2.12,-.7,.7]){braces.push([[x,.06,z],[x+1.42,.95,z]],[[x,.95,z],[x+1.42,.06,z]]);}
      }
      for(const x of[-2.12,2.12]){
        this.box(g,x,.97,0,.5,.045,3.5,'wood');
        for(const y of[.06,.95,1.12,1.28])frame.push([[x,y,-1.75],[x,y,1.75]]);
        for(const z of[-1.75,0])braces.push([[x,.06,z],[x,.95,z+1.75]],[[x,.95,z],[x,.06,z+1.75]]);
      }
      // Independent stair tower with alternating flights, landings and a bridge to each work platform.
      const direction=level%2?1:-1;
      for(const x of[2.65,3.65])for(const z of[-1,1])frame.push([[x,-.11,z],[x,1.28,z]]);
      for(let step=0;step<12;step++){const z=-direction*.82+direction*(step+.5)*1.64/12,y=-.11+(step+1)*FLOOR_HEIGHT/12;this.box(g,3.15,y,z,.94,.035,1.64/12,'scaffoldSteel');}
      for(const x of[2.65,3.65]){frame.push([[x,.6,-direction*.82],[x,1.68,direction*.82]]);for(const z of[-1,1])frame.push([[x,.05,z],[x,1.27,z]]);}
      this.box(g,3.15,.97,direction*.96,1.05,.045,.45,'wood');
      this.box(g,2.58,.97,direction*.96,1.05,.045,.45,'wood');
      for(const z of[-1,1]){braces.push([[2.65,.04,z],[3.65,.95,z]],[[2.65,.95,z],[3.65,.04,z]]);frame.push([[2.65,1.26,z],[3.65,1.26,z]]);}
      this.batch(g,frame,'scaffoldSteel',.013);this.batch(g,braces,'chrome',.01);levels.push(g);
    }
    return levels;
  }
  buildRoadNetwork() {
    const g=this.group();
    // Disjoint rectangles form a level union. No road slab overlaps another road slab.
    const slabs=[[-6.1,-3,2,44],[7.4,4.9875,3.8,2.025]];
    for(const z of[3,-5.1]) slabs.push([-18.55,z,22.9,1.95],[12.45,z,35.1,1.95]);
    this.roadSurfaces=[];
    this.roadRects=slabs.map(([x,z,w,d])=>[x-w/2,x+w/2,z-d/2,z+d/2]);
    for(const[x,z,w,d]of slabs){this.roadSurfaces.push(this.box(g,x,-.32,z,w,.045,d,"road",.008));}
    for(const z of[3,-5.1])for(let x=-28;x<30;x+=.85)if(x<-7.8||x>-4.4)this.box(g,x,-.293,z,.42,.006,.027,"mark");
    for(let z=-24;z<18;z+=.85)if((z<1.5||z>4.4)&&(z<-6.6||z>-3.6))this.box(g,-6.1,-.293,z,.027,.006,.42,"mark");
    for(const z of[2.06,3.94])this.box(g,12.45,-.293,z,35.0,.006,.023,"mark");
    for(const[z,direction]of[[2.55,-1],[3.45,1]])for(const x of[-3.9,2.6]){
      this.beam(g,[x-.23*direction,-.281,z],[x+.23*direction,-.281,z],.015,"mark",4);
      this.beam(g,[x+.23*direction,-.281,z],[x+.07*direction,-.281,z-.12],.015,"mark",4);
      this.beam(g,[x+.23*direction,-.281,z],[x+.07*direction,-.281,z+.12],.015,"mark",4);
    }
    for(let z=2.2;z<3.9;z+=.24)this.box(g,-4.65,-.292,z,.5,.007,.12,"mark");
    return g;
  }
  buildNeighborhood() {
    const g=this.group();
    this.material("distant", "#c4d1de", {roughness:.94});
    this.material("distantGlass", "#8fa9bc", {roughness:.65,metalness:.12});
    this.material("farCity", "#d7e2ed", {roughness:1});
    this.material("pavement", "#bac5ca", {roughness:.96});
    this.material("roof", "#9fafbe", {roughness:.9});
    this.box(g,6,-.32,-6.7,45,.12,.75,"pavement",.025);
    const windows=[],buildings=[];this.cityBlocks=[];
    const addBlock=(x,z,w,d,h,far=false)=>{
      buildings.push({x,z,w,d,h});
      const block=this.group(g),windowPoints=[];this.cityBlocks.push({group:block,center:new V(x,h/2,z),radius:Math.hypot(w,d)/2+.5});
      this.box(block,x,-.32+h/2,z,w,h,d,far?"farCity":"distant",.07);
      this.box(block,x,h-.25,z,w+.12,.12,d+.12,far?"farCity":"roof",.025);
      if(!far)for(let y=.45;y<h-.3;y+=.8)for(let dx=-w/2+.38;dx<w/2-.15;dx+=.7)windowPoints.push([x+dx,y,z+d/2+.008]);
      if(!far)this.box(block,x,-.24,z+d/2+.32,w+.35,.15,.65,"pavement",.02);
      if(windowPoints.length){const mesh=new THREE.InstancedMesh(this.geometry('city-window',()=>new THREE.BoxGeometry(.38,.43,.014)),this.mat.get('distantGlass'),windowPoints.length);windowPoints.forEach((position,i)=>{temp.position.fromArray(position);temp.rotation.set(0,0,0);temp.scale.set(1,1,1);temp.updateMatrix();mesh.setMatrixAt(i,temp.matrix);});mesh.instanceMatrix.needsUpdate=true;block.add(mesh);}
    };
    for(const b of[[-10,-10,3.2,3.4,3.1],[-4.8,-10.2,2.7,3.2,4.4],[0,-10.6,3.3,3.8,2.9],[5,-10.2,3,3.1,4.7],[28,-12.4,3.4,3.5,3.6]])addBlock(...b);
    for(let i=0;i<8;i++)addBlock(-20+i*5.4,-19-(i%3)*1.5,3.3+(i%2)*.7,3.6,4.2+(i%4)*1.1);
    for(let i=0;i<11;i++)addBlock(-30+i*6.2,-32-(i%3)*2,3.9,4.5,5.5+(i%5)*1.15,true);
    for(const b of[[13,-1.1,3.8,3.4,3.3],[19,-2.5,4,4,4.6],[-14,-.8,3.8,3.3,3.8],[-21,-1.6,4,4,4.8]])addBlock(...b);
    // Low-rise campus buildings (lecture halls, library, dormitory) in the background: Dĩ An has no towers.
    for(const b of[[17.2,-14.6,8.6,3.6,4.6],[22.6,-17.8,3.4,6.0,3.5],[-16.4,-13.2,6.2,3.4,3.9],[-10.6,-15.6,3.2,4.2,2.8]])addBlock(...b);
    this.campusBounds=[[12,-.4,-21.5],[24.5,5,-11]];
    for(const radius of[40,58,78])for(let i=0;i<32;i++){const angle=i*Math.PI/16;addBlock(Math.cos(angle)*radius,Math.sin(angle)*radius,3+(i%3),3.8,4.5+(i%6)*1.1,true);}
    const tree=(x,z,scale=1)=>{this.beam(g,[x,-.3,z],[x,.85*scale,z],.065*scale,"bark",8);this.sphere(g,x,1.28*scale,z,.6*scale,"leaf");this.sphere(g,x+.3*scale,1.13*scale,z+.12*scale,.4*scale,"grass");};
    for(let ix=-3;ix<=3;ix++)for(let iz=-3;iz<=3;iz++){
      const x=ix*8.5+2,z=iz*8.5+1.2;
      const conflict=(x>-7.8&&x<11&&z>-7&&z<6)||(Math.abs(z-3)<4.3)||(Math.abs(z+5.1)<4.3)||(Math.abs(x+6.1)<4.3)||buildings.some(b=>Math.abs(x-b.x)<b.w/2+3.2&&Math.abs(z-b.z)<b.d/2+3.2);
      if(conflict)continue;
      if((ix+iz)%3===0){addBlock(x,z,3.8,3.6,2.1+(Math.abs(ix+iz)%3)*.7);continue;}
      this.box(g,x,-.323,z,6.3,.06,6.3,'grass',.14);
      this.box(g,x,-.283,z,.55,.025,6.1,'pavement',.025);this.box(g,x,-.279,z,6.1,.025,.55,'pavement',.025);
      for(const dx of[-2.2,2.2])for(const dz of[-2.2,2.2])tree(x+dx,z+dz,.7);
      for(const dx of[-1.5,1.5]){this.box(g,x+dx,-.08,z+.8,.8,.12,.24,'wood',.025);for(const a of[-.3,.3])this.box(g,x+dx+a,-.2,z+.8,.03,.2,.18,'steel');}
    }
    for(let x=-25;x<30;x+=3.1)tree(x,-7.3,1+(Math.abs(x)%3)*.08);
    for(let x=-25;x<30;x+=5)tree(x,-15.5,.9);
    // A lower foreground park leaves an open view into the construction site.
    this.box(g,3,-.335,8.2,12,.06,4.8,"grass",.12);
    this.box(g,3,-.291,8.2,12,.025,.55,"pavement",.03);
    for(const[x,z]of[[-2,9.5],[2,10],[6,9.8],[8.3,7.2]])tree(x,z,.8);
    for(const x of[-2,3,7]){this.box(g,x,-.05,7.2,.8,.12,.24,"wood",.025);for(const dx of[-.3,.3])this.box(g,x+dx,-.18,7.2,.035,.25,.18,"steel");}
    for(let x=-20;x<30;x+=7){this.beam(g,[x,-.3,-6.2],[x,2.2,-6.2],.025,"chrome",8);this.box(g,x+.16,2.2,-6.2,.4,.04,.16,"white",.02);}
    this.contextBuildings=buildings.length;
    return g;
  }
  buildContext() {
    const group = this.group();const setup=this.group(group);this.siteSetup=setup;
    // Hoarding on three sides; the front stays open to the haul road. The side fences stop short of
    // the kerb so the pump's turn and the roller's exit clear their ends (FleetMotion.OBSTACLES).
    for(const x of[-3.91,8.45]){this.box(setup,x,.03,-1.3,.045,.76,5.2,"blue",.01);for(let z=-3.8;z<1.35;z+=.6)this.box(setup,x,.06,z,.07,.86,.07,"chrome");}
    this.box(setup, 2.25, .03, -3.88, 12.4, .76, .045, "blue", .01);
    for (let x=-3.8; x<8.5; x+=.62) this.box(setup,x,.06,-3.89,.07,.86,.07,"chrome");
    for (const x of [-3.91,8.45]) {
      this.box(setup,x,.26,1.2,.13,1.25,.13,"white",.02);
      this.box(setup,x,.87,1.2,.26,.08,.25,"blue",.02);
    }
    // Concrete hardstand and timber cribbing under the pump's outriggers.
    this.box(setup,6.7,-.31,-2.05,1.9,.04,3.3,"concrete",.025);
    for(const z of[-2.4,-1.0]) for(const x of[5.9,7.5]) this.box(setup,x,-.27,z,.16,.05,.16,"wood",.01);
    // Material storage along the back and east fences, outside every vehicle path.
    for (let i=0;i<6;i++) this.beam(setup,[-.8,-.27+(i%3)*.06,-3.52-Math.floor(i/3)*.12],[.5,-.27+(i%3)*.06,-3.52-Math.floor(i/3)*.12],.035,"steel",8);
    for (let i=0;i<5;i++) this.box(setup,1.45,-.29+i*.055,-3.58,.8,.04,.4,'wood',.014);
    for(const z of[-.62,-.42,-.22])this.box(setup,8.0,-.24,z,.5,.18,.16,"concrete",.025);
    for(let level=0;level<3;level++)for(let x=0;x<3;x++)for(let z=0;z<4;z++)this.box(setup,7.76+x*.24,-.26+level*.12,-1.84+z*.23,.22,.1,.21,"wood",.01);
    for(let i=0;i<7;i++)this.beam(setup,[8.07,-.26+i*.035,-3.6],[8.07,-.26+i*.035,-2.4],.022,'steel',8);
    // A public verge, trees and sidewalk sit outside the construction fence.
    for(const x of[-4.65,9.2]) {
      this.box(group,x,-.35,-.75,1.0,.1,5.1,"floor",.04);
      this.box(group,x,-.284,-.75,.58,.04,4.8,"grass",.05);
      for(const z of[-2.7,-.5,1.4]){
        this.beam(group,[x,-.26,z],[x,.8,z],.065,"bark",8);
        this.sphere(group,x,1.18,z,.47,"leaf");this.sphere(group,x-.22,1.03,z+.14,.31,"grass");
      }
    }
    this.box(group,0,-.35,4.55,12,.1,1.0,"floor",.04);
    for(const x of[-4.6,4.6]){
      this.beam(group,[x,-.29,5.8],[x,2.1,5.8],.026,"chrome",8);
      this.box(group,x+.13,2.12,5.8,.35,.035,.14,"white",.025);
    }
    return group;
  }
  buildCrane() {
    const g = this.group();
    g.position.set(-2.75, 0, -1.9);
    this.box(g, 0, -0.28, 0, 0.6, 0.18, 0.6, "concrete");
    const lines = [];
    for (const x of [-0.13, 0.13])
      for (const z of [-0.13, 0.13])
        lines.push([
          [x, -0.18, z],
          [x, TOWER_HEIGHT, z],
        ]);
    for (let y = 0; y < TOWER_HEIGHT; y += 0.4)
      for (const z of [-0.13, 0.13]) {
        lines.push(
          [
            [-0.13, y, z],
            [0.13, y + 0.4, z],
          ],
          [
            [0.13, y, z],
            [-0.13, y + 0.4, z],
          ],
          [
            [-0.13, y, z],
            [0.13, y, z],
          ],
        );
      }
    this.batch(g, lines, "yellow", 0.018);
    const jib = this.group(g);
    jib.position.y = TOWER_HEIGHT;
    const j = [];
    for (const z of [-0.11, 0.11])
      j.push(
        [
          [-1.35, 0, z],
          [4.2, 0, z],
        ],
        [
          [-1.35, 0.22, z],
          [4.2, 0.04, z],
        ],
      );
    for (let x = -1.3; x < 4.2; x += 0.4) {
      j.push(
        [
          [x, 0, -0.11],
          [x + 0.4, 0.15, -0.11],
        ],
        [
          [x, 0, 0.11],
          [x + 0.4, 0.15, 0.11],
        ],
        [
          [x, 0, -0.11],
          [x, 0, 0.11],
        ],
      );
    }
    this.batch(jib, j, "yellow", 0.014);
    this.box(jib, -1.0, -0.2, 0, 0.7, 0.35, 0.5, "chrome", 0.02);
    this.box(jib, 0.15, -0.23, 0.05, 0.47, 0.36, 0.46, "white", 0.04);
    this.box(jib, 0.15, -0.2, 0.285, 0.32, 0.21, 0.01, "glass");
    this.beam(jib, [0, 0.62, 0], [4.1, 0.08, 0], 0.008, "steel");
    this.beam(jib, [0, 0.62, 0], [-1.3, 0.2, 0], 0.008, "steel");
    const cable = this.beam(jib, [2.6, 0, 0], [2.6, -2.8, 0], 0.008, "steel");
    const hook = this.group(jib);
    hook.position.set(2.6, -2.8, 0);
    this.box(hook, 0, 0, 0, 0.13, 0.19, 0.09, "yellow", 0.025);
    const torus = new THREE.Mesh(
      this.geometry(
        "hook",
        () => new THREE.TorusGeometry(0.055, 0.014, 6, 14, Math.PI * 1.4),
      ),
      this.mat.get("steel"),
    );
    torus.position.y = -0.14;
    hook.add(torus);
    const payload=this.group(hook),boards=this.group(payload),bars=this.group(payload);
    for(let i=0;i<3;i++)this.box(boards,0,-.58+i*.055,0,.75,.045,.45,'wood');
    for(let i=0;i<6;i++)this.beam(bars,[-.47,-.58,i*.04-.1],[.47,-.58,i*.04-.1],.018,'steel',8);
    for(const x of[-.3,.3])for(const z of[-.18,.18])this.beam(payload,[0,-.15,0],[x,-.48,z],.008,'rubber',6);
    g.userData = { jib, cable, hook, payload, boards, bars };
    return g;
  }
  /* ---------------------------------------------------------------- site vehicles
   * Every vehicle group has its origin at the centre of its footprint on the ground (y = 0 at the
   * tyre contact), local +x forward. FleetMotion supplies pose, gear, odometer and steering. */
  // Wheel: steer node (about y) → spin node (about z) → tyre and hub. Tyre touches y = 0.
  makeWheel(parent, x, z, steer = 0, tube = 0.045, radius = 0.123) {
    const steerNode = this.group(parent);
    steerNode.position.set(x, radius + tube, z);
    const spin = this.group(steerNode);
    const tire = new THREE.Mesh(this.geometry('tire-' + radius + '-' + tube, () => new THREE.TorusGeometry(radius, tube, 8, 18)), this.mat.get('rubber'));
    tire.castShadow = true;
    spin.add(tire);
    const hub = new THREE.Mesh(this.geometry('hub-' + radius, () => new THREE.CylinderGeometry(radius * 0.6, radius * 0.6, tube * 0.8, 12)), this.mat.get('chrome'));
    hub.rotation.x = Math.PI / 2;
    spin.add(hub);
    // A spoke makes the rotation visible.
    this.box(spin, 0, radius * 0.3, 0, tube * 0.6, radius * 0.6, tube * 0.9, 'steel');
    return { steerNode, spin, steer, radius: radius + tube };
  }
  makeTruck(kind) {
    const spec = FleetMotion.SPECS[kind], L = spec.length, W = spec.width, hl = L / 2;
    const group = this.group(), wheels = [];
    const ref = -(hl - spec.rearOverhang), front = ref + spec.wheelbase, wz = W / 2 - 0.08;
    const axles = kind === 'pump'
      ? [[ref - 0.2, 0], [ref + 0.2, 0], [front - 0.35, (spec.wheelbase - 0.35) / spec.wheelbase], [front, 1]]
      : [[ref - 0.2, 0], [ref + 0.2, 0], [front, 1]];
    for (const [x, steer] of axles) for (const z of [-wz, wz]) wheels.push(this.makeWheel(group, x, z, steer));
    // Chassis, cab, glazing, bumper, lights.
    this.box(group, -0.02, 0.29, 0, L - 0.06, 0.1, W - 0.3, 'steel', 0.02);
    const cabColor = kind === 'pump' ? 'white' : 'white';
    this.box(group, hl - 0.31, 0.56, 0, 0.58, 0.52, W - 0.04, cabColor, 0.06);
    this.box(group, hl - 0.02, 0.64, 0, 0.02, 0.24, W - 0.2, 'glass', 0.01);
    for (const z of [-(W / 2 - 0.01), W / 2 - 0.01]) this.box(group, hl - 0.3, 0.66, z, 0.3, 0.2, 0.012, 'glass', 0.006);
    this.box(group, hl - 0.03, 0.31, 0, 0.05, 0.09, W - 0.08, 'blue', 0.015);
    for (const z of [-(W / 2 - 0.13), W / 2 - 0.13]) this.box(group, hl - 0.005, 0.38, z, 0.012, 0.05, 0.1, 'mark', 0.006);
    // Mudguards over the axles.
    for (const [x] of axles) for (const z of [-wz, wz]) this.box(group, x, 0.37, z, 0.36, 0.025, 0.11, 'blue', 0.01);
    const item = { kind, group, wheels, state: {} };
    if (kind === 'mixer') {
      this.box(group, -0.32, 0.38, 0, L - 0.78, 0.08, 0.58, 'blue', 0.02);
      const pivot = this.group(group);
      pivot.position.set(-0.32, 0.8, 0);
      pivot.rotation.z = -Math.PI / 2 - 0.12;   // opening at the rear, slightly raised
      const profile = [new THREE.Vector2(0.13, -0.78), new THREE.Vector2(0.35, -0.55), new THREE.Vector2(0.38, 0.12), new THREE.Vector2(0.17, 0.58)];
      const cv = document.createElement('canvas');
      cv.width = cv.height = 128;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#f0f4f6'; ctx.fillRect(0, 0, 128, 128);
      ctx.fillStyle = '#2359a4';
      for (let i = -128; i < 256; i += 52) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + 22, 0); ctx.lineTo(i + 92, 128); ctx.lineTo(i + 70, 128); ctx.fill(); }
      const texture = new THREE.CanvasTexture(cv);
      texture.colorSpace = THREE.SRGBColorSpace;
      this.resources.add(texture);
      const material = new THREE.MeshStandardMaterial({ map: texture, metalness: 0.3, roughness: 0.32 });
      this.resources.add(material);
      const drum = new THREE.Mesh(this.geometry('drum-l', () => new THREE.LatheGeometry(profile, 24)), material);
      drum.castShadow = true; drum.receiveShadow = true;
      pivot.add(drum);
      const cap = new THREE.Mesh(this.geometry('drum-front-cap-l', () => new THREE.CylinderGeometry(0.17, 0.17, 0.012, 24)), this.mat.get('white'));
      cap.position.y = 0.58; drum.add(cap);
      const mouth = new THREE.Mesh(this.geometry('drum-rear-mouth-l', () => new THREE.CylinderGeometry(0.125, 0.125, 0.02, 20)), this.mat.get('steel'));
      mouth.position.y = -0.775; drum.add(mouth);
      this.box(group, -hl + 0.12, 0.62, 0, 0.12, 0.26, 0.3, 'steel', 0.02);   // charging hopper
      item.drum = drum;
      item.chuteRoot = [-hl + 0.04, 0.68, 0];
      item.chute = this.beam(group, item.chuteRoot, [-hl - 0.2, 0.42, 0.18], 0.04, 'chrome');
      item.feed = this.beam(group, [0, 0, 0], [0, 0.1, 0], 0.028, 'concrete', 6);
      item.feed.visible = false;
    }
    if (kind === 'dumper') {
      // Tipping body hinged at the rear of the chassis.
      const bed = this.group(group);
      bed.position.set(-hl + 0.08, 0.36, 0);
      const len = L - 0.78;
      this.box(bed, len / 2, 0.04, 0, len, 0.08, W - 0.06, 'yellow', 0.02);
      for (const z of [-(W / 2 - 0.05), W / 2 - 0.05]) this.box(bed, len / 2, 0.24, z, len, 0.36, 0.04, 'yellow', 0.015);
      this.box(bed, len - 0.02, 0.3, 0, 0.05, 0.48, W - 0.06, 'yellow', 0.015);
      this.box(bed, 0.02, 0.2, 0, 0.04, 0.3, W - 0.1, 'yellow', 0.01);
      const load = this.box(bed, len / 2 + 0.02, 0.2, 0, len - 0.12, 0.26, W - 0.18, 'soilLoad', 0.06);
      item.bed = bed; item.load = load;
    }
    if (kind === 'pump') {
      this.box(group, -0.45, 0.52, 0, 1.45, 0.36, 0.62, 'blue', 0.04);            // pump unit housing
      this.box(group, -hl + 0.16, 0.46, 0, 0.28, 0.24, 0.52, 'steel', 0.03);       // hopper at the rear
      this.box(group, -hl + 0.16, 0.585, 0, 0.22, 0.012, 0.44, 'concrete', 0.005);
      item.hopper = [-hl + 0.16, 0.6, 0];
      // Outriggers: two cross beams that slide out sideways and lower their feet.
      item.outriggers = [];
      for (const x of [0.35, -1.05]) {
        const beam = this.box(group, x, 0.33, 0, 0.08, 0.08, 1.0, 'chrome', 0.01);
        const feet = [-1, 1].map(side => this.box(group, x, 0.2, side * 0.45, 0.14, 0.04, 0.14, 'yellow', 0.01));
        item.outriggers.push({ beam, feet, x });
      }
      const turret = this.group(group);
      turret.position.set(-0.55, 0.82, 0);
      const ring = new THREE.Mesh(this.geometry('pump-turret', () => new THREE.CylinderGeometry(0.2, 0.22, 0.16, 16)), this.mat.get('white'));
      ring.castShadow = true;
      turret.add(ring);
      item.turret = turret;
      item.boomPivot = [-0.55, 0.95, 0];
      item.boomLengths = [2.4, 2.4, 2.4, 2.4, 2.4, 2.4];
      item.booms = item.boomLengths.map((_, i) => this.beam(group, [0, 0, 0], [0, 1, 0], 0.055 - i * 0.005, i % 2 ? 'white' : 'blue', 8));
      item.hose = this.beam(group, [0, 0, 0], [0, 0.3, 0], 0.024, 'rubber');
      item.stream = this.beam(group, [0, 0, 0], [0, 0.2, 0], 0.018, 'concrete', 6);
      item.stream.visible = false;
    }
    return item;
  }
  makeExcavator() {
    const group = this.group(), lower = this.group(group), item = { kind: 'excavator', group, wheels: [], state: {}, rollers: [[], []], trackMats: [] };
    // Tracks with a scrolling cleat texture; the rollers turn with the track.
    const cv = document.createElement('canvas');
    cv.width = 64; cv.height = 8;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#20282e'; ctx.fillRect(0, 0, 64, 8);
    ctx.fillStyle = '#4a555c';
    for (let x = 0; x < 64; x += 8) ctx.fillRect(x, 0, 3, 8);
    [-0.38, 0.38].forEach((z, side) => {
      const tex = new THREE.CanvasTexture(cv);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(5, 1);
      this.resources.add(tex);
      const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, transparent: true });
      this.resources.add(mat);
      const track = new THREE.Mesh(this.geometry('track-box', () => new RoundedBoxGeometry(1.25, 0.24, 0.24, 2, 0.1)), mat);
      track.position.set(0, 0.12, z);
      track.castShadow = true; track.receiveShadow = true;
      lower.add(track);
      item.trackMats.push(tex);
      for (let x = -0.42; x <= 0.43; x += 0.21) {
        const spin = this.group(lower);
        spin.position.set(x, 0.12, z + (side ? 0.125 : -0.125));
        const roller = new THREE.Mesh(this.geometry('trackwheel', () => new THREE.CylinderGeometry(0.07, 0.07, 0.03, 10)), this.mat.get('chrome'));
        roller.rotation.x = Math.PI / 2;
        spin.add(roller);
        this.box(spin, 0, 0.035, 0, 0.012, 0.05, 0.034, 'steel');
        item.rollers[side].push(spin);
      }
    });
    this.box(lower, 0, 0.21, 0, 0.7, 0.12, 0.56, 'steel', 0.03);
    // Upper structure slews on the tracks.
    const upper = this.group(group);
    upper.position.y = 0.3;
    this.box(upper, -0.08, 0.13, 0, 0.92, 0.26, 0.72, 'yellow', 0.05);
    this.box(upper, -0.5, 0.17, 0, 0.18, 0.3, 0.72, 'yellow', 0.05);          // counterweight
    this.box(upper, 0.12, 0.47, 0.18, 0.4, 0.44, 0.32, 'white', 0.05);         // cab
    for (const z of [0.02, 0.341]) this.box(upper, 0.12, 0.52, z, 0.3, 0.24, 0.01, 'glass');
    this.box(upper, 0.322, 0.52, 0.18, 0.01, 0.24, 0.24, 'glass');
    const boom = this.beam(upper, [0, 0, 0], [0, 1, 0], 0.07, 'yellow');
    const arm = this.beam(upper, [0, 0, 0], [0, 1, 0], 0.055, 'yellow');
    const ram = this.beam(upper, [0, 0, 0], [0, 1, 0], 0.025, 'chrome');
    const bucket = this.group(upper);
    this.box(bucket, 0.06, -0.06, 0, 0.26, 0.16, 0.3, 'steel', 0.045);
    for (const z of [-0.1, 0, 0.1]) this.box(bucket, 0.17, -0.15, z, 0.07, 0.05, 0.05, 'chrome');
    Object.assign(item, { lower, upper, boom, arm, ram, bucket, shoulder: [0.32, 0.18, -0.05], boomLength: 1.35, armLength: 1.05 });
    return item;
  }
  makeRoller() {
    const group = this.group(), item = { kind: 'roller', group, wheels: [], state: {} };
    const spec = FleetMotion.SPECS.roller, ref = -(spec.length / 2 - spec.rearOverhang);
    // Rear tyres and the front drum both touch y = 0.
    for (const z of [-0.33, 0.33]) item.wheels.push(this.makeWheel(group, ref, z, 0, 0.055, 0.135));
    this.box(group, -0.22, 0.42, 0, 0.98, 0.32, 0.62, 'yellow', 0.04);
    this.box(group, 0.36, 0.42, 0, 0.2, 0.2, 0.36, 'steel', 0.03);             // articulation
    const drumPivot = this.group(group);
    drumPivot.position.set(0.5, spec.drumRadius, 0);
    const drum = new THREE.Mesh(this.geometry('roller-drum', () => new THREE.CylinderGeometry(spec.drumRadius, spec.drumRadius, 0.82, 24)), this.mat.get('chrome'));
    drum.rotation.x = Math.PI / 2;
    drum.castShadow = true;
    drumPivot.add(drum);
    this.box(drumPivot, 0, spec.drumRadius * 0.55, 0, 0.04, 0.12, 0.84, 'steel');
    for (const z of [-0.44, 0.44]) this.box(group, 0.5, 0.36, z, 0.5, 0.3, 0.05, 'yellow', 0.02);   // drum yoke
    for (const x of [-0.58, -0.1]) for (const z of [-0.28, 0.28]) this.box(group, x, 0.86, z, 0.025, 0.6, 0.025, 'steel');
    this.box(group, -0.34, 1.17, 0, 0.66, 0.05, 0.7, 'yellow', 0.02);
    this.box(group, -0.36, 0.66, 0, 0.16, 0.18, 0.22, 'rubber', 0.02);
    this.sphere(group, -0.36, 0.82, 0, 0.07, 'wood');
    this.sphere(group, -0.36, 0.89, 0, 0.075, 'yellow');
    item.drum = drumPivot;
    return item;
  }
  buildFleet() {
    this.fleet = FleetMotion.createFleet();
    this.vehicleMeshes = new Map();
    for (const v of this.fleet.vehicles) {
      const mesh = v.kind === 'excavator' ? this.makeExcavator() : v.kind === 'roller' ? this.makeRoller() : this.makeTruck(v.kind);
      mesh.group.visible = false;
      this.vehicleMeshes.set(v.id, mesh);
    }
  }
  // Ground under a vehicle: road slabs, the compaction strip, the pump hardstand or the site floor.
  groundAt(x, z) {
    for (const [x0, x1, z0, z1] of this.roadRects) if (x >= x0 && x <= x1 && z >= z0 && z <= z1) return -0.2975;
    if (this.compactionPad.visible && x >= -2.4 && x <= 2.2 && z >= -3.14 && z <= -1.96) return -0.3045;
    if (x >= 5.75 && x <= 7.65 && z >= -3.7 && z <= -0.4) return -0.29;
    return -0.323;
  }
  // Per-vehicle opacity (materials are cloned once per vehicle).
  setAlpha(group, alpha) {
    if (!group.userData.fadeMaterials) {
      const clones = new Map();
      group.traverse(mesh => {
        if (!mesh.material) return;
        const clone = source => {
          if (!clones.has(source)) { const copy = source.clone(); copy.transparent = true; copy.userData.baseOpacity = source.opacity; clones.set(source, copy); this.resources.add(copy); }
          return clones.get(source);
        };
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(clone) : clone(mesh.material);
      });
      group.userData.fadeMaterials = [...clones.values()];
      group.userData.alpha = -1;
    }
    if (Math.abs(group.userData.alpha - alpha) < 1e-3) return;
    group.userData.alpha = alpha;
    for (const m of group.userData.fadeMaterials) { m.opacity = alpha * m.userData.baseOpacity; m.depthWrite = alpha > 0.98 && m.userData.baseOpacity >= 1; }
  }
  // Two-link arm in a vertical plane: returns the elbow for a shoulder→target reach (elbow up).
  static elbow(sx, sy, tx, ty, a, b) {
    let dx = tx - sx, dy = ty - sy, d = Math.hypot(dx, dy);
    const max = a + b - 1e-3, min = Math.abs(a - b) + 1e-3;
    if (d > max) { dx *= max / d; dy *= max / d; d = max; }
    if (d < min) { dx *= min / d; dy *= min / d; d = min; }
    const along = (a * a - b * b + d * d) / (2 * d), h = Math.sqrt(Math.max(0, a * a - along * along));
    return [sx + dx * along / d - dy * h / d, sy + dy * along / d + dx * h / d, sx + dx, sy + dy];
  }
  // Placing boom: six fixed-length sections bent evenly (a0, a0-d, ...) but never past pointing straight
  // down, so close targets give the usual inverted U with the tip sections hanging. Solved for the tip
  // by Newton steps (coarse search if that fails). Section lengths never change: no stretching.
  static boomAngle(a0, d, i) { return Math.max(a0 - i * d, -Math.PI / 2 + 0.03); }
  static boomArch(lengths, r, y, guess) {
    const A = WebGLConstructionScene.boomAngle;
    const tip = (a0, d) => { let x = 0, h = 0; lengths.forEach((l, i) => { x += l * Math.cos(A(a0, d, i)); h += l * Math.sin(A(a0, d, i)); }); return [x, h]; };
    const error = ([a0, d]) => { const [x, h] = tip(a0, d); return Math.hypot(x - r, h - y); };
    const newton = ([a0, d]) => {
      for (let it = 0; it < 14; it++) {
        const [x, h] = tip(a0, d), ex = x - r, ey = h - y;
        if (Math.hypot(ex, ey) < 1e-3) break;
        const e = 1e-4, [xa, ha] = tip(a0 + e, d), [xd, hd] = tip(a0, d + e);
        const j11 = (xa - x) / e, j12 = (xd - x) / e, j21 = (ha - h) / e, j22 = (hd - h) / e, det = j11 * j22 - j12 * j21;
        if (Math.abs(det) < 1e-9) break;
        a0 = clamp(a0 - (j22 * ex - j12 * ey) / det, 0.15, 1.9);
        d = clamp(d - (-j21 * ex + j11 * ey) / det, 0, 1.5);
      }
      return [a0, d];
    };
    let best = newton(guess || [1.25, 0.42]);
    if (error(best) > 0.02) {
      // Poor start (e.g. the target jumped): coarse search, then refine. Unreachable targets get the closest pose.
      let seed = best, err = error(best);
      for (let a0 = 0.2; a0 <= 1.9; a0 += 0.12) for (let d = 0; d <= 1.5; d += 0.1) { const e = error([a0, d]); if (e < err) { err = e; seed = [a0, d]; } }
      const refined = newton(seed);
      best = error(refined) < error(seed) ? refined : seed;
    }
    return best;
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.width = r.width;
    this.height = r.height;
    if (!r.width || !r.height) return;
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(r.width, r.height, false);
    this.dirty = true;
    this.setShot(this.currentP ?? this.getProgress(), true);
  }
  setShot(p, immediate = false) {
    const floorY=(this.focusFloor-1)*FLOOR_HEIGHT;
    const bookmark=this.focusFloor&&this.detailMode==='auto'?{target:[0,floorY+.7,0],direction:[1.1,.9,1.3],bounds:[[-2.4,floorY-.4,-2],[3.8,floorY+2.0,2]]}:this.viewMode==='landmark'?{target:[17.7,2.2,-15.2],direction:[1,.6,1.6],bounds:this.campusBounds}:this.viewMode==='overview'?{target:[7,3,-5],direction:[1,1.1,1.4],bounds:[[-7,-.4,-19],[25,TOWER_HEIGHT+1,7]]}:null;
    const mode = bookmark || DEFAULTS[this.detailMode] || DEFAULTS.auto,
      inspection = this.detailMode !== "auto",
      hasCrane = p > 0.4 && p < 0.98;
    const target = new V(
        ...(mode.target || (p < 0.4 ? [0, -0.05, 0] : [0, FLOOR_COUNT*.54, 0])),
      ),
      direction = new V(
        ...(mode.direction || (p < 0.4 ? [1.05, 1.0, 1.3] : [1.1, 0.8, 1.3])),
      ).normalize(),
      right = new V().crossVectors(UP, direction).normalize(),
      up = new V().crossVectors(direction, right).normalize(),
      tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const points = [];
    const addBounds = (lo, hi) => {
      for (const x of [lo[0], hi[0]])
        for (const y of [lo[1], hi[1]])
          for (const z of [lo[2], hi[2]]) points.push(new V(x, y, z));
    };
    if (bookmark || inspection) addBounds(...mode.bounds);
    else {
      addBounds([-4.6, -1.45, -4.1], [8.8, 0.8, 4.0]);
      addBounds([-1.9, -0.1, -1.5], [1.9, p < 0.4 ? 1.2 : FLOOR_COUNT*1.08+.6, 1.5]);
      if (hasCrane) addBounds([-4.15, TOWER_HEIGHT-.4, -2.2], [1.5, TOWER_HEIGHT+.9, -1.6]);
    }
    let distance = 0;
    for (const point of points) {
      const rel = point.sub(target),
        depth = rel.dot(direction);
      distance = Math.max(
        distance,
        Math.abs(rel.dot(up)) / tan + depth,
        Math.abs(rel.dot(right)) / (tan * this.camera.aspect) + depth,
      );
    }
    distance *= inspection ? 1.1 : 1.06;
    this.targetLook.copy(target);
    this.targetPosition.copy(target).addScaledVector(direction, distance);
    if (immediate) {
      this.camera.position.copy(this.targetPosition);
      this.controls.target.copy(target);
      this.controls.update();
    }
  }
  adjustCamera(action) {
    if(['site','landmark','overview'].includes(action)){this.focusFloor=null;this.viewMode=action==='site'?null:action;this.manual=false;this.setShot(this.lastDesiredP??this.currentP);this.dirty=true;return;}
    if(action==='reset'){this.focusFloor=null;this.viewMode=null;this.manual=false;this.setShot(this.lastDesiredP??this.currentP);return;}
    const offset=this.camera.position.clone().sub(this.controls.target),length=clamp(offset.length()*(action==='in'?.84:1.18),7,80);
    offset.setLength(length);this.targetPosition.copy(this.controls.target).add(offset);this.targetLook.copy(this.controls.target);this.manual=false;
  }
  fadeActor(group, show, dt) {
    if (!group.userData.fadeMaterials) {
      const clones = new Map();
      group.traverse(mesh => {
        if (!mesh.material) return;
        const clone = source => {
          if (!clones.has(source)) { const copy = source.clone(); copy.transparent = true; copy.userData.baseOpacity = source.opacity; clones.set(source, copy); this.resources.add(copy); }
          return clones.get(source);
        };
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(clone) : clone(mesh.material);
      });
      group.userData.fadeMaterials = [...clones.values()];
      group.userData.fadeValue = show ? 1 : 0;
    }
    const value = group.userData.fadeValue = lerp(group.userData.fadeValue, show ? 1 : 0, this.reduced ? 1 : 1 - Math.exp(-8 * dt));
    group.visible = value > .006;
    for (const m of group.userData.fadeMaterials) { m.opacity = value * m.userData.baseOpacity; m.depthWrite = value > .98 && m.userData.baseOpacity >= 1; }
  }
  // Advance the fleet (decisions come from the TARGET progress, not the smoothed view) and pose meshes.
  updateVehicles(dt, view) {
    const paused = WebGLConstructionScene.paused;
    const out = this.fleet.update(dt, { progress: this.fleetProgress, paused, reduced: this.reduced });
    const meshes = this.vehicleMeshes;
    let pump = null, pumpMesh = null;
    for (const o of out) {
      const m = meshes.get(o.id), g = m.group;
      g.visible = view.show && o.visible;
      if (!o.visible) { m.state.y = null; continue; }
      const ground = this.groundAt(o.x, o.z);
      m.state.y = m.state.y == null || this.reduced ? ground : lerp(m.state.y, ground, 1 - Math.exp(-10 * dt));
      g.position.set(o.x, m.state.y, o.z);
      g.rotation.y = o.yaw;
      this.setAlpha(g, o.alpha);
      for (const w of m.wheels) {
        w.spin.rotation.z = -o.odo / w.radius;                        // rolls with signed distance
        if (w.steer) w.steerNode.rotation.y = Math.atan(Math.tan(o.steer) * w.steer);
      }
      if (o.kind === 'excavator') this.poseExcavator(m, o, view);
      else if (o.kind === 'roller') m.drum.rotation.z = -o.odo / FleetMotion.SPECS.roller.drumRadius;
      else if (o.kind === 'dumper') {
        m.bed.rotation.z = o.bed * 0.85;
        m.load.visible = o.load > 0.02;
        m.load.scale.set(1, Math.max(0.05, o.load), 1);
        m.load.position.y = 0.07 + 0.13 * o.load;
      } else if (o.kind === 'mixer') {
        m.state.drum = (m.state.drum || 0) + (paused || this.reduced ? 0 : dt) * (o.pouring ? -1.7 : 0.8);
        m.drum.rotation.y = m.state.drum;
      } else if (o.kind === 'pump') { pump = o; pumpMesh = m; }
    }
    let pouring = false, hopper = null;
    if (pump && pump.visible) {
      pouring = this.posePump(pumpMesh, pump, dt, view);
      pumpMesh.group.updateMatrixWorld(true);
      hopper = pumpMesh.group.localToWorld(new V(...pumpMesh.hopper));
    }
    // Mixer chute: down into the pump hopper when docked rear to rear, folded otherwise.
    for (const o of out) {
      if (o.kind !== 'mixer' || !o.visible) continue;
      const m = meshes.get(o.id);
      m.group.updateMatrixWorld(true);
      const docked = o.docked && hopper;
      const end = docked ? m.group.worldToLocal(hopper.clone().add(new V(0, 0.08, 0))).toArray() : [-FleetMotion.SPECS.mixer.length / 2 - 0.2, 0.42, 0.18];
      this.placeBeam(m.chute, m.chuteRoot, end);
      m.feed.visible = !!(docked && o.pouring && pouring);
      if (m.feed.visible) this.placeBeam(m.feed, end, [end[0], end[1] - 0.12, end[2]]);
    }
    return { out, pouring };
  }
  poseExcavator(m, o, view) {
    m.upper.rotation.y = o.dig.slew;
    m.trackMats[0].offset.x = o.odoL / 0.25;
    m.trackMats[1].offset.x = o.odoR / 0.25;
    m.rollers[0].forEach(r => { r.rotation.z = -o.odoL / 0.07; });
    m.rollers[1].forEach(r => { r.rotation.z = -o.odoR / 0.07; });
    // Bucket target from the dig cycle, kept above the pit floor / ground it is over.
    const [sx, sy, sz] = m.shoulder, reach = o.dig.reach;
    const yaw = o.yaw + o.dig.slew, bx = o.x + Math.cos(yaw) * reach, bz = o.z - Math.sin(yaw) * reach;
    const overPit = Math.abs(bx) < 2 && Math.abs(bz) < 1.7;
    const floor = overPit ? -view.pitDepth : 0;
    const ty = Math.max(o.dig.height, floor + 0.08) - m.upper.position.y;
    const [ex, ey, tx, tyy] = WebGLConstructionScene.elbow(sx, sy, reach, ty, m.boomLength, m.armLength);
    this.placeBeam(m.boom, [sx, sy, sz], [ex, ey, sz]);
    this.placeBeam(m.arm, [ex, ey, sz], [tx, tyy, sz]);
    this.placeBeam(m.ram, [sx + 0.18, sy - 0.05, sz + 0.06], [(sx + ex) / 2, (sy + ey) / 2, sz + 0.06]);
    m.bucket.position.set(tx, tyy, sz);
    m.bucket.rotation.z = -0.4 - o.dig.curl * 0.9;
  }
  // Where concrete goes now (world): blinding pads, footings, columns or the slab strip being poured.
  pourTarget(view, t) {
    const { p, structure, fp } = view;
    if (p < 0.4) {
      if (p < 0.285) { const b = this.blinding[Math.min(8, Math.floor(view.blindP * 9))]; return [b.position.x, -1.2, b.position.z]; }
      const foot = this.footings[Math.min(8, Math.floor(fp * 9))];
      return [foot.f.position.x, foot.ped.position.y + 0.55 * foot.ped.scale.y, foot.f.position.z];
    }
    const floor = Math.min(FLOOR_COUNT - 1, Math.floor(structure * FLOOR_COUNT)), q = structure * FLOOR_COUNT - floor;
    if (q >= 0.7) return [lerp(-1.3, 1.3, clamp((q - 0.77) / 0.125, 0, 1)), floor * FLOOR_HEIGHT + 1.14, 0.2];
    const c = Math.floor(t / 5) % 6, col = clamp((q - 0.33) / 0.21, 0, 1);
    return [[-1.6, 0, 1.6][Math.floor(c / 2)], floor * FLOOR_HEIGHT + Math.max(0.12, col) + 0.04, [-1.2, 1.2][c % 2]];
  }
  posePump(m, o, dt, view) {
    const legs = ease(o.legs);
    for (const r of m.outriggers) {
      r.beam.scale.z = lerp(0.82, 1.6, legs);
      r.feet.forEach((f, i) => { f.position.z = (i ? 1 : -1) * lerp(0.4, 0.78, legs); f.position.y = lerp(0.24, 0.025, legs); });
    }
    // Smoothly follow the pour point; solve the boom as an arch of fixed-length sections.
    const goal = new V(...this.pourTarget(view, view.t));
    const st = m.state;
    if (!st.target || this.reduced) st.target = goal.clone();
    else st.target.lerp(goal, 1 - Math.exp(-2.5 * dt));
    m.group.updateMatrixWorld(true);
    const local = m.group.worldToLocal(st.target.clone()), [px, py, pz] = m.boomPivot, hose = 1.1;
    const dx = local.x - px, dz = local.z - pz, yawT = Math.atan2(-dz, dx), r = Math.hypot(dx, dz), y = local.y + hose - py;
    st.arch = WebGLConstructionScene.boomArch(m.boomLengths, r, y, st.arch);
    const e = o.boom, turn = ease(clamp(e * 2.2 - 0.25, 0, 1)), yaw = yawT * turn;
    m.turret.rotation.y = yaw;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    let x = px, h = py, z = pz;
    m.boomLengths.forEach((len, i) => {
      const folded = i % 2 ? Math.PI - 0.03 : 0.03, unfolded = WebGLConstructionScene.boomAngle(st.arch[0], st.arch[1], i);
      const a = lerp(folded, unfolded, ease(clamp(e * 1.7 - i * 0.12, 0, 1)));
      const nx = x + len * Math.cos(a) * cy, nh = h + len * Math.sin(a), nz = z - len * Math.cos(a) * sy;
      this.placeBeam(m.booms[i], [x, h, z], [nx, nh, nz]);
      x = nx; h = nh; z = nz;
    });
    const hoseEnd = [x, Math.max(local.y + 0.3, h - hose * e - 0.3 * (1 - e)), z];
    this.placeBeam(m.hose, [x, h, z], hoseEnd);
    const pouring = !!o.pouring && e > 0.98;
    m.stream.visible = pouring;
    if (pouring) this.placeBeam(m.stream, hoseEnd, [hoseEnd[0], local.y + 0.02, hoseEnd[2]]);
    return pouring;
  }
  // Street traffic on the back road (right-hand traffic): two lanes joined by U-turns off-screen.
  updateAmbientCars(dt) {
    const step = this.reduced || WebGLConstructionScene.paused ? 0 : dt * 0.75, r = 0.48, arc = Math.PI * r, straight = 58, loop = 2 * straight + 2 * arc;
    for (const [i, car] of this.ambientCars.entries()) {
      car.distance = ((car.distance ?? i * loop / this.ambientCars.length) + step) % loop;
      let d = car.distance, pose;
      if (d < straight) pose = { x: -29 + d, z: -4.62, yaw: 0 };
      else if ((d -= straight) < arc) { const a = d / r; pose = { x: 29 + r * Math.sin(a), z: -5.1 + r * Math.cos(a), yaw: a }; }
      else if ((d -= arc) < straight) pose = { x: 29 - d, z: -5.58, yaw: Math.PI };
      else { const a = (d - straight) / r; pose = { x: -29 - r * Math.sin(a), z: -5.1 - r * Math.cos(a), yaw: Math.PI + a }; }
      car.odo = (car.odo || 0) + step;
      car.group.position.set(pose.x, -0.2975, pose.z);
      car.group.rotation.y = pose.yaw;
      car.group.visible = this.inspect < 0.5;
      for (const w of car.wheels) w.rotation.z = -car.odo / 0.089;
    }
  }
  draw(now = performance.now()) {
    const dt = Math.min(0.05, Math.max(0.001, (now - this.lastTime) / 1000));
    this.lastTime = now;
    const mode = DEFAULTS[this.detailMode] || DEFAULTS.auto,
      targetP = mode.p ?? clamp(this.getProgress(), 0, 1);
    if ((this.reduced || WebGLConstructionScene.paused) && !this.manual && !this.dirty &&
        this.previousMode === this.detailMode && Math.abs(this.currentP - targetP) < .0001 &&
        Math.abs(this.inspect - (this.detailMode === 'auto' ? 0 : 1)) < .001 &&
        this.camera.position.distanceTo(this.targetPosition) < .001) return;
    if (
      this.previousMode !== this.detailMode ||
      this.lastShotPhase !== WebGLConstructionScene.phaseAt(targetP) ||
      Math.abs((this.lastDesiredP ?? targetP) - targetP) > 0.004
    ) {
      this.manual = false;
      this.viewMode=null;
      this.setShot(targetP);
      this.previousMode = this.detailMode;
      this.lastShotPhase = WebGLConstructionScene.phaseAt(targetP);
    }
    this.lastDesiredP = targetP;
    const blend = this.reduced ? 1 : 1 - Math.exp(-5.5 * dt);
    this.currentP = lerp(this.currentP, targetP, blend);
    if (Math.abs(this.currentP - targetP) < 0.0001) this.currentP = targetP;
    this.inspect = lerp(
      this.inspect,
      this.detailMode === "auto" ? 0 : 1,
      blend,
    );
    this.motionClock = (this.motionClock ?? 9) + (WebGLConstructionScene.paused ? 0 : dt);
    const p = this.currentP,
      inspection = this.inspect > 0.5,
      t = this.reduced ? 9 : this.motionClock;
    if (!this.manual) {
      this.camera.position.lerp(
        this.targetPosition,
        this.reduced ? 1 : 1 - Math.exp(-4.7 * dt),
      );
      this.controls.target.lerp(
        this.targetLook,
        this.reduced ? 1 : 1 - Math.exp(-4.7 * dt),
      );
    }
    this.controls.update();
    const view=this.camera.position.clone().sub(this.controls.target),viewLength=view.length(),normal=view.clone().normalize();
    for(const block of this.cityBlocks||[]){const relative=block.center.clone().sub(this.controls.target),along=relative.dot(normal),distance=relative.clone().addScaledVector(normal,-along).length();const blocksView=along>1&&along<viewLength+block.radius&&distance<block.radius+1.1;this.fadeActor(block.group,!blocksView,dt);if(this.camera.position.distanceTo(block.center)<block.radius+1)block.group.visible=false;}
    this.updateAmbientCars(dt);
    // Visual phases match the step windows of ConstructionSequence (half-way to the neighbouring steps).
    const dig = clamp((p - 0.19) / 0.055, 0, 1),
      backfill = window.ConstructionEquipment.earthwork(p).backfill,
      hole = 1 - dig * (1 - backfill);
    this.fill.scale.y = Math.max(0.001, hole);
    this.fill.position.y = -1.3 + 0.5 * hole;
    this.alpha("earth", 1 - this.inspect * 0.93);
    this.alpha("terrain", 1 - this.inspect * 0.93);
    this.alpha("road", 1 - this.inspect * 0.97);
    this.alpha("mark", 1 - this.inspect * 0.97);
    this.cabin.visible = this.inspect < .75 && p>=.1 && p<.985;
    this.siteSetup.visible=p>=.1&&p<.985&&this.inspect<.6;
    this.utilities.visible=p>=.04&&this.inspect<.5;
    this.survey.visible=p<.18&&this.inspect<.5;
    this.context.visible = this.inspect < .5;
    this.neighborhood.visible = this.inspect < .5;
    this.compactionPad.visible = this.inspect < .6 && p >= .32;
    this.blindP = clamp((p - .252) / .014, 0, 1);
    this.blinding.forEach((mesh, i) => { mesh.visible = this.blindP * 9 > i + .05; });
    this.foundationForms.visible=p>=.28&&p<.319;
    const fp = clamp((p - 0.296) / 0.015, 0, 1);
    this.footings.forEach(({ f, ped }, i) => {
      const amount = clamp(fp * 9 - i, 0, 1);
      f.scale.y = Math.max(0.001, amount);
      f.position.y = -1.18 + 0.1 * amount;
      ped.scale.y = Math.max(0.001, amount);
      ped.position.y = -0.98 + 0.55 * amount;
      f.visible = ped.visible = p > 0.26;
    });
    this.foundationBars.visible =
      p > 0.27 && (p < 0.4 || this.detailMode === "foundation");
    this.plinth.visible = p >= 0.4;
    const structure = clamp((p - 0.4) / 0.32, 0, 1),
      finish = clamp((p - 0.72) / 0.26, 0, 1);
    let columnCages = 0,
      slabGrids = 0,
      starterGroups = 0,
      joints = 0;
    this.floors.forEach((f, i) => {
      const q = clamp(structure * FLOOR_COUNT - i, 0, 1),
        next = clamp(structure * FLOOR_COUNT - i - 1, 0, 1);
      f.group.visible = q > 0.001;
      if (!f.group.visible) return;
      const col = clamp((q - 0.33) / 0.21, 0, 1);
      for (const mesh of f.cols) {
        mesh.scale.y = Math.max(0.001, col);
        mesh.position.y = 0.5 * col;
      }
      this.alpha(
        "col" + i,
        this.detailMode === "frame" ? 1 - this.inspect * 0.84 : 1,
      );
      const cage = q < 0.63 || inspection;
      f.barGroup.visible = cage;
      f.barGroup.scale.y = clamp(q / 0.24, 0.02, 1);
      if (cage) columnCages += 6;
      f.beamBars.visible = q > 0.69 && (q < 0.96 || inspection);
      f.mesh.visible = q > 0.70 && (q < 0.97 || inspection);
      if (f.mesh.visible) slabGrids++;
      f.columnForm.visible = q > .2 && q < .67;
      f.form.visible = q > .69 && q < .99;
      f.curing.visible=q>.945&&q<.99;
      f.starter.visible = i < FLOOR_COUNT - 1 && q > 0.75 && next < 0.6;
      if (f.starter.visible) starterGroups += 6;
      const fill = clamp((q - 0.77) / 0.125, 0, 1),
        left = Math.min(1, fill * 2),
        right = Math.max(0, fill * 2 - 1);
      f.slabA.visible = left > 0.001;
      f.slabB.visible = right > 0.001;
      f.slabA.scale.x = Math.max(0.001, left);
      f.slabA.position.x = -1.82 + 0.91 * left;
      f.slabB.scale.x = Math.max(0.001, right);
      f.slabB.position.x = 0.91 * right;
      const alpha = this.detailMode === "frame" ? 1 - this.inspect * 0.8 : 1;
      this.alpha("slabA" + i, alpha);
      this.alpha("slabB" + i, alpha);
      f.joint.visible = (q > 0.76 && q < 0.98) || this.detailMode === "joint";
      if (f.joint.visible) joints++;
      const clad = clamp(finish * FLOOR_COUNT - (FLOOR_COUNT - 1 - i), 0, 1);
      f.facade.visible = clad > 0.01;
      f.facade.scale.y = Math.max(0.01, clad);
    });
    this.scaffold.forEach((group,i)=>{group.visible=this.inspect<.5&&p>.4&&p<.98&&structure*FLOOR_COUNT>i+.02&&i<Math.ceil(FLOOR_COUNT*(1-clamp((p-.92)/.055,0,1)));});
    const construction = p > 0.4 && p < 0.98;
    this.fadeActor(this.crane, construction && this.inspect < 0.6, dt);
    if (this.crane.visible) {
      const {jib,cable,hook,payload,boards,bars}=this.crane.userData;
      const q=(t%48)/48,s=u=>{u=clamp(u,0,1);return u*u*(3-2*u);},floor=Math.min(FLOOR_COUNT-1,Math.floor(structure*FLOOR_COUNT)),localQ=structure*FLOOR_COUNT-floor,surface=floor*FLOOR_HEIGHT+(localQ>=.72?1.14:localQ>=.69?1.015:.06),destination=surface+.61,clear=Math.min(TOWER_HEIGHT-.3,floor*FLOOR_HEIGHT+2.6);
      const swing=q<.2?0:q<.48?s((q-.2)/.28):q<.76?1:1-s((q-.76)/.15);
      jib.rotation.y=lerp(1.8,-.5,swing);
      const trolley=lerp(1.6,4.0,swing);
      let hookY=q<.2?lerp(.39,clear,s(q/.2)):q<.48?clear:q<.60?lerp(clear,destination,s((q-.48)/.12)):q<.68?destination:q<.76?lerp(destination,clear,s((q-.68)/.08)):q<.91?clear:lerp(clear,.39,s((q-.91)/.09));
      const length=Math.max(.3,TOWER_HEIGHT-hookY);
      this.placeBeam(cable,[trolley,0,0],[trolley,-length,0]);hook.position.set(trolley,-length,0);
      payload.visible=q<.64;boards.visible=Math.floor(t/48)%2===0;bars.visible=!boards.visible;
      const cycle=Math.floor(t/48);
      if(q>=.64&&this.lastDeliveryCycle!==cycle){hook.updateWorldMatrix(true,false);this.deliveredPallet.position.copy(hook.localToWorld(new V(0,-.58,0)));this.deliveredPallet.rotation.y=jib.rotation.y;this.deliveredPallet.visible=true;this.lastDeliveryCycle=cycle;this.deliveryProgress=p;}
      if(this.deliveryProgress>p+.02)this.deliveredPallet.visible=false;

      this.craneState={phase:q<.2?'hoist':q<.48?'slew':q<.60?'lower':q<.68?'release':'return',hookY,load:payload.visible,destination};
    }

    const machinesVisible = this.inspect < 0.3, pitDepth = 0.85 * dig * (1 - backfill);
    this.mounds.forEach((m) => {
      const amount = dig * (1 - backfill);
      m.visible = amount > 0.01 && machinesVisible;
      m.scale.set(1, 0.65 * amount, 1);
    });
    this.fleetProgress = clamp(this.getProgress(), 0, 1);
    const fleetView = this.updateVehicles(dt, { show: machinesVisible, p, t, structure, fp, blindP: this.blindP, pitDepth });
    const active = FleetMotion.plan(this.fleetProgress), pouring = fleetView.pouring;
    const onSite = fleetView.out.filter(o => o.visible), dockedMixer = onSite.find(o => o.kind === 'mixer' && o.docked);
    this.lastScene = {
      renderer: "webgl",
      floorCount:FLOOR_COUNT,
      contextBuildings:this.contextBuildings,
      crane:this.craneState,
      roadDatum:-.2975,
      progress: p,
      targetProgress: targetP,
      phase: WebGLConstructionScene.phaseAt(targetP),
      pitDepth: 0.85 * dig * (1 - backfill),
      backfill,
      rollerSurface: "compacted-fill",
      earthwork: window.ConstructionEquipment.earthwork(p),
      inspection: this.detailMode !== "auto",
      machines: { roller: active.roller, excavator: active.excavator, dumpTruck: active.dumpTruck, mixer: active.mixer, pump: active.pump, pouring, step: this.fleet.applied, mixerX: dockedMixer ? dockedMixer.x : null, pumpPosition: [FleetMotion.BAYS.pump.x, FleetMotion.BAYS.pump.z], vehicles: onSite.map(o => ({ id: o.id, kind: o.kind, x: +o.x.toFixed(3), z: +o.z.toFixed(3), yaw: +o.yaw.toFixed(3), mode: o.mode, docked: o.docked, alpha: +o.alpha.toFixed(2) })) },
      rebar: {
        mode: this.detailMode,
        foundationGrids: this.foundationBars.visible ? 9 : 0,
        columnCages,
        slabGrids,
        starterGroups,
        joints,
        scaffoldLevels: this.scaffold.filter(g=>g.visible).length,
        formwork: this.floors.filter(f=>f.group.visible&&f.form.visible).length,
        columnForms: this.floors.filter(f=>f.group.visible&&f.columnForm.visible).length,
        rods: this.foundationBars.visible
          ? 700
          : columnCages * 40 + slabGrids * 50,
      },
      cameraSettled:
        this.camera.position.distanceTo(this.targetPosition) < 0.03,
    };
    this.renderer.render(this.scene, this.camera);
    this.dirty = false;
  }
  destroy() {
    this.running = false;
    WebGLConstructionScene.instances.delete(this);
    this.resizeObserver?.disconnect();
    this.visibilityObserver?.disconnect();
    this.controls?.dispose();
    this.environment?.dispose();
    for (const r of this.resources) r.dispose?.();
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
