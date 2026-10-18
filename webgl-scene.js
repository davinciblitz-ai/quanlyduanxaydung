import * as THREE from "./vendor/three.module.js";
import { RoundedBoxGeometry } from "./vendor/RoundedBoxGeometry.js";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { RoomEnvironment } from "./vendor/RoomEnvironment.js";

const clamp = THREE.MathUtils.clamp,
  lerp = THREE.MathUtils.lerp;
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
    for(const[x,col]of[[-3.65,"blue"],[-3.4,"chrome"]]) this.beam(this.utilities,[x,-.29,-2.8],[x,-.29,1.7],.025,col,8);
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
    this.cabin = this.group();
    this.box(this.cabin, 7.4, -0.02, -3.1, 1.15, 0.65, 0.85, "white", 0.035);
    this.box(this.cabin, 7.4, 0.33, -3.1, 1.25, 0.06, 0.95, "blue", 0.025);
    this.box(this.cabin, 7.35, 0.0, -2.667, 0.45, 0.3, 0.014, "glass");
    this.mounds = [];
    for (const [x, z, r] of [
      [5.5, -2.8, 0.4],
      [5.6, -3.45, 0.3],
    ]) {
      const mound = this.sphere(this.root, x, -0.25, z, r, "soilLoad");
      mound.scale.set(1, 0.6, 1);
      this.mounds.push(mound);
    }
    this.context = this.buildContext();
    this.neighborhood = this.buildNeighborhood();
    this.landmark = this.buildTwinTowers();
    this.eiffel = this.buildEiffel();
    this.ambientCars = this.buildAmbientCars();
    this.compactionPad = this.group();
    this.box(this.compactionPad, -.1, -.332, -2.55, 4.6, .055, 1.18, "soilLoad", .025);
    for (let z = -2.98; z < -2.05; z += .11) this.box(this.compactionPad, -.1, -.301, z, 4.35, .006, .023, "pad");
    this.mixer = this.makeTruck("mixer");
    this.pump = this.makeTruck("pump");
    this.pump.group.position.set(-3.0, 0, .45);
    this.pump.group.rotation.y = Math.PI / 2;
    this.excavator = this.makeExcavator();
    this.roller = this.makeRoller();
    this.traffic=[{distance:0,hold:0,served:-1,laps:0,active:false},{distance:0,hold:0,served:-1,laps:0,active:false}];
    this.dumper = this.makeTruck("dumper");
    this.deployments={pump:{},excavator:{},roller:{},mixer:{}};
    const paths=(a,b)=>({in:FleetMotion.route(a),out:FleetMotion.route(b)});
    this.deploymentRoutes={pump:paths([[-30,2.48],[6.7,2.48],[6.7,-1.2]],[[6.7,-1.2],[6.7,3.52],[-30,3.52]]),mixer:paths([[-30,2.48],[8,2.48],[8,4.8],[6.7,4.8],[6.7,1.1]],[[6.7,1.1],[6.7,3.52],[-30,3.52]]),excavator:paths([[-30,2.48],[4.3,2.48],[4.3,-.1],[2.65,-.1]],[[2.65,-.1],[4.3,-.1],[4.3,3.52],[-30,3.52]]),roller:paths([[-30,2.48],[7.75,2.48],[7.75,1.4],[4.3,1.4],[4.3,-2.55],[-.1,-2.55]],[[-.1,-2.55],[4.3,-2.55],[4.3,1.4],[7.75,1.4],[7.75,3.52],[-30,3.52]])};
    this.vehicleRegistry=new Map();
    this.survey=this.group();
    for(const a of[0,Math.PI*2/3,Math.PI*4/3])this.beam(this.survey,[.8+Math.cos(a)*.24,-.29,1.0+Math.sin(a)*.24],[.8,.4,1.0],.025,'yellow',6);
    this.box(this.survey,.8,.46,1,.18,.15,.16,'blue',.02);
    for(const x of[-1.7,1.7])for(const z of[-1.3,1.3])this.beam(this.survey,[x,-.3,z],[x,.05,z],.018,'wood',6);
  }
  labelBoard(text,w=3,h=.5,color='#032b91',background='#f2f6fc') {
    const cv=document.createElement('canvas');cv.width=1536;cv.height=256;const ctx=cv.getContext('2d');ctx.fillStyle=background;ctx.fillRect(0,0,1536,256);ctx.fillStyle=color;ctx.font='600 78px "BeVietnam",Arial,sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(text,768,135,1450);
    const texture=new THREE.CanvasTexture(cv);texture.colorSpace=THREE.SRGBColorSpace;this.resources.add(texture);const material=new THREE.MeshBasicMaterial({map:texture,side:THREE.DoubleSide});this.resources.add(material);const mesh=new THREE.Mesh(this.geometry('label-'+w+'-'+h,()=>new THREE.PlaneGeometry(w,h)),material);return mesh;
  }
  buildTwinTowers() {
    const g=this.group();this.material('towerSilver','#becbd5',{metalness:.7,roughness:.3});this.material('towerGlass','#6b9aaf',{metalness:.6,roughness:.22});this.material('towerDark','#6b7f8e',{metalness:.65,roughness:.33});
    const positions=[15.2,20.2],z=-15.2;
    this.box(g,17.7,-.24,z,11,.2,7,'pavement',.1);
    this.box(g,17.7,.15,z,9,.65,4.8,'towerGlass',.1);
    for(const x of positions){
      const body=this.group(g);body.position.set(x,.5,z);
      for(let level=0;level<44;level++){
        const y=level*.37,r=level<28?1.32:level<34?1.16:level<38?.96:level<41?.72:.5;
        const cylinder=new THREE.Mesh(this.geometry('twin-floor-'+r,()=>new THREE.CylinderGeometry(r,r,.32,16)),this.mat.get('towerGlass'));cylinder.position.y=y;cylinder.rotation.y=Math.PI/16;body.add(cylinder);
        const ring=new THREE.Mesh(this.geometry('twin-ring-'+r,()=>new THREE.CylinderGeometry(r+.05,r+.05,.046,16)),this.mat.get('towerSilver'));ring.position.y=y+.18;ring.rotation.y=Math.PI/16;body.add(ring);
      }
      for(let side=0;side<8;side++){const a=side*Math.PI/4;this.beam(body,[Math.cos(a)*1.34,0,Math.sin(a)*1.34],[Math.cos(a)*1.34,10.3,Math.sin(a)*1.34],.023,'towerSilver',6);}
      const spire=new THREE.Mesh(this.geometry('twin-spire',()=>new THREE.ConeGeometry(.38,2.1,12)),this.mat.get('towerSilver'));spire.position.y=17.2;body.add(spire);this.beam(body,[0,17.8,0],[0,19.2,0],.024,'chrome',8);
    }
    this.box(g,17.7,8.5,z,3.0,.48,.72,'towerGlass',.04);
    this.box(g,17.7,8.2,z,3.1,.08,.86,'towerSilver',.02);
    for(const side of[-1,1])this.beam(g,[positions[side<0?0:1],5.1,z],[17.7,8.18,z],.055,'towerSilver',8);
    for(let x=13;x<23;x+=1.4){this.sphere(g,x,.45,z+3.1,.34,'leaf');this.box(g,x,-.12,z+3.1,.65,.15,.65,'grass',.06);}
    const sign=this.labelBoard('PETRONAS · KUALA LUMPUR',6.0,.4);sign.position.set(17.7,.5,z+2.44);g.add(sign);
    this.landmarkBounds=[[12,-.4,-19],[23.5,20.5,-11]];return g;
  }
  buildAmbientCars() {
    const cars=[];
    for(let i=0;i<8;i++){const g=this.group();this.box(g,0,-.03,0,.92,.24,.43,i%3?'blue':'white',.07);this.box(g,-.03,.15,0,.48,.22,.38,'glass',.06);for(const x of[-.28,.28])for(const z of[-.23,.23]){const wheel=new THREE.Mesh(this.geometry('ambient-tire',()=>new THREE.TorusGeometry(.065,.024,6,10)),this.mat.get('rubber'));wheel.position.set(x,-.19,z);g.add(wheel);}cars.push({group:g,direction:i%2?1:-1,offset:Math.floor(i/2)*14});}return cars;
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
  buildEiffel() {
    const g=this.group();g.position.set(-16,0,-13);this.material('eiffelMetal','#8b7967',{metalness:.65,roughness:.42});
    this.box(g,0,-.26,0,9,.18,8,'pavement',.12);
    const levels=[[0,3.1],[4.3,1.75],[7.2,1.2],[11,.66],[15,.25],[17,.1]],rods=[];
    for(let i=0;i<levels.length-1;i++){const[y,r]=levels[i],[ny,nr]=levels[i+1];for(const sx of[-1,1])for(const sz of[-1,1])rods.push([[sx*r,y,sz*r],[sx*nr,ny,sz*nr]]);
      const slices=Math.ceil((ny-y)/.7);
      for(let j=0;j<slices;j++){const f=j/slices,n=(j+1)/slices,a=lerp(r,nr,f),b=lerp(r,nr,n),h=lerp(y,ny,f),nh=lerp(y,ny,n);for(const side of[-1,1]){rods.push([[-a,h,side*a],[b,nh,side*b]],[[a,h,side*a],[-b,nh,side*b]],[[side*a,h,-a],[side*b,nh,b]],[[side*a,h,a],[side*b,nh,-b]]);}}
    }
    this.batch(g,rods,'eiffelMetal',.027);
    for(const[y,r]of[[4.3,1.9],[7.2,1.35],[15,.42]])this.box(g,0,y,0,r*2,.18,r*2,'eiffelMetal',.025);
    this.beam(g,[0,17,0],[0,18.4,0],.035,'eiffelMetal',8);
    const sign=this.labelBoard('EIFFEL · PARIS',4,.4);sign.position.set(0,.2,3.9);g.add(sign);return g;
  }
  buildRoadNetwork() {
    const g=this.group();
    // Disjoint rectangles form a level union. No road slab overlaps another road slab.
    const slabs=[[-6.1,-3,2,44],[7.4,4.9875,3.8,2.025]];
    for(const z of[3,-5.1]) slabs.push([-18.55,z,22.9,1.95],[12.45,z,35.1,1.95]);
    this.roadSurfaces=[];
    for(const[x,z,w,d]of slabs){this.roadSurfaces.push(this.box(g,x,-.32,z,w,.045,d,"road",.008));}
    for(const z of[3,-5.1])for(let x=-28;x<30;x+=.85)if(x<-7.8||x>-4.4)this.box(g,x,-.293,z,.42,.006,.027,"mark");
    for(let z=-24;z<18;z+=.85)if((z<1.5||z>4.4)&&(z<-6.6||z>-3.6))this.box(g,-6.1,-.293,z,.027,.006,.42,"mark");
    for(const z of[2.06,3.94])this.box(g,12.45,-.293,z,35.0,.006,.023,"mark");
    for(const[z,direction]of[[2.55,1],[3.45,-1]])for(const x of[-3.9,2.6]){
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
    for(const radius of[40,58,78])for(let i=0;i<32;i++){const angle=i*Math.PI/16;addBlock(Math.cos(angle)*radius,Math.sin(angle)*radius,3+(i%3),3.8,4.5+(i%6)*1.1,true);}
    const tree=(x,z,scale=1)=>{this.beam(g,[x,-.3,z],[x,.85*scale,z],.065*scale,"bark",8);this.sphere(g,x,1.28*scale,z,.6*scale,"leaf");this.sphere(g,x+.3*scale,1.13*scale,z+.12*scale,.4*scale,"grass");};
    for(let ix=-3;ix<=3;ix++)for(let iz=-3;iz<=3;iz++){
      const x=ix*8.5+2,z=iz*8.5+1.2;
      const conflict=(x>-7.8&&x<11&&z>-7&&z<6)||(Math.abs(z-3)<4.3)||(Math.abs(z+5.1)<4.3)||(Math.abs(x+6.1)<4.3)||(Math.abs(x-17.7)<9&&Math.abs(z+15.2)<7)||(Math.abs(x+16)<6&&Math.abs(z+13)<6)||buildings.some(b=>Math.abs(x-b.x)<b.w/2+3.2&&Math.abs(z-b.z)<b.d/2+3.2);
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
    // Hoarding leaves the front haul road open; stored materials stay off vehicle paths.
    for(const x of[-3.91,8.45]){this.box(setup,x,.03,-1.0,.045,.76,5.8,"blue",.01);for(let z=-3.8;z<2;z+=.6)this.box(setup,x,.06,z,.07,.86,.07,"chrome");}
    this.box(setup, 2.25, .03, -3.88, 12.4, .76, .045, "blue", .01);
    for (let x=-3.8; x<8.5; x+=.62) this.box(setup,x,.06,-3.89,.07,.86,.07,"chrome");
    for (const x of [-3.91,8.45]) {
      this.box(setup,x,.26,1.35,.13,1.25,.13,"white",.02);
      this.box(setup,x,.87,1.35,.26,.08,.25,"blue",.02);
    }
    this.box(setup,-3.0,-.31,.45,1.8,.04,2.1,"concrete",.025);
    for(const z of[-.55,1.45]) for(const x of[-3.75,-2.25]) {
      this.box(setup,x,-.245,z,.13,.12,.13,"yellow",.02);
    }
    // Material storage on the left, separated from excavation and the compaction strip.
    for (let i=0;i<5;i++) this.beam(setup,[-3.48,-.2+i*.06,-2.8],[-3.48,-.2+i*.06,-1.5],.035,"steel",8);
    for (let i=0;i<3;i++) this.box(setup,-3.25,-.26+i*.09,-1.05,.4,.075,.4,"wood",.012);
    for(const z of[-1.2,-.8,-.4])this.box(setup,5.35,-.24,z,.5,.18,.26,"concrete",.025);
    // Stored materials occupy the enlarged work yard; landscape stays beyond its boundary.
    for(let level=0;level<3;level++)for(let x=0;x<4;x++)for(let z=0;z<2;z++)this.box(setup,4.9+x*.24,-.23+level*.12,.25+z*.23,.22,.1,.21,"wood",.01);
    for(let i=0;i<7;i++)this.beam(setup,[5.1,-.16+i*.035,-2.0],[6.1,-.16+i*.035,-2.0],.022,'steel',8);
    for(let i=0;i<5;i++)this.box(setup,5.35,-.2+i*.055,-.8,.8,.04,.6,'wood',.014);
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
  makeTruck(kind) {
    const group = this.group(),
      wheels = [];
    this.box(group, 0, -0.11, 0, 1.95, 0.15, 0.62, "blue", 0.025);
    this.box(group, 0.65, 0.17, 0, 0.61, 0.53, 0.68, "white", 0.065);
    this.box(group, 0.95, 0.23, 0, 0.02, 0.25, 0.53, "glass", 0.012);
    for (const z of [-0.347, 0.347]) {
      this.box(group, 0.63, 0.25, z, 0.35, 0.23, 0.012, "glass", 0.008);
      this.box(group, 0.65, 0.035, z, 0.5, 0.07, 0.014, "blue");
    }
    for (const x of [-0.65, -0.22, 0.68])
      for (const z of [-0.36, 0.36]) {
        const wheel = this.group(group);
        wheel.position.set(x, -0.15, z);
        const tire = new THREE.Mesh(
          this.geometry(
            "tire",
            () => new THREE.TorusGeometry(0.123, 0.045, 8, 16),
          ),
          this.mat.get("rubber"),
        );
        wheel.add(tire);
        const hub = new THREE.Mesh(
          this.geometry(
            "hub",
            () => new THREE.CylinderGeometry(0.075, 0.075, 0.035, 12),
          ),
          this.mat.get("chrome"),
        );
        hub.rotation.x = Math.PI / 2;
        wheel.add(hub);
        wheels.push(wheel);
      }
    for (const z of [-0.23, 0.23])
      this.box(group, 0.973, 0.02, z, 0.014, 0.055, 0.1, "mark", 0.008);
    const item = { group, wheels, kind };
    group.position.z = 2.55;
    if (kind === "mixer") {
      this.box(group, -0.27, 0.03, 0, 1.22, 0.1, 0.56, "blue");
      const pivot = this.group(group);
      pivot.position.set(-0.29, 0.43, 0);
      pivot.rotation.z = -Math.PI / 2 + 0.12;
      const profile = [
        new THREE.Vector2(0.12, -0.56),
        new THREE.Vector2(0.31, -0.4),
        new THREE.Vector2(0.34, 0.1),
        new THREE.Vector2(0.16, 0.4),
      ];
      const cv = document.createElement("canvas");
      cv.width = cv.height = 128;
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "#f0f4f6";
      ctx.fillRect(0, 0, 128, 128);
      ctx.fillStyle = "#2359a4";
      for (let i = -128; i < 256; i += 52) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i + 22, 0);
        ctx.lineTo(i + 92, 128);
        ctx.lineTo(i + 70, 128);
        ctx.fill();
      }
      const texture = new THREE.CanvasTexture(cv);
      texture.colorSpace = THREE.SRGBColorSpace;
      this.resources.add(texture);
      const material = new THREE.MeshStandardMaterial({
        map: texture,
        metalness: 0.3,
        roughness: 0.32,
      });
      this.resources.add(material);
      const drum = new THREE.Mesh(
        this.geometry("drum", () => new THREE.LatheGeometry(profile, 24)),
        material,
      );
      drum.castShadow = true;
      drum.receiveShadow = true;
      pivot.add(drum);
      const cap=new THREE.Mesh(this.geometry('drum-front-cap',()=>new THREE.CylinderGeometry(.16,.16,.012,24)),this.mat.get('white'));cap.position.y=.4;drum.add(cap);
      const rear=new THREE.Mesh(this.geometry('drum-rear-mouth',()=>new THREE.CylinderGeometry(.115,.115,.018,20)),this.mat.get('steel'));rear.position.y=-.557;drum.add(rear);
      item.drum = drum;
      item.chute = this.beam(group, [-0.86, 0.32, 0], [-1.13, -0.02, 0.3], 0.045, "chrome");
      item.feed=this.beam(group,[0,0,0],[0,.1,0],.025,'concrete',6);item.feed.visible=false;
    }
    if (kind === "dumper") {
      const bed = this.group(group);
      bed.position.set(-0.9, 0.02, 0);
      this.box(bed, 0.53, 0.04, 0, 1.1, 0.08, 0.7, "yellow", 0.025);
      for (const z of [-0.35, 0.35])
        this.box(bed, 0.53, 0.22, z, 1.1, 0.35, 0.04, "yellow", 0.018);
      this.box(bed, 1.08, 0.22, 0, 0.04, 0.35, 0.7, "yellow");
      this.box(bed, 0.53, 0.2, 0, 1.0, 0.14, 0.61, "soilLoad", 0.05);
      item.bed = bed;
    }
    if (kind === "pump") {
      this.box(group, -0.4, 0.16, 0, 0.95, 0.4, 0.56, "blue", 0.04);
      this.box(group,-.9,-.02,0,.35,.13,.42,'steel',.025);this.box(group,-.9,.052,0,.28,.014,.35,'concrete',.01);
      item.outriggers=[];for (const x of [-0.65, 0.35])
        item.outriggers.push(this.box(group, x, -0.23, 0, 0.055, 0.15, 1.55, "chrome"));
      item.booms = Array.from({ length: 3 }, () =>
        this.beam(group, [0, 0, 0], [0, 1, 0], 0.045, "white", 8),
      );
      item.hose = this.beam(group, [0, 0, 0], [0, 0.3, 0], 0.022, "rubber");
      item.stream = this.beam(
        group,
        [0, 0, 0],
        [0, 0.2, 0],
        0.017,
        "concrete",
        6,
      );
    }
    return item;
  }
  makeExcavator() {
    const g = this.group();
    g.position.set(2.65, 0, -0.1);
    for (const z of [-0.38, 0.38]) {
      this.box(g, 0, -0.23, z, 1.1, 0.23, 0.23, "rubber", 0.09);
      for (let x = -0.38; x < 0.5; x += 0.23) {
        const m = new THREE.Mesh(
          this.geometry(
            "trackwheel",
            () => new THREE.CylinderGeometry(0.075, 0.075, 0.245, 10),
          ),
          this.mat.get("chrome"),
        );
        m.rotation.x = Math.PI / 2;
        m.position.set(x, -0.23, z);
        g.add(m);
      }
    }
    this.box(g, 0, 0.04, 0, 0.9, 0.3, 0.63, "yellow", 0.06);
    this.box(g, -0.18, 0.4, 0, 0.42, 0.45, 0.5, "white", 0.06);
    for (const z of [-0.255, 0.255])
      this.box(g, -0.18, 0.43, z, 0.34, 0.28, 0.01, "glass");
    const upper = this.beam(this.root, [0, 0, 0], [0, 1, 0], 0.075, "yellow"),
      lower = this.beam(this.root, [0, 0, 0], [0, 1, 0], 0.06, "yellow"),
      bucket = this.group();
    this.box(bucket, 0, 0, 0, 0.32, 0.18, 0.29, "steel", 0.045);
    for (const x of [-0.12, 0, 0.12])
      this.box(bucket, x, -0.11, 0.15, 0.045, 0.12, 0.1, "chrome");
    return { group: g, upper, lower, bucket };
  }
  makeRoller() {
    const group = this.group();
    this.box(group, 0, 0.05, 0, 1.0, 0.3, 0.62, "yellow", 0.04);
    const drumPivot = this.group(group);
    drumPivot.position.set(0.5, -0.1, 0);
    const drum = new THREE.Mesh(
      this.geometry(
        "roller",
        () => new THREE.CylinderGeometry(0.28, 0.28, 0.85, 24),
      ),
      this.mat.get("chrome"),
    );
    drum.rotation.x = Math.PI / 2;
    drum.castShadow = true;
    drumPivot.add(drum);
    for (const z of [-0.35, 0.35]) {
      const tire = new THREE.Mesh(
        this.geometry(
          "rollertire",
          () => new THREE.TorusGeometry(0.14, 0.05, 8, 16),
        ),
        this.mat.get("rubber"),
      );
      tire.position.set(-0.44, -0.14, z);
      group.add(tire);
    }
    for (const x of [-0.4, 0.05])
      for (const z of [-0.28, 0.28])
        this.box(group, x, 0.48, z, 0.025, 0.59, 0.025, "steel");
    this.box(group, -0.17, 0.79, 0, 0.73, 0.06, 0.72, "yellow", 0.025);
    this.box(group, -0.24, 0.33, 0, 0.16, 0.2, 0.22, "rubber", 0.02);
    this.sphere(group, -0.24, 0.53, 0, 0.07, "wood");
    this.sphere(group, -0.24, 0.59, 0, 0.075, "yellow");
    return { group, drum: drumPivot };
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
    const bookmark=this.focusFloor&&this.detailMode==='auto'?{target:[0,floorY+.7,0],direction:[1.1,.9,1.3],bounds:[[-2.4,floorY-.4,-2],[3.8,floorY+2.0,2]]}:this.viewMode==='landmark'?{target:[17.7,8,-15.2],direction:[1,.5,1.6],bounds:this.landmarkBounds}:this.viewMode==='overview'?{target:[7,3,-5],direction:[1,1.1,1.4],bounds:[[-7,-.4,-19],[25,TOWER_HEIGHT+1,7]]}:null;
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
  trafficLoop(distance){const straight=44,r=.52,arc=Math.PI*r,length=straight*2+arc*2;let d=((distance%length)+length)%length;if(d<straight)return{x:-22+d,z:2.48,yaw:0,lane:'in'};d-=straight;if(d<arc){const a=d/r;return{x:22+r*Math.sin(a),z:3-r*Math.cos(a),yaw:-a,lane:'turn'};}d-=arc;if(d<straight)return{x:22-d,z:3.52,yaw:-Math.PI,lane:'out'};d-=straight;const a=Math.PI+d/r;return{x:-22+r*Math.sin(a),z:3-r*Math.cos(a),yaw:-a,lane:'turn'};}
  reserveVehicle(key,pose,size,dt,heading=pose.yaw){const old=this.vehicleRegistry.get(key);pose.yaw=this.reduced||!old?.visible?heading:FleetMotion.turnAngle(old.yaw,heading,WebGLConstructionScene.paused?0:dt);return FleetMotion.reserve(this.vehicleRegistry,key,pose,size);}
  updateTraffic(dt,wanted,supplyRequired=false,pumpReady=true){const length=88+Math.PI*1.04;for(let i=1;i<this.traffic.length;i++){const state=this.traffic[i],before={...state},other=this.traffic[1-i],service=i===0?20.4:24;if(!state.active&&wanted[i]&&(i!==0||pumpReady)&&(!other.active||other.distance>3)){state.active=true;state.distance=0;state.served=-1;}if(!state.active){state.pose={...this.trafficLoop(0),visible:false,parked:false};FleetMotion.reserve(this.vehicleRegistry,'truck'+i,state.pose,{length:2.15,width:.84});continue;}const headway=length;const clockDelta=this.reduced||WebGLConstructionScene.paused?0:dt;let step=clockDelta*2.4;const toService=(service-state.distance+length)%length;
    if(this.reduced){state.distance=wanted[i]?service:0;state.active=!!wanted[i];}
    if(wanted[i]&&(i!==0||pumpReady)&&state.served!==state.laps&&toService<step+.03){state.distance=service;step=0;if(i===0&&supplyRequired)state.hold=0;else state.hold+=clockDelta;if(state.hold>=7){state.served=state.laps;state.hold=0;}}
    else if(!wanted[i])state.hold=0;
    step=Math.min(step,Math.max(0,headway-3.0));const next=state.distance+step;if(next>=length)state.laps++;state.distance=next%length;if(!wanted[i]&&state.distance>40&&state.distance<44){state.active=false;state.distance=0;}const pose={...this.trafficLoop(state.distance),visible:state.active,parked:Math.abs(state.distance-service)<.03&&wanted[i]&&state.served!==state.laps};if(this.reserveVehicle('truck'+i,pose,{length:2.15,width:.84},dt))state.pose=pose;else{Object.assign(state,before);state.pose={...(before.pose||this.trafficLoop(before.distance)),visible:!!before.active,waiting:true};}}
    return this.traffic.map(s=>s.pose||this.trafficLoop(s.distance));}
  trafficPose(t, period = 32, park = -1.6) {
    const q=((t%period)+period)%period/period,s=u=>u*u*(3-2*u);
    if(q<.18)return {x:lerp(-7,park,s(q/.18)),z:2.55,yaw:0,parked:false,lane:'in'};
    if(q<.58)return {x:park,z:2.55,yaw:0,parked:true,lane:'in'};
    if(q<.72)return {x:lerp(park,4.4,s((q-.58)/.14)),z:2.55,yaw:0,parked:false,lane:'in'};
    if(q<.8){const a=(q-.72)/.08*Math.PI;return {x:4.4+.45*Math.sin(a),z:3-.45*Math.cos(a),yaw:-a,parked:false,lane:'turn'};}
    return {x:lerp(4.4,-7,s((q-.8)/.2)),z:3.45,yaw:-Math.PI,parked:false,lane:'out'};
  }
  truckPosition(t,period=32,park=-1.6){return this.trafficPose(t,period,park).x;}
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
    for(const [i,car]of this.ambientCars.entries()){const length=116+Math.PI*.96,next=((car.distance??i*14)+(this.reduced||WebGLConstructionScene.paused?0:dt*.75))%length,r=.48,arc=Math.PI*r;let d=next,pose;if(d<58)pose={x:-29+d,z:-5.58,yaw:0};else if((d-=58)<arc){const a=d/r;pose={x:29+r*Math.sin(a),z:-5.1-r*Math.cos(a),yaw:-a};}else if((d-=arc)<58)pose={x:29-d,z:-4.62,yaw:-Math.PI};else{const a=Math.PI+(d-58)/r;pose={x:-29+r*Math.sin(a),z:-5.1-r*Math.cos(a),yaw:-a};}pose.visible=this.inspect<.5;if(this.reserveVehicle('street'+i,pose,{length:1.05,width:.58},dt)){car.distance=next;car.group.position.set(pose.x,0,pose.z);car.group.rotation.y=pose.yaw;car.group.visible=pose.visible;}}
    this.landmark.visible=this.inspect<.5;this.eiffel.visible=this.inspect<.5;
    const dig = clamp((p - 0.18) / 0.06, 0, 1),
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
    this.blinding.forEach(mesh => { mesh.visible = p >= .26; });
    this.foundationForms.visible=p>=.28&&p<.319;
    const fp = clamp((p - 0.285) / 0.025, 0, 1);
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
      const col = clamp((q - 0.26) / 0.3, 0, 1);
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
      const fill = clamp((q - 0.72) / 0.22, 0, 1),
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

    const active = window.ConstructionEquipment.plan(p),
      machinesVisible = this.inspect < 0.3;
    this.mounds.forEach((m) => {
      const amount = dig * (1 - backfill);
      m.visible = amount > 0.01 && machinesVisible;
      m.scale.set(1, 0.65 * amount, 1);
    });
    const currentPourQ=structure*FLOOR_COUNT-Math.floor(structure*FLOOR_COUNT),supplyRequired=p<.4?(p>=.285&&p<.32):p<.72&&((currentPourQ>=.26&&currentPourQ<.56)||(currentPourQ>=.72&&currentPourQ<.94));
    const poses=this.updateTraffic(dt,[false,active.dumpTruck]),mixerReady=this.reduced||this.deployments.pump.phase==='work';
    const mixerPose=FleetMotion.deploy(this.deployments.mixer,this.deploymentRoutes.mixer,active.mixer&&mixerReady,dt,{reduced:this.reduced,paused:WebGLConstructionScene.paused,speed:2.4,accept:pose=>this.reserveVehicle('truck0',pose,{length:2.15,width:.84},dt,pose.parked||pose.phase==='enter'&&Math.abs(pose.x-6.7)<.01&&pose.z<=4.8?-Math.PI/2:pose.yaw)});
    this.traffic[0].pose=mixerPose;this.traffic[0].active=mixerPose.visible;
    const mixerX=mixerPose.x;
    this.mixer.group.visible=machinesVisible&&mixerPose.visible;
    this.mixer.group.position.set(mixerX,0,mixerPose.z);
    this.mixer.group.rotation.y=mixerPose.yaw;
    if (this.mixer.drum) this.mixer.drum.rotation.y = t * 0.85;
    for (const wh of this.mixer.wheels) wh.rotation.z = -mixerX / 0.16;
    const dumpPose=poses[1], dumpX=dumpPose.x;
    this.dumper.group.visible=machinesVisible&&dumpPose.visible;
    this.dumper.group.position.set(dumpX,0,dumpPose.z);
    this.dumper.group.rotation.y=dumpPose.yaw;
    this.dumper.bed.rotation.z = dumpPose.parked&&active.dumpTruck?Math.max(0, Math.sin(t * 0.4)) * 0.25:0;
    for (const wh of this.dumper.wheels) wh.rotation.z = -dumpX / 0.16;
    const deploymentOptions={reduced:this.reduced,paused:WebGLConstructionScene.paused},pumpWanted=(p>=.28&&p<.32)||(p>=.4&&p<.72),pumpPose=FleetMotion.deploy(this.deployments.pump,this.deploymentRoutes.pump,pumpWanted||(this.pumpExtension||0)>.02,dt,{...deploymentOptions,accept:pose=>this.reserveVehicle('pump',pose,{length:2.15,width:pose.parked?1.7:.84},dt,pose.parked||pose.phase==='exit'&&pose.z<3.5?Math.PI/2:pose.yaw)});
    this.pumpExtension=lerp(this.pumpExtension||0,pumpWanted&&pumpPose.parked?1:0,this.reduced?1:1-Math.exp(-3*dt));
    for(const leg of this.pump.outriggers)leg.scale.z=lerp(.36,1,this.pumpExtension);
    this.pump.group.visible=machinesVisible&&pumpPose.visible;
    this.pump.group.position.set(pumpPose.x,0,pumpPose.z);this.pump.group.rotation.y=pumpPose.yaw;
    const pourQ=structure*FLOOR_COUNT-Math.floor(structure*FLOOR_COUNT),pourStage=p<.4?(p>=.285&&p<.32):((pourQ>=.26&&pourQ<.56)||(pourQ>=.72&&pourQ<.94));
    let pouring = false;
    this.mixer.feed.visible=false;
    if (this.pump.group.visible) {
      const pourFloor=Math.min(FLOOR_COUNT-1,Math.floor(structure*FLOOR_COUNT)),columnIndex=Math.floor(t/5)%6;
      let targetX=pourQ>=.72?(pourQ<.83?-.7:.7):[-1.6,0,1.6][Math.floor(columnIndex/2)],targetZ=pourQ>=.72?.2:[-1.2,1.2][columnIndex%2];
      let level=pourFloor*FLOOR_HEIGHT+(pourQ>=.72?1.065:Math.max(.05,clamp((pourQ-.26)/.3,0,1)));
      if(p<.4){const foot=this.footings[Math.min(8,Math.floor(fp*9))];targetX=foot.f.position.x;targetZ=foot.f.position.z;level=foot.ped.position.y+.55*foot.ped.scale.y;}
      this.pump.group.updateMatrixWorld(true);
      const local = point => this.pump.group.worldToLocal(new V(...point)).toArray();
      const folded=[[-.4,.4,0],[.1,.55,0],[-.5,.65,0],[.1,.75,0]],extended=[[-.4,.4,0],local([6.3,level+1.85,-1.1]),local([2.6,level+1.5,.2]),local([targetX,level+.55,targetZ])],points=folded.map((point,i)=>point.map((v,j)=>lerp(v,extended[i][j],this.pumpExtension)));
      this.pump.booms.forEach((mesh,i)=>this.placeBeam(mesh,points[i],points[i+1]));
      const hoseEnd=local([targetX,level+.3,targetZ]).map((v,j)=>lerp([.1,.45,0][j],v,this.pumpExtension));this.placeBeam(this.pump.hose,points[3],hoseEnd);
      this.placeBeam(this.pump.stream,local([targetX,level+.28,targetZ]),local([targetX,level+.02,targetZ]));
      pouring=active.pump&&pumpWanted&&this.pumpExtension>.98&&pumpPose.parked&&mixerPose.parked&&pourStage;
      this.pump.stream.visible=pouring;
      if(this.mixer.chute){
        this.mixer.group.updateMatrixWorld(true);
        const end=this.mixer.group.worldToLocal(new V(6.7,.05,-.3)).toArray();
        this.placeBeam(this.mixer.chute,[-.86,.32,0],pouring?end:[-1.13,.16,0]);
        this.mixer.feed.visible=pouring;if(pouring)this.placeBeam(this.mixer.feed,end,this.mixer.group.worldToLocal(new V(6.7,-.02,-.3)).toArray());
      }
    }

    const plantWanted={excavator:p>=.18&&p<.265,roller:p>=.32&&p<.4};
    if(this.plantGateOwner){const state=this.deployments[this.plantGateOwner];if(!state.phase||state.phase==='idle'||state.phase==='work')this.plantGateOwner=null;}
    if(!this.plantGateOwner)this.plantGateOwner=['excavator','roller'].find(key=>this.deployments[key].phase==='exit'||this.deployments[key].phase==='enter'||this.deployments[key].phase==='work'&&!plantWanted[key])||['excavator','roller'].find(key=>plantWanted[key]&&this.deployments[key].phase!=='work')||null;
    const rollerWanted=plantWanted.roller;
    const oldRollerOffset=this.rollerOffset||0;this.rollerOffset=lerp(oldRollerOffset,rollerWanted&&active.roller&&this.deployments.roller.phase==='work'?Math.sin(t*.42)*1.2:0,this.reduced?1:1-Math.exp(-3*dt));
    const rollerPose=FleetMotion.deploy(this.deployments.roller,this.deploymentRoutes.roller,rollerWanted||Math.abs(this.rollerOffset)>.02,dt,{...deploymentOptions,paused:deploymentOptions.paused||!!this.plantGateOwner&&this.plantGateOwner!=='roller',accept:pose=>{const candidate={...pose,x:pose.x+(pose.parked?this.rollerOffset:0)},ok=this.reserveVehicle('roller',candidate,{length:1.6,width:.82},dt,pose.parked?0:pose.yaw);pose.yaw=candidate.yaw;return ok;}});if(rollerPose.waiting)this.rollerOffset=oldRollerOffset;
    this.roller.group.visible=machinesVisible&&rollerPose.visible;
    this.roller.group.position.set(rollerPose.parked?this.rollerOffset-.1:rollerPose.x,0,rollerPose.z);
    this.roller.group.rotation.y=rollerPose.yaw;
    this.roller.drum.rotation.z = -this.roller.group.position.x / 0.28;
    const ex = this.excavator;
    const excavatorPose=FleetMotion.deploy(this.deployments.excavator,this.deploymentRoutes.excavator,plantWanted.excavator||(this.excavatorWork||0)>.02,dt,{...deploymentOptions,paused:deploymentOptions.paused||!!this.plantGateOwner&&this.plantGateOwner!=='excavator',accept:pose=>this.reserveVehicle('excavator',pose,{length:1.35,width:1.1},dt,pose.parked?0:pose.yaw)});
    for (const object of [ex.group, ex.upper, ex.lower, ex.bucket])object.visible=machinesVisible&&excavatorPose.visible;
    ex.group.position.set(excavatorPose.x,0,excavatorPose.z);
    ex.group.rotation.y=excavatorPose.yaw;
    if (ex.group.visible) {
      this.excavatorWork=lerp(this.excavatorWork||0,plantWanted.excavator&&excavatorPose.parked?1:0,this.reduced?1:1-Math.exp(-4*dt));
      const u = (Math.sin(t * 0.65) + 1) / 2,w=this.excavatorWork,
        tip = [lerp(2.9,1.05+u*.85,w),lerp(.6,-.85+u*1.75,w),lerp(-.1,.12+u*2.43,w)],
        elbow = [lerp(2.75,2.15,w),1.3,lerp(-.1,.15+u*.9,w)];
      const offset=point=>{const x=point[0]-2.65,z=point[2]+.1,a=ex.group.rotation.y;return [excavatorPose.x+x*Math.cos(a)+z*Math.sin(a),point[1],excavatorPose.z-x*Math.sin(a)+z*Math.cos(a)];};
      this.placeBeam(ex.upper, offset([2.62, 0.35, -0.1]), offset(elbow));
      this.placeBeam(ex.lower, offset(elbow), offset(tip));
      ex.bucket.position.fromArray(offset(tip));
      ex.bucket.rotation.x = -0.3 + u * 0.7;
    }
    this.lastScene = {
      renderer: "webgl",
      floorCount:FLOOR_COUNT,
      landmark:!!this.landmark,
      contextBuildings:this.contextBuildings,
      crane:this.craneState,
      eiffel:!!this.eiffel,
      roadDatum:-.2975,
      progress: p,
      targetProgress: targetP,
      phase: WebGLConstructionScene.phaseAt(targetP),
      pitDepth: 0.85 * dig * (1 - backfill),
      backfill,
      rollerSurface: "compacted-fill",
      earthwork: window.ConstructionEquipment.earthwork(p),
      inspection: this.detailMode !== "auto",
      machines: { ...active, pouring, mixerX, mixerLaneZ:mixerPose.z, mixerLane:mixerPose.lane, pumpPosition:[6.7,-1.2] },
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
