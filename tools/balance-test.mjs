/**
 * ทดสอบแกนซิมูเลชันแบบ headless
 *
 *   node tools/balance-test.mjs          ตรวจอย่างเดียว (โหมดที่ CI ใช้)
 *   node tools/balance-test.mjs --trace  พิมพ์เส้นทางประชากรของทั้ง 3 preset ด้วย
 *
 * **สำคัญ**: สคริปต์นี้ต้อง exit ด้วยรหัส 1 เมื่อตรวจไม่ผ่าน
 * ค่าสมดุลของระบบถูกจูนมาอย่างละเอียด การแก้ตัวเลขใน config.js เพียงเล็กน้อย
 * ก็ทำให้ระบบล่มได้เงียบ ๆ การตรวจชุดนี้คือตาข่ายกันพลาดของโปรเจกต์
 */
import { Ecosystem } from '../js/simulation.js';
import { SIM_DT, CAPS, PRESET_ORDER, PRESETS } from '../js/config.js';

/**
 * seed กลาง ๆ ที่ไม่ได้คัดมา — ใช้วัดเสถียรภาพของ "ระบบ" ไม่ใช่ของ seed ที่โชคดี
 * (เวอร์ชันแรกของไฟล์นี้ใช้ seed ที่คัดมา 8 ตัวแล้วได้ 7/8 ซึ่งสูงเกินจริงมาก
 *  วัดด้วย seed กลาง 40 ตัวได้ราว 48% ตัวเลขนั้นคือค่าจริงของระบบ)
 */
const SEEDS = Array.from({ length: 24 }, (_, i) => `s${i}`);
const SURVIVE_MINUTES = 15;
/** เกณฑ์ขั้นต่ำ ตั้งต่ำกว่าค่าที่วัดได้จริง (~48%) พอให้จับ regression โดยไม่ flaky */
const MIN_SURVIVING = 8;
/**
 * สัดส่วนเวลาสูงสุดที่ยอมให้ประชากร "ค้าง" เหนือ 90% ของเพดาน
 *
 * ข้อเท็จจริงที่วัดได้: เพดานในโปรเจกต์นี้ไม่ได้เป็นแค่ตัวคุม performance อย่างที่
 * เอกสารรุ่นแรกอ้างไว้ ตอนประชากรบูม เพดานจะตัดยอดและการตัดยอดนั้นช่วยพยุงระบบจริง
 * (ทดลองยกเพดานขึ้นแล้วอัตราการอยู่รอดตกลง เพราะ overshoot แรงขึ้น)
 * การตรวจนี้จึงไม่ได้ห้ามแตะเพดาน แต่กันกรณีเสื่อม คือประชากรนอนอยู่ที่เพดานตลอดเวลา
 * จนกลไกนิเวศไม่มีความหมาย
 */
const MAX_SATURATION = 0.85;

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  ✓' : '  ✗'} ${name} — ${detail}`);
};
/** ข้อที่ประเมินไม่ได้ (เช่นไม่มีรันที่รอดให้วัด) ไม่นับว่าไม่ผ่าน แต่ต้องไม่แสดงเป็น ✓ ลวงตา */
const skip = (name, detail) => console.log(`  · ${name} — ข้าม: ${detail}`);

/** เดินซิมูเลชันจนครบเวลา หรือจนกว่าจะมีสายพันธุ์ใดสูญพันธุ์ */
function run(presetId, seed, minutes) {
  const eco = new Ecosystem(presetId, seed);
  const steps = Math.round((minutes * 60) / SIM_DT);
  let sum = { plants: 0, herbivores: 0, predators: 0, fungi: 0 };
  let samples = 0;
  let diedAt = null;
  let saturated = 0;
  for (let i = 0; i < steps; i++) {
    eco.step();
    if (diedAt === null && (!eco.herbivores.length || !eco.predators.length)) diedAt = eco.time;
    if (i % 60 === 0) {
      sum.plants += eco.plants.length;
      sum.herbivores += eco.herbivores.length;
      sum.predators += eco.predators.length;
      sum.fungi += eco.fungi.length;
      const usage = Math.max(eco.plants.length / CAPS.plants, eco.herbivores.length / CAPS.herbivores,
        eco.fungi.length / CAPS.fungi);
      if (usage > 0.9) saturated++;
      samples++;
    }
  }
  return {
    eco,
    diedAt,
    saturation: samples ? saturated / samples : 0,
    avg: {
      plants: sum.plants / samples,
      herbivores: sum.herbivores / samples,
      predators: sum.predators / samples,
      fungi: sum.fungi / samples,
    },
  };
}

// ───────────────────────────── 1. ทำซ้ำได้ (determinism)
console.log('\n[1] seed เดิมต้องให้ผลลัพธ์เดิมทุกครั้ง');
{
  const snapshot = (eco) => JSON.stringify({
    counts: eco.counts,
    moisture: eco.averageMoisture().toFixed(9),
    plants: eco.plants.map((p) => `${p.x.toFixed(6)},${p.z.toFixed(6)},${p.size.toFixed(6)}`),
    herbivores: eco.herbivores.map((h) => `${h.x.toFixed(6)},${h.energy.toFixed(6)},${h.state}`),
    predators: eco.predators.map((p) => `${p.x.toFixed(6)},${p.energy.toFixed(6)},${p.state}`),
  });
  const a = snapshot(run('balanced', 'terrarium', 3).eco);
  const b = snapshot(run('balanced', 'terrarium', 3).eco);
  record('determinism', a === b, a === b ? 'สองรันให้สถานะตรงกันทุกตัว' : 'สองรันด้วย seed เดียวกันให้ผลต่างกัน');
}

