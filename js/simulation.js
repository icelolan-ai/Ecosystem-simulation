/**
 * LIVING TERRARIUM — แกนซิมูเลชัน (ไม่พึ่งพา DOM หรือ Three.js)
 *
 * ออกแบบเป็นโมดูลบริสุทธิ์เพื่อให้:
 *  - รันทดสอบแบบ headless ใน Node ได้ (ดู tools/balance-test.mjs)
 *  - ใช้ fixed timestep + seeded RNG => ผลลัพธ์ทำซ้ำได้
 *
 * สรุปกฎของระบบ (แบบง่าย):
 *  ความชื้นในดิน -> พืชเติบโต/แพร่พันธุ์ -> สัตว์กินพืชกินพืช -> ผู้ล่าล่าสัตว์กินพืช
 *  ทุกตัวมี พลังงาน (energy), อายุ (age), ความหิว (hunger) และเป้าหมาย (target)
 */
import { makeRng, hashSeed } from './rng.js';
import {
  SIM_DT, WORLD, CAPS, COVER, PLANT, HERBIVORE, PREDATOR, FUNGUS,
  MOISTURE, NUTRIENT, DETRITUS, EVOLUTION, SEASON, TREE, PRESETS,
} from './config.js';

const TAU = Math.PI * 2;

/** คำอธิบายสาเหตุการตายแบบอ่านง่าย */
export const CAUSE_TEXT = {
  eaten: 'ถูกล่า',
  starved: 'อดตาย',
  old: 'แก่ตาย',
  drought: 'ขาดน้ำ',
};

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function dist2(ax, az, bx, bz) { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; }

export class Ecosystem {
  constructor(presetId = 'balanced', seed = null) {
    this.reset(presetId, seed);
  }

  // ---------------------------------------------------------------- lifecycle

  reset(presetId = this.presetId || 'balanced', seed = null) {
    const preset = PRESETS[presetId] || PRESETS.balanced;
    this.presetId = preset.id;
    this.preset = preset;
    this.seedLabel = seed ?? preset.seed;
    this.rng = makeRng(hashSeed(this.seedLabel));

    this.env = {
      evaporation: MOISTURE.evaporation,
      condensation: MOISTURE.condensation,
      poolRadius: WORLD.poolRadius,
      ...preset.env,
    };

    this.time = 0;            // เวลาจำลอง (วินาที)
    this.steps = 0;
    this.nextId = 1;
    this.trees = [];
    this.plants = [];
    this.herbivores = [];
    this.predators = [];
    this.fungi = [];
    /**
     * ดัชนี id -> เอนทิตี
     * ก่อนหน้านี้การค้นหาเป้าหมายใช้ Array.find ทุก step ต่อสัตว์หนึ่งตัว
     * ซึ่งเป็น O(จำนวนพืช) และจะระเบิดทันทีเมื่อขยายแผนที่
     */
    this.byId = new Map();
    this.rainTimer = 0;
    this.rainIntensity = 1;
    this.history = [];
    this.historyTimer = 0;
    this.events = [];
    this.totals = {
      births: { plant: 0, herbivore: 0, predator: 0, fungus: 0, tree: 0 },
      deaths: { plant: 0, herbivore: 0, predator: 0, fungus: 0, tree: 0 },
      eaten: { plant: 0, herbivore: 0 },
      recycled: 0,          // ธาตุอาหารที่ผู้ย่อยสลายคืนสู่ดินสะสม
    };
    /** สถิติสาเหตุการตายสะสม แยกตามชนิด */
    this.causes = {
      plant: {}, herbivore: {}, predator: {}, fungus: {}, tree: {},
    };
    /** บันทึกการตายล่าสุด ใช้ชันสูตรว่าช่วงก่อนสูญพันธุ์เกิดอะไรขึ้น */
    this.recentDeaths = [];
    /** รายงานการสูญพันธุ์ (เก็บไว้ให้ผู้ใช้อ่านย้อนหลังได้) */
    this.extinctionReports = [];
    this.extinctAt = { herbivore: null, predator: null };
    this._lastSeason = null;

    this._initMoisture();
    this._initSoilChemistry();
    this._initCover();
    this._seedWorld(preset.start);
    this._updateCover();
    this._sampleHistory();
    return this;
  }

