// Inventory, armament grid, gear, food and shops.
import * as db from '../db.js';
import { pbHandlers } from './registry.js';
import { TYPE, shopSelection } from './items.js';
import { ARMAMENT_SIZE, now, pbItem } from './player.js';
import { sendCurrency, sendProfile, sendUserData } from './account.js';

const SHOP = { BLACK_MARKET: 1, KIOSK: 2, CONSUMABLES: 3 };
const SHOP_TYPES = { [SHOP.BLACK_MARKET]: [TYPE.WEAPON, TYPE.GEAR, TYPE.ACCESSORY], [SHOP.KIOSK]: [TYPE.FOOD], [SHOP.CONSUMABLES]: [TYPE.CONSUMABLE] };
const SHOP_SIZE = 8;
const SHOP_REFRESH_SECONDS = 6 * 3600;
const INVENTORY_START = 10;
const INVENTORY_MAX = 40;
const INVENTORY_ROW_PRICE = 20; // gold per row of 5
const STACK_LIMIT = 9999;
const FOOD_SLOTS = 1;

// Empty slot. PBItem's id, quality, type, costs, isGoldPrice and levels are proto2 "required"
// fields: the client crashes while printing a message that lacks them.
const EMPTY = { id: 0, quality: 1, type: 1, costs: { buy: 0, sell: 0 }, isGoldPrice: false, levels: { min: 0, max: 0 } };

function ensureInventory(p) {
  p.inventorySize ??= INVENTORY_START;
  while (p.inventory.length < p.inventorySize) p.inventory.push(null);
}

function freeInventorySlot(p) {
  ensureInventory(p);
  return p.inventory.findIndex((x) => !x);
}

// ------------------------------------------------------------------ views

export function sendInventory(ctx) {
  const p = ctx.player;
  ensureInventory(p);
  const cost = p.inventorySize >= INVENTORY_MAX ? -1 : INVENTORY_ROW_PRICE;
  ctx.pb('viewinventory', { items: p.inventory.map((i) => (i ? pbItem(i) : EMPTY)), unlockCost: cost });
}

export function sendArmament(ctx, p = ctx.player) {
  ctx.pb('viewarmament', {
    playerId: p.id,
    width: ARMAMENT_SIZE.width,
    height: ARMAMENT_SIZE.height,
    itemSlots: p.armament.map((i) => ({ slotX: i.slotX, slotY: i.slotY, active: true, item: pbItem(i) })),
    isUnlockable: false,
    unlockCost: 0,
  });
}

export function sendGear(ctx, p = ctx.player) {
  ctx.pb('viewgear', { playerId: p.id, items: p.gear.map(pbItem) });
}

export function sendFood(ctx, p = ctx.player) {
  p.food = p.food.filter((f) => !f.expires || f.expires > now());
  ctx.pb('viewfood', { playerId: p.id, items: p.food.map(pbItem) });
}

export function sendEquipment(ctx) {
  sendArmament(ctx);
  ctx.pb('getarmamentpresetstatus', { unlockedArmaments: 1, activeArmament: 1, unlockCost: 0 });
  sendGear(ctx);
  sendFood(ctx);
  sendInventory(ctx);
}

function shopState(p, shop) {
  p.shops ??= {};
  let s = p.shops[shop];
  if (!s || s.refreshAt <= now() || s.level !== p.level) {
    const types = SHOP_TYPES[shop];
    const items = [];
    for (let i = 0; i < SHOP_SIZE; i++) {
      const t = types[i % types.length];
      const [it] = shopSelection(t, p.level, 1);
      items.push(it || null);
    }
    s = { items, refreshAt: (s && s.refreshAt > now() ? s.refreshAt : now() + SHOP_REFRESH_SECONDS), level: p.level, safe: s?.safe || null };
    p.shops[shop] = s;
    db.save();
  }
  return s;
}

