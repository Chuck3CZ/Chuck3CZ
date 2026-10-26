#!/usr/bin/env node
// Offline admin tool for data/db.json. Stop the server before using it.
//
//   npm run admin -- list
//   npm run admin -- show <name>
//   npm run admin -- set <name> <field> <value>     e.g. set Tony level 10 | set Tony cash 50000
//   npm run admin -- password <name> <new password>
//   npm run admin -- ban <name> <hours>             0 = unban
//   npm run admin -- delete <name>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scryptSync, randomBytes } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(process.env.DATA_DIR || join(root, 'data'), 'db.json');
if (!existsSync(file)) { console.error(`no database at ${file}`); process.exit(1); }
const db = JSON.parse(readFileSync(file, 'utf8'));
const [cmd, name, ...rest] = process.argv.slice(2);

const find = (n) => Object.values(db.players).find((p) => p.name.toLowerCase() === String(n).toLowerCase());
const xpForLevel = (level) => { const l = Math.max(0, level - 1); return Math.round(0.24 * l ** 3.5 + 50 * l); };
const save = () => writeFileSync(file, JSON.stringify(db));
const need = (p) => { if (!p) { console.error(`player "${name}" not found`); process.exit(1); } return p; };

switch (cmd) {
  case 'list':
    for (const p of Object.values(db.players).filter((x) => !x.bot)) {
      console.log(`${p.id}\t${p.name}\tlevel ${p.level}\tcash ${p.cash}\tgold ${p.gold}`);
    }
    break;
  case 'show': {
    const { password, shops, ...p } = need(find(name));
    console.log(JSON.stringify(p, null, 2));
    break;
  }
  case 'set': {
    const p = need(find(name));
    const [field, value] = rest;
    if (!['level', 'xp', 'cash', 'gold', 'energy', 'freeAttributes', 'glory', 'email'].includes(field)) {
      console.error('field must be one of level, xp, cash, gold, energy, freeAttributes, glory, email');
      process.exit(1);
    }
    p[field] = field === 'email' ? value : Number(value);
    if (field === 'level') p.xp = Math.max(p.xp, xpForLevel(p.level));
    save();
    console.log(`${p.name}.${field} = ${p[field]}`);
    break;
  }
  case 'password': {
    const p = need(find(name));
    const salt = randomBytes(16);
    p.password = salt.toString('hex') + ':' + scryptSync(rest[0], salt, 32).toString('hex');
    save();
    console.log('password changed');
    break;
  }
  case 'ban': {
    const p = need(find(name));
    const hours = Number(rest[0] || 0);
    p.bannedUntil = hours > 0 ? Math.floor(Date.now() / 1000) + hours * 3600 : 0;
    save();
    console.log(hours > 0 ? `banned for ${hours} h` : 'unbanned');
    break;
  }
  case 'delete': {
    const p = need(find(name));
    delete db.players[p.id];
    save();
    console.log('deleted');
    break;
  }
  default:
    console.log('usage: list | show <name> | set <name> <field> <value> | password <name> <pw> | ban <name> <hours> | delete <name>');
}
