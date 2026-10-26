// Game protocol dispatcher. Handlers are registered per command name:
//   xtHandlers[cmd](ctx, params)        classic '%'-separated commands
//   pbHandlers[cmd](ctx, request)       protobuf commands (request already decoded)
import { readFileSync } from 'node:fs';
import { log } from '../config.js';
import * as db from '../db.js';
import { loadCatalog } from './items.js';
import { now } from './player.js';
import { xtHandlers, pbHandlers, online } from './registry.js';

const commands = JSON.parse(readFileSync(new URL('../data/commands.json', import.meta.url), 'utf8'));
const schema = JSON.parse(readFileSync(new URL('../data/pbschema.json', import.meta.url), 'utf8'));

loadCatalog();

// feature modules register their handlers on import
await import('./auth.js');
await import('./account.js');
await import('./equipment.js');
await import('./missions.js');
await import('./duels.js');
await import('./misc.js');

class Ctx {
  constructor(session) {
    this.session = session;
    this.player = null;
    this.pendingAvatar = null;
  }
  get p() { return this.player; }
  xt(cmd, error = 0, ...params) { this.session.xt(cmd, error, ...params); }
  /** Sends the protobuf response for `cmd` (response type looked up from the client's command table). */
  pb(cmd, obj) {
    const def = commands.pb[cmd];
    if (!def?.res) throw new Error(`no response type for ${cmd}`);
    this.session.pb(cmd, def.res, obj);
  }
  save() { db.save(); }
}

function genericPbReply(ctx, cmd) {
  const def = commands.pb[cmd];
  if (!def?.res) return;
  const fields = schema.messages[def.res] || [];
  const reply = {};
  if (fields.some((f) => f[1] === 'result')) reply.result = 1;
  ctx.pb(cmd, reply);
}

export function attachGame(session) {
  const ctx = new Ctx(session);

  session.on('sys', ({ action, r }) => {
    switch (action) {
      case 'verChk': session.sys('apiOK'); break;
      case 'login': session.roomList(); break;
      case 'autoJoin': session.joinOk(0); break;
      case 'roundTrip': session.sys('roundTripRes', '', r); break;
      default: log.debug('unhandled sys', action);
    }
  });

  session.on('xt', ({ cmd, params }) => {
    try {
      if (commands.pb[cmd]) {
        const def = commands.pb[cmd];
        const req = def.req ? session.decodePb(def.req, params) : {};
        log.debug('pb', cmd, JSON.stringify(req));
        const h = pbHandlers[cmd];
        if (h) h(ctx, req);
        else { log.info('unimplemented pb command', cmd, JSON.stringify(req)); genericPbReply(ctx, cmd); }
        return;
      }
      const h = xtHandlers[cmd];
      if (h) h(ctx, params);
      else log.info('unimplemented command', cmd, params.join('|'));
    } catch (err) {
      log.error(`error handling ${cmd}:`, err);
    }
  });

  session.on('close', () => {
    if (ctx.player) {
      ctx.player.lastSeen = now();
      if (online.get(ctx.player.id) === ctx) online.delete(ctx.player.id);
      db.save();
    }
  });
  return ctx;
}
