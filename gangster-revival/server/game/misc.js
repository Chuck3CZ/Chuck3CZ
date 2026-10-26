// Smaller features: messages, news, feature status, avatar change, energy refill.
import * as db from '../db.js';
import { xtHandlers, pbHandlers } from './registry.js';
import { MAX_ENERGY } from './rules.js';
import { sendStats, sendProfile } from './account.js';
import { sendMissions } from './missions.js';

pbHandlers.getmessagesstatus = (ctx) => ctx.pb('getmessagesstatus', { unreadMessages: 0 });
pbHandlers.shownews = (ctx) => ctx.pb('shownews', { result: 1, messages: [] });
pbHandlers.getfeaturestatus = (ctx) => ctx.pb('getfeaturestatus', { featureStatus: [] });
pbHandlers.loginwelcome = (ctx) => ctx.pb('loginwelcome', { reward: [] });

// change avatar look (costs gold in the original; free here)
xtHandlers.cav = (ctx, [portrait]) => {
  const p = ctx.player;
  if (!p || !portrait) return ctx.xt('cav', 1);
  p.portrait = portrait;
  db.save();
  ctx.xt('cav', 0);
  sendProfile(ctx);
};

// buy mission energy refill with gold
xtHandlers.ben = (ctx) => {
  const p = ctx.player;
  const price = 10;
  if (!p || p.gold < price) return ctx.xt('ben', 1);
  p.gold -= price;
  p.energy = MAX_ENERGY;
  db.save();
  ctx.xt('ben', 0);
  sendStats(ctx);
  sendMissions(ctx);
};

// item response timeout / unlocked assets / feedback: acknowledge
xtHandlers.irt = (ctx) => ctx.xt('irt', 0);
xtHandlers.gua = (ctx) => ctx.xt('gua', 0, '');
xtHandlers.fdb = (ctx) => ctx.xt('fdb', 0);
