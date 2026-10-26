// HTTP: web page with Ruffle, game files, emulated Goodgame CDN. Responses are
// Brotli-compressed (cached in memory) when the browser supports it.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { brotliCompress, gzip, constants as zc } from 'node:zlib';
import { promisify } from 'node:util';
import { config, log } from './config.js';
import { countryXml, networkXml, languageFile, cookieSaverSwf } from './cdn.js';

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.swf': 'application/x-shockwave-flash',
  '.xml': 'text/xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.properties': 'text/plain', '.ggs': 'application/octet-stream', '.map': 'application/json',
};

const ruffleDir = join(config.root, 'node_modules', '@ruffle-rs', 'ruffle');
const publicDir = join(config.root, 'public');

const compressedCache = new Map(); // key -> { br, gz }

function isCompressible(body, type) {
  if (body.length < 512) return false;
  const sig = body.subarray(0, 3).toString('latin1');
  if (sig === 'CWS' || sig === 'ZWS' || sig.startsWith('PK')) return false; // already compressed
  return !/^image\/(png|jpeg)/.test(type);
}

async function compressed(key, body, enc) {
  let entry = compressedCache.get(key);
  if (!entry) { entry = {}; compressedCache.set(key, entry); }
  if (!entry[enc]) {
    entry[enc] = enc === 'br'
      ? brotli(body, { params: { [zc.BROTLI_PARAM_QUALITY]: 9, [zc.BROTLI_PARAM_SIZE_HINT]: body.length } })
      : gz(body, { level: 9 });
  }
  return entry[enc];
}

async function send(req, res, body, type, { cacheKey, maxAge = 0 } = {}) {
  const headers = { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', Vary: 'Accept-Encoding' };
  headers['Cache-Control'] = maxAge ? `public, max-age=${maxAge}` : 'no-cache';
  const accept = req.headers['accept-encoding'] || '';
  let out = body;
  if (cacheKey && isCompressible(body, type)) {
    const enc = /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null;
    if (enc) {
      out = await compressed(cacheKey, body, enc === 'br' ? 'br' : 'gz');
      headers['Content-Encoding'] = enc;
    }
  }
  headers['Content-Length'] = out.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : out);
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
  res.end('not found');
}

async function serveFile(req, res, baseDir, rel, maxAge) {
  const p = normalize(join(baseDir, decodeURIComponent(rel)));
  if (!p.startsWith(baseDir + sep) && p !== baseDir) return notFound(res);
  let st;
  try { st = await stat(p); } catch { return notFound(res); }
  if (!st.isFile()) return notFound(res);
  const body = await readFile(p);
  return send(req, res, body, TYPES[extname(p).toLowerCase()] || 'application/octet-stream',
    { cacheKey: `${p}:${st.mtimeMs}`, maxAge });
}

let indexTemplate;
async function indexPage(req) {
  indexTemplate ??= await readFile(join(publicDir, 'index.html'), 'utf8');
  const host = req.headers.host || `localhost:${config.httpPort}`;
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  const wsProto = proto === 'https' ? 'wss' : 'ws';
  const cfg = {
    origin: `${proto}://${host}`,
    socket: { host: config.socketHost, port: config.socketPort, proxyUrl: `${wsProto}://${host}/ws` },
    serverName: config.serverName,
  };
  return indexTemplate.replace('/*SERVER_CONFIG*/', `window.GANGSTER = ${JSON.stringify(cfg)};`);
}

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  log.debug('http', req.method, path);

  if (path === '/' || path === '/index.html') {
    return send(req, res, Buffer.from(await indexPage(req)), TYPES['.html'], { cacheKey: null });
  }
  if (path.startsWith('/ruffle/')) return serveFile(req, res, ruffleDir, path.slice(8), 86400);
  if (path.startsWith('/game/')) return serveFile(req, res, config.clientDir, path.slice(6), 3600);
  if (path.startsWith('/static/')) return serveFile(req, res, publicDir, path.slice(8), 3600);

  if (path.startsWith('/cdn/')) {
    const p = path.slice(4);
    if (req.method === 'POST') { res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }); return res.end(''); }
    if (p.endsWith('/CookieSaver.swf')) return send(req, res, cookieSaverSwf(), TYPES['.swf']);
    if (p.endsWith('/games-config/country_new2.xml')) return send(req, res, Buffer.from(countryXml()), TYPES['.xml']);
    if (/\/games-netconf(-test)?\/4\/\d+\.xml$/.test(p)) return send(req, res, Buffer.from(networkXml()), TYPES['.xml']);
    const lang = /\/games-languages(?:-test)?\/4\/([a-zA-Z_]+)\.(ggs|xml)$/.exec(p);
    if (lang) {
      const f = languageFile(lang[1], lang[2]);
      return send(req, res, f.body, f.type, { cacheKey: `lang:${lang[1]}:${lang[2]}:${f.body.length}`, maxAge: 0 });
    }
    if (p.endsWith('crossdomain.xml')) {
      return send(req, res, Buffer.from('<?xml version="1.0"?><cross-domain-policy><allow-access-from domain="*"/></cross-domain-policy>'), TYPES['.xml']);
    }
    log.debug('cdn 404', p);
    return notFound(res);
  }
  if (path === '/crossdomain.xml') {
    return send(req, res, Buffer.from('<?xml version="1.0"?><cross-domain-policy><allow-access-from domain="*"/></cross-domain-policy>'), TYPES['.xml']);
  }
  return notFound(res);
}

export function createHttpServer() {
  return createServer((req, res) => {
    route(req, res).catch((err) => {
      log.error('http error', req.url, err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
}
