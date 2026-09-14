/**
 * LIVING TERRARIUM — จุดเริ่มต้นของแอป
 * ผูกซิมูเลชัน (fixed timestep) เข้ากับฉาก 3 มิติ กราฟ และแผงควบคุม
 */
import { Ecosystem } from './simulation.js';
import { Terrarium } from './scene.js';
import { PopulationChart } from './chart.js';
import { UI } from './ui.js';
import { SIM_DT, MAX_STEPS_PER_FRAME, PRESETS, PRESET_ORDER, PLANT } from './config.js';

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];

const state = {
  playing: true,
  speedIndex: 2,
  plantMode: false,
  selection: null,
  presetId: 'balanced',
};

const canvas = document.getElementById('view');
const loading = document.getElementById('loading');

let sim;
let terrarium;
let chart;
let ui;

function boot() {
  sim = new Ecosystem(state.presetId);
  try {
    terrarium = new Terrarium(canvas);
  } catch (err) {
    loading.innerHTML = `<div style="max-width:340px;text-align:center;line-height:1.7">
      เปิดฉาก 3 มิติไม่สำเร็จ — เบราว์เซอร์นี้อาจไม่รองรับ WebGL<br>
      <small style="opacity:.6">${String(err.message || err)}</small></div>`;
    throw err;
  }
  terrarium.setPoolRadius(sim.env.poolRadius);
  terrarium.updateSoilMoisture(sim);

  chart = new PopulationChart(document.getElementById('chart'));
  ui = new UI(handlers);
  ui.setPreset(state.presetId);
  ui.setSeed(sim.seedLabel);
  ui.setSpeed(state.speedIndex, SPEEDS[state.speedIndex]);
  ui.setPlaying(state.playing);
  ui.setPlantMode(false);

  // hook สำหรับทดสอบอัตโนมัติ (ไม่กระทบการใช้งานปกติ)
  if (typeof window !== 'undefined') {
    window.__terrarium = terrarium;
    window.__sim = sim;
    window.__setSelection = (sel) => { state.selection = sel; };
  }
  bindCanvas();
  window.addEventListener('resize', onResize);
  window.addEventListener('keydown', onKey);
  onResize();
  requestAnimationFrame(loop);
}

// ------------------------------------------------------------------ handlers

const handlers = {
  onTogglePlay() {
    state.playing = !state.playing;
    ui.setPlaying(state.playing);
  },
  onStep() {
    // เดินทีละ 1 วินาทีจำลอง สำหรับดูการเปลี่ยนแปลงแบบละเอียด
    state.playing = false;
    ui.setPlaying(false);
    for (let i = 0; i < Math.round(1 / SIM_DT); i++) sim.step();
    refreshSlowVisuals(true);
  },
  onReset() { applyPreset(state.presetId, sim.seedLabel); ui.toast('เริ่มใหม่ด้วย seed เดิม'); },
  onPreset(id) {
    applyPreset(id, PRESETS[id].seed);
    ui.toast(`เปลี่ยนเป็นรูปแบบ “${PRESETS[id].name}”`);
  },
  onSeed(value) {
    const seed = String(value || '').trim() || PRESETS[state.presetId].seed;
    applyPreset(state.presetId, seed);
    ui.toast(`ใช้ seed: ${seed}`);
  },
  onSpeed(index) {
    state.speedIndex = index;
    ui.setSpeed(index, SPEEDS[index]);
  },
  onWindow(seconds) { chart.setWindow(seconds); chart.draw(sim.history); },
  onTogglePlant() {
    state.plantMode = !state.plantMode;
    ui.setPlantMode(state.plantMode);
    canvas.classList.toggle('planting', state.plantMode);
  },
  onAddAnimal(kind) {
    const p = sim.randomSoilPoint(1.2);
    const added = kind === 'herbivore' ? sim.addHerbivore(p.x, p.z) : sim.addPredator(p.x, p.z);
    if (!added) {
      ui.toast(kind === 'herbivore' ? 'สัตว์กินพืชเต็มเพดานแล้ว' : 'ผู้ล่าเต็มเพดานแล้ว');
      return;
    }
    state.selection = { kind, id: added.id };
    ui.toast(kind === 'herbivore' ? 'ปล่อยสัตว์กินพืชลงไป 1 ตัว' : 'ปล่อยผู้ล่าลงไป 1 ตัว');
  },
  onRain() {
    sim.startRain();
    ui.toast('ฝนกำลังตก ความชื้นในดินจะเพิ่มขึ้น');
  },
};

