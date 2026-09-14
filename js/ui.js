/**
 * แผงควบคุมและการแสดงผลฝั่ง DOM
 * รับ callback จาก main.js แล้วอัปเดตตัวเลขจากสถานะซิมูเลชันจริง
 */
import { PRESETS, PRESET_ORDER, SPECIES_COLORS, SECONDS_PER_DAY, HERBIVORE, PREDATOR, PLANT } from './config.js';

const STATE_LABEL = {
  wander: 'เดินสำรวจ',
  seek: 'มุ่งไปหาอาหาร',
  eat: 'กำลังกิน',
  flee: 'หนีผู้ล่า',
  rest: 'พักผ่อน',
  hunt: 'กำลังไล่ล่า',
};

const KIND_LABEL = {
  plant: 'พืช',
  herbivore: 'สัตว์กินพืช',
  predator: 'ผู้ล่า',
};

const $ = (id) => document.getElementById(id);

function fmtTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export class UI {
  constructor(handlers) {
    this.h = handlers;
    this.el = {
      plants: $('statPlants'), herbs: $('statHerbs'), preds: $('statPreds'),
      trendPlants: $('trendPlants'), trendHerbs: $('trendHerbs'), trendPreds: $('trendPreds'),
      moisture: $('statMoisture'), bar: $('barMoisture'),
      time: $('statTime'), day: $('statDay'), speed: $('statSpeed'), state: $('statState'),
      inspector: $('inspector'), toast: $('toast'),
      play: $('btnPlay'), plant: $('btnPlant'), hint: $('actionHint'),
      seed: $('seedInput'), presets: $('presetList'),
      speedRange: $('speed'), speedOut: $('speedOut'),
    };
    this._lastInspect = 0;
    this._buildPresets();
    this._bind();
  }

  _buildPresets() {
    this.el.presets.innerHTML = '';
    for (const id of PRESET_ORDER) {
      const p = PRESETS[id];
      const btn = document.createElement('button');
      btn.className = 'preset';
      btn.dataset.preset = id;
      btn.innerHTML = `<b>${p.name}</b><small>${p.desc}</small>`;
      btn.addEventListener('click', () => this.h.onPreset(id));
      this.el.presets.appendChild(btn);
    }
  }

  _bind() {
    this.el.play.addEventListener('click', () => this.h.onTogglePlay());
    $('btnStep').addEventListener('click', () => this.h.onStep());
    $('btnReset').addEventListener('click', () => this.h.onReset());
    $('btnHerb').addEventListener('click', () => this.h.onAddAnimal('herbivore'));
    $('btnPred').addEventListener('click', () => this.h.onAddAnimal('predator'));
    $('btnRain').addEventListener('click', () => this.h.onRain());
    this.el.plant.addEventListener('click', () => this.h.onTogglePlant());
    $('applySeed').addEventListener('click', () => this.h.onSeed(this.el.seed.value));
    this.el.seed.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.h.onSeed(this.el.seed.value);
    });
    this.el.speedRange.addEventListener('input', () => this.h.onSpeed(Number(this.el.speedRange.value)));

    $('windowSeg').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-window]');
      if (!btn) return;
      [...e.currentTarget.children].forEach((b) => b.classList.toggle('on', b === btn));
      this.h.onWindow(Number(btn.dataset.window));
    });

    $('togglePanels').addEventListener('click', () => {
      if (window.innerWidth <= 940) document.body.classList.toggle('mobile-controls');
      else document.body.classList.toggle('panels-hidden');
    });

    const rules = $('rulesCard');
    $('rulesToggle').addEventListener('click', () => {
      const body = rules.querySelector('.card-body');
      const open = body.hasAttribute('hidden');
      body.toggleAttribute('hidden', !open);
      rules.setAttribute('open-state', open ? '1' : '0');
      $('rulesToggle').setAttribute('aria-expanded', String(open));
    });
  }

  // ------------------------------------------------------------------ output

  setPlaying(playing) {
    this.playing = playing;
    this.el.play.textContent = playing ? 'หยุดชั่วคราว' : 'เดินต่อ';
  }

  setPlantMode(on) {
    this.el.plant.classList.toggle('on', on);
    this.el.hint.textContent = on
      ? 'คลิกบนผิวดินเพื่อหยอดเมล็ด (คลิกปุ่มอีกครั้งเพื่อปิดโหมด)'
      : 'เปิดโหมดปลูกพืชแล้วคลิกบนผิวดินเพื่อหยอดเมล็ด';
  }

  setSpeed(index, multiplier) {
    this.el.speedRange.value = String(index);
    this.el.speedOut.textContent = `${multiplier.toFixed(2).replace(/\.?0+$/, '')}×`;
    this.el.speed.textContent = this.el.speedOut.textContent;
  }

  setPreset(id) {
    [...this.el.presets.children].forEach((b) => b.classList.toggle('on', b.dataset.preset === id));
  }

  setSeed(seed) { this.el.seed.value = String(seed); }

  toast(message, ms = 2200) {
    const el = this.el.toast;
    el.textContent = message;
    el.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  /** อัปเดตตัวเลขสถานะทั้งหมด (เรียกได้ทุกเฟรม ราคาถูกพอ) */
  update(sim, selection) {
    const c = sim.counts;
    this.el.plants.textContent = c.plants;
    this.el.herbs.textContent = c.herbivores;
    this.el.preds.textContent = c.predators;

    this._trend(this.el.trendPlants, sim, 'plants');
    this._trend(this.el.trendHerbs, sim, 'herbivores');
    this._trend(this.el.trendPreds, sim, 'predators');

    const moist = sim.averageMoisture();
    this.el.moisture.textContent = `${Math.round(moist * 100)}%`;
    this.el.bar.style.width = `${Math.round(moist * 100)}%`;

    this.el.time.textContent = fmtTime(sim.time);
    this.el.day.textContent = String(Math.floor(sim.time / SECONDS_PER_DAY) + 1);
    this.el.state.textContent = !this.playing ? 'หยุดชั่วคราว'
      : sim.isRaining ? 'ฝนกำลังตก' : 'กำลังเดิน';

    const now = performance.now();
    if (now - this._lastInspect > 90) {
      this._lastInspect = now;
      this._renderInspector(sim, selection);
    }
  }

  _trend(el, sim, key) {
    const h = sim.history;
    if (h.length < 16) { el.textContent = ''; return; }
    const past = h[Math.max(0, h.length - 16)][key];
    const diff = h[h.length - 1][key] - past;
    el.textContent = diff === 0 ? '' : `${diff > 0 ? '▲' : '▼'}${Math.abs(diff)}`;
    el.className = diff > 0 ? 'up' : diff < 0 ? 'down' : '';
  }

  // --------------------------------------------------------------- inspector

  _renderInspector(sim, selection) {
    const box = this.el.inspector;
    const e = selection ? sim.findById(selection.id) : null;
    if (!e) {
      if (!box.classList.contains('empty')) {
        box.classList.add('empty');
        box.innerHTML = '<p class="empty-msg">คลิกที่พืชหรือสัตว์ในภาชนะ เพื่อดูพลังงาน อายุ ความหิว และเส้นแสดงเป้าหมายปัจจุบัน</p>';
      }
      return;
    }
    box.classList.remove('empty');
    box.innerHTML = e.kind === 'plant' ? this._plantCard(sim, e) : this._animalCard(sim, e);
  }

  _bar(label, value, max, color, text) {
    const pct = Math.max(0, Math.min(1, value / max)) * 100;
    return `<div class="bar-row">
      <div class="bar-label"><span>${label}</span><b>${text}</b></div>
      <div class="bar"><i style="width:${pct.toFixed(1)}%;background:${color}"></i></div>
    </div>`;
  }

  _head(e) {
    const color = SPECIES_COLORS[e.kind];
    return `<div class="insp-head">
      <span class="dot" style="background:${color};box-shadow:0 0 10px ${color}"></span>
      <b>${KIND_LABEL[e.kind]}</b><span>#${e.id}</span>
    </div>`;
  }

  _plantCard(sim, p) {
    const moist = sim.moistureAt(p.x, p.z);
    const status = moist < PLANT.wiltMoisture ? 'ขาดน้ำ กำลังเหี่ยว'
      : p.size > PLANT.matureSize + 0.08 ? 'โตเต็มที่ พร้อมแพร่พันธุ์'
        : 'กำลังเติบโต';
    return `${this._head(p)}
      ${this._bar('ขนาด', p.size, 1, SPECIES_COLORS.plant, `${Math.round(p.size * 100)}%`)}
      ${this._bar('ความสมบูรณ์', p.health, 1, '#9ad46f', `${Math.round(p.health * 100)}%`)}
      ${this._bar('ความชื้นที่จุดนี้', moist, 1, SPECIES_COLORS.moisture, `${Math.round(moist * 100)}%`)}
      <div class="insp-facts">
        <div><small>อายุ</small><b>${p.age.toFixed(0)} / ${p.maxAge.toFixed(0)} วิ</b></div>
        <div><small>ที่กำบังรอบตัว</small><b>${Math.round(sim.coverAt(p.x, p.z) * 100)}%</b></div>
      </div>
      <div class="insp-target">สถานะ: <b>${status}</b><br>
        พืชไม่เคลื่อนที่ จึงไม่มีเป้าหมายการเดินทาง — เติบโตตามความชื้นในดินตรงจุดที่งอก</div>`;
  }

  _animalCard(sim, a) {
    const spec = a.kind === 'herbivore' ? HERBIVORE : PREDATOR;
    const hunger = sim.hungerOf(a);
    const target = sim.targetPointOf(a);
    let targetText = 'ยังไม่มีเป้าหมาย';
    if (target) {
      const d = Math.hypot(target.x - a.x, target.z - a.z).toFixed(1);
      if (target.kind === 'plant') targetText = `<b>กินพืช</b> ที่อยู่ห่าง ${d} หน่วย`;
      else if (target.kind === 'herbivore') targetText = `<b>ไล่ล่าสัตว์กินพืช</b> ห่าง ${d} หน่วย`;
      else if (target.kind === 'flee') targetText = `<b>หนีผู้ล่า</b> ที่อยู่ห่าง ${d} หน่วย`;
      else targetText = `<b>เดินไปยังจุดหมาย</b> ห่าง ${d} หน่วย`;
    }
    const canBreed = a.energy > spec.breedEnergy && a.age > spec.breedAge && a.breedCooldown <= 0;
    return `${this._head(a)}
      ${this._bar('พลังงาน', a.energy, a.maxEnergy, SPECIES_COLORS[a.kind], `${a.energy.toFixed(0)} / ${a.maxEnergy}`)}
      ${this._bar('ความหิว', hunger, 1, '#d98a4a', `${Math.round(hunger * 100)}%`)}
      ${this._bar('อายุ', a.age, a.maxAge, '#b98ad9', `${a.age.toFixed(0)} / ${a.maxAge.toFixed(0)} วิ`)}
      <div class="insp-facts">
        <div><small>สถานะ</small><b>${STATE_LABEL[a.state] || a.state}</b></div>
        <div><small>มื้อที่กินแล้ว</small><b>${a.meals}</b></div>
        <div><small>พร้อมสืบพันธุ์</small><b>${canBreed ? 'พร้อม' : `อีก ${Math.max(0, a.breedCooldown).toFixed(0)} วิ`}</b></div>
        <div><small>ที่กำบัง</small><b>${Math.round(sim.coverAt(a.x, a.z) * 100)}%</b></div>
      </div>
      <div class="insp-target">เป้าหมายตอนนี้: ${targetText}<br>
        <small style="color:rgba(246,231,211,.5)">เส้นสีในภาชนะชี้ไปยังเป้าหมายเดียวกันนี้</small></div>`;
  }
}