export function sendShop(ctx, shop) {
  const s = shopState(ctx.player, shop);
  ctx.pb('viewitems', {
    shop,
    refresh: Math.max(0, s.refreshAt - now()),
    items: s.items.map((i) => (i ? pbItem(i) : EMPTY)),
    safe: s.safe ? pbItem(s.safe) : undefined,
  });
}

export function sendShops(ctx) {
  sendShop(ctx, SHOP.BLACK_MARKET);
  sendShop(ctx, SHOP.CONSUMABLES);
  sendShop(ctx, SHOP.KIOSK);
}

/** After stats-affecting changes. */
function sendAfterEquip(ctx) {
  sendEquipment(ctx);
  sendProfile(ctx);
  sendUserData(ctx);
}

// ------------------------------------------------------------------ armament grid

function shapeOf(item) {
  return { w: item.shape?.width || 1, h: item.shape?.height || 1 };
}

function itemAt(p, x, y) {
  return p.armament.find((i) => {
    const { w, h } = shapeOf(i);
    return x >= i.slotX && x < i.slotX + w && y >= i.slotY && y < i.slotY + h;
  });
}

function fits(p, item, x, y, ignore) {
  const { w, h } = shapeOf(item);
  if (x < 0 || y < 0 || x + w > ARMAMENT_SIZE.width || y + h > ARMAMENT_SIZE.height) return false;
  for (let dx = 0; dx < w; dx++) {
    for (let dy = 0; dy < h; dy++) {
      const other = itemAt(p, x + dx, y + dy);
      if (other && other !== ignore) return false;
    }
  }
  return true;
}

function armamentAllowed(item) {
  return [TYPE.WEAPON, TYPE.CONSUMABLE, TYPE.ACCESSORY, TYPE.SKILL].includes(item.type);
}

// ------------------------------------------------------------------ handlers

pbHandlers.viewitems = (ctx, req) => ctx.player && sendShop(ctx, req.shop || SHOP.BLACK_MARKET);
pbHandlers.viewinventory = (ctx) => ctx.player && sendInventory(ctx);
pbHandlers.viewarmament = (ctx) => ctx.player && sendArmament(ctx);
pbHandlers.viewgear = (ctx) => ctx.player && sendGear(ctx);
pbHandlers.viewfood = (ctx) => ctx.player && sendFood(ctx);
pbHandlers.getarmamentpresetstatus = (ctx) => ctx.pb('getarmamentpresetstatus', { unlockedArmaments: 1, activeArmament: 1, unlockCost: 0 });

pbHandlers.buyitem = (ctx, { shop, source, target }) => {
  const p = ctx.player;
  const s = shopState(p, shop);
  const item = s.items[source];
  if (!item) return ctx.pb('buyitem', { result: 4 });
  ensureInventory(p);
  let slot = target;
  if (slot === undefined || slot >= p.inventory.length || p.inventory[slot]) slot = freeInventorySlot(p);
  // stack consumables onto an existing stack
  const stack = item.amount ? p.inventory.find((i) => i && i.type === item.type && i.id === item.id && i.quality === item.quality) : null;
  if (!stack && slot < 0) return ctx.pb('buyitem', { result: 5 });
  const price = item.costs.buy;
  if (item.isGoldPrice ? p.gold < price : p.cash < price) return ctx.pb('buyitem', { result: 7, item: pbItem(item) });
  if (item.isGoldPrice) p.gold -= price; else p.cash -= price;
  if (stack) {
    if (stack.amount + item.amount > STACK_LIMIT) return ctx.pb('buyitem', { result: 6 });
    stack.amount += item.amount;
  } else {
    p.inventory[slot] = item;
  }
  s.items[source] = null;
  db.save();
  ctx.pb('buyitem', { result: 1, item: pbItem(stack || item), stacked: !!stack });
  sendInventory(ctx);
  sendShop(ctx, shop);
  sendCurrency(ctx);
};

