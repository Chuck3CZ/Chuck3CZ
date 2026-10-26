#!/usr/bin/env node
// Writes .br and .gz copies next to Ruffle and the game files; the server sends them
// according to Accept-Encoding (the ~14 MB of Ruffle WebAssembly becomes a few MB).
// Copies are only regenerated for files that changed. Already-compressed SWFs are skipped.
//   npm run precompress
import { readdirSync, readFileSync, statSync, writeFileSync, utimesSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync, constants as zc } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [join(root, 'node_modules', '@ruffle-rs', 'ruffle'), process.env.CLIENT_DIR || join(root, 'client')];
const EXT = new Set(['.wasm', '.js', '.xml', '.properties', '.swf']);

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (EXT.has(extname(p))) yield p;
  }
}

let n = 0;
let saved = 0;
for (const dir of dirs) {
  for (const p of walk(dir)) {
    const st = statSync(p);
    const body = readFileSync(p);
    const sig = body.subarray(0, 3).toString('latin1');
    if (body.length < 1024 || sig === 'CWS' || sig === 'ZWS') continue; // tiny or already compressed
    for (const [ext, fn] of [
      ['.br', () => brotliCompressSync(body, { params: { [zc.BROTLI_PARAM_QUALITY]: 11, [zc.BROTLI_PARAM_SIZE_HINT]: body.length } })],
      ['.gz', () => gzipSync(body, { level: 9 })],
    ]) {
      try { if (statSync(p + ext).mtimeMs >= st.mtimeMs) continue; } catch { /* missing */ }
      const out = fn();
      writeFileSync(p + ext, out);
      const t = new Date(st.mtimeMs + 1000);
      utimesSync(p + ext, t, t);
      if (ext === '.br') { n++; saved += body.length - out.length; }
    }
  }
}
console.log(`precompressed ${n} files, brotli saves ${(saved / 1e6).toFixed(1)} MB`);
