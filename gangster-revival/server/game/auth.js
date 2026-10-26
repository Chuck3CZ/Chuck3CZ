// Version check, registration, login, avatar creation and the initial data push (apd).
import * as db from '../db.js';
import { log } from '../config.js';
import { xtHandlers, pbHandlers, bindPlayer } from './registry.js';
import { createPlayer, applyAvatar } from './player.js';
import { sendAllPlayerData } from './account.js';

const BUILD_NUMBER = 2040; // client build (MafiaEnvironmentGlobals.buildNumberGame)

const LRE = { OK: 0, NAME_OFFER: 5, NAME_EXISTS: 6, INVALID_EMAIL: 7, BAD_PASSWORD: 9, SHORT_PASSWORD: 10 };
const LGN = { OK: 0, WRONG_NAME: 1, WRONG_PASSWORD: 2, BANNED: 3 };

xtHandlers.vck = (ctx) => ctx.xt('vck', 0, BUILD_NUMBER, 0);
xtHandlers.pin = () => {};

function nameSuggestions(name) {
  const base = name.replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'Gangster';
  const out = [];
  for (let i = 0; out.length < 3 && i < 50; i++) {
    const n = `${base}${Math.floor(Math.random() * 900 + 100)}`;
    if (!db.findByName(n)) out.push(n);
  }
  return out.join('#');
}

// lre: name, mail, password, referrer, lang, distributor, accountId, ...
xtHandlers.lre = (ctx, params) => {
  const [name = '', email = '', password = ''] = params;
  let code = LRE.OK;
  if (!/^[\p{L}\p{N}_ .-]{3,20}$/u.test(name) || name.trim() !== name) code = LRE.NAME_OFFER;
  else if (db.findByName(name)) code = LRE.NAME_EXISTS;
  else if (email && !/^[^@\s]+@[^@\s]+$/.test(email)) code = LRE.INVALID_EMAIL;
  else if (password.length < 4) code = LRE.SHORT_PASSWORD;

  if (code === LRE.NAME_OFFER) return ctx.xt('lre', code, nameSuggestions(name));
  if (code !== LRE.OK) return ctx.xt('lre', code);

  const p = createPlayer({ name, email, password, avatar: ctx.pendingAvatar });
  p.hasAvatar = !!ctx.pendingAvatar;
  ctx.pendingAvatar = null;
  bindPlayer(ctx, p);
  log.info(`registered player ${p.id} "${name}"`);
  ctx.xt('lre', 0, p.id, p.id);
};

// lgn: name, password, lang, connectTime, ping, accountId
xtHandlers.lgn = (ctx, params) => {
  const [name = '', password = ''] = params;
  const p = db.findByName(name);
  if (!p) return ctx.xt('lgn', LGN.WRONG_NAME);
  if (!db.checkPassword(password, p.password)) return ctx.xt('lgn', LGN.WRONG_PASSWORD);
  if (p.bannedUntil && p.bannedUntil > Date.now() / 1000) {
    return ctx.xt('lgn', LGN.BANNED, 0, 0, Math.round(p.bannedUntil - Date.now() / 1000));
  }
  bindPlayer(ctx, p);
  log.info(`login player ${p.id} "${p.name}"`);
  // userId, playerId, needs avatar creation, daily bonus amount, bonus type
  ctx.xt('lgn', LGN.OK, p.id, p.id, p.hasAvatar ? 0 : 1, 0, 0);
};

// createavatar: gender, characterClass, portrait
pbHandlers.createavatar = (ctx, req) => {
  if (ctx.player) {
    applyAvatar(ctx.player, req);
    ctx.player.hasAvatar = true;
  } else {
    ctx.pendingAvatar = req;
  }
  ctx.pb('createavatar', { result: 1 });
};

// apd: all player data -> a burst of messages, then 'apd' to enter the game
xtHandlers.apd = (ctx) => {
  if (!ctx.player) return ctx.xt('apd', 1);
  sendAllPlayerData(ctx);
  ctx.xt('apd', 0);
};
