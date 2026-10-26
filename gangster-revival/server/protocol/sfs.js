// SmartFoxServer 1.x wire protocol, as spoken by the Goodgame Gangster client.
//
// Every message is a UTF-8 string terminated by a NUL byte.
//   client -> server  XML  <msg t='sys'><body action='verChk' r='0'>...</body></msg>
//   client -> server  STR  %xt%<zone>%<cmd>%<roomId>%<p1>%<p2>%...%
//   server -> client  STR  %xt%<cmd>%<roomId>%<errorCode>%<p1>%...%      (classic command)
//   server -> client  STR  %xt%<cmd>%<roomId>%-1%<base64 protobuf>%       (protobuf command)
import { encode as pbEncode, decode as pbDecode } from './pb.js';
import { EventEmitter } from 'node:events';

export const ROOM_ID = 1;
const ROOM_NAME = 'Lobby';

// SmartFox room-list ints are sent "compressed": base-58 digits 'A'..'z', least significant first.
export function compressInt(n) {
  if (n <= 0) return 'A';
  let s = '';
  while (n > 0) { s += String.fromCharCode(65 + (n % 58)); n = Math.floor(n / 58); }
  return s;
}

const POLICY = "<?xml version='1.0'?><cross-domain-policy><allow-access-from domain='*' to-ports='*' /></cross-domain-policy>";

export class Session extends EventEmitter {
  /**
   * @param transport {{ send(buf: Buffer): void, close(): void, remote: string }}
   */
  constructor(transport, log) {
    super();
    this.transport = transport;
    this.log = log;
    this.buffer = Buffer.alloc(0);
    this.player = null; // set after login
    this.closed = false;
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let i;
    while ((i = this.buffer.indexOf(0)) !== -1) {
      const msg = this.buffer.subarray(0, i).toString('utf8');
      this.buffer = this.buffer.subarray(i + 1);
      if (msg) this.handleRaw(msg);
    }
    if (this.buffer.length > 1 << 20) this.close('oversized message');
  }

  handleRaw(msg) {
    this.log.debug('<<', msg.length > 300 ? msg.slice(0, 300) + '…' : msg);
    if (msg.startsWith('<policy-file-request')) {
      this.sendRaw(POLICY);
      return;
    }
    if (msg[0] === '<') {
      const action = /<body[^>]*action=['"]([^'"]+)['"]/.exec(msg)?.[1];
      const r = Number(/<body[^>]*\br=['"](-?\d+)['"]/.exec(msg)?.[1] ?? 0);
      const inner = /<body[^>]*>([\s\S]*)<\/body>/.exec(msg)?.[1] ?? '';
      this.emit('sys', { action, r, inner });
      return;
    }
    if (msg[0] === '%') {
      // %xt%<zone>%<cmd>%<roomId>%<params...>%
      const parts = msg.slice(1, -1).split('%');
      if (parts[0] !== 'xt' || parts.length < 4) return;
      const [, zone, cmd, room, ...params] = parts;
      const clean = params.map((p) => (p === '<RoundHouseKick>' ? '' : p));
      this.emit('xt', { zone, cmd, room: Number(room), params: clean });
    }
  }

  sendRaw(str) {
    if (this.closed) return;
    this.log.debug('>>', str.length > 300 ? str.slice(0, 300) + '…' : str);
    this.transport.send(Buffer.concat([Buffer.from(str, 'utf8'), Buffer.from([0])]));
  }

  sys(action, inner = '', r = 0) {
    this.sendRaw(`<msg t='sys'><body action='${action}' r='${r}'>${inner}</body></msg>`);
  }

  /** Classic command response. `params` are joined with '%'. */
  xt(cmd, error = 0, ...params) {
    const tail = params.length ? params.map((p) => (p ?? '')).join('%') + '%' : '';
    this.sendRaw(`%xt%${cmd}%${ROOM_ID}%${error}%${tail}`);
  }

  /** Protobuf command response. */
  pb(cmd, type, obj) {
    const b64 = pbEncode(type, obj).toString('base64');
    this.sendRaw(`%xt%${cmd}%${ROOM_ID}%-1%${b64}%`);
  }

  decodePb(type, params) {
    return pbDecode(type, Buffer.from(params[0] || '', 'base64'));
  }

  roomList() {
    // %xt%rlu%-1%<roomId>%<userCount>%<maxUsers>%<flags>%<name>%  (ints compressed)
    const flags = 2; // temporary room
    this.sendRaw(`%xt%rlu%-1%${ROOM_ID}%${compressInt(0)}%${compressInt(1000)}%${compressInt(flags)}%${ROOM_NAME}%`);
  }

  joinOk(pid) {
    this.sys('joinOK', `<pid id='${pid}'/><vars></vars><uLs r='${ROOM_ID}'></uLs>`, ROOM_ID);
  }

  close(reason) {
    if (this.closed) return;
    this.log.info('closing session', this.transport.remote, reason || '');
    this.closed = true;
    this.transport.close();
    this.emit('close');
  }
}