function applyPreset(id, seed) {
  state.presetId = id;
  sim.reset(id, seed);
  state.selection = null;
  terrarium.setPoolRadius(sim.env.poolRadius);
  terrarium.updateSoilMoisture(sim);
  ui.setPreset(id);
  ui.setSeed(sim.seedLabel);
  chart.draw(sim.history);
}

// -------------------------------------------------------------------- input

function bindCanvas() {
  let down = null;
  canvas.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY, t: performance.now() };
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const quick = performance.now() - down.t < 500;
    down = null;
    if (moved > 6 || !quick) return;     // ลากกล้องอยู่ ไม่ใช่การคลิกเลือก
    handleClick(e);
  });
}

function handleClick(e) {
  if (state.plantMode) {
    const spot = terrarium.pickSoil(e);
    if (!spot) return;
    if (Math.hypot(spot.x, spot.z) > 8.6) { ui.toast('ตรงนั้นชิดผนังแก้วเกินไป'); return; }
    if (sim.isWater(spot.x, spot.z)) { ui.toast('ปลูกในน้ำไม่ได้'); return; }
    const plant = sim.addPlant(spot.x, spot.z, PLANT.seedSize);
    if (!plant) { ui.toast('พืชเต็มเพดานแล้ว'); return; }
    state.selection = { kind: 'plant', id: plant.id };
    return;
  }
  const hit = terrarium.pick(e);
  state.selection = hit;
  if (!hit) return;
}

function onKey(e) {
  if (e.target instanceof HTMLInputElement) return;
  switch (e.key.toLowerCase()) {
    case ' ': e.preventDefault(); handlers.onTogglePlay(); break;
    case 'r': handlers.onReset(); break;
    case 'p': handlers.onTogglePlant(); break;
    case 'f': handlers.onRain(); break;
    case 'escape': state.selection = null; break;
    case '1': case '2': case '3': {
      const id = PRESET_ORDER[Number(e.key) - 1];
      if (id) handlers.onPreset(id);
      break;
    }
    default: break;
  }
}

function onResize() {
  terrarium.resize();
  chart.draw(sim.history);
}

// --------------------------------------------------------------------- loop

let lastFrame = performance.now();
let accumulator = 0;
let chartTimer = 0;
let soilTimer = 0;

function refreshSlowVisuals(force = false) {
  chart.draw(sim.history);
  if (force) terrarium.updateSoilMoisture(sim);
}

function loop(now) {
  const dtReal = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  if (state.playing) {
    accumulator += dtReal * SPEEDS[state.speedIndex];
    let steps = 0;
    while (accumulator >= SIM_DT && steps < MAX_STEPS_PER_FRAME) {
      sim.step();
      accumulator -= SIM_DT;
      steps++;
    }
    // ตามไม่ทัน (เช่นเพิ่งสลับแท็บกลับมา) ให้ทิ้งเวลาส่วนเกินแทนการไล่เก็บ
    if (accumulator > SIM_DT * MAX_STEPS_PER_FRAME) accumulator = 0;
  }

  // เลือกอยู่แล้วสิ่งมีชีวิตตายไป -> ยกเลิกการเลือก
  if (state.selection && !sim.findById(state.selection.id)) state.selection = null;

  terrarium.update(sim, dtReal, state.selection);
  terrarium.render();
  ui.update(sim, state.selection);

  chartTimer += dtReal;
  if (chartTimer > 0.2) { chartTimer = 0; chart.draw(sim.history); }
  soilTimer += dtReal;
  if (soilTimer > 0.35) { soilTimer = 0; terrarium.updateSoilMoisture(sim); }

  if (!loading.classList.contains('done')) {
    loading.classList.add('done');
    setTimeout(() => { loading.hidden = true; }, 600);
  }
  requestAnimationFrame(loop);
}

boot();
