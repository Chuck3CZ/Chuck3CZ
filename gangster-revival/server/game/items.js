// Item catalog. The set of existing items is read from the symbol names in the
// client's item library (MafiaItemLib2_*.swf): <category>_<type>_<subtype>_<id>_<quality>.
// Stats are not part of the client, so they are generated from the item's id/level.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { config, log } from '../config.js';

export const TYPE = { GEAR: 1, FOOD: 2, WEAPON: 3, CONSUMABLE: 4, SKILL: 5, ACCESSORY: 6, EXTRA: 7 };
export const QUALITY = { NORMAL: 1, PREMIUM: 2, EPIC: 3, LEGENDARY: 4 };
const TYPE_PREFIX = { 1: 'gear_', 2: 'food_', 3: 'weapon_', 4: 'consumable_', 5: 'skill_', 6: 'accessory_', 7: 'extras_' };

function swfSymbols(path) {
  const data = readFileSync(path);
  const sig = data.subarray(0, 3).toString('latin1');
  const body = sig === 'CWS' ? inflateSync(data.subarray(8)) : data.subarray(8);
  const nbits = body[0] >> 3;
  let pos = Math.ceil((5 + nbits * 4) / 8) + 4;
  const names = [];
  while (pos < body.length) {
    const cl = body.readUInt16LE(pos); pos += 2;
    const code = cl >> 6;
    let len = cl & 0x3f;
    if (len === 0x3f) { len = body.readUInt32LE(pos); pos += 4; }
    if (code === 76) {
      const n = body.readUInt16LE(pos);
      let p = pos + 2;
      for (let i = 0; i < n; i++) {
        const end = body.indexOf(0, p + 2);
        names.push(body.subarray(p + 2, end).toString('utf8'));
        p = end + 1;
      }
    }
    pos += len;
    if (code === 0) break;
  }
  return names;
}

/** catalog[type] = [{ type, subType, id, qualities: Set }] sorted by id */
export const catalog = {};
const byKey = new Map();

export function loadCatalog() {
  if (!existsSync(config.clientDir)) return;
  const lib = readdirSync(config.clientDir).find((f) => /^MafiaItemLib2_\d+\.swf$/.test(f));
  if (!lib) return;
  for (const name of swfSymbols(join(config.clientDir, lib))) {
    const m = /^[a-z]+_(\d)_(\d+)_(\d+)_(\d)$/.exec(name);
    if (!m) continue;
    const [type, subType, id, quality] = m.slice(1).map(Number);
    if (id === 0) continue; // id 0 means "empty slot" to the client
    const key = `${type}:${id}`;
    let e = byKey.get(key);
    if (!e) {
      e = { type, subType, id, qualities: new Set() };
      byKey.set(key, e);
      (catalog[type] ??= []).push(e);
    }
    e.qualities.add(quality);
  }
  for (const list of Object.values(catalog)) list.sort((a, b) => a.id - b.id);
  log.info('item catalog:', Object.entries(catalog).map(([t, l]) => `${t}:${l.length}`).join(' '));
}

export function catalogEntry(type, id) { return byKey.get(`${type}:${id}`); }

/** Text id the client uses for an item's name. */
export function itemNameKey(type, subType, id, quality) {
  return `${TYPE_PREFIX[type]}${type === TYPE.CONSUMABLE ? 0 : subType}_${id}_${quality}`;
}

// ------------------------------------------------------------------ stat generation

const WEAPON_SHAPES = { 1: [1, 1], 2: [2, 1], 3: [3, 1], 4: [3, 1], 5: [4, 1], 6: [1, 1] };

/** Required level for an item, spread across the catalog by id rank. */
function itemLevel(entry) {
  const list = catalog[entry.type] || [entry];
  const rank = list.indexOf(entry);
  const span = entry.type === TYPE.WEAPON || entry.type === TYPE.GEAR ? 60 : 40;
  return Math.max(1, Math.round(1 + (rank / Math.max(1, list.length - 1)) * span));
}

let uidCounter = Date.now() % 100000;
export function newUid() { return ++uidCounter; }

/**
 * Builds a concrete item (stored in the player's data and sent as PBItem).
 * @param entry catalog entry
 * @param quality item quality (falls back to the best available graphic)
 * @param level player level for scaling (optional)
 */
