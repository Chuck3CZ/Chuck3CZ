// Builds a tiny replacement for Goodgame's CookieSaver.swf.
//
// The client loads CookieSaver.swf from the CDN during startup and, for first-time
// visitors, calls `loader.content.getSharedObject(name)` on it. The original file is
// not part of the desktop installer, so we assemble an equivalent AS3 class by hand:
//
//   package { public class CookieSaver extends flash.display.Sprite {
//       public function getSharedObject(name:String):Object {
//           return flash.net.SharedObject.getLocal(name, "/");
//       } } }

function u30(n) {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

function abc() {
  const strings = ['', 'CookieSaver', 'flash.display', 'Sprite', 'getSharedObject', 'flash.net',
    'SharedObject', 'getLocal', '/', 'Object', 'flash.events', 'EventDispatcher', 'DisplayObject',
    'InteractiveObject', 'DisplayObjectContainer'];
  const s = (x) => strings.indexOf(x);
  const nsList = ['', 'flash.display', 'flash.net', 'flash.events'];
  const ns = (x) => nsList.indexOf(x) + 1;
  const mnList = [
    ['CookieSaver', ''], ['Sprite', 'flash.display'], ['getSharedObject', ''], ['SharedObject', 'flash.net'],
    ['getLocal', ''], ['Object', ''], ['EventDispatcher', 'flash.events'], ['DisplayObject', 'flash.display'],
    ['InteractiveObject', 'flash.display'], ['DisplayObjectContainer', 'flash.display'],
  ];
  const mn = (x) => mnList.findIndex((m) => m[0] === x) + 1;

  const b = [];
  const push = (...xs) => b.push(...xs.flat());
  push(0x10, 0x00, 0x2e, 0x00); // minor 16, major 46
  push(u30(0), u30(0), u30(0)); // int, uint, double pools
  push(u30(strings.length));
  for (const str of strings.slice(1)) { const by = Buffer.from(str, 'utf8'); push(u30(by.length), ...by); }
  push(u30(nsList.length + 1));
  for (const n of nsList) push(0x16, u30(s(n)));
  push(u30(1)); // ns sets
  push(u30(mnList.length + 1));
  for (const [name, n] of mnList) push(0x07, u30(ns(n)), u30(s(name)));

  // methods: 0 iinit, 1 cinit, 2 getSharedObject, 3 script init
  push(u30(4));
  push(u30(0), u30(0), u30(0), 0x00);
  push(u30(0), u30(0), u30(0), 0x00);
  push(u30(1), u30(0), u30(0), u30(0), 0x00);
  push(u30(0), u30(0), u30(0), 0x00);

  push(u30(0)); // metadata
  push(u30(1)); // classes
  // instance
  push(u30(mn('CookieSaver')), u30(mn('Sprite')), 0x01, u30(0), u30(0));
  push(u30(1), u30(mn('getSharedObject')), 0x01, u30(0), u30(2)); // method trait
  // class
  push(u30(1), u30(0));
  // script
  push(u30(1), u30(3), u30(1), u30(mn('CookieSaver')), 0x04, u30(1), u30(0));

  const OP = {
    getlocal0: 0xd0, getlocal1: 0xd1, pushscope: 0x30, popscope: 0x1d, constructsuper: 0x49,
    returnvoid: 0x47, returnvalue: 0x48, getlex: 0x60, pushstring: 0x2c, callproperty: 0x46,
    getscopeobject: 0x65, newclass: 0x58, initproperty: 0x68,
  };
  const bodies = [
    [0, 1, 1, 8, 9, [OP.getlocal0, OP.pushscope, OP.getlocal0, OP.constructsuper, 0, OP.returnvoid]],
    [1, 1, 1, 7, 8, [OP.getlocal0, OP.pushscope, OP.returnvoid]],
    [2, 3, 2, 8, 9, [OP.getlocal0, OP.pushscope, OP.getlex, ...u30(mn('SharedObject')), OP.getlocal1,
      OP.pushstring, ...u30(s('/')), OP.callproperty, ...u30(mn('getLocal')), 2, OP.returnvalue]],
    [3, 2, 1, 1, 9, [OP.getlocal0, OP.pushscope, OP.getscopeobject, 0,
      ...['Object', 'EventDispatcher', 'DisplayObject', 'InteractiveObject', 'DisplayObjectContainer']
        .flatMap((c) => [OP.getlex, ...u30(mn(c)), OP.pushscope]),
      OP.getlex, ...u30(mn('Sprite')), OP.newclass, 0,
      OP.popscope, OP.popscope, OP.popscope, OP.popscope, OP.popscope,
      OP.initproperty, ...u30(mn('CookieSaver')), OP.returnvoid]],
  ];
  push(u30(bodies.length));
  for (const [m, maxStack, locals, initScope, maxScope, code] of bodies) {
    push(u30(m), u30(maxStack), u30(locals), u30(initScope), u30(maxScope), u30(code.length), code, u30(0), u30(0));
  }
  return Buffer.from(b);
}

function tag(code, payload) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE((code << 6) | 0x3f, 0);
  head.writeUInt32LE(payload.length, 2);
  return Buffer.concat([head, payload]);
}

export function buildCookieSaverSwf() {
  // empty stage RECT (nbits = 0), 24 fps, 1 frame
  const header = Buffer.from([0x00, 0x00, 0x18, 0x01, 0x00]);
  const fileAttributes = tag(69, Buffer.from([0x08, 0, 0, 0])); // AS3
  const doAbc = tag(82, Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.from('CookieSaver\0'), abc()]));
  const symbolClass = tag(76, Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.from('CookieSaver\0')]));
  const showFrame = Buffer.from([0x40, 0x00]);
  const end = Buffer.from([0x00, 0x00]);
  const body = Buffer.concat([header, fileAttributes, doAbc, symbolClass, showFrame, end]);
  const out = Buffer.alloc(8);
  out.write('FWS', 0, 'ascii');
  out[3] = 10;
  out.writeUInt32LE(body.length + 8, 4);
  return Buffer.concat([out, body]);
}
