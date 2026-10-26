// PvP duels, rankings and bot opponents (so a small private server is not empty).
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as db from '../db.js';
import { log } from '../config.js';
import { xtHandlers, pbHandlers } from './registry.js';
import { TYPE, catalog, makeItem, shopSelection } from './items.js';
import { now, addXp, rankOf } from './player.js';
import { START_ATTRIBUTES, xpForLevel, randInt } from './rules.js';
import { playerFighter, simulateFight } from './fight.js';
import { sendStats, sendPing } from './account.js';
import { sendArmament, sendGear } from './equipment.js';

const avatars = JSON.parse(readFileSync(new URL('../data/avatars.json', import.meta.url), 'utf8'));
const DUEL_COOLDOWN = 10 * 60;
const MAX_ATTACKS = 10;
const BOT_COUNT = 40;

const FIRST = ['Tony', 'Vito', 'Sal', 'Frankie', 'Lucky', 'Johnny', 'Mickey', 'Carlo', 'Nicky', 'Benny', 'Paulie', 'Joey',
  'Rosa', 'Lola', 'Gina', 'Maria', 'Sonny', 'Vinnie', 'Rocco', 'Enzo'];
const LAST = ['Bones', 'Knuckles', 'The Shark', 'Moretti', 'Corleone', 'Barzini', 'Two-Times', 'Fingers', 'Russo', 'Gallo',
  'Esposito', 'The Fist', 'Capone', 'Lansky', 'Siegel', 'Costello', 'Gambino', 'Bonanno'];

function ensureBots() {
  const bots = db.allPlayers().filter((p) => p.bot);
  for (let i = bots.length; i < BOT_COUNT; i++) {
    let name;
    do { name = `${FIRST[randInt(0, FIRST.length - 1)]} ${LAST[randInt(0, LAST.length - 1)]}`; } while (db.findByName(name));
    const female = ['Rosa', 'Lola', 'Gina', 'Maria'].includes(name.split(' ')[0]);
    const level = 1 + Math.floor((i / BOT_COUNT) ** 1.5 * 45);
    const cls = randInt(1, 3);
    const base = START_ATTRIBUTES[cls];
    const extra = (level - 1) * 3;
    const p = db.createPlayer({
      bot: true, name, email: '', password: db.hashPassword(randomBytes(12).toString('hex')), created: now(),
      gender: female ? 2 : 1, characterClass: cls,
      portrait: (female ? avatars.female : avatars.male)[randInt(0, (female ? avatars.female : avatars.male).length - 1)],
      level, xp: xpForLevel(level), cash: 200 + level * level * 15, gold: 0, policeBadges: 0,
      attributes: {
        attack: base.attack + Math.round(extra * 0.3), endurance: base.endurance + Math.round(extra * 0.3),
        luck: base.luck + Math.round(extra * 0.2), toughness: base.toughness + Math.round(extra * 0.2),
      },
      freeAttributes: 0, energy: 0, energyAt: now(), city: 1, status: 1, action: null,
      wonDuels: randInt(0, level * 5), lostDuels: randInt(0, level * 4), glory: level * randInt(8, 15),
      tutorialShown: true, armament: [], gear: [], food: [], inventory: [], shops: {}, hasAvatar: true,
    });
    const [w] = shopSelection(TYPE.WEAPON, level, 1);
    if (w) { w.slotX = 0; w.slotY = 0; p.armament.push(w); }
    for (const g of shopSelection(TYPE.GEAR, level, 3)) {
      if (!p.gear.some((x) => x.subType === g.subType)) p.gear.push(g);
    }
  }
  db.save();
}
ensureBots();
log.info('bots ready');

function rankingList(listSize, around) {
  const all = db.allPlayers().sort((a, b) => b.glory - a.glory || b.level - a.level || a.id - b.id);
  let start = 0;
  if (around) {
    const idx = all.findIndex((p) => p.id === around.id);
    if (idx >= 0) start = Math.max(0, idx - Math.floor(listSize / 2));
  }
  return all.slice(start, start + listSize).map((p, i) => ({
    rank: start + i + 1, id: p.id, name: p.name, level: p.level, glory: p.glory, typeId: p.characterClass, familyId: 0, familyName: '',
  }));
}

pbHandlers.rankingsearch = (ctx, { listType = 1, value = '', listSize = 10 }) => {
  if (listType > 2) return ctx.pb('rankingsearch', { result: 1, listType, listUpdateTimeInSecs: 0, playerRankList: [], familyRankList: [] });
  let around = ctx.player;
  if (value) {
    const asRank = Number(value);
    if (Number.isInteger(asRank) && asRank > 0) {
      const all = db.allPlayers().sort((a, b) => b.glory - a.glory || b.level - a.level || a.id - b.id);
      around = all[asRank - 1] || around;
    } else {
      const found = db.findByName(value);
      if (!found) return ctx.pb('rankingsearch', { result: 2, listType });
      around = found;
    }
  }
  ctx.pb('rankingsearch', {
    result: 1, listType, listUpdateTimeInSecs: 0, playerRankList: rankingList(Math.min(listSize || 10, 50), around), familyRankList: [],
  });
};

