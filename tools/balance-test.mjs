/**
 * ทดสอบสมดุลของระบบแบบ headless:
 *   node tools/balance-test.mjs [นาทีจำลอง]
 * พิมพ์ประชากรตามเวลา และตรวจว่า seed เดิมให้ผลลัพธ์เดิม (determinism)
 */
import { Ecosystem } from '../js/simulation.js';
import { SIM_DT, PRESET_ORDER, PRESETS } from '../js/config.js';

const minutes = Number(process.argv[2] || 6);
const totalSteps = Math.round((minutes * 60) / SIM_DT);

function run(presetId, seed, steps, { rainEvery = 0 } = {}) {
  const eco = new Ecosystem(presetId, seed);
  for (let i = 0; i < steps; i++) {
    if (rainEvery && i % Math.round(rainEvery / SIM_DT) === 0 && i > 0) eco.startRain();
    eco.step();
  }
  return eco;
}

for (const id of PRESET_ORDER) {
  const eco = new Ecosystem(id, PRESETS[id].seed);
  const marks = [];
  for (let i = 0; i < totalSteps; i++) {
    eco.step();
    if (i % Math.round(30 / SIM_DT) === 0) {
      const c = eco.counts;
      marks.push(`${Math.round(eco.time).toString().padStart(4)}s P${String(c.plants).padStart(3)} H${String(c.herbivores).padStart(2)} X${String(c.predators).padStart(2)} m${eco.averageMoisture().toFixed(2)}`);
    }
  }
  const c = eco.counts;
  console.log(`\n=== ${PRESETS[id].name} (${id}) ===`);
  console.log(marks.join('\n'));
  console.log(`สรุป: พืช ${c.plants} / กินพืช ${c.herbivores} / ผู้ล่า ${c.predators}`,
    `เกิด`, JSON.stringify(eco.totals.births), `ตาย`, JSON.stringify(eco.totals.deaths));
}

// determinism check
const a = run('balanced', 'terrarium', 4000);
const b = run('balanced', 'terrarium', 4000);
const same = JSON.stringify(a.counts) === JSON.stringify(b.counts)
  && Math.abs(a.averageMoisture() - b.averageMoisture()) < 1e-12
  && a.plants.map((p) => p.x.toFixed(6)).join() === b.plants.map((p) => p.x.toFixed(6)).join();
console.log(`\ndeterminism (seed เดิม -> ผลเดิม): ${same ? 'PASS' : 'FAIL'}`);
