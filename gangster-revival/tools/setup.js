#!/usr/bin/env node
// Downloads the official Goodgame Gangster desktop installer (preserved on the
// Internet Archive), extracts the game files into ./client and fetches the original
// language files into ./data/languages.
//
//   npm run setup                      download + extract
//   npm run setup -- --from FILE.exe   use an installer you already downloaded
//   npm run setup -- --langs en,cs      only these original language files
//   npm run setup -- --mirror DIR       take language files from a CDN backup (default ./cdn-backup)
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER_URL = 'https://archive.org/download/goodgame-gangster-installer/GoodgameGangster_installer.exe';
const INSTALLER_SHA256 = '3667e82c2bea228b72961fc94dda1df1ba71a77d2fcc952b3154e82607549c98';
const PREFIX = 'Goodgame Gangster/';
// languages listed in the client's MafiaLangVersion.properties
const LANGS = ['en', 'cs', 'de', 'pl', 'fr', 'it', 'es', 'nl', 'pt', 'ru', 'tr', 'el', 'fi', 'sv', 'no', 'da', 'hu', 'ja', 'ko'];

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Minimal ZIP reader that copes with the self-extractor stub in front of the archive. */
function* zipEntries(buf) {
  let eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip archive');
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const shift = eocd - cdSize - cdOffset; // bytes of SFX stub before the zip data
  let p = cdOffset + shift;
  const count = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42) + shift;
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    yield { name, data: method === 8 ? inflateRawSync(raw) : raw };
  }
}

async function main() {
  const clientDir = join(root, 'client');
  const langDir = join(root, 'data', 'languages');
  mkdirSync(clientDir, { recursive: true });
  mkdirSync(langDir, { recursive: true });

  const from = opt('from');
  let exe;
  if (from) {
    exe = readFileSync(from);
  } else {
    console.log(`Downloading installer from the Internet Archive...\n  ${INSTALLER_URL}`);
    exe = await download(INSTALLER_URL);
  }
  const sha = createHash('sha256').update(exe).digest('hex');
  if (sha !== INSTALLER_SHA256) console.warn(`warning: unexpected installer checksum ${sha}`);

  let n = 0;
  for (const { name, data } of zipEntries(exe)) {
    if (!name.startsWith(PREFIX)) continue;
    const rel = name.slice(PREFIX.length);
    if (!rel || /\.(exe|msi)$/i.test(rel) || rel.startsWith('META-INF/')) continue;
    const out = normalize(join(clientDir, rel));
    if (!out.startsWith(clientDir + sep)) continue; // zip-slip guard
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, data);
    n++;
  }
  console.log(`Extracted ${n} game files into ${clientDir}`);

  // Original language files (UI texts, item names, mission texts, enemy names). Goodgame's
  // old CDN still serves them; the Wayback Machine is the fallback.
  const langs = opt('langs', LANGS.join(',')).split(',').filter(Boolean);
  let ok = 0;
  for (const lang of langs) {
    const target = join(langDir, `${lang}.ggs`);
    if (existsSync(target)) { ok++; continue; }
    const urls = [
      `https://files-ak.goodgamestudios.com/games-languages/4/${lang}.ggs`,
      `https://media.goodgamestudios.com/games-languages/4/${lang}.ggs`,
      `https://web.archive.org/web/2019id_/http://gangster-data.goodgamestudios.com/games-languages/4/${lang}.ggs`,
    ];
    let done = false;
    // a local CDN backup (npm run backup-cdn, or an unpacked backup zip) wins
    const mirror = join(opt('mirror', join(root, 'cdn-backup')), 'games-languages', '4', `${lang}.ggs`);
    if (existsSync(mirror)) {
      writeFileSync(target, readFileSync(mirror));
      ok++;
      continue;
    }
    for (const url of urls) {
      try {
        const data = await download(url);
        if (data.subarray(0, 2).toString('latin1') !== 'PK') throw new Error('not a .ggs archive');
        writeFileSync(target, data);
        done = true;
        ok++;
        break;
      } catch { /* try the next source */ }
    }
    if (!done) console.log(`language ${lang}: not available - the generated English fallback will be used`);
  }
  console.log(`Original language files: ${ok}/${langs.length} in ${langDir}`);
  console.log('\nDone. Start the server with:  npm start');
}

main().catch((e) => { console.error(e); process.exit(1); });
