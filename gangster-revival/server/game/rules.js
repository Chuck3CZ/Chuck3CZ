// Game formulas. The original values lived on Goodgame's servers and are lost, so
// these are tuned to feel like the original (calibrated on a few captured messages).

/** Total XP needed to reach `level`. (Captured: level 18 -> 5116, 19 -> 6263.) */
export function xpForLevel(level) {
  const l = Math.max(0, level - 1);
  return Math.round(0.24 * l ** 3.5 + 50 * l);
}

export function levelForXp(xp) {
  let level = 1;
  while (xp >= xpForLevel(level + 1) && level < 200) level++;
  return level;
}

export const MAX_ENERGY = 1000;
export const ENERGY_REGEN_SECONDS = 360; // +ENERGY_TICK mission energy every 6 minutes
export const ENERGY_TICK = 10;
export const ATTRIBUTE_POINTS_PER_LEVEL = 3;

export const CLASS = { BULLY: 1, ROGUE: 2, TACTICIAN: 3 };
export const START_ATTRIBUTES = {
  [CLASS.BULLY]: { attack: 12, endurance: 14, luck: 5, toughness: 12 },
  [CLASS.ROGUE]: { attack: 14, endurance: 10, luck: 12, toughness: 7 },
  [CLASS.TACTICIAN]: { attack: 10, endurance: 10, luck: 14, toughness: 9 },
};

/** Price in cash for raising an attribute that currently has `value` points. */
export function attributeCost(value) {
  return Math.round(10 + value ** 1.9 * 1.5);
}

export function sumAttributes(...list) {
  const out = { attack: 0, endurance: 0, luck: 0, toughness: 0 };
  for (const a of list) {
    if (!a) continue;
    for (const k of Object.keys(out)) out[k] += a[k] || 0;
  }
  return out;
}

export function combatStats(attr, level, weaponDamage = 0) {
  return {
    damage: Math.round(attr.attack * 1.5 + weaponDamage + level),
    health: Math.round(attr.endurance * 10 + level * 20),
    criticalHitChance: Math.min(0.5, attr.luck / (attr.luck + level * 8 + 40)),
    resistance: Math.min(0.6, attr.toughness / (attr.toughness + level * 6 + 40)),
    hitChance: Math.min(0.95, 0.75 + attr.attack / (attr.attack + level * 10 + 200)),
  };
}

/** Cash earned per hour of work. */
export function workCashPerHour(level) {
  return 20 + level * 12;
}

export function randInt(min, max, rnd = Math.random) {
  return min + Math.floor(rnd() * (max - min + 1));
}
