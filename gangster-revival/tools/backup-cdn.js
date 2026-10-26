#!/usr/bin/env node
// Mirrors everything Goodgame Gangster needs from Goodgame's (still running) CDN into
// ./cdn-backup, with a manifest of source URLs and SHA-256 checksums, so the game keeps
// working if the CDN goes away. Asset ids are probed in the ranges the client uses.
//
//   npm run backup-cdn
//   npm run backup-cdn -- --out /some/dir
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : join(root, 'cdn-backup');
const HOSTS = ['https://files-ak.goodgamestudios.com', 'https://media.goodgamestudios.com'];
const CONCURRENCY = 16;

const LANGS = ['en', 'cs', 'de', 'pl', 'fr', 'it', 'es', 'nl', 'pt', 'ru', 'tr', 'el', 'fi', 'sv', 'no', 'da', 'hu', 'ja', 'ko',
  'sk', 'ro', 'bg', 'zh_CN', 'zh_TW', 'ar', 'lt', 'lv', 'et', 'hr', 'sr', 'sl', 'uk', 'pt_BR', 'es_MX', 'en_US', 'id', 'th', 'vi'];

function candidates() {
  const p = new Set([
    'CookieSaver.swf', 'crossdomain.xml', 'games-config/country_new2.xml', 'games-config/country.xml',
    'abFlash/config/abTests_4.xml',
    'loader/mafia/MafiaGame_2040.swf', 'loader/mafia/MafiaCacheBreakerSwf.swf', 'loader/mafia/Mafia_PromotionLoaderSwf.swf',
    'loader/mafia/MafiaLangVersion.properties', 'loader/mafia/MafiaItemLib1_396.swf', 'loader/mafia/MafiaItemLib2_227.swf',
    'loader/mafia/config/MafiaItems_v103.xml', 'loader/mafia/crossdomain.xml',
  ]);
  for (const l of LANGS) {
    p.add(`games-languages/4/${l}.ggs`);
    p.add(`loader/mafia/fonts/MafiaFonts_${l}.swf`);
  }
  for (let n = 0; n <= 120; n++) p.add(`games-netconf/4/${n}.xml`);
  // avatar parts: blocks of 500 starting at 10000, ids block..block+99 (one block goes to 590)
  for (let b = 10000; b <= 23500; b += 500) {
    for (let i = 0; i < (b === 16500 ? 600 : 100); i++) p.add(`loader/mafia/AvatarParts/AvaPart_${b + i}.swf`);
  }
  for (let c = 0; c <= 4; c++) for (let n = 0; n <= 70; n++) p.add(`loader/mafia/backgrounds/ScreenBackground_${c}_${n}.swf`);
  const two = (n) => String(n).padStart(2, '0');
  for (let c = 1; c <= 4; c++) for (let t = 1; t <= 40; t++) for (let v = 1; v <= 12; v++) {
    p.add(`loader/mafia/familyCrestParts/FamilyCrestPart_${c}_${two(t)}_${two(v)}.swf`);
  }
  return [...p];
}

async function fetchOne(path) {
  for (const host of HOSTS) {
    try {
      const res = await fetch(`${host}/${path}`, { redirect: 'follow' });
      if (res.status === 404 || res.status === 403) continue;
      if (!res.ok) continue;
      const body = Buffer.from(await res.arrayBuffer());
      if ((res.headers.get('content-type') || '').startsWith('text/html')) continue; // error pages
      return { url: `${host}/${path}`, body, type: res.headers.get('content-type') };
    } catch { /* next host */ }
  }
  return null;
}

async function main() {
  mkdirSync(out, { recursive: true });
  const manifestFile = join(out, 'manifest.json');
  const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : { files: {} };
  const list = candidates();
  console.log(`probing ${list.length} paths on ${HOSTS.join(', ')} ...`);
  let i = 0;
  let found = 0;
  async function worker() {
    while (i < list.length) {
      const path = list[i++];
      const r = await fetchOne(path);
      if (!r) continue;
      const target = join(out, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, r.body);
      manifest.files[path] = {
        source: r.url, size: r.body.length, sha256: createHash('sha256').update(r.body).digest('hex'),
        contentType: r.type, fetched: new Date().toISOString(),
      };
      found++;
      if (found % 50 === 0) console.log(`  ${found} files...`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  manifest.updated = new Date().toISOString();
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 1));
  const total = Object.values(manifest.files).reduce((s, f) => s + f.size, 0);
  console.log(`done: ${Object.keys(manifest.files).length} files, ${(total / 1e6).toFixed(1)} MB in ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
