/**
 * กราฟประชากรย้อนหลัง วาดด้วย Canvas 2D
 * ข้อมูลทั้งหมดมาจาก sim.history ซึ่งบันทึกจากซิมูเลชันจริงทุก 1 วินาทีจำลอง
 *
 * แบ่งเป็น 3 แถบ เพราะสเกลของแต่ละกลุ่มต่างกันมาก (พืชหลักร้อย ผู้ล่าหลักหน่วย):
 *   แถบบน   = พืช
 *   แถบกลาง = สัตว์กินพืช + ผู้ล่า
 *   แถบล่าง  = ความชื้นเฉลี่ย และช่วงที่ฝนตก
 */
import { SPECIES_COLORS } from './config.js';

const PAD = { left: 30, right: 8, top: 12, bottom: 16 };

function niceMax(v, min = 4) {
  const target = Math.max(v * 1.12, min);
  const mag = Math.pow(10, Math.floor(Math.log10(target)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (mag * m >= target) return mag * m;
  }
  return mag * 10;
}

export class PopulationChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.windowSeconds = 240;
    this.hover = null;
    canvas.addEventListener('pointermove', (e) => {
      const rect = canvas.getBoundingClientRect();
      this.hover = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    });
    canvas.addEventListener('pointerleave', () => { this.hover = null; });
  }

  setWindow(seconds) { this.windowSeconds = seconds; }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return false;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w; this.h = h;
    return true;
  }

  draw(history) {
    if (!this.resize()) return;
    const ctx = this.ctx;
    const { w, h } = this;
    ctx.clearRect(0, 0, w, h);
    if (!history.length) return;

    const tEnd = history[history.length - 1].t;
    const tStart = Math.max(0, tEnd - this.windowSeconds);
    const data = history.filter((s) => s.t >= tStart);
    if (data.length < 2) return;

    const innerW = w - PAD.left - PAD.right;
    const innerH = h - PAD.top - PAD.bottom;
    const span = Math.max(1, tEnd - tStart);
    const xOf = (t) => PAD.left + ((t - tStart) / span) * innerW;

    // แต่ละกลุ่มมีสเกลของตัวเอง เพราะจำนวนต่างกันคนละระดับ
    // (พืชหลักร้อย สัตว์กินพืชหลักสิบ ผู้ล่าหลักหน่วย) ถ้าใช้แกนเดียวจะมองไม่เห็นผู้ล่าเลย
    const series = [
      { key: 'plants', label: 'พืช', color: SPECIES_COLORS.plant, min: 20, area: true, weight: 1.05 },
      { key: 'herbivores', label: 'สัตว์กินพืช', color: SPECIES_COLORS.herbivore, min: 10, area: true, weight: 1 },
      { key: 'predators', label: 'ผู้ล่า', color: SPECIES_COLORS.predator, min: 4, area: true, weight: 0.85 },
      { key: 'fungi', label: 'ผู้ย่อยสลาย', color: SPECIES_COLORS.fungus, min: 10, area: true, weight: 0.9 },
      { key: 'moisture', label: 'ความชื้น', color: SPECIES_COLORS.moisture, min: 1, area: true, weight: 0.75, fixed: 1 },
    ];
    const gap = 7;
    const totalWeight = series.reduce((a, s2) => a + s2.weight, 0);
    const usable = innerH - gap * (series.length - 1);
    let y = PAD.top;
    for (const s2 of series) {
      s2.band = { y, h: (usable * s2.weight) / totalWeight };
      y += s2.band.h + gap;
      s2.max = s2.fixed || niceMax(Math.max(...data.map((d) => d[s2.key])), s2.min);
    }

    this._rainBands(data, xOf, PAD.top, innerH);

    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
    for (const s2 of series) {
      this._grid(s2.band, s2.max, 1);
      this._area(data, s2.band, (d) => d[s2.key], s2.max, s2.color, xOf,
        s2.key === 'moisture' ? 0.26 : 0.4);
      // ป้ายกำกับในแถบ
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(240, 222, 198, 0.5)';
      ctx.fillText(s2.fixed ? '100%' : String(s2.max), PAD.left - 4, s2.band.y + 8);
      ctx.textAlign = 'left';
      ctx.fillStyle = this._rgba(s2.color, 0.85);
      ctx.font = '10px system-ui, sans-serif';
      const last = data[data.length - 1][s2.key];
      const value = s2.fixed ? `${Math.round(last * 100)}%` : last;
      ctx.fillText(`${s2.label} ${value}`, PAD.left + 4, s2.band.y + 10);
      ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
    }

    // แกนเวลา
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(240, 222, 198, 0.45)';
    const secs = Math.round(span);
    ctx.fillText(`-${secs >= 120 ? `${Math.round(secs / 60)} นาที` : `${secs} วิ`}`, PAD.left + 20, h - 4);
    ctx.fillText('ตอนนี้', w - PAD.right - 16, h - 4);

    this._hoverReadout(data, xOf);
  }

  /** แถบไฮไลต์ช่วงที่ฝนตก */
  _rainBands(data, xOf, top, height) {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(95, 182, 201, 0.16)';
    let runStart = null;
    for (let i = 0; i < data.length; i++) {
      if (data[i].raining && runStart === null) runStart = data[i].t;
      const ended = !data[i].raining || i === data.length - 1;
      if (runStart !== null && ended) {
        const x0 = xOf(runStart);
        ctx.fillRect(x0, top, Math.max(1.5, xOf(data[i].t) - x0), height);
        runStart = null;
      }
    }
  }

  _grid(band, max, lines) {
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(255, 226, 190, 0.09)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= lines; i++) {
      const y = band.y + (band.h * i) / lines;
      ctx.beginPath();
      ctx.moveTo(PAD.left, Math.round(y) + 0.5);
      ctx.lineTo(this.w - PAD.right, Math.round(y) + 0.5);
      ctx.stroke();
    }
  }

  _area(data, band, get, max, color, xOf, alpha = 0.42) {
    const ctx = this.ctx;
    const yOf = (v) => band.y + band.h - Math.min(1, v / max) * band.h;
    ctx.beginPath();
    ctx.moveTo(xOf(data[0].t), band.y + band.h);
    for (const s of data) ctx.lineTo(xOf(s.t), yOf(get(s)));
    ctx.lineTo(xOf(data[data.length - 1].t), band.y + band.h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, band.y, 0, band.y + band.h);
    grad.addColorStop(0, this._rgba(color, alpha));
    grad.addColorStop(1, this._rgba(color, 0.03));
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    data.forEach((s, i) => (i ? ctx.lineTo(xOf(s.t), yOf(get(s))) : ctx.moveTo(xOf(s.t), yOf(get(s)))));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  _hoverReadout(data, xOf) {
    if (!this.hover) return;
    const ctx = this.ctx;
    const x = this.hover.x;
    if (x < PAD.left || x > this.w - PAD.right) return;
    let best = data[0], bestD = Infinity;
    for (const s of data) {
      const d = Math.abs(xOf(s.t) - x);
      if (d < bestD) { bestD = d; best = s; }
    }
    const px = xOf(best.t);
    ctx.strokeStyle = 'rgba(255, 226, 190, 0.35)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(px, PAD.top);
    ctx.lineTo(px, this.h - PAD.bottom);
    ctx.stroke();
    ctx.setLineDash([]);

    const label = `${Math.round(best.t)} วิ · พืช ${best.plants} · กินพืช ${best.herbivores} · ผู้ล่า ${best.predators} · เห็ดรา ${best.fungi ?? 0}`;
    ctx.font = '11px system-ui, sans-serif';
    const tw = ctx.measureText(label).width + 12;
    const bx = Math.min(Math.max(px - tw / 2, PAD.left), this.w - PAD.right - tw);
    ctx.fillStyle = 'rgba(28, 18, 12, 0.92)';
    ctx.fillRect(bx, PAD.top - 2, tw, 18);
    ctx.fillStyle = 'rgba(245, 228, 205, 0.95)';
    ctx.textAlign = 'left';
    ctx.fillText(label, bx + 6, PAD.top + 11);
  }

  _rgba(hex, a) {
    const c = hex.replace('#', '');
    const n = parseInt(c, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
}
