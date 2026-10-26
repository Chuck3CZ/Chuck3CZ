// Shared handler tables and online-player bookkeeping (kept separate to avoid import cycles).
import * as db from '../db.js';
import { now, tickEnergy } from './player.js';

export const xtHandlers = {};
export const pbHandlers = {};
export const online = new Map(); // playerId -> ctx

/** Called once a player is logged in on a connection. */
export function bindPlayer(ctx, player) {
  const old = online.get(player.id);
  if (old && old !== ctx) old.session.close('logged in elsewhere');
  ctx.player = player;
  online.set(player.id, ctx);
  player.lastLogin = now();
  tickEnergy(player);
  db.save();
}
