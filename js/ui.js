/**
 * แผงควบคุมและการแสดงผลฝั่ง DOM
 * รับ callback จาก main.js แล้วอัปเดตตัวเลขจากสถานะซิมูเลชันจริง
 */
import {
  PRESETS, PRESET_ORDER, SPECIES_COLORS, SECONDS_PER_DAY,
  HERBIVORE, PREDATOR, PLANT, FUNGUS, NUTRIENT,
} from './config.js';
import { CAUSE_TEXT } from './simulation.js';

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
  fungus: 'ผู้ย่อยสลาย',
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
      plants: $('statPlants'), herbs: $('statHerbs'), preds: $('statPreds'), fungi: $('statFungi'),
      trendPlants: $('trendPlants'), trendHerbs: $('trendHerbs'),
      trendPreds: $('trendPreds'), trendFungi: $('trendFungi'),
      moisture: $('statMoisture'), bar: $('barMoisture'),
      nutrient: $('statNutrient'), barNutrient: $('barNutrient'),
      time: $('statTime'), day: $('statDay'), speed: $('statSpeed'), state: $('statState'),
      season: $('statSeason'), gene: $('statGene'),
      inspector: $('inspector'), toast: $('toast'), eventLog: $('eventLog'),
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
    $('btnShare').addEventListener('click', () => this.h.onShare());
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
    this.el.fungi.textContent = c.fungi;

    this._trend(this.el.trendPlants, sim, 'plants');
    this._trend(this.el.trendHerbs, sim, 'herbivores');
    this._trend(this.el.trendPreds, sim, 'predators');
    this._trend(this.el.trendFungi, sim, 'fungi');

    const moist = sim.averageMoisture();
    this.el.moisture.textContent = `${Math.round(moist * 100)}%`;
    this.el.bar.style.width = `${Math.round(moist * 100)}%`;

    const nutrient = sim.averageNutrient();
    this.el.nutrient.textContent = `${Math.round(nutrient * 100)}%`;
    this.el.barNutrient.style.width = `${Math.round(nutrient * 100)}%`;

    this.el.time.textContent = fmtTime(sim.time);
    this.el.day.textContent = String(Math.floor(sim.time / SECONDS_PER_DAY) + 1);
    this.el.state.textContent = !this.playing ? 'หยุดชั่วคราว'
      : sim.isRaining ? 'ฝนกำลังตก' : 'กำลังเดิน';
    this.el.season.textContent = sim.seasonName;
    const gene = sim.averageGene(sim.herbivores);
    this.el.gene.textContent = gene === null ? '—' : gene.toFixed(3);

    const now = performance.now();
    if (now - this._lastInspect > 90) {
      this._lastInspect = now;
      this._renderInspector(sim, selection);
    }
    if (now - (this._lastLog || 0) > 400) {
      this._lastLog = now;
      this._renderEventLog(sim);
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

  /**
   * บันทึกเหตุการณ์ + รายงานชันสูตรตอนสายพันธุ์สูญพันธุ์
   * ใช้ข้อมูลที่ซิมูเลชันเก็บอยู่แล้ว (events, causes, extinctionReports)
   */
  _renderEventLog(sim) {
    const signature = `${sim.events.length}|${sim.extinctionReports.length}|${Math.floor(sim.time)}`;
    if (signature === this._logSignature) return;
    this._logSignature = signature;

    const parts = [];
    for (const r of sim.extinctionReports.slice(-2)) parts.push(this._postmortem(r));

    const recent = sim.events.slice(-7).reverse();
    if (recent.length) {
      for (const e of recent) {
        parts.push(`<div class="event-row" data-type="${e.type}">
          <time>${fmtTime(e.t)}</time><span>${e.text}</span></div>`);
      }
    } else if (!parts.length) {
      parts.push('<p class="empty-msg">ยังไม่มีเหตุการณ์สำคัญ</p>');
    }
    this.el.eventLog.innerHTML = parts.join('');
  }

  _postmortem(r) {
    const name = KIND_LABEL[r.kind];
    const causes = Object.entries(r.tally)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${CAUSE_TEXT[k] || k} ${v}`)
      .join(' · ') || 'ไม่มีข้อมูล';
    const plants = r.avgPlants === null ? '—' : r.avgPlants.toFixed(0);
    return `<div class="postmortem">
      <div class="pm-head"><b>${name}สูญพันธุ์</b> ที่ ${fmtTime(r.time)}</div>
      <div class="pm-detail">
        ${r.window} วินาทีก่อนหน้า ตายไป <em>${r.total}</em> ตัว — ${causes}<br>
        ช่วงนั้นมีพืชเฉลี่ย <em>${plants}</em> ต้น · ผู้ล่า <em>${r.predators}</em> ตัว ·
        ความชื้น <em>${Math.round(r.moisture * 100)}%</em> · ${r.season}
      </div>
    </div>`;
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
    box.innerHTML = e.kind === 'plant' ? this._plantCard(sim, e)
      : e.kind === 'fungus' ? this._fungusCard(sim, e)
        : this._animalCard(sim, e);
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
    const nutrient = sim.nutrientAt(p.x, p.z);
    const fert = Math.min(1, nutrient / NUTRIENT.comfortable);
    const status = moist < PLANT.wiltMoisture ? 'ขาดน้ำ กำลังเหี่ยว'
      : fert < 0.6 ? 'ดินจืด โตได้ช้ากว่าปกติ'
        : p.size > PLANT.matureSize + 0.08 ? 'โตเต็มที่ พร้อมแพร่พันธุ์'
          : 'กำลังเติบโต';
    return `${this._head(p)}
      ${this._bar('ขนาด', p.size, 1, SPECIES_COLORS.plant, `${Math.round(p.size * 100)}%`)}
      ${this._bar('ความสมบูรณ์', p.health, 1, '#9ad46f', `${Math.round(p.health * 100)}%`)}
      ${this._bar('ความชื้นที่จุดนี้', moist, 1, SPECIES_COLORS.moisture, `${Math.round(moist * 100)}%`)}
      ${this._bar('ธาตุอาหารที่จุดนี้', nutrient, 1, SPECIES_COLORS.fungus, `${Math.round(nutrient * 100)}%`)}
      <div class="insp-facts">
        <div><small>อายุ</small><b>${p.age.toFixed(0)} / ${p.maxAge.toFixed(0)} วิ</b></div>
        <div><small>ที่กำบังรอบตัว</small><b>${Math.round(sim.coverAt(p.x, p.z) * 100)}%</b></div>
      </div>
      <div class="insp-target">สถานะ: <b>${status}</b><br>
        พืชไม่เคลื่อนที่ จึงไม่มีเป้าหมายการเดินทาง — เติบโตตามความชื้นในดินตรงจุดที่งอก</div>`;
  }

  _fungusCard(sim, f) {
    const detritus = sim.detritusAt(f.x, f.z);
    const nutrient = sim.nutrientAt(f.x, f.z);
    const status = detritus > 0.01 ? 'กำลังย่อยซาก' : 'ไม่มีซากเหลือแล้ว กำลังฝ่อ';
    return `${this._head(f)}
      ${this._bar('ขนาดดอก', f.size, 1, SPECIES_COLORS.fungus, `${Math.round(f.size * 100)}%`)}
      ${this._bar('ซากในบริเวณนี้', detritus, 0.6, '#b08968', detritus.toFixed(2))}
      ${this._bar('ธาตุอาหารที่จุดนี้', nutrient, 1, SPECIES_COLORS.fungus, `${Math.round(nutrient * 100)}%`)}
      <div class="insp-facts">
        <div><small>อายุ</small><b>${f.age.toFixed(0)} / ${f.maxAge.toFixed(0)} วิ</b></div>
        <div><small>ย่อยไปแล้ว</small><b>${f.digested.toFixed(2)} หน่วย</b></div>
      </div>
      <div class="insp-target">สถานะ: <b>${status}</b><br>
        ผู้ย่อยสลายอยู่กับที่เหมือนพืช จึงไม่มีเป้าหมายการเดินทาง —
        กินซากและมูลสัตว์ในบริเวณนั้น แล้วคืนธาตุอาหารกลับลงดินให้พืชใช้ต่อ</div>`;
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
    const popGene = sim.averageGene(a.kind === 'herbivore' ? sim.herbivores : sim.predators);
    const diff = popGene === null ? 0 : (a.speedGene - popGene);
    const geneVsPop = Math.abs(diff) < 0.005 ? 'พอ ๆ กับฝูง'
      : `${diff > 0 ? 'เร็วกว่า' : 'ช้ากว่า'} ${(Math.abs(diff) * 100).toFixed(1)}%`;
    return `${this._head(a)}
      ${this._bar('พลังงาน', a.energy, a.maxEnergy, SPECIES_COLORS[a.kind], `${a.energy.toFixed(0)} / ${a.maxEnergy}`)}
      ${this._bar('ความหิว', hunger, 1, '#d98a4a', `${Math.round(hunger * 100)}%`)}
      ${this._bar('อายุ', a.age, a.maxAge, '#b98ad9', `${a.age.toFixed(0)} / ${a.maxAge.toFixed(0)} วิ`)}
      <div class="insp-facts">
        <div><small>สถานะ</small><b>${STATE_LABEL[a.state] || a.state}</b></div>
        <div><small>มื้อที่กินแล้ว</small><b>${a.meals}</b></div>
        <div><small>พร้อมสืบพันธุ์</small><b>${canBreed ? 'พร้อม' : `อีก ${Math.max(0, a.breedCooldown).toFixed(0)} วิ`}</b></div>
        <div><small>ที่กำบัง</small><b>${Math.round(sim.coverAt(a.x, a.z) * 100)}%</b></div>
        <div><small>ยีนความเร็ว</small><b>${a.speedGene.toFixed(3)}</b></div>
        <div><small>เทียบฝูง</small><b>${geneVsPop}</b></div>
      </div>
      <div class="insp-target">เป้าหมายตอนนี้: ${targetText}<br>
        <small style="color:rgba(246,231,211,.5)">เส้นสีในภาชนะชี้ไปยังเป้าหมายเดียวกันนี้</small></div>`;
  }
}