pbHandlers.prepareduelfight = (ctx, { opponentName = '' }) => {
  const p = ctx.player;
  let opp = opponentName ? db.findByName(opponentName) : null;
  if (!opponentName) {
    // random opponent around the player's level
    const pool = db.allPlayers().filter((x) => x.id !== p.id && Math.abs(x.level - p.level) <= 3 + Math.floor(p.level / 5));
    opp = pool[randInt(0, Math.max(0, pool.length - 1))];
  }
  if (!opp) return ctx.pb('prepareduelfight', { result: 4 });
  if (opp.id === p.id) return ctx.pb('prepareduelfight', { result: 5 });
  ctx.pb('prepareduelfight', { result: 1, opponentId: opp.id, maxAttacks: MAX_ATTACKS });
  sendArmament(ctx, opp);
  sendGear(ctx, opp);
};

pbHandlers.startduel = (ctx, { opponentId }) => {
  const p = ctx.player;
  const opp = db.getPlayer(opponentId);
  if (!opp || opp.id === p.id) return ctx.pb('startduel', { result: 4 });
  const cooldown = Math.max(0, (p.nextFreeDuel || 0) - now());
  if (cooldown > 0) {
    const price = Math.ceil(cooldown / 60);
    if (p.gold < price) return ctx.pb('startduel', { result: 3 });
    p.gold -= price;
  }
  const { fight, leftWon } = simulateFight(playerFighter(p), playerFighter(opp));
  const levelDiff = opp.level - p.level;
  const glory = Math.max(1, Math.round(10 + levelDiff * 2));
  const reward = { cash: 0, xp: 0, gold: 0, activity: 0, glory: 0 };
  if (leftWon) {
    const loot = Math.min(Math.floor(opp.cash * 0.08), 50 + p.level * 40);
    reward.cash = loot;
    reward.glory = glory;
    reward.xp = Math.max(1, 5 + levelDiff + Math.floor(p.level / 2));
    p.cash += loot;
    opp.cash = Math.max(0, opp.cash - loot);
    p.glory += glory;
    opp.glory = Math.max(0, opp.glory - Math.ceil(glory / 2));
    p.wonDuels++;
    opp.lostDuels++;
    addXp(p, reward.xp);
  } else {
    reward.glory = -Math.ceil(glory / 2);
    p.glory = Math.max(0, p.glory - Math.ceil(glory / 2));
    opp.glory += Math.ceil(glory / 2);
    p.lostDuels++;
    opp.wonDuels++;
  }
  p.nextFreeDuel = now() + DUEL_COOLDOWN;
  db.save();
  ctx.pb('startduel', { result: 1, maxAttacks: MAX_ATTACKS, fight, reward });
  sendStats(ctx);
  sendPing(ctx);
};

// sdu: duel screen opponent. param '1' = look for a new opponent.
// reply: cooldown seconds, then id+name+level+family+gender+avatar+class
function pickOpponent(p) {
  const pool = db.allPlayers().filter((x) => x.id !== p.id && x.portrait && Math.abs(x.level - p.level) <= 3 + Math.floor(p.level / 5));
  const all = pool.length ? pool : db.allPlayers().filter((x) => x.id !== p.id && x.portrait);
  return all[randInt(0, Math.max(0, all.length - 1))];
}

// The client switches to the duel screen and requests data in the same frame; answering
// instantly can beat the screen's event listeners, so reply after a short delay
// (the original server had real network latency).
const SCREEN_DELAY_MS = 400;

xtHandlers.sdu = (ctx, [mode]) => {
  const p = ctx.player;
  if (!p) return;
  let opp = p.duelOpponent && db.getPlayer(p.duelOpponent);
  // '1' = screen opened (keep the current opponent), '0' = "next enemy" button
  if (mode === '0' || !opp) {
    opp = pickOpponent(p);
    p.duelOpponent = opp?.id;
    db.save();
  }
  setTimeout(() => {
    const cooldown = Math.max(0, (p.nextFreeDuel || 0) - now());
    if (!opp) return ctx.xt('sdu', 0, cooldown, '');
    // classic gender ids: 1 female, 2 male (first digit of the avatar string)
    const gender = opp.portrait.split('!')[0];
    ctx.xt('sdu', 0, cooldown, [opp.id, opp.name, opp.level, '', gender, opp.portrait, opp.characterClass].join('+'));
  }, SCREEN_DELAY_MS);
};

// vef: wanted fight info (cooldown, enemy picture, enemy class)
xtHandlers.vef = (ctx) => {
  const p = ctx.player;
  if (!p) return;
  p.wanted ??= { pic: randInt(1, 18), cls: randInt(1, 3) };
  setTimeout(() => ctx.xt('vef', 0, Math.max(0, (p.nextWanted || 0) - now()), p.wanted.pic, p.wanted.cls), SCREEN_DELAY_MS);
};

// ssu: survival cooldown
xtHandlers.ssu = (ctx) => ctx.player
  && setTimeout(() => ctx.xt('ssu', 0, Math.max(0, (ctx.player.nextSurvival || 0) - now())), SCREEN_DELAY_MS);

export { rankOf };
