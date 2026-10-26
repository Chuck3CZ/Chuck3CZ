import { createServer as createTcpServer } from 'node:net';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { config, log } from './config.js';
import { createHttpServer } from './http.js';
import { Session } from './protocol/sfs.js';
import { attachGame } from './game/index.js';
import './db.js';

if (!existsSync(join(config.clientDir, 'GoodgameGangster.swf'))) {
  log.warn(`game client not found in ${config.clientDir} - run "npm run setup" first`);
}

function startSession(transport) {
  const session = new Session(transport, log);
  log.info('connection from', transport.remote);
  attachGame(session);
  return session;
}

// HTTP + WebSocket (browser via Ruffle's socketProxy)
const http = createHttpServer();
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
http.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    const remote = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const session = startSession({
      remote: `ws:${remote}`,
      send: (buf) => ws.readyState === ws.OPEN && ws.send(buf, { binary: true }),
      close: () => ws.close(),
    });
    ws.on('message', (data) => session.receive(Buffer.isBuffer(data) ? data : Buffer.from(data)));
    ws.on('close', () => session.close('ws closed'));
    ws.on('error', () => session.close('ws error'));
  });
});
http.listen(config.httpPort, config.httpHost, () => {
  log.info(`web:    http://localhost:${config.httpPort}/`);
});

// Raw TCP (original desktop client)
if (config.tcpPort) {
  createTcpServer((sock) => {
    sock.setNoDelay(true);
    const session = startSession({
      remote: `tcp:${sock.remoteAddress}`,
      send: (buf) => sock.write(buf),
      close: () => sock.end(),
    });
    sock.on('data', (d) => session.receive(d));
    sock.on('close', () => session.close('tcp closed'));
    sock.on('error', () => session.close('tcp error'));
  }).listen(config.tcpPort, config.httpHost, () => log.info(`socket: tcp://${config.socketHost}:${config.tcpPort}`));
}