pbHandlers.sellitem = (ctx, { source, amount }) => {
  const p = ctx.player;
  ensureInventory(p);
  const item = p.inventory[source];
  if (!item) return ctx.pb('sellitem', { result: 3 });
  const n = item.amount ? Math.min(item.amount, amount || 1) : 1;
  p.cash += (item.costs?.sell || 0) * n;
  if (item.amount && item.amount > n) item.amount -= n;
  else p.inventory[source] = null;
  db.save();
  ctx.pb('sellitem', { result: 1, item: pbItem(item) });
  sendInventory(ctx);
  sendCurrency(ctx);
};

pbHandlers.changeinventory = (ctx, { source, target }) => {
  const p = ctx.player;
  ensureInventory(p);
  if (source >= p.inventory.length || target >= p.inventory.length) return ctx.pb('changeinventory', { result: 2 });
  if (!p.inventory[source]) return ctx.pb('changeinventory', { result: 4 });
  [p.inventory[source], p.inventory[target]] = [p.inventory[target], p.inventory[source]];
  db.save();
  ctx.pb('changeinventory', { result: 1 });
  sendInventory(ctx);
};

pbHandlers.unlockinventory = (ctx) => {
  const p = ctx.player;
  ensureInventory(p);
  if (p.inventorySize >= INVENTORY_MAX) return ctx.pb('unlockinventory', { result: 3 });
  if (p.gold < INVENTORY_ROW_PRICE) return ctx.pb('unlockinventory', { result: 2 });
  p.gold -= INVENTORY_ROW_PRICE;
  p.inventorySize += 5;
  ensureInventory(p);
  db.save();
  ctx.pb('unlockinventory', { result: 1 });
  sendInventory(ctx);
  sendCurrency(ctx);
};

pbHandlers.equipgear = (ctx, { source }) => {
  const p = ctx.player;
  ensureInventory(p);
  const item = p.inventory[source];
  if (!item) return ctx.pb('equipgear', { result: 3 });
  if (item.type !== TYPE.GEAR) return ctx.pb('equipgear', { result: 4 });
  const old = p.gear.find((g) => g.subType === item.subType);
  p.gear = p.gear.filter((g) => g !== old);
  p.gear.push(item);
  p.inventory[source] = old || null;
  db.save();
  ctx.pb('equipgear', { result: 1 });
  sendAfterEquip(ctx);
};

pbHandlers.unequipgear = (ctx, { source, target }) => {
  const p = ctx.player;
  ensureInventory(p);
  const item = p.gear.find((g) => g.subType === source);
  if (!item) return ctx.pb('unequipgear', { result: 3 });
  let slot = target;
  if (slot === undefined || slot >= p.inventory.length || p.inventory[slot]) slot = freeInventorySlot(p);
  if (slot < 0) return ctx.pb('unequipgear', { result: 2 });
  p.gear = p.gear.filter((g) => g !== item);
  p.inventory[slot] = item;
  db.save();
  ctx.pb('unequipgear', { result: 1 });
  sendAfterEquip(ctx);
};

pbHandlers.equipfood = (ctx, { source }) => {
  const p = ctx.player;
  ensureInventory(p);
  const item = p.inventory[source];
  if (!item) return ctx.pb('equipfood', { result: 4 });
  if (item.type !== TYPE.FOOD) return ctx.pb('equipfood', { result: 6 });
  p.food = p.food.filter((f) => !f.expires || f.expires > now());
  if (p.food.length >= FOOD_SLOTS) return ctx.pb('equipfood', { result: 7 });
  item.expires = now() + (item.duration?.total || 3600);
  p.food.push(item);
  p.inventory[source] = null;
  db.save();
  ctx.pb('equipfood', { result: 1 });
  sendAfterEquip(ctx);
};

pbHandlers.unequipfood = (ctx) => {
  const p = ctx.player;
  if (!p.food.length) return ctx.pb('unequipfood', { result: 3 });
  p.food = []; // eaten food is gone
  db.save();
  ctx.pb('unequipfood', { result: 1 });
  sendAfterEquip(ctx);
};

