// Player model: creation, derived values and conversion to protocol structures.
import * as db from '../db.js';
import { config } from '../config.js';
import { TYPE, QUALITY, catalog, makeItem } from './items.js';
import {
  CLASS, START_ATTRIBUTES, MAX_ENERGY, ENERGY_REGEN_SECONDS, ENERGY_TICK, xpForLevel, levelForXp,
  sumAttributes, combatStats, attributeCost,
} from './rules.js';

export const STATUS = { FREE: 1, MISSION: 2, FINISH_MISSION: 3, WORKING: 4, FINISH_WORKING: 5, FLYING: 6, FINISH_FLYING: 7 };
export const ARMAMENT_SIZE = { width: 5, height: 2 };
export const now = () => Math.floor(Date.now() / 1000);

export function createPlayer({ name, email, password, avatar }) {
  const cls = avatar?.characterClass || CLASS.BULLY;
  const p = db.createPlayer({
    name,
    email,
    password: db.hashPassword(password),
    created: now(),
    lastLogin: now(),
    gender: avatar?.gender || 1,
    characterClass: cls,
    portrait: avatar?.portrait || '',
    level: 1,
    xp: 0,
    cash: config.startCash,
    gold: config.startGold,
    policeBadges: 0,
    attributes: { ...START_ATTRIBUTES[cls] },
    freeAttributes: 0,
    energy: MAX_ENERGY,
    energyAt: now(),
    city: 1,
    status: STATUS.FREE,
    action: null,
    wonDuels: 0,
    lostDuels: 0,
    glory: 0,
    tutorialShown: false,
    armament: [],
    gear: [],
    food: [],
    inventory: [],
    shops: {},
    missions: null,
  });
  // starter weapon: the cheapest pistol in the catalog
  const pistol = (catalog[TYPE.WEAPON] || []).find((e) => e.subType === 1);
  if (pistol) {
    const w = makeItem(pistol, QUALITY.NORMAL, 1);
    w.slotX = 0; w.slotY = 0;
    p.armament.push(w);
  }
  db.save();
  return p;
}

export function applyAvatar(p, avatar) {
  if (!avatar) return;
  if (avatar.gender) p.gender = avatar.gender;
  if (avatar.portrait) p.portrait = avatar.portrait;
  if (avatar.characterClass && avatar.characterClass !== p.characterClass) {
    p.characterClass = avatar.characterClass;
    if (p.level === 1) p.attributes = { ...START_ATTRIBUTES[avatar.characterClass] };
  }
  db.save();
}

/** Recomputes regenerated mission energy. */
export function tickEnergy(p) {
  if (p.energy >= MAX_ENERGY) { p.energyAt = now(); return; }
  const gained = Math.floor((now() - p.energyAt) / ENERGY_REGEN_SECONDS);
  if (gained > 0) {
    p.energy = Math.min(MAX_ENERGY, p.energy + gained * ENERGY_TICK);
    p.energyAt += gained * ENERGY_REGEN_SECONDS;
    if (p.energy >= MAX_ENERGY) p.energyAt = now();
  }
}

/** Adds XP and handles level ups. Returns number of levels gained. */
export function addXp(p, xp) {
  p.xp += xp;
  const before = p.level;
  p.level = Math.max(p.level, levelForXp(p.xp));
  const gained = p.level - before;
  if (gained > 0) {
    p.freeAttributes += gained * 3;
    p.energy = MAX_ENERGY;
  }
  return gained;
}

export function equippedItems(p) {
  return [...p.armament, ...p.gear];
}

export function totalAttributes(p) {
  return sumAttributes(p.attributes, ...p.gear.map((i) => i.attributes), ...p.food.map((i) => i.attributes && {
    attack: Math.round(p.attributes.attack * (i.attributes.attack || 0) / 100),
    endurance: Math.round(p.attributes.endurance * (i.attributes.endurance || 0) / 100),
    luck: Math.round(p.attributes.luck * (i.attributes.luck || 0) / 100),
    toughness: Math.round(p.attributes.toughness * (i.attributes.toughness || 0) / 100),
  }));
}

export function playerCombatStats(p) {
  const weapons = p.armament.filter((i) => i.type === TYPE.WEAPON && i.damage);
  const wd = weapons.reduce((s, w) => s + (w.damage.min + w.damage.max) / 2, 0) / Math.max(1, weapons.length);
  return combatStats(totalAttributes(p), p.level, wd);
}

// ------------------------------------------------------------------ protocol views

/** PBItem from a stored item. */
export function pbItem(it) {
  if (!it) return undefined;
  const out = {
    id: it.id, quality: it.quality, type: it.type, costs: it.costs, isGoldPrice: !!it.isGoldPrice,
    levels: it.levels, subType: it.subType,
  };
  for (const k of ['attributes', 'damage', 'shape', 'amount', 'rounds', 'effects', 'dependencies', 'charge']) {
    if (it[k] !== undefined) out[k] = it[k];
  }
  if (it.duration) {
    const remaining = it.expires ? Math.max(0, it.expires - now()) : it.duration.remaining;
    out.duration = { total: it.duration.total, remaining };
  }
  return out;
}

export function pbProfile(p) {
  return {
    name: p.name,
    gender: p.gender,
    picString: p.portrait,
    characterClass: p.characterClass,
    attributes: totalAttributes(p),
    combatStats: playerCombatStats(p),
    highscore: { dynamic: { glory: p.glory, rank: rankOf(p) }, alltime: { glory: p.glory, rank: rankOf(p) } },
    wonDuels: p.wonDuels,
    lostDuels: p.lostDuels,
    isIgnored: false,
    level: p.level,
    cityId: p.city,
    rankInClan: 1,
  };
}

export function rankOf(p) {
  const all = db.allPlayers().sort((a, b) => b.glory - a.glory || b.level - a.level || a.id - b.id);
  return all.findIndex((x) => x.id === p.id) + 1;
}

/** '+'-separated user data for `oud`. */
export function oudPayload(p) {
  tickEnergy(p);
  const nextEnergyIn = p.energy >= MAX_ENERGY ? 0 : ENERGY_REGEN_SECONDS - (now() - p.energyAt);
  // AP, level, xp, xp@level, xp@next, energy, (unused), seconds to next energy tick, energy per tick, defense
  const fields = [
    0, p.level, p.xp, xpForLevel(p.level), xpForLevel(p.level + 1), p.energy,
    0, nextEnergyIn, ENERGY_TICK, totalAttributes(p).toughness,
  ];
  return fields.join('+');
}

export function attributeCostsPayload(p) {
  const a = p.attributes;
  return [attributeCost(a.attack), attributeCost(a.endurance), attributeCost(a.luck), attributeCost(a.toughness), p.freeAttributes].join('+');
}
