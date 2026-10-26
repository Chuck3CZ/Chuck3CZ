// Godfather missions and work.
import * as db from '../db.js';
import { config } from '../config.js';
import { pbHandlers } from './registry.js';
import { TYPE, QUALITY, catalog, makeItem } from './items.js';
import { STATUS, now, tickEnergy, addXp, pbItem } from './player.js';
import { workCashPerHour, randInt } from './rules.js';
import { playerFighter, npcFighter, simulateFight } from './fight.js';
import { sendStats, sendPing, sendUserData } from './account.js';
import { sendInventory } from './equipment.js';

const MISSIONS_PER_CITY = 3;
const WORK_MAX_HOURS = 10;

function scaled(seconds) {
  return Math.max(5, Math.round(seconds * config.timeScale));
}

function newMission(p, nr) {
  const lvl = p.level;
  const durations = [60, 180, 300, 600, 900];
  const time = durations[randInt(0, Math.min(durations.length - 1, 1 + Math.floor(lvl / 5)))];
  const mins = time / 60;
  const m = {
    id: randInt(1, 1000),
    cash: Math.round((15 + lvl * 6) * (0.6 + mins * 0.4) * (0.8 + Math.random() * 0.4)),
    xp: Math.round((8 + lvl * 2) * (0.6 + mins * 0.35) * (0.8 + Math.random() * 0.4)),
    activity: Math.round(60 + mins * 20),
    time,
    opponentClass: randInt(1, 3),
    picId: randInt(1, 19),
    nr,
  };
  // sometimes an item reward
  if (Math.random() < 0.25) {
    const types = [TYPE.WEAPON, TYPE.GEAR, TYPE.FOOD, TYPE.CONSUMABLE];
    const list = (catalog[types[randInt(0, types.length - 1)]] || []);
    const near = list.filter((e) => e.qualities.has(1)).slice(0, Math.max(3, Math.floor(lvl / 2) + 3));
    const e = near[randInt(0, near.length - 1)];
    if (e) m.item = makeItem(e, Math.random() < 0.15 && e.qualities.has(2) ? QUALITY.PREMIUM : QUALITY.NORMAL, lvl);
  }
  return m;
}

function missions(p) {
  if (!p.missions || p.missions.length !== MISSIONS_PER_CITY) {
    p.missions = Array.from({ length: MISSIONS_PER_CITY }, (_, i) => newMission(p, i));
    db.save();
  }
  return p.missions;
}

function pbMission(m) {
  return { id: m.id, cash: m.cash, xp: m.xp, activity: m.activity, time: scaled(m.time), opponentClass: m.opponentClass, item: m.item ? pbItem(m.item) : undefined };
}

/** progress string for ping: elapsed+remaining+giver+actionId */
export function actionProgress(p) {
  const a = p.action;
  if (!a) return '0+0+0+0';
  const elapsed = Math.max(0, now() - a.start);
  const remaining = a.end ? Math.max(0, a.end - now()) : 0;
  if (a.type === 'mission' && remaining === 0 && p.status === STATUS.MISSION) p.status = STATUS.FINISH_MISSION;
  return `${elapsed}+${remaining}+${a.giver || 0}+${a.id || 0}`;
}

export function sendMissions(ctx) {
  const p = ctx.player;
  tickEnergy(p);
  const busy = p.status !== STATUS.FREE;
  ctx.pb('viewmissions', {
    result: busy ? 2 : 1,
    energyRefiller: 0,
    freeMissionEnergyDrinks: 0,
    maxEnergyRefill: 10,
    missionEnergy: p.energy,
    missions: missions(p).map(pbMission),
  });
}

export function sendWork(ctx) {
  const p = ctx.player;
  const working = p.action?.type === 'work';
  ctx.pb('viewwork', {
    result: p.status === STATUS.FREE || working ? 1 : 2,
    moneyPerHour: workCashPerHour(p.level),
    currentWorkDuration: working ? Math.min(WORK_MAX_HOURS * 3600, now() - p.action.start) : 0,
  });
}