  _initMoisture() {
    const n = WORLD.gridN;
    this.gridN = n;
    this.cellSize = (WORLD.radius * 2) / n;
    this.moisture = new Float32Array(n * n);
    this._moistureNext = new Float32Array(n * n);
    this.poolMask = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const { x, z } = this.cellCenter(i, j);
        const d = Math.sqrt(dist2(x, z, WORLD.poolCenter.x, WORLD.poolCenter.z));
        const inPool = clamp(1 - (d - this.env.poolRadius) / 0.9, 0, 1);
        this.poolMask[j * n + i] = inPool;
        const rim = clamp(1 - d / (this.env.poolRadius * 3.2), 0, 1);
        this.moisture[j * n + i] = clamp(Math.max(inPool, 0.30 + rim * 0.45), 0, 1);
      }
    }
  }

  /** ตารางธาตุอาหารและซาก ใช้ความละเอียดเดียวกับตารางความชื้น */
  _initSoilChemistry() {
    const n = this.gridN;
    this.nutrients = new Float32Array(n * n).fill(NUTRIENT.initial);
    this._nutrientsNext = new Float32Array(n * n);
    this.detritus = new Float32Array(n * n);
  }

  nutrientAt(x, z) { return this.nutrients[this.cellIndex(x, z)]; }
  detritusAt(x, z) { return this.detritus[this.cellIndex(x, z)]; }

  /** ค่าเฉลี่ยธาตุอาหารบนผืนดิน (ไม่นับใต้น้ำ) */
  averageNutrient() {
    let sum = 0, count = 0;
    for (let k = 0; k < this.nutrients.length; k++) {
      if (this.poolMask[k] > 0.5) continue;
      sum += this.nutrients[k]; count++;
    }
    return count ? sum / count : 0;
  }

  totalDetritus() {
    let sum = 0;
    for (let k = 0; k < this.detritus.length; k++) sum += this.detritus[k];
    return sum;
  }

  /** ทิ้งซากลงดินตรงจุดที่ตาย */
  _addDetritus(x, z, amount) {
    if (amount <= 0) return;
    this.detritus[this.cellIndex(x, z)] += amount;
  }

  _initCover() {
    this.coverGrid = new Float32Array(COVER.gridN * COVER.gridN);
    this._coverTimer = 0;
  }

  /**
   * คำนวณความหนาแน่นของพุ่มไม้ลงตารางหยาบ แล้วเกลี่ยหนึ่งรอบ
   * ใช้เป็น "ที่กำบัง" ของสัตว์กินพืช (คำนวณเป็นระยะ ไม่ใช่ทุกเฟรม เพื่อ performance)
   */
  _updateCover() {
    const n = COVER.gridN;
    const g = this.coverGrid;
    g.fill(0);
    const cell = (WORLD.radius * 2) / n;
    for (let i = 0; i < this.plants.length; i++) {
      const p = this.plants[i];
      const ci = clamp(Math.floor((p.x + WORLD.radius) / cell), 0, n - 1);
      const cj = clamp(Math.floor((p.z + WORLD.radius) / cell), 0, n - 1);
      g[cj * n + ci] += p.size;
    }
    for (let i = 0; i < this.trees.length; i++) {
      const t = this.trees[i];
      const ci = clamp(Math.floor((t.x + WORLD.radius) / cell), 0, n - 1);
      const cj = clamp(Math.floor((t.z + WORLD.radius) / cell), 0, n - 1);
      g[cj * n + ci] += t.size * TREE.coverWeight;
    }
    // เกลี่ยกับเพื่อนบ้านเล็กน้อยให้ขอบพุ่มไม้ไม่แข็งเกินไป
    const blurred = new Float32Array(g.length);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        let sum = g[k] * 2, w = 2;
        if (i > 0) { sum += g[k - 1]; w++; }
        if (i < n - 1) { sum += g[k + 1]; w++; }
        if (j > 0) { sum += g[k - n]; w++; }
        if (j < n - 1) { sum += g[k + n]; w++; }
        blurred[k] = sum / w;
      }
    }
    this.coverGrid = blurred;
  }

  /** ระดับการกำบัง 0..1 ที่พิกัดหนึ่ง */
  coverAt(x, z) {
    const n = COVER.gridN;
    const cell = (WORLD.radius * 2) / n;
    const i = clamp(Math.floor((x + WORLD.radius) / cell), 0, n - 1);
    const j = clamp(Math.floor((z + WORLD.radius) / cell), 0, n - 1);
    return clamp(this.coverGrid[j * n + i] / COVER.full, 0, 1);
  }

  _seedWorld(start) {
    // ต้นไม้ตั้งต้นกระจายห่าง ๆ ขนาดสุ่มตั้งแต่ต้นอ่อนถึงโตเต็มวัย
    for (let i = 0; i < (start.trees || 0); i++) {
      const p = this.randomSoilPoint(2.5);
      this.addTree(p.x, p.z, this.rng.range(0.25, 1));
    }
    for (let i = 0; i < start.plants; i++) {
      const p = this.randomSoilPoint(0.6);
      this.addPlant(p.x, p.z, this.rng.range(0.2, 0.85));
    }
    for (let i = 0; i < start.herbivores; i++) {
      const p = this.randomSoilPoint(1.2);
      this.addHerbivore(p.x, p.z);
    }
    for (let i = 0; i < start.predators; i++) {
      const p = this.randomSoilPoint(1.2);
      this.addPredator(p.x, p.z);
    }
  }

  // ------------------------------------------------------------------- helpers

  cellCenter(i, j) {
    const s = this.cellSize;
    return { x: -WORLD.radius + (i + 0.5) * s, z: -WORLD.radius + (j + 0.5) * s };
  }

  cellIndex(x, z) {
    const n = this.gridN;
    const i = clamp(Math.floor((x + WORLD.radius) / this.cellSize), 0, n - 1);
    const j = clamp(Math.floor((z + WORLD.radius) / this.cellSize), 0, n - 1);
    return j * n + i;
  }

  moistureAt(x, z) { return this.moisture[this.cellIndex(x, z)]; }

  isWater(x, z) {
    return dist2(x, z, WORLD.poolCenter.x, WORLD.poolCenter.z) < this.env.poolRadius * this.env.poolRadius;
  }

  /** จุดสุ่มบนผิวดิน (ไม่อยู่ในแอ่งน้ำ) */
  randomSoilPoint(margin = 0.5, tries = 24) {
    for (let k = 0; k < tries; k++) {
      const a = this.rng() * TAU;
      const r = Math.sqrt(this.rng()) * (WORLD.radius - margin);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (!this.isWater(x, z)) return { x, z };
    }
    return { x: WORLD.radius * 0.5, z: -WORLD.radius * 0.4 };
  }

  averageMoisture() {
    let sum = 0, count = 0;
    for (let k = 0; k < this.moisture.length; k++) {
      if (this.poolMask[k] > 0.5) continue;     // ไม่นับผิวน้ำ
      sum += this.moisture[k]; count++;
    }
    return count ? sum / count : 0;
  }

  get isRaining() { return this.rainTimer > 0; }

  /** ตำแหน่งในรอบปี 0..1 (0 = กลางฤดูฝน) */
  get seasonPhase() {
    return (this.time % SEASON.secondsPerYear) / SEASON.secondsPerYear;
  }

  /** ชื่อฤดูปัจจุบัน */
  get seasonName() {
    return SEASON.names[Math.floor(this.seasonPhase * SEASON.names.length) % SEASON.names.length];
  }

  /**
   * ตัวคูณอัตราการระเหยตามฤดู — ต่ำสุดกลางฤดูฝน สูงสุดกลางฤดูแล้ง
   * ใช้ cosine เพื่อให้เปลี่ยนอย่างนุ่มนวล ไม่กระตุกตอนข้ามฤดู
   */
  get seasonDryness() {
    return 1 - SEASON.amplitude * Math.cos(this.seasonPhase * TAU);
  }

  get counts() {
    return {
      trees: this.trees.length,
      plants: this.plants.length,
      herbivores: this.herbivores.length,
      predators: this.predators.length,
      fungi: this.fungi.length,
    };
  }

  // ------------------------------------------------------------------- spawning

  addPlant(x, z, size = PLANT.seedSize) {
    if (this.plants.length >= CAPS.plants) return null;
    if (this.isWater(x, z)) return null;
    const p = {
      id: this.nextId++, kind: 'plant', alive: true,
      x, z,
      size,
      age: 0,
      maxAge: PLANT.maxAge * (0.8 + this.rng() * 0.45),
      lean: this.rng() * TAU,
      tint: this.rng(),
      health: 1,
    };
    this.plants.push(p);
    this.byId.set(p.id, p);
    return p;
  }

  addTree(x, z, size = TREE.seedSize) {
    if (this.trees.length >= CAPS.trees) return null;
    if (this.isWater(x, z)) return null;
    const t = {
      id: this.nextId++, kind: 'tree', alive: true,
      x, z,
      size,
      age: 0,
      maxAge: TREE.maxAge * (0.75 + this.rng() * 0.5),
      lean: this.rng() * TAU,
      tint: this.rng(),
      health: 1,
      shed: 0,              // ใบร่วงสะสม (โชว์ในแผงข้อมูล)
    };
    this.trees.push(t);
    this.byId.set(t.id, t);
    return t;
  }

  addFungus(x, z, size = FUNGUS.seedSize) {
    if (this.fungi.length >= CAPS.fungi) return null;
    if (this.isWater(x, z)) return null;
    const f = {
      id: this.nextId++, kind: 'fungus', alive: true,
      x, z,
      size,
      age: 0,
      maxAge: FUNGUS.maxAge * (0.8 + this.rng() * 0.5),
      lean: this.rng() * TAU,
      tint: this.rng(),
      digested: 0,          // ย่อยซากไปแล้วเท่าไร (โชว์ในแผงข้อมูล)
    };
    this.fungi.push(f);
    this.byId.set(f.id, f);
    return f;
  }

  addHerbivore(x, z, energy = HERBIVORE.startEnergy, gene = null) {
    if (this.herbivores.length >= CAPS.herbivores) return null;
    const h = this._makeAnimal('herbivore', x, z, energy, HERBIVORE, gene);
    this.herbivores.push(h);
    this.byId.set(h.id, h);
    return h;
  }

  addPredator(x, z, energy = PREDATOR.startEnergy, home = null, gene = null) {
    if (this.predators.length >= CAPS.predators) return null;
    const p = this._makeAnimal('predator', x, z, energy, PREDATOR, gene);
    p.home = home || this._claimTerritory(x, z) || { x, z };
    this.predators.push(p);
    this.byId.set(p.id, p);
    return p;
  }

  /**
   * หาที่ตั้งอาณาเขตว่างใกล้จุดหนึ่ง (ต้องห่างจากอาณาเขตผู้ล่าตัวอื่น)
   * คืน null ถ้าไม่มีที่ว่าง -> ผู้ล่าตัวใหม่จะเกิดไม่ได้
   */
  _claimTerritory(x, z, tries = 10) {
    const spacing = PREDATOR.breedSpacing;
    const maxR = WORLD.radius - 1.2;
    for (let k = 0; k < tries; k++) {
      const a = this.rng() * TAU;
      const r = k === 0 ? 0 : this.rng.range(spacing, spacing * 1.6);
      let cx = x + Math.cos(a) * r;
      let cz = z + Math.sin(a) * r;
      const rd = Math.hypot(cx, cz);
      if (rd > maxR) { cx = (cx / rd) * maxR; cz = (cz / rd) * maxR; }
      let ok = true;
      for (let i = 0; i < this.predators.length; i++) {
        const h = this.predators[i].home;
        if (h && dist2(h.x, h.z, cx, cz) < spacing * spacing) { ok = false; break; }
      }
      if (ok) return { x: cx, z: cz };
    }
    return null;
  }

  _makeAnimal(kind, x, z, energy, spec, gene = null) {
    return {
      id: this.nextId++, kind, alive: true,
      x, z,
      dir: this.rng() * TAU,
      // ยีนความเร็ว: รับจากพ่อแม่ถ้ามี ไม่งั้นสุ่มรอบ 1.0 (ประชากรตั้งต้น)
      speedGene: gene ?? (1 + this.rng.spread() * EVOLUTION.spread),
      energy,
      maxEnergy: spec.maxEnergy,
      age: 0,
      maxAge: spec.maxAge * (0.82 + this.rng() * 0.4),
      state: 'wander',
      target: null,
      repathIn: this.rng.range(0, 0.5),
      alertTimer: 0,
      actionTimer: 0,
      breedCooldown: spec.breedCooldown * 0.5,
      chaseTimer: 0,
      restTimer: 0,
      moving: 0,
      born: this.time,
      meals: 0,
    };
  }

  startRain(duration = MOISTURE.rainDuration, intensity = 1, label = 'ฝนตกลงมาในเทอราเรียม') {
    this.rainTimer = Math.max(this.rainTimer, duration);
    this.rainIntensity = intensity;
    if (label) this._log('rain', label);
  }

  /** บันทึกการตาย 1 ครั้ง (ใช้ทั้งสถิติสะสมและการชันสูตร) */
  _recordDeath(kind, cause, x, z) {
    const bucket = this.causes[kind];
    bucket[cause] = (bucket[cause] || 0) + 1;
    this.recentDeaths.push({ t: this.time, kind, cause });
    // เก็บย้อนหลังพอสำหรับหน้าต่างชันสูตร
    while (this.recentDeaths.length && this.time - this.recentDeaths[0].t > 180) {
      this.recentDeaths.shift();
    }
  }

  /** นับสาเหตุการตายของชนิดหนึ่งในช่วง N วินาทีล่าสุด */
  deathsInWindow(kind, seconds) {
    const since = this.time - seconds;
    const tally = {};
    let total = 0;
    for (let i = 0; i < this.recentDeaths.length; i++) {
      const d = this.recentDeaths[i];
      if (d.t < since || d.kind !== kind) continue;
      tally[d.cause] = (tally[d.cause] || 0) + 1;
      total++;
    }
    return { tally, total };
  }

  /**
   * สร้างรายงานชันสูตรตอนสายพันธุ์หนึ่งหมดไป
   * ตอบคำถามว่า "ตายเพราะอะไร" และ "ตอนนั้นสภาพแวดล้อมเป็นยังไง"
   */
  _buildExtinctionReport(kind) {
    const window = 120;
    const { tally, total } = this.deathsInWindow(kind, window);
    const plantsBefore = [];
    for (let i = this.history.length - 1; i >= 0 && this.history[i].t > this.time - window; i--) {
      plantsBefore.push(this.history[i].plants);
    }
    const avgPlants = plantsBefore.length
      ? plantsBefore.reduce((a, b) => a + b, 0) / plantsBefore.length : null;
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0] || null;
    const report = {
      kind,
      time: this.time,
      window,
      tally,
      total,
      topCause: top ? top[0] : null,
      avgPlants,
      plants: this.plants.length,
      predators: this.predators.length,
      herbivores: this.herbivores.length,
      moisture: this.averageMoisture(),
      nutrient: this.averageNutrient(),
      season: this.seasonName,
    };
    this.extinctionReports.push(report);
    return report;
  }

  _log(type, text) {
    this.events.push({ t: this.time, type, text });
    if (this.events.length > 60) this.events.shift();
  }

  // ----------------------------------------------------------------- main step

  /** เดินซิมูเลชัน 1 step ด้วย timestep คงที่ */
  step() {
    const dt = SIM_DT;
    this.time += dt;
    this.steps++;

    const season = this.seasonName;
    if (season !== this._lastSeason) {
      if (this._lastSeason !== null) this._log('season', `เข้าสู่${season}`);
      this._lastSeason = season;
    }
    this._seasonalRain(dt);

    this._coverTimer -= dt;
    if (this._coverTimer <= 0) { this._coverTimer = COVER.updateEvery; this._updateCover(); }

    this._stepMoisture(dt);
    this._stepSoilChemistry(dt);
    this._stepTrees(dt);
    this._stepPlants(dt);
    this._stepFungi(dt);
    this._stepHerbivores(dt);
    this._stepPredators(dt);
    this._cull();

    this.historyTimer += dt;
    if (this.historyTimer >= 1) {
      this.historyTimer -= 1;
      this._sampleHistory();
    }
  }

  /**
   * วัฏจักรน้ำแบบง่ายของภาชนะปิด:
   *   แอ่งน้ำ = แหล่งน้ำถาวร -> ซึมออกไปตามดิน -> ระเหยตามความชื้นที่มี
   *   -> ส่วนใหญ่กลั่นตัวกลับลงดินเป็นน้ำค้างอย่างสม่ำเสมอ
   * ทำให้เกิดความชื้นไล่ระดับ (ใกล้แอ่งน้ำชื้นกว่า) และระบบอยู่ตัวได้นาน
   */
  /** ฤดูฝนมีฝนตกเองเป็นระยะ ยิ่งใกล้กลางฤดูฝนยิ่งบ่อย */
  _seasonalRain(dt) {
    if (this.rainTimer > 0) return;
    const wetness = 1 - this.seasonDryness / (1 + SEASON.amplitude); // 0..1 ยิ่งมากยิ่งชื้น
    if (wetness <= 0) return;
    if (this.rng() < SEASON.rainChance * wetness * dt) {
      this.startRain(SEASON.rainDuration, SEASON.rainIntensity,
        `ฝนปรอยตามฤดูกาล (${this.seasonName})`);
    }
  }

  _stepMoisture(dt) {
    const n = this.gridN;
    const m = this.moisture, next = this._moistureNext, pool = this.poolMask;
    const raining = this.rainTimer > 0;
    if (raining) this.rainTimer = Math.max(0, this.rainTimer - dt);

    const diff = Math.min(0.22, MOISTURE.diffuse * dt);
    const evap = this.env.evaporation * this.seasonDryness * dt;
    const rain = raining ? MOISTURE.rainRate * this.rainIntensity * dt : 0;
    let evaporated = 0;
    let landCells = 0;

    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const c = m[k];
        const l = i > 0 ? m[k - 1] : c;
        const r = i < n - 1 ? m[k + 1] : c;
        const u = j > 0 ? m[k - n] : c;
        const d = j < n - 1 ? m[k + n] : c;
        let v = c + diff * ((l + r + u + d) * 0.25 - c);
        const land = 1 - pool[k];
        if (land > 0) {
          const lost = evap * v * land;
          v -= lost;
          evaporated += lost * land;
          landCells += land;
          v += rain * land;
        }
        // แอ่งน้ำเป็นแหล่งน้ำถาวร ดันค่ากลับขึ้นเสมอ
        if (pool[k] > 0) v = Math.max(v, pool[k]);
        next[k] = v < 0 ? 0 : v > 1 ? 1 : v;
      }
    }

    // ไอน้ำกลั่นตัวกลับลงดินอย่างทั่วถึง
    if (landCells > 0 && this.env.condensation > 0) {
      const back = (evaporated * this.env.condensation) / landCells;
      for (let k = 0; k < next.length; k++) {
        const land = 1 - pool[k];
        if (land <= 0) continue;
        const v = next[k] + back * land;
        next[k] = v > 1 ? 1 : v;
      }
    }
    this.moisture.set(next);
  }

  /**
   * ธาตุอาหารซึมไปตามดินช้า ๆ และซากค่อย ๆ ย่อยสลายเองแม้ไม่มีเห็ดรา
   * (อัตราธรรมชาตินี้ช้ามากโดยตั้งใจ — ผู้ย่อยสลายคือตัวเร่งที่ทำให้ระบบหมุนได้จริง)
   */
  _stepSoilChemistry(dt) {
    const n = this.gridN;
    const cur = this.nutrients, next = this._nutrientsNext;
    const diff = Math.min(0.22, NUTRIENT.diffuse * dt);
    const abiotic = DETRITUS.abioticRate * dt;

    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const c = cur[k];
        const l = i > 0 ? cur[k - 1] : c;
        const r = i < n - 1 ? cur[k + 1] : c;
        const u = j > 0 ? cur[k - n] : c;
        const d = j < n - 1 ? cur[k + n] : c;
        let v = c + diff * ((l + r + u + d) * 0.25 - c);

        const det = this.detritus[k];
        if (det > 0) {
          const rotted = Math.min(det, abiotic);
          this.detritus[k] = det - rotted;
          v += rotted * DETRITUS.toNutrient;
        }
        next[k] = v < 0 ? 0 : v > 1 ? 1 : v;
      }
    }
    this.nutrients.set(next);
  }

  /**
   * ต้นไม้ใหญ่: โตช้า ทิ้งใบร่วงตลอดเวลา และแย่งน้ำ/ธาตุอาหารกับพืชเล็ก
   * สัตว์กินพืชกินไม่ถึง จึงเป็นโครงสร้างถาวรของภูมิประเทศมากกว่าจะเป็นอาหาร
   */
  _stepTrees(dt) {
    const canSeed = this.trees.length < CAPS.trees;
    for (let i = 0; i < this.trees.length; i++) {
      const t = this.trees[i];
      t.age += dt;
      const k = this.cellIndex(t.x, t.z);
      const moist = this.moisture[k];

      if (moist >= TREE.wiltMoisture) {
        const fert = clamp(this.nutrients[k] / NUTRIENT.comfortable, 0, 1);
        const grow = TREE.growthRate * moist * fert * t.size * (1 - t.size) * dt;
        t.size = clamp(t.size + grow, 0, 1);
        t.health = clamp(t.health + dt * 0.2, 0, 1);
        this.moisture[k] = Math.max(0, moist - TREE.drinkRate * t.size * dt * (1 - this.poolMask[k]));
        this.nutrients[k] = Math.max(0, this.nutrients[k] - grow * TREE.nutrientDraw);
      } else {
        const lack = (TREE.wiltMoisture - moist) / TREE.wiltMoisture;
        t.size = Math.max(0, t.size - TREE.wiltRate * lack * dt);
        t.health = clamp(t.health - dt * 0.25 * lack, 0, 1);
      }

      // ใบร่วงลงดินตลอดเวลา — นี่คือทางที่ต้นไม้ป้อนวงจรสารอาหาร
      const litter = TREE.litterRate * t.size * dt;
      this._addDetritus(t.x, t.z, litter);
      t.shed += litter;

      if (t.size < TREE.deathSize || t.age > t.maxAge) {
        t.alive = false;
        t.deathCause = t.age > t.maxAge ? 'old' : 'drought';
        this._addDetritus(t.x, t.z, t.size * TREE.deadwood);
        this.totals.deaths.tree++;
        this._recordDeath('tree', t.deathCause);
        continue;
      }

      if (canSeed && t.size > TREE.matureSize && this.rng() < TREE.seedRate * moist * dt) {
        this._treeSeed(t);
      }
    }
  }

  _treeSeed(parent) {
    const a = this.rng() * TAU;
    const r = this.rng.range(TREE.seedRadius[0], TREE.seedRadius[1]);
    const x = parent.x + Math.cos(a) * r;
    const z = parent.z + Math.sin(a) * r;
    if (x * x + z * z > (WORLD.radius - 1.5) ** 2) return;
    if (this.isWater(x, z)) return;
    if (this.moistureAt(x, z) < TREE.wiltMoisture) return;
    let near = 0;
    const rr = TREE.crowdRadius * TREE.crowdRadius;
    for (let i = 0; i < this.trees.length; i++) {
      if (dist2(this.trees[i].x, this.trees[i].z, x, z) < rr) {
        if (++near > TREE.crowdLimit) return;
      }
    }
    if (this.addTree(x, z)) this.totals.births.tree++;
  }

  _stepPlants(dt) {
    const plants = this.plants;
    const canSeed = plants.length < CAPS.plants;
    for (let i = 0; i < plants.length; i++) {
      const p = plants[i];
      p.age += dt;
      const k = this.cellIndex(p.x, p.z);
      const moist = this.moisture[k];

      if (moist >= PLANT.wiltMoisture) {
        // logistic growth จำกัดด้วยทั้งความชื้นและธาตุอาหารในดิน
        const fert = clamp(this.nutrients[k] / NUTRIENT.comfortable, 0, 1);
        const grow = PLANT.growthRate * moist * fert * p.size * (1 - p.size) * dt;
        p.size = clamp(p.size + grow, 0, 1);
        p.health = clamp(p.health + dt * 0.35 * (0.4 + fert * 0.6), 0, 1);
        this.moisture[k] = Math.max(0, moist - PLANT.drinkRate * p.size * dt * (1 - this.poolMask[k]));
        this.nutrients[k] = Math.max(0, this.nutrients[k] - grow * PLANT.nutrientDraw);
      } else {
        // แล้ง: เหี่ยวและหดตัว
        const lack = (PLANT.wiltMoisture - moist) / PLANT.wiltMoisture;
        p.size = Math.max(0, p.size - PLANT.wiltRate * lack * dt);
        p.health = clamp(p.health - dt * 0.5 * lack, 0, 1);
      }

      if (p.size < PLANT.deathSize || p.age > p.maxAge) {
        p.alive = false;
        p.deathCause = p.age > p.maxAge ? 'old' : 'drought';
        this._addDetritus(p.x, p.z, p.size * DETRITUS.fromPlantSize);
        this.totals.deaths.plant++;
        this._recordDeath('plant', p.deathCause);
        continue;
      }

      if (canSeed && p.size > PLANT.matureSize + 0.08 && this.rng() < PLANT.seedRate * moist * dt) {
        this._trySeed(p);
      }
    }
  }

  _trySeed(parent) {
    const a = this.rng() * TAU;
    const r = this.rng.range(PLANT.seedRadius[0], PLANT.seedRadius[1]);
    const x = parent.x + Math.cos(a) * r;
    const z = parent.z + Math.sin(a) * r;
    if (x * x + z * z > (WORLD.radius - 0.5) ** 2) return;
    if (this.isWater(x, z)) return;
    if (this.moistureAt(x, z) < PLANT.wiltMoisture) return;
    // กันพืชขึ้นแน่นเกินไป
    let near = 0;
    const rr = PLANT.crowdRadius * PLANT.crowdRadius;
    for (let i = 0; i < this.plants.length; i++) {
      if (dist2(this.plants[i].x, this.plants[i].z, x, z) < rr) {
        if (++near > PLANT.crowdLimit) return;
      }
    }
    if (this.addPlant(x, z, PLANT.seedSize)) this.totals.births.plant++;
  }

  /**
   * ผู้ย่อยสลาย: อยู่กับที่ กินซากในช่องดินของตัวเอง แล้วคืนธาตุอาหารลงดินจุดนั้น
   * ไม่มีซากให้กินก็ฝ่อและตายไป — จำนวนเห็ดราจึงสะท้อนปริมาณความตายในระบบ
   */
  _stepFungi(dt) {
    this._seedSporesFromAir(dt);
    const canSpread = this.fungi.length < CAPS.fungi;
    for (let i = 0; i < this.fungi.length; i++) {
      const f = this.fungi[i];
      f.age += dt;
      // เส้นใยแผ่ไปช่องข้างเคียงด้วย ไม่ได้กินเฉพาะช่องที่ดอกขึ้น
      const k = this._richestDetritusCell(f.x, f.z);
      const det = this.detritus[k];

      if (det > 0.002) {
        const eaten = Math.min(det, FUNGUS.digestRate * f.size * dt);
        this.detritus[k] = det - eaten;
        f.digested += eaten;
        const released = eaten * DETRITUS.toNutrient * FUNGUS.nutrientYield;
        this.nutrients[k] = clamp(this.nutrients[k] + released, 0, 1);
        this.totals.recycled += released;
        f.size = clamp(f.size + FUNGUS.growthRate * f.size * (1 - f.size) * dt, 0, 1);
      } else {
        f.size -= FUNGUS.decayRate * dt;
      }

      if (f.size < FUNGUS.deathSize || f.age > f.maxAge) {
        f.alive = false;
        f.deathCause = f.age > f.maxAge ? 'old' : 'starved';
        this.totals.deaths.fungus++;
        this._recordDeath('fungus', f.deathCause);
        continue;
      }

      if (canSpread && f.size > FUNGUS.matureSize && this.rng() < FUNGUS.spreadRate * dt) {
        this._trySpore(f);
      }
    }
  }

  /** ช่องที่มีซากมากที่สุดในละแวก 3x3 รอบจุดหนึ่ง (เส้นใยเห็ดราแผ่ไปถึง) */
  _richestDetritusCell(x, z) {
    const n = this.gridN;
    const ci = clamp(Math.floor((x + WORLD.radius) / this.cellSize), 0, n - 1);
    const cj = clamp(Math.floor((z + WORLD.radius) / this.cellSize), 0, n - 1);
    let bestK = cj * n + ci, best = this.detritus[bestK];
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= n || j >= n) continue;
        const k = j * n + i;
        if (this.detritus[k] > best) { best = this.detritus[k]; bestK = k; }
      }
    }
    return bestK;
  }

  /** แพร่สปอร์ไปยังจุดใกล้ ๆ ที่มีซากพอให้งอก */
  _trySpore(parent) {
    const a = this.rng() * TAU;
    const r = this.rng.range(FUNGUS.spreadRadius[0], FUNGUS.spreadRadius[1]);
    const x = parent.x + Math.cos(a) * r;
    const z = parent.z + Math.sin(a) * r;
    if (x * x + z * z > (WORLD.radius - 0.5) ** 2) return;
    if (this.isWater(x, z)) return;
    if (this.detritus[this.cellIndex(x, z)] < FUNGUS.sporeThreshold) return;
    let near = 0;
    const rr = FUNGUS.crowdRadius * FUNGUS.crowdRadius;
    for (let i = 0; i < this.fungi.length; i++) {
      if (dist2(this.fungi[i].x, this.fungi[i].z, x, z) < rr) {
        if (++near > FUNGUS.crowdLimit) return;
      }
    }
    if (this.addFungus(x, z)) this.totals.births.fungus++;
  }

  /**
   * ซากที่ตกใหม่มีโอกาสให้สปอร์ที่ลอยอยู่ในอากาศงอกขึ้นมาเอง
   * (ทำให้ผู้ย่อยสลายกลับมาได้แม้เคยสูญพันธุ์ เหมือนสปอร์ในเทอราเรียมจริง)
   */
  _seedSporesFromAir(dt) {
    if (this.fungi.length >= CAPS.fungi) return;
    if (this.rng() > 1.6 * dt) return;
    const n = this.gridN;
    let bestK = -1, best = FUNGUS.sporeThreshold;
    // สุ่มสำรวจไม่กี่ช่อง แล้วเลือกช่องที่ซากเยอะสุด
    for (let t = 0; t < 40; t++) {
      const k = Math.floor(this.rng() * this.detritus.length);
      if (this.detritus[k] > best) { best = this.detritus[k]; bestK = k; }
    }
    if (bestK < 0) return;
    const i = bestK % n, j = Math.floor(bestK / n);
    const c = this.cellCenter(i, j);
    const jitter = this.cellSize * 0.4;
    if (this.addFungus(c.x + this.rng.spread() * jitter, c.z + this.rng.spread() * jitter)) {
      this.totals.births.fungus++;
    }
  }

  // ------------------------------------------------------------- herbivores

  _stepHerbivores(dt) {
    const spec = HERBIVORE;
    for (let i = 0; i < this.herbivores.length; i++) {
      const h = this.herbivores[i];
      h.age += dt;
      h.breedCooldown = Math.max(0, h.breedCooldown - dt);
      h.repathIn -= dt;

      const wasEating = h.state === 'eat';
      const spotted = this._nearestPredator(h, wasEating);
      if (spotted) h.alertTimer = (h.alertTimer || 0) + dt;
      else h.alertTimer = 0;
      const reaction = wasEating ? spec.reactionEating : spec.reactionTime;
      const threat = spotted && h.alertTimer >= reaction ? spotted : null;
      let speedMul = 1;

      if (threat) {
        // หนีผู้ล่า สำคัญกว่าทุกอย่าง
        h.state = 'flee';
        const esc = this._escapePoint(h, threat);
        h.target = { kind: 'flee', id: threat.id, x: esc.x, z: esc.z };
        speedMul = spec.fleeSpeedBonus;
        h.repathIn = Math.min(h.repathIn, 0.25);
      } else {
        if (h.state === 'flee') { h.state = 'wander'; h.target = null; h.repathIn = 0; }
        const hunger = this.hungerOf(h);
        // อิ่มแล้วพักนิ่ง ๆ: ประหยัดพลังงานและผู้ล่าสังเกตเห็นยากขึ้น
        if (h.state === 'rest') {
          if (h.energy < h.maxEnergy * spec.restUntil) { h.state = 'wander'; h.repathIn = 0; }
          else { h.target = null; }
        } else if (h.state !== 'eat' && h.energy > h.maxEnergy * spec.restAt) {
          h.state = 'rest'; h.target = null;
        }
        if (h.state === 'eat') {
          const plant = h.target && h.target.kind === 'plant' ? this._plantById(h.target.id) : null;
          if (!plant || !plant.alive || dist2(h.x, h.z, plant.x, plant.z) > spec.eatRadius ** 2 * 2.2) {
            h.state = 'wander'; h.target = null; h.repathIn = 0;
          } else {
            h.actionTimer -= dt;
            if (h.actionTimer <= 0) {
              const bite = Math.min(plant.size - PLANT.grazeFloor, spec.biteSize);
              if (bite > 0.01) {
                plant.size -= bite;
                plant.health = Math.min(plant.health, 0.75);
                h.energy = Math.min(h.maxEnergy, h.energy + bite * PLANT.energyPerSize);
                // คืนสารอาหารส่วนใหญ่ลงดินเป็นมูล
                this._addDetritus(h.x, h.z, bite * DETRITUS.fromGrazing);
                h.meals++;
                h.actionTimer = spec.biteTime;
                this.totals.eaten.plant++;
              }
              // เล็มจนเหลือแค่ตอ หรืออิ่มแล้ว -> ไปหาต้นใหม่
              if (plant.size <= PLANT.grazeFloor + 0.02 || h.energy > h.maxEnergy * 0.97) {
                h.target = null; h.state = 'wander'; h.repathIn = 0;
              }
            }
          }
        } else if (h.state !== 'rest' && h.repathIn <= 0) {
          h.repathIn = this.rng.range(spec.repathEvery[0], spec.repathEvery[1]);
          const plant = hunger > 1 - spec.hungryAt ? this._findPlant(h) : null;
          if (plant) {
            h.state = 'seek';
            h.target = { kind: 'plant', id: plant.id, x: plant.x, z: plant.z };
          } else if (!h.target || h.target.kind !== 'point' || this._reached(h, 0.7)) {
            h.state = 'wander';
            h.target = this._wanderPoint(h, true);
          }
        }

        // ถ้ากำลังเดินไปหาพืชแล้วพืชหายไป ให้หาใหม่
        if (h.state === 'seek') {
          const plant = this._plantById(h.target?.id);
          if (!plant || !plant.alive) {
            h.target = null; h.state = 'wander'; h.repathIn = 0;
          } else {
            h.target.x = plant.x; h.target.z = plant.z;
            if (dist2(h.x, h.z, plant.x, plant.z) < spec.eatRadius * spec.eatRadius) {
              h.state = 'eat';
              h.actionTimer = spec.biteTime * 0.4;
            }
          }
        }
      }

      const moved = this._moveAnimal(h, spec, speedMul, dt);
      const burn = (h.state === 'rest' ? spec.metabolism * spec.restMetabolism : spec.metabolism)
        * this._basalFactor(h);
      h.energy -= (burn + spec.moveCost * moved) * dt;

      // สืบพันธุ์
      if (h.energy > spec.breedEnergy && h.age > spec.breedAge && h.breedCooldown <= 0
          && this.herbivores.length < CAPS.herbivores && h.state !== 'flee'
          && this.coverAt(h.x, h.z) > spec.breedCover) {
        h.energy -= spec.breedCost;
        h.breedCooldown = spec.breedCooldown;
        const baby = this.addHerbivore(
          h.x + this.rng.spread() * 0.8, h.z + this.rng.spread() * 0.8, spec.breedCost * 0.72,
          this._inherit(h.speedGene),
        );
        if (baby) { baby.breedCooldown = spec.breedCooldown; this.totals.births.herbivore++; }
      }

      if (h.energy <= 0 || h.age > h.maxAge) {
        h.alive = false;
        h.deathCause = h.energy <= 0 ? 'starved' : 'old';
        this._addDetritus(h.x, h.z, h.maxEnergy * DETRITUS.fromAnimalEnergy);
        this.totals.deaths.herbivore++;
        this._recordDeath('herbivore', h.deathCause);
      }
    }
  }

  // --------------------------------------------------------------- predators

  _stepPredators(dt) {
    const spec = PREDATOR;
    for (let i = 0; i < this.predators.length; i++) {
      const p = this.predators[i];
      p.age += dt;
      p.breedCooldown = Math.max(0, p.breedCooldown - dt);
      p.repathIn -= dt;

      p.restTimer = Math.max(0, (p.restTimer || 0) - dt);

      if (p.state === 'eat') {
        p.actionTimer -= dt;
        if (p.actionTimer <= 0) { p.state = 'wander'; p.target = null; p.repathIn = 0; }
      } else {
        const hunger = this.hungerOf(p);
        if (p.repathIn <= 0) {
          p.repathIn = this.rng.range(spec.repathEvery[0], spec.repathEvery[1]);
          const prey = (hunger > 1 - spec.hungryAt && p.restTimer <= 0) ? this._findPrey(p) : null;
          if (prey) {
            if (p.state !== 'hunt') p.chaseTimer = 0;
            p.state = 'hunt';
            p.target = { kind: 'herbivore', id: prey.id, x: prey.x, z: prey.z };
          } else if (!p.target || p.target.kind !== 'point' || this._reached(p, 0.7)) {
            p.state = 'wander';
            p.target = this._wanderPoint(p, false);
          }
        }
        if (p.state === 'hunt') {
          // ไล่นานเกินไปก็หมดแรง ต้องพักก่อนล่าใหม่
          p.chaseTimer = (p.chaseTimer || 0) + dt;
          const farFromHome = p.home && dist2(p.x, p.z, p.home.x, p.home.z) > spec.leash * spec.leash;
          if (p.chaseTimer > spec.chaseMax || farFromHome) {
            p.chaseTimer = 0;
            p.restTimer = spec.restTime;
            p.state = 'rest';
            p.target = this._wanderPoint(p, false);
            p.repathIn = spec.restTime;
            continue;
          }
          const prey = this._herbById(p.target?.id);
          if (!prey || !prey.alive) {
            p.target = null; p.state = 'wander'; p.repathIn = 0;
          } else {
            p.target.x = prey.x; p.target.z = prey.z;
            if (dist2(p.x, p.z, prey.x, prey.z) < spec.eatRadius * spec.eatRadius) {
              prey.alive = false;
              prey.deathCause = 'eaten';
              this._addDetritus(prey.x, prey.z,
                prey.maxEnergy * DETRITUS.fromAnimalEnergy * DETRITUS.eatenFraction);
              this.totals.deaths.herbivore++;
              this.totals.eaten.herbivore++;
              this._recordDeath('herbivore', 'eaten');
              p.energy = Math.min(p.maxEnergy, p.energy + spec.killGain);
              this._addDetritus(p.x, p.z,
                prey.maxEnergy * DETRITUS.fromAnimalEnergy * DETRITUS.fromPredation);
              p.meals++;
              p.state = 'eat';
              p.chaseTimer = 0;
              p.actionTimer = spec.eatTime;
              p.target = { kind: 'point', id: null, x: p.x, z: p.z };
            }
          }
        }
      }

      const gait = p.state === 'hunt' ? spec.huntSpeed : p.state === 'rest' ? 0.45 : 0.72;
      const moved = p.state === 'eat' ? 0 : this._moveAnimal(p, spec, gait, dt);
      p.energy -= (spec.metabolism * this._basalFactor(p) + spec.moveCost * moved) * dt;

      if (p.energy > spec.breedEnergy && p.age > spec.breedAge && p.breedCooldown <= 0
          && this.predators.length < CAPS.predators
          && this._preyNearby(p, spec.senseRadius * 1.5) >= spec.breedPreyNearby) {
        // ลูกจะเกิดได้ก็ต่อเมื่อยังมีอาณาเขตว่างให้จับจอง
        const home = this._claimTerritory(p.home.x, p.home.z);
        if (home) {
          p.energy -= spec.breedCost;
          p.breedCooldown = spec.breedCooldown;
          const baby = this.addPredator(home.x, home.z, spec.breedCost * 0.72, home,
            this._inherit(p.speedGene));
          if (baby) { baby.breedCooldown = spec.breedCooldown; this.totals.births.predator++; }
        } else {
          p.breedCooldown = spec.breedCooldown * 0.5;
        }
      }

      if (p.energy <= 0 || p.age > p.maxAge) {
        p.alive = false;
        p.deathCause = p.energy <= 0 ? 'starved' : 'old';
        this._addDetritus(p.x, p.z, p.maxEnergy * DETRITUS.fromAnimalEnergy);
        this.totals.deaths.predator++;
        this._recordDeath('predator', p.deathCause);
      }
    }
  }

  // ------------------------------------------------------------------ motion

  _moveAnimal(a, spec, speedMul, dt) {
    if (!a.target) { a.moving = Math.max(0, a.moving - dt * 3); return 0; }
    const dx = a.target.x - a.x, dz = a.target.z - a.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05 || a.state === 'eat') { a.moving = Math.max(0, a.moving - dt * 3); return 0; }

    const speed = spec.speed * a.speedGene * speedMul;
    const stepLen = Math.min(d, speed * dt);
    let nx = a.x + (dx / d) * stepLen;
    let nz = a.z + (dz / d) * stepLen;

    // กันเดินลงน้ำ: ดันออกจากแอ่งน้ำ
    const pd = Math.hypot(nx - WORLD.poolCenter.x, nz - WORLD.poolCenter.z);
    const keepOut = this.env.poolRadius + 0.35;
    if (pd < keepOut) {
      const ux = (nx - WORLD.poolCenter.x) / (pd || 1);
      const uz = (nz - WORLD.poolCenter.z) / (pd || 1);
      nx = WORLD.poolCenter.x + ux * keepOut;
      nz = WORLD.poolCenter.z + uz * keepOut;
    }
    // กันออกนอกภาชนะ
    const rd = Math.hypot(nx, nz);
    const maxR = WORLD.radius - 0.45;
    if (rd > maxR) { nx = (nx / rd) * maxR; nz = (nz / rd) * maxR; }

    const realDx = nx - a.x, realDz = nz - a.z;
    if (Math.abs(realDx) + Math.abs(realDz) > 1e-5) a.dir = Math.atan2(realDx, realDz);
    a.x = nx; a.z = nz;
    a.moving = Math.min(1, a.moving + dt * 4);
    // ต้นทุนแปรผันตามกำลังสองของความเร็ว — ตัวที่เร็วกว่าต้องหาอาหารมากกว่า
    return speedMul * a.speedGene * a.speedGene;
  }

  /**
   * จุดหลบหนี: ปกติวิ่งออกตรงข้ามผู้ล่า แต่ถ้าทิศนั้นชนขอบเกาะ
   * จะเบนไปวิ่งเลียบขอบภาชนะแทน (ไม่งั้นจะถูกต้อนจนมุมและโดนจับง่ายเกินไป)
   */
  _escapePoint(h, threat) {
    const maxR = WORLD.radius - 0.6;
    let dx = h.x - threat.x, dz = h.z - threat.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    let x = h.x + dx * 4.5, z = h.z + dz * 4.5;
    if (Math.hypot(x, z) > maxR) {
      const rl = Math.hypot(h.x, h.z) || 1;
      const rx = h.x / rl, rz = h.z / rl;
      // เวกเตอร์สัมผัสวงกลม เลือกด้านที่พาออกห่างผู้ล่า
      let tx = -rz, tz = rx;
      if (tx * dx + tz * dz < 0) { tx = rz; tz = -rx; }
      x = h.x + tx * 4.5; z = h.z + tz * 4.5;
      const rd = Math.hypot(x, z);
      if (rd > maxR) { x = (x / rd) * maxR; z = (z / rd) * maxR; }
    }
    return { x, z };
  }

  _reached(a, r = 0.6) {
    return a.target ? dist2(a.x, a.z, a.target.x, a.target.z) < r * r : true;
  }

  /**
   * เดินเตร่: สุ่มจุด 3 จุดแล้วเลือกจุดที่ดีที่สุด
   * สัตว์กินพืชเลือกจุดที่ชื้นกว่า (มักมีพืช) ส่วนผู้ล่าจะวนอยู่ในอาณาเขตของตัวเอง
   */
  _wanderPoint(a, preferMoist) {
    let best = null, bestScore = -Infinity;
    for (let k = 0; k < 3; k++) {
      const ang = a.dir + this.rng.spread() * 2.2;
      const r = this.rng.range(1.8, 5.2);
      let x = a.x + Math.sin(ang) * r;
      let z = a.z + Math.cos(ang) * r;
      if (a.home) {
        // ดึงกลับเข้าอาณาเขต
        const hx = x - a.home.x, hz = z - a.home.z;
        const hd = Math.hypot(hx, hz);
        if (hd > PREDATOR.homeRadius) {
          x = a.home.x + (hx / hd) * PREDATOR.homeRadius;
          z = a.home.z + (hz / hd) * PREDATOR.homeRadius;
        }
      }
      const rd = Math.hypot(x, z);
      if (rd > WORLD.radius - 0.6) { x = (x / rd) * (WORLD.radius - 0.6); z = (z / rd) * (WORLD.radius - 0.6); }
      const score = preferMoist ? this.moistureAt(x, z) + this.rng() * 0.2 : this.rng();
      if (score > bestScore) { bestScore = score; best = { x, z }; }
    }
    return { kind: 'point', id: null, x: best.x, z: best.z };
  }

  // ------------------------------------------------------------------ queries

  hungerOf(a) { return clamp(1 - a.energy / a.maxEnergy, 0, 1); }

  /**
   * ตัวคูณค่าใช้จ่ายพลังงานพื้นฐานตามยีนความเร็ว
   * ตัวที่เร็วกว่ามีกล้ามเนื้อมากกว่า จึงเปลืองพลังงานแม้ตอนไม่ได้วิ่ง
   */
  _basalFactor(a) {
    const k = EVOLUTION.basalCostShare;
    return (1 - k) + k * a.speedGene * a.speedGene;
  }

  /** ยีนของลูก = ยีนพ่อแม่ + กลายพันธุ์เล็กน้อย */
  _inherit(gene) {
    return clamp(gene * (1 + this.rng.spread() * EVOLUTION.mutation), EVOLUTION.min, EVOLUTION.max);
  }

  /** ค่าเฉลี่ยยีนความเร็วของประชากร (ใช้ดูทิศทางวิวัฒนาการ) */
  averageGene(list) {
    if (!list.length) return null;
    let sum = 0;
    for (let i = 0; i < list.length; i++) sum += list[i].speedGene;
    return sum / list.length;
  }

  /** ค้นเอนทิตีจากดัชนี — คืน null ถ้าไม่มีหรือชนิดไม่ตรง */
  _byId(id, kind) {
    if (id == null) return null;
    const e = this.byId.get(id);
    return e && e.kind === kind ? e : null;
  }

  _plantById(id) { return this._byId(id, 'plant'); }
  _herbById(id) { return this._byId(id, 'herbivore'); }

  /** หาพืชที่คุ้มค่าที่สุด: ใกล้และตัวใหญ่ */
  _findPlant(h) {
    const rr = HERBIVORE.senseRadius * HERBIVORE.senseRadius;
    let best = null, bestScore = Infinity;
    for (let i = 0; i < this.plants.length; i++) {
      const p = this.plants[i];
      if (p.size < 0.18) continue;
      const d2 = dist2(h.x, h.z, p.x, p.z);
      if (d2 > rr) continue;
      const score = Math.sqrt(d2) - p.size * 2.5;
      if (score < bestScore) { bestScore = score; best = p; }
    }
    return best;
  }

  /** ผู้ล่าเลือกเหยื่อที่ใกล้ที่สุด (เหยื่ออ่อนแอถูกเลือกก่อนเล็กน้อย) */
  _findPrey(p) {
    let best = null, bestScore = Infinity;
    for (let i = 0; i < this.herbivores.length; i++) {
      const h = this.herbivores[i];
      // เหยื่อที่กำลังวิ่งเห็นง่ายกว่าเหยื่อที่หยุดนิ่ง และพุ่มไม้ช่วยกำบัง
      const vis = PREDATOR.stillPreyFactor + (1 - PREDATOR.stillPreyFactor) * h.moving;
      const hidden = 1 - PREDATOR.coverHiding * this.coverAt(h.x, h.z);
      const radius = PREDATOR.senseRadius * vis * hidden;
      const rr = radius * radius;
      const d2 = dist2(p.x, p.z, h.x, h.z);
      if (d2 > rr) continue;
      let score = Math.sqrt(d2) + this.hungerOf(h) * -0.8;
      // ไม่สนใจเหยื่อที่อยู่นอกอาณาเขตมากนัก
      if (p.home && dist2(h.x, h.z, p.home.x, p.home.z) > PREDATOR.leash * PREDATOR.leash) score += 6;
      if (score < bestScore) { bestScore = score; best = h; }
    }
    return best;
  }

  /**
   * ระยะที่สัตว์กินพืช "ตกใจ" ขึ้นกับสถานการณ์:
   *  - ผู้ล่าที่กำลังไล่ล่า น่ากลัวกว่าผู้ล่าที่เดินเตร่
   *  - ตัวที่หิวจัดยอมเสี่ยงเข้าใกล้กว่าเดิม (ไม่งั้นจะเอาแต่หนีจนอดตาย)
   */
  /** นับเหยื่อในรัศมีหนึ่ง (ใช้ตัดสินว่าผู้ล่าควรออกลูกหรือไม่) */
  _preyNearby(p, radius) {
    const rr = radius * radius;
    let count = 0;
    for (let i = 0; i < this.herbivores.length; i++) {
      if (dist2(this.herbivores[i].x, this.herbivores[i].z, p.x, p.z) < rr) count++;
    }
    return count;
  }

  _nearestPredator(h, distracted = false) {
    const hungry = this.hungerOf(h);
    let factor = hungry > 0.72 ? 0.6 : 1;
    if (distracted) factor *= HERBIVORE.distractedFactor;
    let best = null, bestD = Infinity;
    for (let i = 0; i < this.predators.length; i++) {
      const p = this.predators[i];
      if (p.state === 'eat' || p.state === 'rest') continue;
      const radius = HERBIVORE.fleeRadius * (p.state === 'hunt' ? 1 : 0.6) * factor;
      const d2 = dist2(h.x, h.z, p.x, p.z);
      if (d2 < radius * radius && d2 < bestD) { bestD = d2; best = p; }
    }
    return best;
  }

  /** หาสิ่งมีชีวิตจาก id (ใช้ตอนผู้ใช้คลิกเลือก) */
  findById(id) {
    return this.byId.get(id) || null;
  }

  /** หาเป้าหมายปัจจุบันของสิ่งมีชีวิตในรูปพิกัด (สำหรับวาดเส้นเป้าหมาย) */
  targetPointOf(entity) {
    if (!entity || !entity.target) return null;
    const t = entity.target;
    if (t.kind === 'plant') { const p = this._plantById(t.id); return p ? { x: p.x, z: p.z, kind: t.kind } : null; }
    if (t.kind === 'herbivore') { const h = this._herbById(t.id); return h ? { x: h.x, z: h.z, kind: t.kind } : null; }
    if (t.kind === 'flee') { const p = this._byId(t.id, 'predator'); return p ? { x: p.x, z: p.z, kind: t.kind } : null; }
    return { x: t.x, z: t.z, kind: 'point' };
  }

  // ------------------------------------------------------------------ cleanup

  /** เอาตัวที่ตายออกจากทั้ง array และดัชนี */
  _sweep(list) {
    const kept = [];
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.alive) kept.push(e);
      else this.byId.delete(e.id);
    }
    return kept;
  }

  _cull() {
    if (this.plants.some((p) => !p.alive)) this.plants = this._sweep(this.plants);
    if (this.trees.some((t) => !t.alive)) this.trees = this._sweep(this.trees);
    if (this.fungi.some((f) => !f.alive)) this.fungi = this._sweep(this.fungi);
    if (this.herbivores.some((h) => !h.alive)) {
      this.herbivores = this._sweep(this.herbivores);
      if (!this.herbivores.length && this.extinctAt.herbivore === null) {
        this.extinctAt.herbivore = this.time;
        const r = this._buildExtinctionReport('herbivore');
        this._log('extinct', `สัตว์กินพืชสูญพันธุ์ (${CAUSE_TEXT[r.topCause] || 'ไม่ทราบสาเหตุ'})`);
      }
    }
    if (this.predators.some((p) => !p.alive)) {
      this.predators = this._sweep(this.predators);
      if (!this.predators.length && this.extinctAt.predator === null) {
        this.extinctAt.predator = this.time;
        const r = this._buildExtinctionReport('predator');
        this._log('extinct', `ผู้ล่าสูญพันธุ์ (${CAUSE_TEXT[r.topCause] || 'ไม่ทราบสาเหตุ'})`);
      }
    }
  }

  _sampleHistory() {
    this.history.push({
      t: this.time,
      trees: this.trees.length,
      plants: this.plants.length,
      herbivores: this.herbivores.length,
      predators: this.predators.length,
      fungi: this.fungi.length,
      moisture: this.averageMoisture(),
      nutrient: this.averageNutrient(),
      herbGene: this.averageGene(this.herbivores),
      predGene: this.averageGene(this.predators),
      season: Math.floor(this.seasonPhase * SEASON.names.length),
      raining: this.rainTimer > 0,
    });
    if (this.history.length > 900) this.history.shift();
  }
}

