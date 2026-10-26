// Player data: the initial burst after login (apd), profile, attributes, currency, ping.
import * as db from '../db.js';
import { xtHandlers, pbHandlers } from './registry.js';
import {
  STATUS, now, tickEnergy, pbProfile, oudPayload, attributeCostsPayload,
} from './player.js';
import { attributeCost } from './rules.js';
import { sendEquipment } from './equipment.js';
import { sendShops } from './equipment.js';
import { sendMissions, sendWork, actionProgress } from './missions.js';

// gold prices: clan, avatar change, energy refill, cut mission/s, slot machine max, cut duel/s,
// cut wanted/s, cut survival/s, cut dungeon/s, new shop items, new kiosk items, cut flight/s,
// email verification reward, level up reward, tutorial reward, gang slot unlock, bail
const GOLD_CONSTANTS = [50, 10, 10, 1, 100, 1, 1, 1, 1, 2, 2, 1, 10, 5, 10, 20, 5];

// Gang members for hire: id+pic+cash+gold+effect+value+stars+durationDays+secondsLeft
// (matches a capture from the original server)
const GANG_SHOP = '1+1+0+675+2+1+1+7+604800#2+2+0+500+0+50+1+7+604800#3+3+0+500+1+10+1+7+604800#4+4+0+325+3+2+1+7+604800#5+5+3500+0+4+2+0+7+604800#';

const ACHIEVEMENT_COUNT = 10;

export function sendProfile(ctx, p = ctx.player) {
  ctx.pb('playerprofile', { result: 1, playerId: p.id, playerName: p.name, profile: pbProfile(p) });
}

export function sendUserData(ctx, p = ctx.player) {
  ctx.xt('oud', 0, p.id, oudPayload(p));
}

export function sendCurrency(ctx) {
  const p = ctx.player;
  ctx.pb('playercurrency', { cash: Math.floor(p.cash), gold: Math.floor(p.gold), policeBadges: p.policeBadges || 0 });
}

export function sendAttributeCosts(ctx) {
  ctx.xt('auc', 0, attributeCostsPayload(ctx.player));
}

export function sendAchievements(ctx, p = ctx.player) {
  const list = [];
  for (let i = 0; i < ACHIEVEMENT_COUNT; i++) {
    const a = p.achievements?.[i] || { level: 0, value: 0, next: 10 };
    list.push(`${a.level}+${a.value}+${a.next}`);
  }
  ctx.xt('oga', 0, p.id, list.join('#') + '#');
}

export function sendPing(ctx) {
  const p = ctx.player;
  tickEnergy(p);
  const prog = actionProgress(p); // progress+time+giver+action
  const police = '0+0+0+0'; // seconds left, effect, value, bail cost
  const duelCooldown = Math.max(0, (p.nextFreeDuel || 0) - now());
  // classic status codes are the protobuf PBPlayerStatus values minus one (0 = free)
  ctx.xt('png', 0, (p.status || STATUS.FREE) - 1, p.city - 1, prog, 0, police, duelCooldown > 0 ? duelCooldown : 0, '');
}

/** Everything that changes when stats/currency change. */
export function sendStats(ctx) {
  sendUserData(ctx);
  sendCurrency(ctx);
  sendAttributeCosts(ctx);
  sendProfile(ctx);
}

export function sendAllPlayerData(ctx) {
  const p = ctx.player;
  sendAchievements(ctx);
  ctx.xt('sgc', 0, GOLD_CONSTANTS.join('+'));
  ctx.xt('oio', 0, p.email || '', 1, p.tutorialShown ? 1 : 0);
  sendProfile(ctx);
  ctx.pb('newachievements', { achievements: [] });
  ctx.pb('paymentinfo', { isPayUser: false, dopplerCount: 0 });
  sendUserData(ctx);
  sendCurrency(ctx);
  sendEquipment(ctx);
  sendShops(ctx);
  sendAttributeCosts(ctx);
  ctx.pb('getplayerbooster', { result: 1, playerID: p.id, boosters: [] });
  ctx.pb('showmissionbooster', { boosters: [] });
  sendMissions(ctx);
  sendWork(ctx);
  sendPing(ctx);
  ctx.xt('sae', 0, 0);
  ctx.xt('lfe', 0, '');
  ctx.xt('gch', 0, '');
  ctx.xt('gfl', 0, '');
  ctx.pb('getactivequests', { result: 1, quests: [], newQuestsAvailable: false });
  ctx.xt('sgs', 0, GANG_SHOP);
  ctx.xt('sga', 0, p.id, '0#0#0#0#0#', 0);
}

// ------------------------------------------------------------------ handlers

xtHandlers.png = (ctx) => ctx.player && sendPing(ctx);
xtHandlers.oud = (ctx) => ctx.player && sendUserData(ctx);
xtHandlers.sae = (ctx) => ctx.xt('sae', 0, 0);
xtHandlers.sgs = (ctx) => ctx.xt('sgs', 0, GANG_SHOP);
xtHandlers.sga = (ctx, [id]) => {
  const p = db.getPlayer(Number(id)) || ctx.player;
  if (p) ctx.xt('sga', 0, p.id, '0#0#0#0#0#', 0);
};

// tutorial finished / skipped
xtHandlers.qtu = (ctx) => {
  if (!ctx.player) return;
  ctx.player.tutorialShown = true;
  db.save();
  ctx.xt('qtu', 0);
};

// upgrade attribute: 1 attack, 2 endurance, 3 luck, 4 toughness
const ATTR_BY_TYPE = { 1: 'attack', 2: 'endurance', 3: 'luck', 4: 'toughness' };
xtHandlers.uat = (ctx, [type]) => {
  const p = ctx.player;
  const key = ATTR_BY_TYPE[Number(type)];
  if (!p || !key) return ctx.xt('uat', 1);
  if (p.freeAttributes > 0) {
    p.freeAttributes--;
  } else {
    const cost = attributeCost(p.attributes[key]);
    if (p.cash < cost) return ctx.xt('uat', 91); // not enough cash
    p.cash -= cost;
  }
  p.attributes[key]++;
  db.save();
  ctx.xt('uat', 0);
  sendStats(ctx);
};

pbHandlers.playerprofile = (ctx, req) => {
  let p = null;
  if (req.playerId) p = db.getPlayer(req.playerId);
  else if (req.playerName) p = db.findByName(req.playerName);
  else p = ctx.player;
  if (!p) return ctx.pb('playerprofile', { result: 2, playerId: req.playerId || 0, playerName: req.playerName || '' });
  sendProfile(ctx, p);
  if (p !== ctx.player && !req.shortInfo) {
    sendUserData(ctx, p);
    sendAchievements(ctx, p);
    ctx.xt('sga', 0, p.id, '0#0#0#0#0#', 0);
  }
};

pbHandlers.playercurrency = (ctx) => sendCurrency(ctx);
pbHandlers.paymentinfo = (ctx) => ctx.pb('paymentinfo', { isPayUser: false, dopplerCount: 0 });
pbHandlers.newachievements = (ctx) => ctx.pb('newachievements', { achievements: [] });
pbHandlers.getactivequests = (ctx) => ctx.pb('getactivequests', { result: 1, quests: [], newQuestsAvailable: false });
pbHandlers.getplayerbooster = (ctx) => ctx.pb('getplayerbooster', { result: 1, playerID: ctx.player?.id || 0, boosters: [] });
pbHandlers.showmissionbooster = (ctx) => ctx.pb('showmissionbooster', { boosters: [] });