pbHandlers.viewmissions = (ctx) => ctx.player && sendMissions(ctx);
pbHandlers.viewwork = (ctx) => ctx.player && sendWork(ctx);

pbHandlers.startmission = (ctx, { missionNumber = 0 }) => {
  const p = ctx.player;
  tickEnergy(p);
  if (p.status !== STATUS.FREE) return ctx.pb('startmission', { result: 2 });
  const m = missions(p)[missionNumber];
  if (!m) return ctx.pb('startmission', { result: 4 });
  if (p.energy < m.activity) return ctx.pb('startmission', { result: 3 });
  p.energy -= m.activity;
  if (p.energy < 1000) p.energyAt = Math.min(p.energyAt, now());
  const duration = scaled(m.time);
  p.status = STATUS.MISSION;
  p.action = { type: 'mission', start: now(), end: now() + duration, giver: missionNumber, id: m.id, mission: m };
  db.save();
  ctx.pb('startmission', {
    result: 1, playerStatus: STATUS.MISSION, progressTime: 0, remainingTime: duration, missionGiver: missionNumber, missionId: m.id,
  });
  sendPing(ctx);
  sendUserData(ctx);
};

pbHandlers.quitmission = (ctx) => {
  const p = ctx.player;
  const a = p.action;
  if (!a || a.type !== 'mission') return ctx.pb('quitmission', { result: 3 });
  const remaining = Math.max(0, a.end - now());
  if (remaining > 0) {
    // finish immediately for gold (1 gold per started minute)
    const price = Math.ceil(remaining / 60);
    if (p.gold < price) return ctx.pb('quitmission', { result: 2 });
    p.gold -= price;
  }
  const m = a.mission;
  const npc = npcFighter({ level: p.level, characterClass: m.opponentClass, picId: m.picId, strength: 0.75 + Math.random() * 0.35 });
  const { fight, leftWon } = simulateFight(playerFighter(p), npc);
  const reward = { cash: 0, xp: 0, gold: 0, activity: 0, glory: 0 };
  if (leftWon) {
    reward.cash = m.cash;
    reward.xp = m.xp;
    p.cash += m.cash;
    addXp(p, m.xp);
    if (m.item) {
      const slot = p.inventory.findIndex((x) => !x);
      if (slot >= 0) { p.inventory[slot] = m.item; reward.item = pbItem(m.item); }
    }
  } else {
    reward.xp = Math.round(m.xp / 4);
    addXp(p, reward.xp);
  }
  p.status = STATUS.FREE;
  p.action = null;
  p.missions[a.giver] = newMission(p, a.giver);
  db.save();
  ctx.pb('quitmission', { result: 1, fight, reward });
  sendStats(ctx);
  sendInventory(ctx);
  sendMissions(ctx);
  sendPing(ctx);
};

pbHandlers.goworking = (ctx) => {
  const p = ctx.player;
  if (p.status !== STATUS.FREE) return ctx.pb('goworking', { result: 2 });
  p.status = STATUS.WORKING;
  p.action = { type: 'work', start: now(), end: now() + WORK_MAX_HOURS * 3600 };
  db.save();
  ctx.pb('goworking', { result: 1, currentWorkDuration: 0 });
  sendPing(ctx);
};

pbHandlers.stopworking = (ctx) => {
  const p = ctx.player;
  const a = p.action;
  if (!a || a.type !== 'work') return ctx.pb('stopworking', { result: 2 });
  const seconds = Math.min(WORK_MAX_HOURS * 3600, now() - a.start);
  const effective = seconds / config.timeScale;
  const cash = Math.floor((effective / 3600) * workCashPerHour(p.level));
  p.cash += cash;
  p.status = STATUS.FREE;
  p.action = null;
  db.save();
  ctx.pb('stopworking', { result: 1, cashForWork: cash, cashBonusForFamily: 0, cashBonusForAchievement: 0, workDuration: seconds });
  sendStats(ctx);
  sendPing(ctx);
};
