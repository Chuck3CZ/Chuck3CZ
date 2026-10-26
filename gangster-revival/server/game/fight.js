// Turn-based fight simulation. The original server simulated fights and sent the
// client a replay (PBFight); this reproduces the same structure.
import { TYPE, catalog, makeItem } from './items.js';
import { combatStats } from './rules.js';
import { totalAttributes, playerCombatStats } from './player.js';

const SIDE = { LEFT: 1, RIGHT: 2 };
const HIT = { HIT: 1, EVADED: 2, MISSED: 3 };
const MAX_TURNS = 40;

function fightItem(w) {
  return { type: TYPE.WEAPON, itemId: w.id, quality: w.quality || 1, subType: w.subType || 1 };
}

function defaultWeapon(level) {
  const list = (catalog[TYPE.WEAPON] || []).filter((e) => e.subType === 1);
  const e = list[Math.min(list.length - 1, Math.floor(level / 10))] || (catalog[TYPE.WEAPON] || [])[0];
  return e ? makeItem(e, 1, level) : { id: 1, type: TYPE.WEAPON, subType: 1, quality: 1, damage: { min: 2, max: 4 } };
}

/** Fighter description from a player record. */
export function playerFighter(p) {
  const weapons = p.armament.filter((i) => i.type === TYPE.WEAPON);
  const stats = playerCombatStats(p);
  return {
    pb: {
      id: p.id, type: 1, gender: p.gender, characterClass: p.characterClass, level: p.level,
      attributes: totalAttributes(p), name: p.name, picString: p.portrait,
    },
    stats,
    hp: stats.health,
    luck: totalAttributes(p).luck,
    weapons: weapons.length ? weapons : [defaultWeapon(p.level)],
  };
}

/** NPC fighter (missions). `picId` selects an EnemyN graphic. */
export function npcFighter({ level, characterClass, picId, strength = 1 }) {
  const base = Math.round((8 + level * 2.2) * strength);
  const attributes = { attack: base, endurance: base, luck: Math.round(base * 0.7), toughness: Math.round(base * 0.8) };
  const weapon = defaultWeapon(level);
  const stats = combatStats(attributes, level, (weapon.damage.min + weapon.damage.max) / 2);
  return {
    pb: { id: picId, type: 2, gender: 1, characterClass, level, attributes },
    stats,
    hp: stats.health,
    luck: attributes.luck,
    weapons: [weapon],
  };
}

export function simulateFight(left, right, rnd = Math.random) {
  const fighters = { [SIDE.LEFT]: { ...left, cur: left.hp, wi: 0 }, [SIDE.RIGHT]: { ...right, cur: right.hp, wi: 0 } };
  const turns = [];
  let attacker = left.luck >= right.luck ? SIDE.LEFT : SIDE.RIGHT;
  let winner = null;
  for (let t = 0; t < MAX_TURNS && !winner; t++) {
    const a = fighters[attacker];
    const d = fighters[attacker === SIDE.LEFT ? SIDE.RIGHT : SIDE.LEFT];
    const weapon = a.weapons[a.wi++ % a.weapons.length];
    const hit = { weapon: fightItem(weapon), result: HIT.HIT, firstDmg: 0, secondDmg: 0, critical: false };
    if (rnd() > a.stats.hitChance) {
      hit.result = HIT.MISSED;
    } else if (rnd() < Math.min(0.3, d.luck / (d.luck + a.pb.level * 10 + 60))) {
      hit.result = HIT.EVADED;
    } else {
      const wd = weapon.damage ? weapon.damage.min + rnd() * (weapon.damage.max - weapon.damage.min) : 3;
      let dmg = wd + a.pb.attributes.attack * 0.6 + a.pb.level;
      // late-fight rage so long fights end
      if (t > 20) dmg *= 1 + (t - 20) * 0.15;
      if (rnd() < a.stats.criticalHitChance) { dmg *= 2; hit.critical = true; }
      dmg *= 1 - d.stats.resistance;
      // the client derives HP from the damage values; never go below zero
      hit.firstDmg = Math.min(d.cur, Math.max(1, Math.round(dmg)));
      d.cur -= hit.firstDmg;
    }
    turns.push({ attacker, actions: [{ type: 1, hit }] });
    if (d.cur <= 0) winner = attacker;
    attacker = attacker === SIDE.LEFT ? SIDE.RIGHT : SIDE.LEFT;
  }
  if (!winner) winner = fighters[SIDE.LEFT].cur / left.hp >= fighters[SIDE.RIGHT].cur / right.hp ? SIDE.LEFT : SIDE.RIGHT;
  return {
    fight: {
      leftFighter: { ...left.pb, totalHp: left.hp, currentHp: left.hp },
      rightFighter: { ...right.pb, totalHp: right.hp, currentHp: right.hp },
      winner,
      turns,
      leftAmmunition: [],
      rightAmmunition: [],
    },
    leftWon: winner === SIDE.LEFT,
  };
}
