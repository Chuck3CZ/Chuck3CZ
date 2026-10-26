// Tiny JSON-file database. Good enough for a private server with a handful of players.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { config, log } from './config.js';

const file = join(config.dataDir, 'db.json');
let state = { nextId: 1000, players: {} };
let dirty = false;

function load() {
  mkdirSync(config.dataDir, { recursive: true });
  if (existsSync(file)) state = JSON.parse(readFileSync(file, 'utf8'));
  log.info(`database: ${Object.keys(state.players).length} players`);
  setInterval(flush, 5000).unref();
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flush(); process.exit(0); });
}

export function flush() {
  if (!dirty) return;
  writeFileSync(file + '.tmp', JSON.stringify(state));
  renameSync(file + '.tmp', file);
  dirty = false;
}

export function save() { dirty = true; }

export function allPlayers() { return Object.values(state.players); }

export function getPlayer(id) { return state.players[id]; }

export function findByName(name) {
  const n = String(name).toLowerCase();
  return allPlayers().find((p) => p.name.toLowerCase() === n);
}

export function createPlayer(fields) {
  const id = state.nextId++;
  const player = { id, ...fields };
  state.players[id] = player;
  save();
  return player;
}

export function hashPassword(pw) {
  const salt = randomBytes(16);
  return salt.toString('hex') + ':' + scryptSync(pw, salt, 32).toString('hex');
}

export function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const test = scryptSync(pw, Buffer.from(salt, 'hex'), 32);
  return timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

load();