pbHandlers.equiparmament = (ctx, { source, targetX = 0, targetY = 0, amount }) => {
  const p = ctx.player;
  ensureInventory(p);
  const item = p.inventory[source];
  if (!item) return ctx.pb('equiparmament', { result: 5 });
  if (!armamentAllowed(item)) return ctx.pb('equiparmament', { result: 7 });
  const existing = itemAt(p, targetX, targetY);
  // stack onto the same consumable
  if (existing && item.amount && existing.id === item.id && existing.type === item.type) {
    const n = Math.min(item.amount, amount || item.amount);
    existing.amount += n;
    item.amount -= n;
    if (item.amount <= 0) p.inventory[source] = null;
  } else {
    if (existing) {
      // swap with the item in the grid
      p.armament = p.armament.filter((i) => i !== existing);
      if (!fits(p, item, targetX, targetY)) { p.armament.push(existing); return ctx.pb('equiparmament', { result: 4 }); }
      p.inventory[source] = existing;
      delete existing.slotX; delete existing.slotY;
    } else {
      if (!fits(p, item, targetX, targetY)) return ctx.pb('equiparmament', { result: 4 });
      p.inventory[source] = null;
    }
    item.slotX = targetX;
    item.slotY = targetY;
    p.armament.push(item);
  }
  db.save();
  ctx.pb('equiparmament', { result: 1, inventorySlot: source });
  sendAfterEquip(ctx);
};

pbHandlers.unequiparmament = (ctx, { sourceX = 0, sourceY = 0, target }) => {
  const p = ctx.player;
  ensureInventory(p);
  const item = itemAt(p, sourceX, sourceY);
  if (!item) return ctx.pb('unequiparmament', { result: 4 });
  let slot = target;
  if (slot === undefined || slot >= p.inventory.length || p.inventory[slot]) slot = freeInventorySlot(p);
  if (slot < 0) return ctx.pb('unequiparmament', { result: 7 });
  p.armament = p.armament.filter((i) => i !== item);
  delete item.slotX; delete item.slotY;
  p.inventory[slot] = item;
  db.save();
  ctx.pb('unequiparmament', { result: 1 });
  sendAfterEquip(ctx);
};

pbHandlers.changearmament = (ctx, { sourceX = 0, sourceY = 0, targetX = 0, targetY = 0 }) => {
  const p = ctx.player;
  const item = itemAt(p, sourceX, sourceY);
  if (!item) return ctx.pb('changearmament', { result: 4 });
  if (!fits(p, item, targetX, targetY, item)) return ctx.pb('changearmament', { result: 5 });
  item.slotX = targetX;
  item.slotY = targetY;
  db.save();
  ctx.pb('changearmament', { result: 1 });
  sendArmament(ctx);
};

pbHandlers.orderitems = (ctx, { shop }) => {
  const p = ctx.player;
  const price = 2;
  if (p.gold < price) return ctx.pb('orderitems', { result: 2 });
  p.gold -= price;
  if (p.shops?.[shop]) p.shops[shop].refreshAt = 0;
  shopState(p, shop);
  p.shops[shop].refreshAt = now() + SHOP_REFRESH_SECONDS;
  db.save();
  ctx.pb('orderitems', { result: 1 });
  sendShop(ctx, shop);
  sendCurrency(ctx);
};

pbHandlers.saveitem = (ctx, { shop, source }) => {
  const s = shopState(ctx.player, shop);
  if (s.safe) return ctx.pb('saveitem', { result: 4 });
  if (!s.items[source]) return ctx.pb('saveitem', { result: 3 });
  s.safe = s.items[source];
  s.items[source] = null;
  db.save();
  ctx.pb('saveitem', { result: 1 });
  sendShop(ctx, shop);
};

pbHandlers.clearsafe = (ctx, { shop }) => {
  const s = shopState(ctx.player, shop);
  if (!s.safe) return ctx.pb('clearsafe', { result: 2 });
  s.safe = null;
  db.save();
  ctx.pb('clearsafe', { result: 1 });
  sendShop(ctx, shop);
};
