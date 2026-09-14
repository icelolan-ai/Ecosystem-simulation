/**
 * ฉาก 3 มิติของเทอราเรียม (Three.js)
 *
 * โมดูลนี้ทำหน้าที่ "วาด" สถานะจากซิมูเลชันเท่านั้น ไม่มีตรรกะของระบบนิเวศอยู่ในนี้
 * สิ่งมีชีวิตทุกชนิดวาดด้วย InstancedMesh เพื่อให้รองรับหลายร้อยตัวใน draw call เดียว
 */
import * as THREE from './vendor/three.module.min.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { mergeGeometries } from './vendor/BufferGeometryUtils.js';
import { RoomEnvironment } from './vendor/RoomEnvironment.js';
import { WORLD, WORLD_AREA, CAPS, HERBIVORE, PREDATOR, SECONDS_PER_DAY } from './config.js';
import { makeRng } from './rng.js';

const SKY_HEIGHT = 12;
const OBJ = new THREE.Object3D();
const COL = new THREE.Color();

/** โทนสีอบอุ่นแบบ miniature diorama */
const PALETTE = {
  soil: 0x9c6842,
  soilDeep: 0x5c3b29,
  soilDamp: 0x6d4630,
  sand: 0xb08a5e,
  base: 0x6f4626,
  baseRim: 0x8a5a30,
  water: 0x3f9fb8,
  rock: 0x9c8877,
  leaf: 0x7fb069,
  leafDeep: 0x4f7a46,
  stem: 0x6d8a45,
  bud: 0xe8b44a,
  herbBody: 0xe8bd72,
  herbBelly: 0xf7e6c4,
  herbEar: 0xc08348,
  herbLeg: 0x8f5a33,
  predBody: 0xd9643a,
  predBelly: 0xeda876,
  predEar: 0x8f3a1e,
  predLeg: 0x8a3f22,
  eye: 0x241610,
  bark: 0x6b4a33,
  barkLight: 0x86603f,
  canopy: 0x4f7a46,
  canopyLit: 0x7ba659,
  canopyDeep: 0x3a5e36,
  fungusCap: 0xc9a0dc,
  fungusCapPale: 0xe3cdf0,
  fungusStem: 0xf0e4d4,
  fungusGill: 0x9b7bb0,
};

/** ใส่ vertex color ให้ geometry หนึ่งชิ้น (ใช้ก่อนรวมชิ้นส่วนเป็นตัวเดียว) */
function tint(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function part(geo, hex, { pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1] } = {}) {
  geo.scale(scale[0], scale[1], scale[2]);
  geo.rotateX(rot[0]); geo.rotateY(rot[1]); geo.rotateZ(rot[2]);
  geo.translate(pos[0], pos[1], pos[2]);
  return tint(geo, hex);
}

/** value noise แบบง่าย (seeded) ใช้ปั้นผิวดินให้ไม่เรียบเป็นกระดาน */
function makeNoise(seed) {
  const rng = makeRng(seed);
  const size = 64;
  const grid = new Float32Array(size * size);
  for (let i = 0; i < grid.length; i++) grid[i] = rng();
  const at = (i, j) => grid[((j % size) + size) % size * size + ((i % size) + size) % size];
  const smooth = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = smooth(x - xi), yf = smooth(y - yi);
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return (a * (1 - xf) + b * xf) * (1 - yf) + (c * (1 - xf) + d * xf) * yf;
  };
}

export class Terrarium {
  constructor(canvas) {
    this.canvas = canvas;
    this.noise = makeNoise(7717);
    this.clock = new THREE.Clock();
    this.selected = null;
    this.targetPoint = null;
    this.raining = false;

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: true, powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.16;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x2b1b12, 0.0032);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
    this.camera.position.set(18.5, 15, 27);
    this.userMovedCamera = false;

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.target.set(0, 3.0, 0);
    this.controls.minDistance = 2.5;
    this.controls.maxDistance = 140;
    this.controls.minPolarAngle = 0.25;
    this.controls.maxPolarAngle = 1.48;
    this.controls.rotateSpeed = 0.75;
    this.controls.addEventListener('start', () => { this.userMovedCamera = true; });
    this.controls.update();

    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Line.threshold = 0.2;

    this._buildEnvironment();
    this._buildLights();
    this._buildBackdrop();
    this._buildTerrain();
    this._buildDecor();
    this._buildEdge();
    this._buildCreatures();
    this._buildSelection();
    this._buildWeather();

