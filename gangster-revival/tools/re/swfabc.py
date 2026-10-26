"""Minimal SWF + AVM2 (ABC) parser / disassembler.

Usage:
  python3 -I swfabc.py tags   FILE.swf
  python3 -I swfabc.py strings FILE.swf
  python3 -I swfabc.py classes FILE.swf
  python3 -I swfabc.py dump FILE.swf OUTDIR      # one .asm file per class
"""
import os
import struct
import sys
import zlib


# ---------------------------------------------------------------- SWF level
def read_swf(path):
    data = open(path, 'rb').read()
    sig = data[:3]
    version = data[3]
    if sig == b'FWS':
        body = data[8:]
    elif sig == b'CWS':
        body = zlib.decompress(data[8:])
    elif sig == b'ZWS':
        import lzma
        # ZWS: 4 bytes compressed len, 5 bytes props, then raw lzma
        props = data[12:17]
        raw = data[17:]
        dec = lzma.LZMADecompressor(format=lzma.FORMAT_RAW, filters=[
            {'id': lzma.FILTER_LZMA1, 'dict_size': struct.unpack('<I', props[1:5])[0],
             'lc': props[0] % 9, 'lp': (props[0] // 9) % 5, 'pb': props[0] // 45}])
        body = dec.decompress(raw)
    else:
        raise ValueError('not a swf: %r' % sig)
    # rect
    nbits = body[0] >> 3
    rect_len = (5 + nbits * 4 + 7) // 8
    pos = rect_len + 4  # frame rate + frame count
    header = body[:pos]
    tags = []
    while pos < len(body):
        code_len = struct.unpack_from('<H', body, pos)[0]
        pos += 2
        code = code_len >> 6
        ln = code_len & 0x3f
        long_form = False
        if ln == 0x3f:
            ln = struct.unpack_from('<I', body, pos)[0]
            pos += 4
            long_form = True
        tags.append([code, body[pos:pos + ln], long_form])
        pos += ln
        if code == 0:
            break
    return {'version': version, 'header': header, 'tags': tags}


def write_swf(swf, path, compress=True):
    out = bytearray(swf['header'])
    for code, payload, long_form in swf['tags']:
        ln = len(payload)
        if ln >= 0x3f or long_form:
            out += struct.pack('<HI', (code << 6) | 0x3f, ln)
        else:
            out += struct.pack('<H', (code << 6) | ln)
        out += payload
    total = len(out) + 8
    if compress:
        data = b'CWS' + bytes([swf['version']]) + struct.pack('<I', total) + zlib.compress(bytes(out), 9)
    else:
        data = b'FWS' + bytes([swf['version']]) + struct.pack('<I', total) + bytes(out)
    open(path, 'wb').write(data)


def abc_tags(swf):
    """Yield (tag_index, name, abc_bytes, prefix_len)"""
    for i, (code, payload, _) in enumerate(swf['tags']):
        if code == 82:  # DoABC2
            flags = payload[:4]
            end = payload.index(b'\0', 4)
            name = payload[4:end].decode('utf-8', 'replace')
            yield i, name, payload[end + 1:], end + 1
        elif code == 72:
            yield i, '', payload, 0


# ---------------------------------------------------------------- ABC level
class Reader:
    def __init__(self, data, pos=0):
        self.d = data
        self.p = pos

    def u8(self):
        v = self.d[self.p]
        self.p += 1
        return v

    def u16(self):
        v = struct.unpack_from('<H', self.d, self.p)[0]
        self.p += 2
        return v

    def s24(self):
        b = self.d[self.p:self.p + 3]
        self.p += 3
        v = b[0] | (b[1] << 8) | (b[2] << 16)
        if v & 0x800000:
            v -= 0x1000000
        return v

    def u30(self):
        result = 0
        shift = 0
        while True:
            b = self.d[self.p]
            self.p += 1
            result |= (b & 0x7f) << shift
            if not b & 0x80 or shift >= 28:
                break
            shift += 7
        return result

    def s32(self):
        v = self.u30()
        v &= 0xffffffff
        if v & 0x80000000:
            v -= 0x100000000
        return v

    def d64(self):
        v = struct.unpack_from('<d', self.d, self.p)[0]
        self.p += 8
        return v

    def bytes(self, n):
        v = self.d[self.p:self.p + n]
        self.p += n
        return v


NS_KINDS = {0x08: 'ns', 0x16: 'pkg', 0x17: 'pkginternal', 0x18: 'protected',
            0x19: 'explicit', 0x1A: 'staticprotected', 0x05: 'private'}


class ABC:
    def __init__(self, data):
        self.data = data
        r = Reader(data)
        self.minor = r.u16()
        self.major = r.u16()
        n = r.u30()
        self.ints = [0] + [r.s32() for _ in range(max(0, n - 1))]
        n = r.u30()
        self.uints = [0] + [r.u30() for _ in range(max(0, n - 1))]
        n = r.u30()
        self.doubles = [float('nan')] + [r.d64() for _ in range(max(0, n - 1))]
        n = r.u30()
        self.strings = [None]
        self.string_offsets = [None]
        for _ in range(max(0, n - 1)):
            ln = r.u30()
            self.string_offsets.append(r.p)
            self.strings.append(r.bytes(ln).decode('utf-8', 'replace'))
        self.strings_end = r.p
        n = r.u30()
        self.namespaces = [(0, 0)] + [(r.u8(), r.u30()) for _ in range(max(0, n - 1))]
        n = r.u30()
        self.nssets = [[]]
        for _ in range(max(0, n - 1)):
            c = r.u30()
            self.nssets.append([r.u30() for _ in range(c)])
        n = r.u30()
        self.multinames = [None]
        for _ in range(max(0, n - 1)):
            k = r.u8()
            if k in (0x07, 0x0D):
                self.multinames.append(('QName', r.u30(), r.u30(), k == 0x0D))
            elif k in (0x0F, 0x10):
                self.multinames.append(('RTQName', r.u30()))
            elif k in (0x11, 0x12):
                self.multinames.append(('RTQNameL',))
            elif k in (0x09, 0x0E):
                name = r.u30()
                self.multinames.append(('Multiname', name, r.u30(), k == 0x0E))
            elif k in (0x1B, 0x1C):
                self.multinames.append(('MultinameL', r.u30(), k == 0x1C))
            elif k == 0x1D:
                base = r.u30()
                c = r.u30()
                self.multinames.append(('TypeName', base, [r.u30() for _ in range(c)]))
            else:
                raise ValueError('bad multiname kind %x' % k)
        n = r.u30()
        self.methods = []
        for _ in range(n):
            pc = r.u30()
            ret = r.u30()
            params = [r.u30() for _ in range(pc)]
            name = r.u30()
            flags = r.u8()
            opts = []
            if flags & 0x08:
                oc = r.u30()
                opts = [(r.u30(), r.u8()) for _ in range(oc)]
            pnames = []
            if flags & 0x80:
                pnames = [r.u30() for _ in range(pc)]
            self.methods.append({'ret': ret, 'params': params, 'name': name, 'flags': flags,
                                 'opts': opts, 'pnames': pnames, 'body': None})
        n = r.u30()
        self.metadata = []
        for _ in range(n):
            name = r.u30()
            c = r.u30()
            keys = [r.u30() for _ in range(c)]
            vals = [r.u30() for _ in range(c)]
            self.metadata.append((name, keys, vals))
        n = r.u30()
        self.instances = []
        for _ in range(n):
            name = r.u30()
            sup = r.u30()
            flags = r.u8()
            pns = r.u30() if flags & 0x08 else 0
            ic = r.u30()
            ifaces = [r.u30() for _ in range(ic)]
            iinit = r.u30()
            traits = self._traits(r)
            self.instances.append({'name': name, 'super': sup, 'flags': flags, 'ifaces': ifaces,
                                   'iinit': iinit, 'traits': traits})
        self.classes = []
        for _ in range(n):
            cinit = r.u30()
            self.classes.append({'cinit': cinit, 'traits': self._traits(r)})
        n = r.u30()
        self.scripts = []
        for _ in range(n):
            init = r.u30()
            self.scripts.append({'init': init, 'traits': self._traits(r)})
        n = r.u30()
        self.bodies = []
        for _ in range(n):
            m = r.u30()
            b = {'method': m, 'max_stack': r.u30(), 'locals': r.u30(), 'init_scope': r.u30(),
                 'max_scope': r.u30()}
            cl = r.u30()
            b['code_offset'] = r.p
            b['code'] = r.bytes(cl)
            ec = r.u30()
            b['exceptions'] = [(r.u30(), r.u30(), r.u30(), r.u30(), r.u30()) for _ in range(ec)]
            b['traits'] = self._traits(r)
            self.bodies.append(b)
            self.methods[m]['body'] = b

    def _traits(self, r):
        out = []
        n = r.u30()
        for _ in range(n):
            name = r.u30()
            kind = r.u8()
            k = kind & 0x0f
            t = {'name': name, 'kind': k}
            if k in (0, 6):
                t['slot_id'] = r.u30()
                t['type'] = r.u30()
                t['vindex'] = r.u30()
                if t['vindex']:
                    t['vkind'] = r.u8()
            elif k == 4:
                t['slot_id'] = r.u30()
                t['class'] = r.u30()
            elif k == 5:
                t['slot_id'] = r.u30()
                t['function'] = r.u30()
            elif k in (1, 2, 3):
                t['disp_id'] = r.u30()
                t['method'] = r.u30()
            else:
                raise ValueError('bad trait kind %d' % k)
            if (kind >> 4) & 0x04:
                mc = r.u30()
                t['meta'] = [r.u30() for _ in range(mc)]
            out.append(t)
        return out

    # ---- naming helpers
    def ns_name(self, i):
        if i == 0:
            return '*'
        kind, s = self.namespaces[i]
        return self.strings[s] if s else ''

    def mn(self, i):
        if i == 0:
            return '*'
        m = self.multinames[i]
        if m[0] == 'QName':
            ns = self.ns_name(m[1])
            nm = self.strings[m[2]] if m[2] else '*'
            return (ns + '::' + nm) if ns else nm
        if m[0] == 'Multiname':
            return self.strings[m[1]] if m[1] else '*'
        if m[0] == 'RTQName':
            return self.strings[m[1]] if m[1] else '*'
        if m[0] == 'MultinameL':
            return '@[late]' if m[2] else '[late]'
        if m[0] == 'TypeName':
            return '%s.<%s>' % (self.mn(m[1]), ','.join(self.mn(x) for x in m[2]))
        return '[rt]'

    def short(self, i):
        if i == 0:
            return '*'
        m = self.multinames[i]
        if m[0] in ('QName', 'Multiname'):
            idx = m[2] if m[0] == 'QName' else m[1]
            return ('@' if m[3] else '') + (self.strings[idx] if idx else '*')
        return self.mn(i)


# ---------------------------------------------------------------- disassembly
# opcode -> (name, operand spec)  spec chars: u=u30 s=s24 b=u8 S=string M=multiname I=int U=uint D=double N=ns m=method c=class k=lookupswitch
OPS = {
    0x01: ('bkpt', ''), 0x02: ('nop', ''), 0x03: ('throw', ''), 0x04: ('getsuper', 'M'),
    0x05: ('setsuper', 'M'), 0x06: ('dxns', 'S'), 0x07: ('dxnslate', ''), 0x08: ('kill', 'u'),
    0x09: ('label', ''), 0x0C: ('ifnlt', 's'), 0x0D: ('ifnle', 's'), 0x0E: ('ifngt', 's'),
    0x0F: ('ifnge', 's'), 0x10: ('jump', 's'), 0x11: ('iftrue', 's'), 0x12: ('iffalse', 's'),
    0x13: ('ifeq', 's'), 0x14: ('ifne', 's'), 0x15: ('iflt', 's'), 0x16: ('ifle', 's'),
    0x17: ('ifgt', 's'), 0x18: ('ifge', 's'), 0x19: ('ifstricteq', 's'), 0x1A: ('ifstrictne', 's'),
    0x1B: ('lookupswitch', 'k'), 0x1C: ('pushwith', ''), 0x1D: ('popscope', ''),
    0x1E: ('nextname', ''), 0x1F: ('hasnext', ''), 0x20: ('pushnull', ''),
    0x21: ('pushundefined', ''), 0x23: ('nextvalue', ''), 0x24: ('pushbyte', 'b'),
    0x25: ('pushshort', 'u'), 0x26: ('pushtrue', ''), 0x27: ('pushfalse', ''),
    0x28: ('pushnan', ''), 0x29: ('pop', ''), 0x2A: ('dup', ''), 0x2B: ('swap', ''),
    0x2C: ('pushstring', 'S'), 0x2D: ('pushint', 'I'), 0x2E: ('pushuint', 'U'),
    0x2F: ('pushdouble', 'D'), 0x30: ('pushscope', ''), 0x31: ('pushnamespace', 'N'),
    0x32: ('hasnext2', 'uu'), 0x35: ('li8', ''), 0x36: ('li16', ''), 0x37: ('li32', ''),
    0x38: ('lf32', ''), 0x39: ('lf64', ''), 0x3A: ('si8', ''), 0x3B: ('si16', ''),
    0x3C: ('si32', ''), 0x3D: ('sf32', ''), 0x3E: ('sf64', ''), 0x40: ('newfunction', 'm'),
    0x41: ('call', 'u'), 0x42: ('construct', 'u'), 0x43: ('callmethod', 'uu'),
    0x44: ('callstatic', 'mu'), 0x45: ('callsuper', 'Mu'), 0x46: ('callproperty', 'Mu'),
    0x47: ('returnvoid', ''), 0x48: ('returnvalue', ''), 0x49: ('constructsuper', 'u'),
    0x4A: ('constructprop', 'Mu'), 0x4C: ('callproplex', 'Mu'), 0x4E: ('callsupervoid', 'Mu'),
    0x4F: ('callpropvoid', 'Mu'), 0x50: ('sxi1', ''), 0x51: ('sxi8', ''), 0x52: ('sxi16', ''),
    0x53: ('applytype', 'u'), 0x55: ('newobject', 'u'), 0x56: ('newarray', 'u'),
    0x57: ('newactivation', ''), 0x58: ('newclass', 'c'), 0x59: ('getdescendants', 'M'),
    0x5A: ('newcatch', 'u'), 0x5D: ('findpropstrict', 'M'), 0x5E: ('findproperty', 'M'),
    0x5F: ('finddef', 'M'), 0x60: ('getlex', 'M'), 0x61: ('setproperty', 'M'),
    0x62: ('getlocal', 'u'), 0x63: ('setlocal', 'u'), 0x64: ('getglobalscope', ''),
    0x65: ('getscopeobject', 'b'), 0x66: ('getproperty', 'M'), 0x67: ('getouterscope', 'u'),
    0x68: ('initproperty', 'M'), 0x6A: ('deleteproperty', 'M'), 0x6C: ('getslot', 'u'),
    0x6D: ('setslot', 'u'), 0x6E: ('getglobalslot', 'u'), 0x6F: ('setglobalslot', 'u'),
    0x70: ('convert_s', ''), 0x71: ('esc_xelem', ''), 0x72: ('esc_xattr', ''),
    0x73: ('convert_i', ''), 0x74: ('convert_u', ''), 0x75: ('convert_d', ''),
    0x76: ('convert_b', ''), 0x77: ('convert_o', ''), 0x78: ('checkfilter', ''),
    0x80: ('coerce', 'M'), 0x81: ('coerce_b', ''), 0x82: ('coerce_a', ''), 0x83: ('coerce_i', ''),
    0x84: ('coerce_d', ''), 0x85: ('coerce_s', ''), 0x86: ('astype', 'M'), 0x87: ('astypelate', ''),
    0x88: ('coerce_u', ''), 0x89: ('coerce_o', ''), 0x90: ('negate', ''), 0x91: ('increment', ''),
    0x92: ('inclocal', 'u'), 0x93: ('decrement', ''), 0x94: ('declocal', 'u'), 0x95: ('typeof', ''),
    0x96: ('not', ''), 0x97: ('bitnot', ''), 0xA0: ('add', ''), 0xA1: ('subtract', ''),
    0xA2: ('multiply', ''), 0xA3: ('divide', ''), 0xA4: ('modulo', ''), 0xA5: ('lshift', ''),
    0xA6: ('rshift', ''), 0xA7: ('urshift', ''), 0xA8: ('bitand', ''), 0xA9: ('bitor', ''),
    0xAA: ('bitxor', ''), 0xAB: ('equals', ''), 0xAC: ('strictequals', ''), 0xAD: ('lessthan', ''),
    0xAE: ('lessequals', ''), 0xAF: ('greaterthan', ''), 0xB0: ('greaterequals', ''),
    0xB1: ('instanceof', ''), 0xB2: ('istype', 'M'), 0xB3: ('istypelate', ''), 0xB4: ('in', ''),
    0xC0: ('increment_i', ''), 0xC1: ('decrement_i', ''), 0xC2: ('inclocal_i', 'u'),
    0xC3: ('declocal_i', 'u'), 0xC4: ('negate_i', ''), 0xC5: ('add_i', ''), 0xC6: ('subtract_i', ''),
    0xC7: ('multiply_i', ''), 0xD0: ('getlocal0', ''), 0xD1: ('getlocal1', ''),
    0xD2: ('getlocal2', ''), 0xD3: ('getlocal3', ''), 0xD4: ('setlocal0', ''),
    0xD5: ('setlocal1', ''), 0xD6: ('setlocal2', ''), 0xD7: ('setlocal3', ''),
    0xEF: ('debug', 'bubu'), 0xF0: ('debugline', 'u'), 0xF1: ('debugfile', 'S'),
    0xF2: ('bkptline', 'u'), 0xF3: ('timestamp', ''),
}


def disasm(abc, code):
    """Return list of (offset, opname, operands_text, raw_operands, length)."""
    r = Reader(code)
    out = []
    while r.p < len(code):
        start = r.p
        op = r.u8()
        if op not in OPS:
            out.append((start, 'op_%02x' % op, '', [], 1))
            continue
        name, spec = OPS[op]
        args = []
        txt = []
        if spec == 'k':
            base = start
            default = r.s24()
            cnt = r.u30()
            cases = [r.s24() for _ in range(cnt + 1)]
            args = [default, cases]
            txt.append('default:%d cases:%s' % (base + default, [base + c for c in cases]))
        else:
            for ch in spec:
                if ch == 's':
                    v = r.s24()
                    args.append(v)
                    txt.append('L%d' % (r.p + v))
                elif ch == 'b':
                    v = r.u8()
                    if name == 'pushbyte' and v > 127:
                        v -= 256
                    args.append(v)
                    txt.append(str(v))
                else:
                    v = r.u30()
                    args.append(v)
                    if ch == 'S':
                        txt.append(repr(abc.strings[v]))
                    elif ch == 'M':
                        txt.append(abc.mn(v))
                    elif ch == 'I':
                        txt.append(str(abc.ints[v]))
                    elif ch == 'U':
                        txt.append(str(abc.uints[v]))
                    elif ch == 'D':
                        txt.append(repr(abc.doubles[v]))
                    elif ch == 'm':
                        txt.append('method#%d' % v)
                    elif ch == 'c':
                        txt.append('class#%d' % v)
                    else:
                        txt.append(str(v))
        out.append((start, name, ' '.join(txt), args, r.p - start))
    return out


def method_sig(abc, mi, name):
    m = abc.methods[mi]
    ps = []
    for i, p in enumerate(m['params']):
        pn = abc.strings[m['pnames'][i]] if m['pnames'] and m['pnames'][i] else 'p%d' % (i + 1)
        ps.append('%s:%s' % (pn, abc.short(p)))
    return '%s(%s):%s' % (name, ', '.join(ps), abc.short(m['ret']))


def dump_method(abc, mi, name, out):
    out.append('  method %s  [#%d]' % (method_sig(abc, mi, name), mi))
    b = abc.methods[mi]['body']
    if not b:
        out.append('    (no body)')
        return
    for off, op, txt, _, _ in disasm(abc, b['code']):
        if op in ('debugline', 'debugfile', 'debug'):
            continue
        out.append('    %5d  %-16s %s' % (off, op, txt))


TRAIT_KIND = {0: 'var', 1: 'method', 2: 'getter', 3: 'setter', 4: 'class', 5: 'function', 6: 'const'}


def dump_traits(abc, traits, out, prefix=''):
    for t in traits:
        nm = abc.mn(t['name'])
        k = t['kind']
        if k in (0, 6):
            val = ''
            if t.get('vindex'):
                vk = t['vkind']
                vi = t['vindex']
                if vk == 0x01:
                    val = ' = %r' % abc.strings[vi]
                elif vk == 0x03:
                    val = ' = %d' % abc.ints[vi]
                elif vk == 0x04:
                    val = ' = %d' % abc.uints[vi]
                elif vk == 0x06:
                    val = ' = %r' % abc.doubles[vi]
                elif vk in (0x0A, 0x0B, 0x0C):
                    val = ' = %s' % {0x0A: 'false', 0x0B: 'true', 0x0C: 'null'}[vk]
            out.append('  %s%s %s:%s%s' % (prefix, TRAIT_KIND[k], nm, abc.short(t['type']), val))
    for t in traits:
        if t['kind'] in (1, 2, 3):
            kind = TRAIT_KIND[t['kind']]
            dump_method(abc, t['method'], prefix + kind + ' ' + abc.short(t['name']), out)


def dump_class(abc, ci):
    inst = abc.instances[ci]
    cls = abc.classes[ci]
    out = ['class %s extends %s implements %s' % (
        abc.mn(inst['name']), abc.mn(inst['super']), ','.join(abc.mn(x) for x in inst['ifaces']))]
    dump_traits(abc, cls['traits'], out, 'static ')
    dump_traits(abc, inst['traits'], out)
    dump_method(abc, cls['cinit'], 'static_init', out)
    dump_method(abc, inst['iinit'], 'constructor', out)
    return '\n'.join(out)


def main():
    cmd, path = sys.argv[1], sys.argv[2]
    swf = read_swf(path)
    if cmd == 'tags':
        for code, payload, _ in swf['tags']:
            print(code, len(payload))
        return
    for ti, name, data, _ in abc_tags(swf):
        abc = ABC(data)
        if cmd == 'strings':
            for s in abc.strings[1:]:
                print(s)
        elif cmd == 'classes':
            for inst in abc.instances:
                print(abc.mn(inst['name']), '<', abc.mn(inst['super']))
        elif cmd == 'dump':
            outdir = sys.argv[3]
            os.makedirs(outdir, exist_ok=True)
            for ci, inst in enumerate(abc.instances):
                fn = abc.mn(inst['name']).replace('::', '.').replace('/', '_').replace(':', '_')
                with open(os.path.join(outdir, fn + '.asm'), 'w') as f:
                    f.write(dump_class(abc, ci))
            # script-level functions / initializers
            sout = []
            for si, s in enumerate(abc.scripts):
                sout.append('script #%d' % si)
                dump_method(abc, s['init'], 'script_init', sout)
            with open(os.path.join(outdir, '_scripts.asm'), 'w') as f:
                f.write('\n'.join(sout))


if __name__ == '__main__':
    main()
