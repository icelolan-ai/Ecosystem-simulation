/**
 * Seeded pseudo random number generator (mulberry32).
 * ทุกค่าสุ่มในซิมูเลชันมาจากตัวนี้ทั้งหมด เพื่อให้ผลลัพธ์ทำซ้ำได้ (deterministic)
 * เมื่อใช้ seed เดิม + ลำดับการกระทำเดิม
 */
export function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  const rng = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.range = (min, max) => min + (max - min) * rng();
  rng.int = (min, max) => Math.floor(rng.range(min, max + 1));
  rng.chance = (p) => rng() < p;
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  /** ค่าสุ่มแบบกระจายรอบ 0 (ประมาณ normal) ใช้สำหรับการกลายพันธุ์เล็กน้อย */
  rng.spread = () => (rng() + rng() + rng() - 1.5) / 1.5;
  return rng;
}

/** แปลงข้อความเป็นตัวเลข seed (FNV-1a) เพื่อให้ผู้ใช้พิมพ์ seed เป็นคำได้ */
export function hashSeed(text) {
  const str = String(text ?? '');
  if (/^\d+$/.test(str.trim()) && str.trim().length <= 9) return parseInt(str.trim(), 10) >>> 0;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