export function makeItem(entry, quality = QUALITY.NORMAL, level) {
  const lvl = level ?? itemLevel(entry);
  const qMul = { 1: 1, 2: 1.25, 3: 1.6, 4: 2 }[quality] || 1;
  const base = Math.round((4 + lvl * 3) * qMul);
  const price = Math.round((40 + lvl * lvl * 12) * qMul);
  const item = {
    uid: newUid(),
    id: entry.id,
    type: entry.type,
    subType: entry.subType,
    quality,
    levels: { min: lvl, max: 0 },
    costs: { buy: price, sell: Math.round(price / 4) },
    isGoldPrice: false,
  };
  switch (entry.type) {
    case TYPE.WEAPON: {
      const [w, h] = WEAPON_SHAPES[entry.subType] || [1, 1];
      const shapeMul = 0.7 + 0.3 * w;
      item.damage = { min: Math.round(base * shapeMul), max: Math.round(base * shapeMul * 1.6) };
      item.shape = { width: w, height: h };
      item.rounds = entry.subType === 5 ? 2 : 0;
      break;
    }
    case TYPE.GEAR:
    case TYPE.ACCESSORY: {
      const a = Math.max(1, Math.round(base / 3));
      const s = entry.id % 4;
      item.attributes = { attack: s === 0 ? a : Math.round(a / 2), endurance: s === 1 ? a : Math.round(a / 2),
        luck: s === 2 ? a : Math.round(a / 3), toughness: s === 3 ? a : Math.round(a / 2) };
      if (entry.type === TYPE.ACCESSORY) item.shape = { width: 1, height: 1 };
      break;
    }
    case TYPE.FOOD: {
      const p = 5 + Math.round(lvl / 4);
      item.attributes = { attack: p, endurance: p, luck: 0, toughness: 0 };
      item.duration = { total: 3600, remaining: 3600 };
      item.costs = { buy: Math.round(price / 3), sell: Math.round(price / 12) };
      break;
    }
    case TYPE.CONSUMABLE: {
      item.amount = 1;
      item.shape = { width: 1, height: 1 };
      item.damage = { min: Math.round(base / 2), max: base };
      item.costs = { buy: Math.round(price / 5), sell: Math.round(price / 20) };
      break;
    }
    case TYPE.SKILL: {
      item.shape = { width: 1, height: 1 };
      break;
    }
    default:
      item.shape = { width: 1, height: 1 };
  }
  return item;
}

export function itemFor(type, id, quality = QUALITY.NORMAL, level) {
  const entry = catalogEntry(type, id);
  return entry ? makeItem(entry, quality, level) : null;
}

/** Items of a type the player can use around their level (for shops). */
export function shopSelection(type, level, count, rnd = Math.random) {
  const list = (catalog[type] || []).filter((e) => itemLevel(e) <= level + 3);
  const pool = list.length ? list : (catalog[type] || []).slice(0, count);
  const out = [];
  const picked = new Set();
  for (let i = 0; i < count * 4 && out.length < count && pool.length; i++) {
    // prefer items close to the player's level
    const idx = Math.max(0, pool.length - 1 - Math.floor(Math.abs(rnd() - rnd()) * pool.length));
    const e = pool[idx];
    if (picked.has(e) && picked.size < pool.length) continue;
    picked.add(e);
    let q = QUALITY.NORMAL;
    const r = rnd();
    if (r > 0.97 && e.qualities.has(4)) q = QUALITY.LEGENDARY;
    else if (r > 0.9 && e.qualities.has(3)) q = QUALITY.EPIC;
    else if (r > 0.75 && e.qualities.has(2)) q = QUALITY.PREMIUM;
    const it = makeItem(e, q);
    it.levels.min = Math.min(it.levels.min, level);
    out.push(it);
  }
  return out;
}

/** Generated English names for all known items (used by the fallback language file). */
export function generatedItemNames() {
  const names = {};
  const sub = {
    3: { 1: 'Pistol', 2: 'SMG', 3: 'Shotgun', 4: 'Assault Rifle', 5: 'Sniper Rifle', 6: 'Weapon' },
    1: { 1: 'Car', 2: 'House', 3: 'Pet', 4: 'Luxury Item', 5: 'Bodyguard', 6: 'Accessory', 7: 'Tattoo', 8: 'Lucky Charm' },
    4: { 1: 'Ammo', 2: 'Surprise', 3: 'Medkit', 4: 'Grenade' },
  };
  const qual = { 1: '', 2: 'Fine ', 3: 'Epic ', 4: 'Legendary ' };
  const typeName = { 2: 'Meal', 5: 'Skill', 6: 'Accessory', 7: 'Crate' };
  for (const list of Object.values(catalog)) {
    for (const e of list) {
      for (const q of [1, 2, 3, 4]) {
        const base = sub[e.type]?.[e.subType] || typeName[e.type] || 'Item';
        names[itemNameKey(e.type, e.subType, e.id, q)] = `${qual[q]}${base} #${e.id}`;
      }
    }
  }
  return names;
}
