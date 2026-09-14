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

const SEEDS = ['terrarium', 'moss', 'glass', 'fern', 'amber', 'clay', 'leaf', 'stone'];
const SURVIVE_MINUTES = 15;
/** ต้องรอดอย่างน้อยเท่านี้ (ปัจจุบันได้ 7/8 เผื่อระยะไว้ 1 กันความผันผวน) */
const MIN_SURVIVING = 6;
/** ประชากรเฉลี่ยต้องไม่ชนเพดาน ไม่งั้นแปลว่าเพดานกลายเป็นตัวคุมระบบแทนกลไกนิเวศ */
const MAX_CAP_USAGE = 0.9;

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
  let sum = { plants: 0, herbivores: 0, predators: 0 };
  let samples = 0;
  let diedAt = null;
  for (let i = 0; i < steps; i++) {
    eco.step();
    if (diedAt === null && (!eco.herbivores.length || !eco.predators.length)) diedAt = eco.time;
    if (i % 60 === 0) {
      sum.plants += eco.plants.length;
      sum.herbivores += eco.herbivores.length;
      sum.predators += eco.predators.length;
      samples++;
    }
  }
  return {
    eco,
    diedAt,
    avg: {
      plants: sum.plants / samples,
      herbivores: sum.herbivores / samples,
      predators: sum.predators / samples,
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
console.log(`\n[2] preset "สมดุล" ต้องอยู่รอดครบ ${SURVIVE_MINUTES} นาที อย่างน้อย ${MIN_SURVIVING}/${SEEDS.length} seed`);
const runs = SEEDS.map((seed) => ({ seed, ...run('balanced', seed, SURVIVE_MINUTES) }));
{
  const alive = runs.filter((r) => r.diedAt === null);
  const dead = runs.filter((r) => r.diedAt !== null);
  record('survival', alive.length >= MIN_SURVIVING,
    `รอด ${alive.length}/${SEEDS.length}${dead.length ? ` (ล่ม: ${dead.map((d) => `${d.seed}@${d.diedAt.toFixed(0)}s`).join(', ')})` : ''}`);
}

// ───────────────────────────── 3. เพดานต้องเป็นแค่กันล้น ไม่ใช่ตัวคุมระบบ
console.log('\n[3] ประชากรต้องแกว่งอยู่ต่ำกว่าเพดาน (เพดานมีไว้คุม performance เท่านั้น)');
{
  const alive = runs.filter((r) => r.diedAt === null);
  const worst = { kind: null, usage: 0 };
  if (!alive.length) skip('headroom', 'ไม่มีรันที่รอดให้วัด (ดูข้อ survival)');
  else {
  for (const r of alive) {
    for (const [kind, cap] of [['plants', CAPS.plants], ['herbivores', CAPS.herbivores], ['predators', CAPS.predators]]) {
      const usage = r.avg[kind] / cap;
      if (usage > worst.usage) { worst.kind = `${kind} (seed ${r.seed})`; worst.usage = usage; }
    }
  }
  record('headroom', worst.usage < MAX_CAP_USAGE,
    `ใช้เพดานสูงสุด ${(worst.usage * 100).toFixed(0)}% ที่ ${worst.kind} (เกณฑ์ < ${MAX_CAP_USAGE * 100}%)`);
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
    detail = `พืช ${r.eco.plants.length} / กินพืช ${r.eco.herbivores.length} / ผู้ล่า ${r.eco.predators.length}`;
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
        marks.push(`${(eco.time / 60).toFixed(0)}m P${String(eco.plants.length).padStart(3)} H${String(eco.herbivores.length).padStart(2)} X${String(eco.predators.length).padStart(2)}`);
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
