// Schema-driven protobuf (proto2) codec.
// The schema in server/data/pbschema.json was extracted from the game client's
// generated netease-as3 protobuf classes (see tools/re/pbschema.py).
// Messages are plain JS objects keyed by the client's camelCase field names.
import { readFileSync } from 'node:fs';

const schema = JSON.parse(readFileSync(new URL('../data/pbschema.json', import.meta.url), 'utf8'));
export const enums = schema.enums;

const WIRE = { uint32: 0, int32: 0, enum: 0, bool: 0, string: 2, message: 2, float: 5 };

function fieldsOf(type) {
  const f = schema.messages[type];
  if (!f) throw new Error(`unknown protobuf message ${type}`);
  return f;
}

// ---------------------------------------------------------------- encode
class Writer {
  constructor() { this.chunks = []; }
  byte(b) { this.chunks.push(Buffer.from([b])); }
  varint(v) {
    // handles negative int32 as 10-byte two's complement
    let n = BigInt.asUintN(64, BigInt(Math.trunc(v)));
    const out = [];
    do {
      let b = Number(n & 0x7fn);
      n >>= 7n;
      if (n) b |= 0x80;
      out.push(b);
    } while (n);
    this.chunks.push(Buffer.from(out));
  }
  bytes(buf) { this.varint(buf.length); this.chunks.push(buf); }
  float(v) { const b = Buffer.alloc(4); b.writeFloatLE(v); this.chunks.push(b); }
  finish() { return Buffer.concat(this.chunks); }
}

function enumValue(ref, v) {
  if (typeof v === 'number') return v;
  const e = enums[ref];
  if (!e || !(v in e)) throw new Error(`unknown enum value ${ref}.${v}`);
  return e[v];
}

function writeValue(w, type, ref, v) {
  switch (type) {
    case 'uint32': w.varint(v >>> 0); break;
    case 'int32': w.varint(v | 0); break;
    case 'bool': w.varint(v ? 1 : 0); break;
    case 'enum': w.varint(enumValue(ref, v)); break;
    case 'float': w.float(v); break;
    case 'string': w.bytes(Buffer.from(String(v), 'utf8')); break;
    case 'message': w.bytes(encode(ref, v)); break;
    default: throw new Error(`unsupported field type ${type}`);
  }
}

export function encode(type, obj = {}) {
  const w = new Writer();
  for (const [id, name, ftype, repeated, ref] of fieldsOf(type)) {
    const v = obj[name];
    if (v === undefined || v === null) continue;
    for (const item of repeated ? v : [v]) {
      w.varint((id << 3) | WIRE[ftype]);
      writeValue(w, ftype, ref, item);
    }
  }
  return w.finish();
}

// ---------------------------------------------------------------- decode
class Reader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  get done() { return this.pos >= this.buf.length; }
  varint() {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const b = this.buf[this.pos++];
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7n;
    }
    return result;
  }
  bytes() { const n = Number(this.varint()); const b = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return b; }
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`bad wire type ${wire}`);
  }
}

function readScalar(r, type, ref) {
  switch (type) {
    case 'uint32': return Number(BigInt.asUintN(32, r.varint()));
    case 'int32': return Number(BigInt.asIntN(32, r.varint()));
    case 'enum': return Number(BigInt.asIntN(32, r.varint()));
    case 'bool': return r.varint() !== 0n;
    case 'float': { const v = r.buf.readFloatLE(r.pos); r.pos += 4; return v; }
    case 'string': return r.bytes().toString('utf8');
    case 'message': return decode(ref, r.bytes());
    default: throw new Error(`unsupported field type ${type}`);
  }
}

export function decode(type, buf) {
  const byId = new Map(fieldsOf(type).map((f) => [f[0], f]));
  const r = new Reader(buf);
  const out = {};
  while (!r.done) {
    const key = Number(r.varint());
    const id = key >>> 3;
    const wire = key & 7;
    const f = byId.get(id);
    if (!f) { r.skip(wire); continue; }
    const [, name, ftype, repeated, ref] = f;
    if (repeated && wire === 2 && WIRE[ftype] !== 2) {
      // packed repeated scalars
      const sub = new Reader(r.bytes());
      out[name] ??= [];
      while (!sub.done) out[name].push(readScalar(sub, ftype, ref));
      continue;
    }
    const v = readScalar(r, ftype, ref);
    if (repeated) (out[name] ??= []).push(v);
    else out[name] = v;
  }
  return out;
}

export function enumName(ref, value) {
  const e = enums[ref] || {};
  return Object.keys(e).find((k) => e[k] === value);
}
