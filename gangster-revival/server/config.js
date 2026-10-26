import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const env = process.env;

export const config = {
  root,
  // HTTP server (web page, game files, CDN emulation, WebSocket at /ws)
  httpHost: env.HTTP_HOST || '0.0.0.0',
  httpPort: Number(env.PORT || env.HTTP_PORT || 8080),
  // Raw TCP SmartFox port for the original desktop (AIR) client. 0 disables it.
  tcpPort: Number(env.TCP_PORT ?? 9339),
  // Host/port the client is told to connect to. Ruffle maps this pair to the WebSocket,
  // the desktop client connects to it directly.
  socketHost: env.SOCKET_HOST || '127.0.0.1',
  socketPort: Number(env.SOCKET_PORT || env.TCP_PORT || 9339),
  zone: 'MafiaEx',
  serverName: env.SERVER_NAME || 'Gangster Revival',
  clientDir: resolve(root, env.CLIENT_DIR || 'client'),
  dataDir: resolve(root, env.DATA_DIR || 'data'),
  logLevel: env.LOG_LEVEL || 'info',
  // everything is free / starting resources (handy for a private server)
  startCash: Number(env.START_CASH ?? 1000),
  startGold: Number(env.START_GOLD ?? 100),
  // multiplies mission/work durations (0.1 = ten times faster)
  timeScale: Number(env.TIME_SCALE ?? 1),
};

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
function make(level) {
  return (...args) => {
    if (LEVELS[level] >= LEVELS[config.logLevel]) {
      console[level === 'debug' ? 'log' : level](new Date().toISOString().slice(11, 19), level.toUpperCase(), ...args);
    }
  };
}
export const log = { debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error') };