// ───────────────────────────── 2. ระบบต้องอยู่รอดได้นานพอ
console.log(`\n[2] ระบบต้องอยู่รอดครบ ${SURVIVE_MINUTES} นาที อย่างน้อย ${MIN_SURVIVING}/${SEEDS.length} seed (seed กลาง ไม่ได้คัดมา)`);
const runs = SEEDS.map((seed) => ({ seed, ...run('balanced', seed, SURVIVE_MINUTES) }));
{
  const alive = runs.filter((r) => r.diedAt === null);
  const dead = runs.filter((r) => r.diedAt !== null);
  record('survival', alive.length >= MIN_SURVIVING,
    `รอด ${alive.length}/${SEEDS.length}${dead.length ? ` (ล่ม: ${dead.map((d) => `${d.seed}@${d.diedAt.toFixed(0)}s`).join(', ')})` : ''}`);
}

// ───────────────────────────── 2b. seed ที่แถมมากับ preset ต้องอยู่รอดจริง
console.log(`\n[2b] seed ของ preset "สมดุล" (สิ่งที่ผู้ใช้เห็นตอนเปิดเว็บ) ต้องรอดครบ ${SURVIVE_MINUTES} นาที`);
{
  const r = run('balanced', PRESETS.balanced.seed, SURVIVE_MINUTES);
  record(`preset seed "${PRESETS.balanced.seed}"`, r.diedAt === null,
    r.diedAt === null
      ? `รอด (พืช ${r.eco.plants.length} / กินพืช ${r.eco.herbivores.length} / ผู้ล่า ${r.eco.predators.length} / เห็ดรา ${r.eco.fungi.length})`
      : `ล่มที่ ${r.diedAt.toFixed(0)}s — ผู้ใช้จะเห็นระบบตายก่อนได้ดูอะไร`);
}

// ───────────────────────────── 2c. วงจรสารอาหารต้องหมุนจริง
console.log('\n[2c] ผู้ย่อยสลายต้องทำงานจริง ไม่ใช่ของประดับ');
{
  const r = run('balanced', PRESETS.balanced.seed, 8);
  const eco = r.eco;
  record('decomposers', eco.fungi.length > 0 && eco.totals.recycled > 10,
    `เห็ดรา ${eco.fungi.length} ดอก คืนธาตุอาหารสะสม ${eco.totals.recycled.toFixed(0)} หน่วย ซากคงค้าง ${eco.totalDetritus().toFixed(1)}`);
  // ธาตุอาหารต้องไม่ไหลลงเหวจนดินจืดถาวร
  record('soil not exhausted', eco.averageNutrient() > 0.15,
    `ธาตุอาหารเฉลี่ยในดิน ${eco.averageNutrient().toFixed(3)} (เกณฑ์ > 0.15)`);
}

// ───────────────────────────── 3. เพดานต้องไม่กลายเป็นที่นอนถาวรของประชากร
console.log('\n[3] ประชากรต้องไม่นอนค้างอยู่ที่เพดานตลอดเวลา');
{
  const alive = runs.filter((r) => r.diedAt === null);
  if (!alive.length) {
    skip('saturation', 'ไม่มีรันที่รอดให้วัด (ดูข้อ survival)');
  } else {
    let worst = { seed: null, share: 0 };
    for (const r of alive) {
      if (r.saturation > worst.share) worst = { seed: r.seed, share: r.saturation };
    }
    record('saturation', worst.share < MAX_SATURATION,
      `ค้างเหนือ 90% ของเพดานนานสุด ${(worst.share * 100).toFixed(0)}% ของเวลา `
      + `(seed ${worst.seed}, เกณฑ์ < ${MAX_SATURATION * 100}%)`);
  }
}

// ───────────────────────────── 4. ทุก preset ต้องเดินได้โดยไม่พัง
console.log('\n[4] ทุก preset ต้องเดินได้ 5 นาทีโดยไม่ error และพืชไม่สูญพันธุ์');
for (const id of PRESET_ORDER) {
  let ok = true;
  let detail = '';
  try {
    const r = run(id, PRESETS[id].seed, 5);
    ok = r.eco.plants.length > 0;
    detail = `พืช ${r.eco.plants.length} / กินพืช ${r.eco.herbivores.length} / ผู้ล่า ${r.eco.predators.length} / เห็ดรา ${r.eco.fungi.length}`;
  } catch (err) {
    ok = false;
    detail = `throw: ${err.message}`;
  }
  record(`preset "${PRESETS[id].name}"`, ok, detail);
}

// ───────────────────────────── โหมด --trace (ไม่ใช่การตรวจ)
if (process.argv.includes('--trace')) {
  console.log('\n[trace] เส้นทางประชากร 10 นาทีของแต่ละ preset');
  for (const id of PRESET_ORDER) {
    const eco = new Ecosystem(id, PRESETS[id].seed);
    const marks = [];
    for (let i = 0; i < Math.round(600 / SIM_DT); i++) {
      eco.step();
      if (i % Math.round(60 / SIM_DT) === 0) {
        marks.push(`${(eco.time / 60).toFixed(0)}m P${String(eco.plants.length).padStart(3)} H${String(eco.herbivores.length).padStart(2)} X${String(eco.predators.length).padStart(2)} F${String(eco.fungi.length).padStart(3)}`);
      }
    }
    console.log(`  ${PRESETS[id].name}: ${marks.join(' | ')}`);
  }
}

// ───────────────────────────── สรุป
const failed = results.filter((r) => !r.pass);
console.log(`\n${'─'.repeat(60)}`);
if (failed.length) {
  console.log(`ไม่ผ่าน ${failed.length}/${results.length} ข้อ: ${failed.map((f) => f.name).join(', ')}`);
  process.exit(1);
}
console.log(`ผ่านครบ ${results.length}/${results.length} ข้อ`);