    this.resize();
  }

  /**
   * environment map สำหรับวัสดุสะท้อนแสง (แก้วและผิวน้ำ)
   * ถ้าไม่มีตัวนี้ ผิวเรียบมันจะดำสนิทเพราะไม่มีอะไรให้สะท้อน
   */
  _buildEnvironment() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04);
    this.scene.environment = env.texture;
    this.scene.environmentIntensity = 0.3;
    pmrem.dispose();
  }

  // ------------------------------------------------------------------ lights

  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0xffe8c8, 0x6b4327, 0.95);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xffd9a5, 2.1);
    this.sun.position.set(11, 16, 7);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1536, 1536);
    this.sun.shadow.camera.near = 4;
    this.sun.shadow.camera.far = 46;
    const s = WORLD.radius + 3;
    Object.assign(this.sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0016;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // ไฟเสริมโทนอุ่นจากอีกฝั่ง ให้เงาไม่ทึบจนเกินไป
    this.fill = new THREE.PointLight(0xffa759, 55, 34, 2);
    this.fill.position.set(-8, 7, -6);
    this.scene.add(this.fill);

    this.ambient = new THREE.AmbientLight(0xffd8ac, 0.4);
    this.scene.add(this.ambient);
  }

  /** ฉากหลังไล่สีอุ่น ช่วยให้แก้วมีอะไรให้หักเห */
  _buildBackdrop() {
    const geo = new THREE.SphereGeometry(70, 32, 24);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x6b452a) },
        bottom: { value: new THREE.Color(0x170f0a) },
        glow: { value: new THREE.Color(0x9c5f2c) },
      },
      vertexShader: `
        varying vec3 vPos;
        void main() {
          vPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 top; uniform vec3 bottom; uniform vec3 glow;
        varying vec3 vPos;
        void main() {
          float h = normalize(vPos).y * 0.5 + 0.5;
          vec3 c = mix(bottom, top, smoothstep(0.18, 0.85, h));
          float halo = pow(max(0.0, 1.0 - abs(h - 0.40) * 2.6), 2.0);
          c += glow * halo * 0.42;
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.scene.add(new THREE.Mesh(geo, mat));
  }

  // ----------------------------------------------------------------- terrain

  /** ความลึกของแอ่งน้ำที่ระยะ pd จากจุดกลางแอ่ง */
  _bowl(pd) {
    const r = WORLD.poolRadius + 0.7;
    if (pd >= r) return 0;
    const t = pd / r;
    return -WORLD.poolDepth * Math.pow(1 - t * t, 1.4);
  }

  /** ความสูงผิวดินที่พิกัดหนึ่ง (ใช้วางสิ่งมีชีวิตให้ติดพื้น) */
  groundHeight(x, z) {
    const pd = Math.hypot(x - WORLD.poolCenter.x, z - WORLD.poolCenter.z);
    const bowl = this._bowl(pd);
    const flat = Math.min(1, Math.max(0, (pd - (WORLD.poolRadius + 0.75)) / 1.5));
    const n = this.noise(x * 0.32 + 12, z * 0.32 + 5) * 0.62 + this.noise(x * 0.95, z * 0.95) * 0.28;
    const bump = (n - 0.45) * 0.62;
    const edge = Math.min(1, Math.max(0, (WORLD.radius - Math.hypot(x, z)) / 1.2));
    return bowl + bump * Math.max(0, flat) * edge;
  }

  _buildTerrain() {
    const R = WORLD.radius;
    const seg = Math.min(150, Math.round((R * 2) / 0.42));
    const geo = new THREE.PlaneGeometry(R * 2, R * 2, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const base = new THREE.Color(PALETTE.soil);
    const damp = new THREE.Color(PALETTE.soilDamp);
    const sand = new THREE.Color(PALETTE.sand);

    for (let i = 0; i < pos.count; i++) {
      let x = pos.getX(i), z = pos.getZ(i);
      // บีบมุมสี่เหลี่ยมเข้าหาขอบวงกลม ให้ผิวดินเป็นวงกลมพอดีภาชนะ
      const r = Math.hypot(x, z);
      if (r > R) { x = (x / r) * R; z = (z / r) * R; pos.setX(i, x); pos.setZ(i, z); }
      const y = this.groundHeight(x, z);
      pos.setY(i, y);

      const pd = Math.hypot(x - WORLD.poolCenter.x, z - WORLD.poolCenter.z);
      const grain = this.noise(x * 1.8 + 40, z * 1.8) * 0.22 + 0.88;
      COL.copy(base);
      COL.lerp(damp, Math.max(0, 1 - pd / (WORLD.poolRadius + 2.2)) * 0.8);
      COL.lerp(sand, Math.max(0, 1 - Math.abs(pd - WORLD.poolRadius - 0.5) / 1.1) * 0.35);
      COL.multiplyScalar(grain);
      colors[i * 3] = COL.r; colors[i * 3 + 1] = COL.g; colors[i * 3 + 2] = COL.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    this.soilBaseColors = colors.slice();
    this.soil = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.97, metalness: 0,
    }));
    this.soil.receiveShadow = true;
    this.soil.name = 'soil';
    this.scene.add(this.soil);

    // ตัวถังดินด้านล่าง (ให้เห็นชั้นดินจากด้านข้างผ่านแก้ว)
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(R, R * 0.99, 2.6, 72, 1, true),
      new THREE.MeshStandardMaterial({ color: PALETTE.soilDeep, roughness: 1, side: THREE.DoubleSide }),
    );
    body.position.y = -1.3;
    body.receiveShadow = true;
    this.scene.add(body);

    const bottom = new THREE.Mesh(
      new THREE.CircleGeometry(R, 72),
      new THREE.MeshStandardMaterial({ color: PALETTE.soilDeep, roughness: 1 }),
    );
    bottom.rotation.x = Math.PI / 2;
    bottom.position.y = -2.6;
    this.scene.add(bottom);

    // ฐานไม้
    const plate = new THREE.Mesh(
      new THREE.CylinderGeometry(R + 0.2, R - 1.6, 1.1, 96),
      new THREE.MeshStandardMaterial({ color: PALETTE.base, roughness: 0.9 }),
    );
    plate.position.y = -3.1;
    plate.receiveShadow = true;
    plate.castShadow = true;
    this.scene.add(plate);


    this._buildWater();
  }

  _buildWater() {
    const geo = new THREE.CircleGeometry(1, 64);
    geo.rotateX(-Math.PI / 2);
    this.waterBase = geo.attributes.position.array.slice();
    this.water = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: PALETTE.water,
      roughness: 0.3,
      metalness: 0.0,
      transparent: true,
      opacity: 0.82,
      emissive: 0x1f6b80,
      emissiveIntensity: 0.22,
      envMapIntensity: 1.1,
    }));
    this.water.position.set(WORLD.poolCenter.x, 0, WORLD.poolCenter.z);
    this.scene.add(this.water);
    this.setPoolRadius(WORLD.poolRadius);
  }

  /** ปรับขนาดแอ่งน้ำตาม preset (ภัยแล้งจะเหลือแอ่งเล็กในแอ่งดินเดิม) */
  setPoolRadius(radius) {
    this.poolRadius = radius;
    this.water.scale.set(radius, 1, radius);
    this.water.position.y = this._bowl(radius) + 0.025;
  }

  // ------------------------------------------------------------------- decor

  _buildDecor() {
    const rng = makeRng(20260914);
    const rockMat = new THREE.MeshStandardMaterial({ color: PALETTE.rock, roughness: 0.92, flatShading: true });
    const mossMat = new THREE.MeshStandardMaterial({ color: 0x6f9a52, roughness: 1, flatShading: true });
    const group = new THREE.Group();

    const areaScale = WORLD_AREA / (Math.PI * 81);
    for (let i = 0; i < Math.round(9 * areaScale); i++) {
      const a = rng() * Math.PI * 2;
      const rad = 2.2 + rng() * (WORLD.radius - 3.2);
      const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
      const pd = Math.hypot(x - WORLD.poolCenter.x, z - WORLD.poolCenter.z);
      if (pd < WORLD.poolRadius + 0.6) continue;
      const s = 0.22 + rng() * 0.45;
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), rockMat);
      rock.position.set(x, this.groundHeight(x, z) + s * 0.35, z);
      rock.rotation.set(rng() * 3, rng() * 3, rng() * 3);
      rock.scale.y = 0.6 + rng() * 0.5;
      rock.castShadow = true;
      rock.receiveShadow = true;
      group.add(rock);
    }

    // ก้อนมอสส์แบน ๆ กระจายรอบแอ่งน้ำ
    for (let i = 0; i < Math.round(16 * areaScale); i++) {
      const a = rng() * Math.PI * 2;
      const rad = WORLD.poolRadius + 0.4 + rng() * 2.4;
      const x = WORLD.poolCenter.x + Math.cos(a) * rad;
      const z = WORLD.poolCenter.z + Math.sin(a) * rad;
      if (Math.hypot(x, z) > WORLD.radius - 0.6) continue;
      const s = 0.3 + rng() * 0.5;
      const moss = new THREE.Mesh(new THREE.SphereGeometry(s, 7, 5), mossMat);
      moss.position.set(x, this.groundHeight(x, z) + 0.02, z);
      moss.scale.set(1, 0.22 + rng() * 0.16, 1);
      moss.receiveShadow = true;
      group.add(moss);
    }

    // กรวดเล็ก ๆ ริมน้ำ
    const pebble = new THREE.SphereGeometry(0.09, 6, 4);
    const pebbleCount = Math.round(70 * Math.sqrt(areaScale));
    const pebbles = new THREE.InstancedMesh(pebble, new THREE.MeshStandardMaterial({
      color: 0xbaa78f, roughness: 0.85, flatShading: true,
    }), pebbleCount);
    for (let i = 0; i < pebbleCount; i++) {
      const a = rng() * Math.PI * 2;
      const rad = WORLD.poolRadius + 0.05 + rng() * 0.75;
      const x = WORLD.poolCenter.x + Math.cos(a) * rad;
      const z = WORLD.poolCenter.z + Math.sin(a) * rad;
      OBJ.position.set(x, this.groundHeight(x, z) + 0.03, z);
      OBJ.rotation.set(rng() * 3, rng() * 3, rng() * 3);
      const s = 0.6 + rng() * 0.9;
      OBJ.scale.set(s, s * 0.6, s);
      OBJ.updateMatrix();
      pebbles.setMatrixAt(i, OBJ.matrix);
    }
    pebbles.count = pebbleCount;
    pebbles.instanceMatrix.needsUpdate = true;
    group.add(pebbles);

    this.scene.add(group);
  }

  // ------------------------------------------------------------------- ขอบแผนที่

  /**
   * ขอบดินของเกาะ — เดิมตรงนี้เคยเป็นโหลแก้วครอบทั้งใบ
   * ถอดออกแล้วเพื่อให้เป็นภูมิประเทศเปิดที่ซูมเข้าไปดูใกล้ ๆ ได้
   * (วัฏจักรน้ำแบบภาชนะปิดยังทำงานเหมือนเดิมในซิมูเลชัน — ตอนนี้ตีความเป็นน้ำค้าง)
   */
  _buildEdge() {
    const R = WORLD.radius;
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(R + 0.35, 0.3, 10, 120),
      new THREE.MeshStandardMaterial({ color: PALETTE.baseRim, roughness: 0.75, metalness: 0.08 }),
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.y = -0.15;
    rim.receiveShadow = true;
    this.scene.add(rim);
  }

  // --------------------------------------------------------------- creatures

  /** พืช: ลำต้น + ใบ + ตุ่มดอก รวมเป็น geometry เดียว */
  _plantGeometry() {
    const parts = [
      part(new THREE.CylinderGeometry(0.028, 0.055, 0.42, 6), PALETTE.stem, { pos: [0, 0.21, 0] }),
    ];
    const leaves = [
      { a: 0.0, tilt: 0.55, r: 0.17, h: 0.46 },
      { a: 1.9, tilt: 0.62, r: 0.155, h: 0.40 },
      { a: 3.6, tilt: 0.50, r: 0.165, h: 0.52 },
      { a: 5.0, tilt: 0.70, r: 0.14, h: 0.36 },
    ];
    for (const l of leaves) {
      const leaf = new THREE.SphereGeometry(l.r, 8, 6);
      leaf.scale(1.35, 0.42, 1.0);
      leaf.rotateZ(l.tilt);
      leaf.rotateY(l.a);
      leaf.translate(Math.cos(l.a) * 0.13, l.h, Math.sin(l.a) * 0.13);
      parts.push(tint(leaf, l.h > 0.44 ? PALETTE.leaf : PALETTE.leafDeep));
    }
    parts.push(part(new THREE.SphereGeometry(0.055, 7, 5), PALETTE.bud, { pos: [0, 0.6, 0] }));
    return mergeGeometries(parts, false);
  }

  /** สัตว์กินพืช: ตัวกลมป้อม หูกลม หางสั้น */
  _herbivoreGeometry() {
    const p = [];
    p.push(part(new THREE.SphereGeometry(0.22, 12, 9), PALETTE.herbBody, { scale: [1, 0.86, 1.28], pos: [0, 0.21, 0] }));
    p.push(part(new THREE.SphereGeometry(0.14, 11, 8), PALETTE.herbBelly, { scale: [0.85, 0.55, 1.0], pos: [0, 0.1, 0.02] }));
    p.push(part(new THREE.SphereGeometry(0.145, 11, 9), PALETTE.herbBody, { pos: [0, 0.3, 0.25] }));
    p.push(part(new THREE.SphereGeometry(0.075, 9, 7), PALETTE.herbBelly, { scale: [0.9, 0.7, 1.0], pos: [0, 0.25, 0.35] }));
    for (const sx of [-1, 1]) {
      p.push(part(new THREE.SphereGeometry(0.07, 8, 6), PALETTE.herbEar,
        { scale: [0.45, 1.35, 0.75], pos: [sx * 0.085, 0.44, 0.22] }));
      p.push(part(new THREE.SphereGeometry(0.024, 7, 5), PALETTE.eye, { pos: [sx * 0.075, 0.31, 0.36] }));
      for (const sz of [-1, 1]) {
        p.push(part(new THREE.CylinderGeometry(0.042, 0.035, 0.16, 6), PALETTE.herbLeg,
          { pos: [sx * 0.12, 0.08, sz * 0.13] }));
      }
    }
    p.push(part(new THREE.SphereGeometry(0.06, 8, 6), PALETTE.herbBelly, { pos: [0, 0.26, -0.3] }));
    return mergeGeometries(p, false);
  }

  /** ผู้ล่า: ตัวยาวเพรียว จมูกแหลม หูตั้ง หางยาว */
  _predatorGeometry() {
    const p = [];
    p.push(part(new THREE.SphereGeometry(0.21, 12, 9), PALETTE.predBody, { scale: [0.95, 0.85, 1.55], pos: [0, 0.26, 0] }));
    p.push(part(new THREE.SphereGeometry(0.15, 10, 8), PALETTE.predBelly, { scale: [0.8, 0.5, 1.25], pos: [0, 0.15, 0] }));
    p.push(part(new THREE.SphereGeometry(0.145, 11, 9), PALETTE.predBody, { pos: [0, 0.36, 0.3] }));
    p.push(part(new THREE.ConeGeometry(0.075, 0.22, 8), PALETTE.predBelly,
      { rot: [Math.PI / 2, 0, 0], pos: [0, 0.31, 0.44] }));
    for (const sx of [-1, 1]) {
      p.push(part(new THREE.ConeGeometry(0.062, 0.17, 5), PALETTE.predEar,
        { rot: [0.25, 0, 0], pos: [sx * 0.085, 0.51, 0.27] }));
      p.push(part(new THREE.SphereGeometry(0.026, 7, 5), PALETTE.eye, { pos: [sx * 0.073, 0.38, 0.4] }));
      for (const sz of [-1, 1]) {
        p.push(part(new THREE.CylinderGeometry(0.042, 0.032, 0.22, 6), PALETTE.predLeg,
          { pos: [sx * 0.115, 0.11, sz * 0.17] }));
      }
    }
    p.push(part(new THREE.CylinderGeometry(0.055, 0.02, 0.5, 7), PALETTE.predBody,
      { rot: [-0.85, 0, 0], pos: [0, 0.4, -0.42] }));
    return mergeGeometries(p, false);
  }

  /**
   * ผู้ย่อยสลาย: กลุ่มเห็ดเล็ก 3 ดอกบนพื้นซาก
   * ทำเป็นกระจุกเพื่อให้เห็นชัดในระยะกล้องปกติ แม้แต่ละดอกจะเล็กมาก
   */
  /**
   * ต้นไม้ใหญ่ — ลำต้นเอียงเล็กน้อย กิ่งสามกิ่ง และพุ่มใบซ้อนกันหลายก้อน
   * เรขาคณิตชิ้นนี้สูงราว 5.5 หน่วยที่ scale 1 แล้วค่อยย่อตามขนาดต้นจริง
   */
  _treeGeometry() {
    const p = [];
    const H = 3.4;
    p.push(part(new THREE.CylinderGeometry(0.16, 0.42, H, 8), PALETTE.bark,
      { pos: [0, H / 2, 0] }));
    // พูพอนโคนต้น
    p.push(part(new THREE.ConeGeometry(0.62, 0.7, 8), PALETTE.bark, { pos: [0, 0.3, 0] }));

    const branches = [
      { a: 0.4, h: 2.2, len: 1.25, tilt: 0.75 },
      { a: 2.6, h: 2.6, len: 1.05, tilt: 0.66 },
      { a: 4.6, h: 2.0, len: 1.15, tilt: 0.82 },
    ];
    for (const b of branches) {
      const g = new THREE.CylinderGeometry(0.06, 0.13, b.len, 6);
      g.translate(0, b.len / 2, 0);
      g.rotateZ(b.tilt);
      g.rotateY(b.a);
      g.translate(0, b.h, 0);
      p.push(tint(g, PALETTE.barkLight));
    }

    const blobs = [
      { x: 0, y: 4.5, z: 0, r: 1.5, c: PALETTE.canopy },
      { x: 1.05, y: 3.85, z: 0.35, r: 1.05, c: PALETTE.canopyLit },
      { x: -0.95, y: 3.7, z: -0.55, r: 1.0, c: PALETTE.canopyDeep },
      { x: 0.25, y: 3.5, z: 1.05, r: 0.92, c: PALETTE.canopyDeep },
      { x: -0.3, y: 5.3, z: 0.4, r: 0.85, c: PALETTE.canopyLit },
    ];
    for (const b of blobs) {
      // ต้องเป็น geometry แบบมี index เหมือนชิ้นอื่น ไม่งั้น mergeGeometries รวมไม่ได้
      const g = new THREE.SphereGeometry(b.r, 9, 7);
      g.scale(1, 0.82, 1);
      g.translate(b.x, b.y, b.z);
      p.push(tint(g, b.c));
    }
    return mergeGeometries(p, false);
  }

  _fungusGeometry() {
    const p = [];
    const caps = [
      { x: 0, z: 0, h: 0.3, r: 0.17 },
      { x: 0.14, z: 0.09, h: 0.2, r: 0.12 },
      { x: -0.11, z: 0.13, h: 0.15, r: 0.1 },
    ];
    for (const c of caps) {
      p.push(part(new THREE.CylinderGeometry(0.028, 0.042, c.h, 6), PALETTE.fungusStem,
        { pos: [c.x, c.h / 2, c.z] }));
      // หมวกเห็ดทำจากครึ่งทรงกลม
      const cap = new THREE.SphereGeometry(c.r, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.55);
      cap.scale(1, 0.72, 1);
      cap.translate(c.x, c.h, c.z);
      p.push(tint(cap, PALETTE.fungusCap));
      p.push(part(new THREE.CylinderGeometry(c.r * 0.82, c.r * 0.82, 0.016, 10), PALETTE.fungusGill,
        { pos: [c.x, c.h - 0.012, c.z] }));
    }
    return mergeGeometries(p, false);
  }

  _makeInstanced(geo, count, roughness = 0.78) {
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness, metalness: 0.02 });
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, COL.setHex(0xffffff));
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.count = 0;
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    return mesh;
  }

  _buildCreatures() {
    this.treeMesh = this._makeInstanced(this._treeGeometry(), CAPS.trees, 0.9);
    this.plantMesh = this._makeInstanced(this._plantGeometry(), CAPS.plants, 0.86);
    this.herbMesh = this._makeInstanced(this._herbivoreGeometry(), CAPS.herbivores, 0.72);
    this.predMesh = this._makeInstanced(this._predatorGeometry(), CAPS.predators, 0.68);
    this.fungusMesh = this._makeInstanced(this._fungusGeometry(), CAPS.fungi, 0.9);
    this.treeMesh.name = 'tree';
    this.plantMesh.name = 'plant';
    this.herbMesh.name = 'herbivore';
    this.predMesh.name = 'predator';
    this.fungusMesh.name = 'fungus';
    // แผนที่ instance index -> id ของสิ่งมีชีวิต (ใช้ตอนคลิกเลือก)
    this.ids = { tree: [], plant: [], herbivore: [], predator: [], fungus: [] };
  }

  // --------------------------------------------------------------- selection

  _buildSelection() {
    this.selectRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.42, 0.035, 8, 40),
      new THREE.MeshBasicMaterial({ color: 0xffd27d, transparent: true, opacity: 0.95 }),
    );
    this.selectRing.rotation.x = Math.PI / 2;
    this.selectRing.visible = false;
    this.scene.add(this.selectRing);

    // เส้นแสดงเป้าหมายปัจจุบัน (ทรงกระบอกบางยืดระหว่างตัวสัตว์กับเป้าหมาย)
    const beamGeo = new THREE.CylinderGeometry(0.028, 0.028, 1, 6, 1, true);
    beamGeo.translate(0, 0.5, 0);
    this.targetBeam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({
      color: 0xffd27d, transparent: true, opacity: 0.55, depthWrite: false,
    }));
    this.targetBeam.visible = false;
    this.scene.add(this.targetBeam);

    this.targetMark = new THREE.Mesh(
      new THREE.TorusGeometry(0.3, 0.028, 8, 28),
      new THREE.MeshBasicMaterial({ color: 0xffd27d, transparent: true, opacity: 0.9 }),
    );
    this.targetMark.rotation.x = Math.PI / 2;
    this.targetMark.visible = false;
    this.scene.add(this.targetMark);
  }

  // ----------------------------------------------------------------- weather

  _buildWeather() {
    const rng = makeRng(4242);
    const areaScaleOf = () => Math.min(4, WORLD_AREA / (Math.PI * 81));
    // ละอองฝุ่นลอยในภาชนะ ให้บรรยากาศดูมีชีวิต
    const dustCount = Math.round(110 * areaScaleOf());
    const dustPos = new Float32Array(dustCount * 3);
    this.dustPhase = new Float32Array(dustCount);
    for (let i = 0; i < dustCount; i++) {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * (WORLD.radius - 0.6);
      dustPos[i * 3] = Math.cos(a) * r;
      dustPos[i * 3 + 1] = 0.6 + rng() * (SKY_HEIGHT - 2.2);
      dustPos[i * 3 + 2] = Math.sin(a) * r;
      this.dustPhase[i] = rng() * Math.PI * 2;
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
    this.dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
      color: 0xffcf9a, size: 0.075, transparent: true, opacity: 0.55,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    }));
    this.scene.add(this.dust);

    // หยดฝน
    const rainCount = Math.round(260 * areaScaleOf());
    const rainPos = new Float32Array(rainCount * 3);
    this.rainSpeed = new Float32Array(rainCount);
    for (let i = 0; i < rainCount; i++) {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * (WORLD.radius - 0.4);
      rainPos[i * 3] = Math.cos(a) * r;
      rainPos[i * 3 + 1] = rng() * SKY_HEIGHT;
      rainPos[i * 3 + 2] = Math.sin(a) * r;
      this.rainSpeed[i] = 6 + rng() * 5;
    }
    const rainGeo = new THREE.BufferGeometry();
    rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
    this.rain = new THREE.Points(rainGeo, new THREE.PointsMaterial({
      color: 0xd8f2ff, size: 0.17, transparent: true, opacity: 0.85,
      depthWrite: false, sizeAttenuation: true,
    }));
    this.rain.visible = false;
    this.scene.add(this.rain);
  }

  // ------------------------------------------------------------------ update

  /** วาดสถานะล่าสุดของซิมูเลชัน เรียกทุกเฟรม */
  update(sim, dtReal, selection) {
    const t = this.clock.getElapsedTime();
    this._syncTrees(sim, t);
    this._syncPlants(sim, t);
    this._syncFungi(sim, t);
    this._syncAnimals(sim.herbivores, this.herbMesh, this.ids.herbivore, HERBIVORE, t);
    this._syncAnimals(sim.predators, this.predMesh, this.ids.predator, PREDATOR, t);
    this._syncSelection(sim, selection);
    this._syncWeather(sim, dtReal, t);
    this._syncDaylight(sim);
    this.controls.update();
  }

  _syncTrees(sim, t) {
    const mesh = this.treeMesh;
    const ids = this.ids.tree;
    ids.length = 0;
    const n = Math.min(sim.trees.length, CAPS.trees);
    for (let i = 0; i < n; i++) {
      const tr = sim.trees[i];
      ids.push(tr.id);
      const s = 0.16 + tr.size * 1.0;
      const sway = Math.sin(t * 0.55 + tr.lean * 2) * 0.016;
      OBJ.position.set(tr.x, this.groundHeight(tr.x, tr.z) - 0.12, tr.z);
      OBJ.rotation.set(sway, tr.lean, sway * 0.7);
      OBJ.scale.set(s, s * (0.9 + tr.health * 0.18), s);
      OBJ.updateMatrix();
      mesh.setMatrixAt(i, OBJ.matrix);
      // ต้นขาดน้ำใบออกน้ำตาล ต้นสมบูรณ์ใบเขียวเข้ม
      const dry = 1 - tr.health;
      COL.setHSL(0.27 - dry * 0.14, 0.34 + dry * 0.2, 0.5 + tr.tint * 0.1 - dry * 0.08);
      mesh.setColorAt(i, COL);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  _syncPlants(sim, t) {
    const mesh = this.plantMesh;
    const list = sim.plants;
    const ids = this.ids.plant;
    ids.length = 0;
    const n = Math.min(list.length, CAPS.plants);
    for (let i = 0; i < n; i++) {
      const p = list[i];
      ids.push(p.id);
      const s = 0.5 + p.size * 1.15;
      const sway = Math.sin(t * 1.1 + p.lean * 3) * 0.045 * p.size;
      OBJ.position.set(p.x, this.groundHeight(p.x, p.z) - 0.03, p.z);
      OBJ.rotation.set(sway, p.lean, sway * 0.6);
      OBJ.scale.set(s, s * (0.85 + p.health * 0.3), s);
      OBJ.updateMatrix();
      mesh.setMatrixAt(i, OBJ.matrix);
      // ต้นที่ขาดน้ำจะออกเหลือง ต้นสมบูรณ์จะเขียวสด
      const dry = 1 - p.health;
      COL.setHSL(0.26 - dry * 0.12, 0.42 + dry * 0.22, 0.46 + p.tint * 0.12 - dry * 0.06);
      mesh.setColorAt(i, COL);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  _syncFungi(sim, t) {
    const mesh = this.fungusMesh;
    const ids = this.ids.fungus;
    ids.length = 0;
    const n = Math.min(sim.fungi.length, CAPS.fungi);
    for (let i = 0; i < n; i++) {
      const f = sim.fungi[i];
      ids.push(f.id);
      const s = 0.45 + f.size * 0.85;
      OBJ.position.set(f.x, this.groundHeight(f.x, f.z) - 0.02, f.z);
      OBJ.rotation.set(0, f.lean, 0);
      OBJ.scale.set(s, s * (0.8 + f.size * 0.35), s);
      OBJ.updateMatrix();
      mesh.setMatrixAt(i, OBJ.matrix);
      // ดอกอ่อนสีซีด ดอกแก่สีม่วงเข้มขึ้น
      COL.setHSL(0.78 - f.tint * 0.06, 0.2 + f.size * 0.22, 0.82 - f.size * 0.2);
      mesh.setColorAt(i, COL);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  _syncAnimals(list, mesh, ids, spec, t) {
    ids.length = 0;
    const n = Math.min(list.length, mesh.instanceMatrix.count);
    for (let i = 0; i < n; i++) {
      const a = list[i];
      ids.push(a.id);
      const grow = (0.62 + 0.38 * Math.min(1, a.age / spec.breedAge)) * 1.42;
      const gait = Math.abs(Math.sin(t * 7.5 + a.id * 1.7)) * a.moving;
      const y = this.groundHeight(a.x, a.z) + gait * 0.055;
      OBJ.position.set(a.x, y, a.z);
      OBJ.rotation.set(
        a.state === 'eat' ? 0.28 : gait * 0.06,
        a.dir,
        Math.sin(t * 7.5 + a.id) * 0.05 * a.moving,
      );
      OBJ.scale.setScalar(grow);
      OBJ.updateMatrix();
      mesh.setMatrixAt(i, OBJ.matrix);
      // ตัวที่หิวจัดจะสีซีดลง
      const vigor = 0.62 + 0.38 * (a.energy / a.maxEnergy);
      COL.setRGB(vigor, vigor * 0.97, vigor * 0.93);
      mesh.setColorAt(i, COL);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  _syncSelection(sim, selection) {
    const entity = selection ? sim.findById(selection.id) : null;
    if (!entity) {
      this.selectRing.visible = false;
      this.targetBeam.visible = false;
      this.targetMark.visible = false;
      return;
    }
    const y = this.groundHeight(entity.x, entity.z);
    const scale = entity.kind === 'tree' ? 1.6 + entity.size * 2.6
      : entity.kind === 'plant' ? 0.5 + entity.size * 0.7
        : entity.kind === 'fungus' ? 0.45 + entity.size * 0.4 : 0.85;
    this.selectRing.visible = true;
    this.selectRing.position.set(entity.x, y + 0.06, entity.z);
    this.selectRing.scale.setScalar(scale);
    const pulse = 0.75 + Math.sin(this.clock.getElapsedTime() * 4) * 0.25;
    this.selectRing.material.opacity = pulse;

    const target = sim.targetPointOf(entity);
    if (!target) {
      this.targetBeam.visible = false;
      this.targetMark.visible = false;
      return;
    }
    // สีเส้นบอกชนิดเป้าหมาย: อาหาร=เขียว, ล่า=แดง, หนี=ฟ้า, จุดเดินเล่น=เหลือง
    const color = target.kind === 'plant' ? 0x9ad46f
      : target.kind === 'herbivore' ? 0xff8a5c
        : target.kind === 'flee' ? 0x7fd4ff : 0xffd27d;
    this.targetBeam.material.color.setHex(color);
    this.targetMark.material.color.setHex(color);

    const from = new THREE.Vector3(entity.x, y + 0.45, entity.z);
    const ty = this.groundHeight(target.x, target.z);
    const to = new THREE.Vector3(target.x, ty + 0.35, target.z);
    const dir = to.clone().sub(from);
    const len = dir.length();
    this.targetBeam.visible = len > 0.05;
    if (this.targetBeam.visible) {
      this.targetBeam.position.copy(from);
      this.targetBeam.scale.set(1, len, 1);
      this.targetBeam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    }
    this.targetMark.visible = true;
    this.targetMark.position.set(target.x, ty + 0.07, target.z);
    this.targetMark.scale.setScalar(0.9 + Math.sin(this.clock.getElapsedTime() * 5) * 0.12);
  }

  _syncWeather(sim, dt, t) {
    // ผิวน้ำกระเพื่อมเบา ๆ
    const pos = this.water.geometry.attributes.position;
    const base = this.waterBase;
    for (let i = 0; i < pos.count; i++) {
      const x = base[i * 3], z = base[i * 3 + 2];
      pos.array[i * 3 + 1] = Math.sin(t * 1.7 + x * 3.1 + z * 2.4) * 0.012
        + Math.sin(t * 2.6 - x * 4.6) * 0.008;
    }
    pos.needsUpdate = true;

    const dust = this.dust.geometry.attributes.position;
    for (let i = 0; i < this.dustPhase.length; i++) {
      const ph = this.dustPhase[i] + t * 0.35;
      dust.array[i * 3 + 1] += Math.sin(ph) * 0.0032;
      dust.array[i * 3] += Math.cos(ph * 0.7) * 0.0026;
      if (dust.array[i * 3 + 1] > SKY_HEIGHT - 1.4) dust.array[i * 3 + 1] = 0.5;
    }
    dust.needsUpdate = true;

    this.rain.visible = sim.isRaining;
    if (sim.isRaining) {
      const rp = this.rain.geometry.attributes.position;
      for (let i = 0; i < this.rainSpeed.length; i++) {
        rp.array[i * 3 + 1] -= this.rainSpeed[i] * dt;
        if (rp.array[i * 3 + 1] < 0) rp.array[i * 3 + 1] = SKY_HEIGHT - 1.2;
      }
      rp.needsUpdate = true;
    }
  }

  /** วงจรกลางวัน–กลางคืนแบบอ่อน ๆ ให้เห็นว่าเวลาเดิน */
  _syncDaylight(sim) {
    const phase = (sim.time % SECONDS_PER_DAY) / SECONDS_PER_DAY;
    const day = 0.5 + 0.5 * Math.cos(phase * Math.PI * 2);   // 1 = เที่ยงวัน, 0 = กลางคืน
    this.sun.intensity = 1.35 + day * 1.5;
    this.sun.position.set(Math.cos(phase * Math.PI * 2) * 13, 7 + day * 10, Math.sin(phase * Math.PI * 2) * 9 + 4);
    this.hemi.intensity = 0.6 + day * 0.5;
    this.fill.intensity = 30 + (1 - day) * 45;
    this.ambient.intensity = 0.3 + day * 0.18;
    this.dayPhase = phase;
  }

  /** อัปเดตสีผิวดินตามความชื้นจริง (เรียกเป็นระยะ ไม่ต้องทุกเฟรม) */
  updateSoilMoisture(sim) {
    const geo = this.soil.geometry;
    const pos = geo.attributes.position;
    const col = geo.attributes.color;
    const base = this.soilBaseColors;
    for (let i = 0; i < pos.count; i++) {
      const wet = sim.moistureAt(pos.getX(i), pos.getZ(i));
      const k = 1 - wet * 0.42;                  // ชื้น = เข้มขึ้น
      col.array[i * 3] = base[i * 3] * k;
      col.array[i * 3 + 1] = base[i * 3 + 1] * k * (1 - wet * 0.04);
      col.array[i * 3 + 2] = base[i * 3 + 2] * k * (1 - wet * 0.08);
    }
    col.needsUpdate = true;
  }

  // ---------------------------------------------------------------- picking

  _ndc(event) {
    const rect = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  /** คลิกโดนสิ่งมีชีวิตตัวไหน -> { kind, id } */
  pick(event) {
    this.raycaster.setFromCamera(this._ndc(event), this.camera);
    const hits = this.raycaster.intersectObjects(
      [this.herbMesh, this.predMesh, this.plantMesh, this.fungusMesh, this.treeMesh], false);
    for (const hit of hits) {
      const kind = hit.object.name;
      const id = this.ids[kind]?.[hit.instanceId];
      if (id != null) return { kind, id };
    }
    return null;
  }

  /** คลิกลงบนผิวดินตรงไหน -> { x, z } (ใช้ตอนปลูกพืช) */
  pickSoil(event) {
    this.raycaster.setFromCamera(this._ndc(event), this.camera);
    const hit = this.raycaster.intersectObject(this.soil, false)[0];
    if (!hit) return null;
    return { x: hit.point.x, z: hit.point.z };
  }

  // ---------------------------------------------------------------- plumbing

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);

    // จอแนวตั้งมีแผงควบคุมบังครึ่งล่าง จึงเลื่อนภาพขึ้นด้วย view offset
    // (ทำที่ projection ไม่ใช่ที่ target กล้อง เพื่อให้การหมุนยังหมุนรอบภาชนะตามปกติ)
    const shift = w / h < 1 ? h * 0.17 : 0;
    if (shift > 0) this.camera.setViewOffset(w, h + shift * 2, 0, shift * 2, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();

    if (!this.userMovedCamera) this.frameContents();
  }

  /**
   * จัดกล้องให้เห็นภาชนะทั้งใบพอดีจอ ทั้งจอกว้างและจอมือถือแนวตั้ง
   * เรียกอัตโนมัติจนกว่าผู้ใช้จะหมุน/ซูมเอง แล้วจะไม่ไปยุ่งกับกล้องอีก
   */
  frameContents() {
    const portrait = this.camera.aspect < 1;
    // ครอบภาชนะทั้งใบด้วยทรงกลม แล้วคำนวณระยะกล้องให้พอดีทั้งแนวตั้งและแนวนอน
    const bound = WORLD.radius * 1.32;
    const centerY = 2.0;
    const halfV = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const halfH = Math.atan(Math.tan(halfV) * this.camera.aspect);
    const dist = THREE.MathUtils.clamp(
      bound / Math.sin(Math.min(halfV, halfH)),
      this.controls.minDistance, this.controls.maxDistance,
    );

    this.controls.target.set(0, portrait ? centerY : 1.5, 0);
    const dir = new THREE.Vector3(0.52, 0.37, 0.77).normalize();
    this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
    this.controls.update();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
