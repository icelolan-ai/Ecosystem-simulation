/**
 * แชร์การทดลองผ่าน URL
 *
 * ซิมูเลชันเป็น deterministic อยู่แล้ว (fixed timestep + seeded RNG) ดังนั้น
 * preset + seed + "ลำดับการกระทำพร้อม step ที่เกิด" ก็เพียงพอให้เล่นซ้ำได้เป๊ะ
 * ไม่ต้องบันทึกสถานะของสิ่งมีชีวิตทีละตัวเลย
 *
 * รูปแบบ: #p=<preset>&s=<seed>&a=<step><ชนิด>[@x,z]!<step><ชนิด>...
 * ตัวอย่าง: #p=balanced&s=mossgarden&a=120r!340g@-2.3,4.1!900h
 */

/** ตัวอักษรย่อของการกระทำแต่ละชนิด */
export const ACTION = {
  plant: 'g',
  herbivore: 'h',
  predator: 'x',
  rain: 'r',
};
const FROM_CODE = Object.fromEntries(Object.entries(ACTION).map(([k, v]) => [v, k]));

export function encodeActions(actions) {
  return actions.map((a) => {
    const head = `${a.step}${ACTION[a.kind]}`;
    return a.kind === 'plant' ? `${head}@${a.x.toFixed(1)},${a.z.toFixed(1)}` : head;
  }).join('!');
}

export function decodeActions(text) {
  if (!text) return [];
  const out = [];
  for (const part of text.split('!')) {
    const m = /^(\d+)([a-z])(?:@(-?[\d.]+),(-?[\d.]+))?$/.exec(part.trim());
    if (!m) continue;
    const kind = FROM_CODE[m[2]];
    if (!kind) continue;
    const action = { step: Number(m[1]), kind };
    if (m[3] !== undefined) {
      action.x = Number(m[3]);
      action.z = Number(m[4]);
      if (!Number.isFinite(action.x) || !Number.isFinite(action.z)) continue;
    }
    out.push(action);
  }
  return out.sort((a, b) => a.step - b.step);
}

/** อ่านสถานะจาก URL hash — คืน null ถ้าไม่มีหรืออ่านไม่ได้ */
export function readHash(hash = window.location.hash) {
  if (!hash || hash.length < 2) return null;
  const params = new URLSearchParams(hash.slice(1));
  const preset = params.get('p');
  if (!preset) return null;
  return {
    preset,
    seed: params.get('s') || null,
    actions: decodeActions(params.get('a')),
  };
}

/** เขียนสถานะลง URL โดยไม่เพิ่มประวัติการเข้าชม */
export function writeHash({ preset, seed, actions }) {
  const params = new URLSearchParams();
  params.set('p', preset);
  if (seed) params.set('s', String(seed));
  if (actions.length) params.set('a', encodeActions(actions));
  const url = `${window.location.pathname}${window.location.search}#${params.toString()}`;
  window.history.replaceState(null, '', url);
  return window.location.href;
}
