"""Very small AVM2 pseudo-decompiler: stack ops -> expressions, control flow as gotos.

python3 -I pseudo.py FILE.swf OUTDIR [classFilterSubstring]
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import swfabc  # noqa: E402

BINOPS = {'add': '+', 'add_i': '+', 'subtract': '-', 'subtract_i': '-', 'multiply': '*',
          'multiply_i': '*', 'divide': '/', 'modulo': '%', 'lshift': '<<', 'rshift': '>>',
          'urshift': '>>>', 'bitand': '&', 'bitor': '|', 'bitxor': '^', 'equals': '==',
          'strictequals': '===', 'lessthan': '<', 'lessequals': '<=', 'greaterthan': '>',
          'greaterequals': '>=', 'instanceof': 'instanceof', 'istypelate': 'is', 'in': 'in',
          'astypelate': 'as'}
CONDS = {'ifeq': '==', 'ifne': '!=', 'iflt': '<', 'ifle': '<=', 'ifgt': '>', 'ifge': '>=',
         'ifstricteq': '===', 'ifstrictne': '!==', 'ifnlt': '!<', 'ifnle': '!<=', 'ifngt': '!>',
         'ifnge': '!>='}


def decompile(abc, mi):
    m = abc.methods[mi]
    b = m['body']
    if not b:
        return ['    (no body)']
    names = {0: 'this'}
    for i in range(len(m['params'])):
        names[i + 1] = abc.strings[m['pnames'][i]] if m['pnames'] and m['pnames'][i] else 'arg%d' % (i + 1)
    if m['flags'] & 0x01 or m['flags'] & 0x04:
        names[len(m['params']) + 1] = 'arguments'

    def loc(i):
        return names.get(i, '_loc%d' % i)

    ins = swfabc.disasm(abc, b['code'])
    targets = set()
    for off, op, txt, args, ln in ins:
        if op in CONDS or op in ('jump', 'iftrue', 'iffalse'):
            targets.add(off + ln + args[0])
        if op == 'lookupswitch':
            targets.add(off + args[0])
            for c in args[1]:
                targets.add(off + c)
    for ex in b['exceptions']:
        targets.add(ex[2])
    out = []
    st = []

    def pop():
        return st.pop() if st else '<?>'

    def popn(n):
        a = [pop() for _ in range(n)]
        return a[::-1]

    def prop(obj, mi_):
        mn = abc.multinames[mi_] if mi_ else None
        if mn and mn[0] in ('MultinameL',):
            k = pop()
            o = pop() if obj is None else obj
            return '%s%s[%s]' % (o, '.@' if mn[2] else '', k)
        nm = abc.short(mi_)
        o = pop() if obj is None else obj
        if o in ('this', ''):
            return nm
        return '%s.%s' % (o, nm)

    def name_with_late(mi_):
        mn = abc.multinames[mi_] if mi_ else None
        late = mn and mn[0] in ('MultinameL', 'RTQNameL')
        return late

    def emit(s):
        out.append('    ' + s)

    for off, op, txt, args, ln in ins:
        if off in targets:
            if st:
                emit('// stack: %s' % st)
            out.append('  L%d:' % off)
        if op in ('debugline', 'debugfile', 'debug', 'nop', 'label', 'timestamp'):
            continue
        if op == 'getlocal0':
            st.append('this')
        elif op in ('getlocal1', 'getlocal2', 'getlocal3'):
            st.append(loc(int(op[-1])))
        elif op == 'getlocal':
            st.append(loc(args[0]))
        elif op in ('setlocal0', 'setlocal1', 'setlocal2', 'setlocal3', 'setlocal'):
            i = args[0] if op == 'setlocal' else int(op[-1])
            v = pop()
            emit('%s = %s;' % (loc(i), v))
            if st and st[-1] == v and ('(' in v or '.' in v):
                st[-1] = loc(i)  # dup + setlocal: the remaining copy is the local
        elif op in ('pushscope', 'pushwith', 'popscope'):
            if op != 'popscope':
                pop()
        elif op == 'pushstring':
            st.append(repr(abc.strings[args[0]]))
        elif op in ('pushbyte', 'pushshort'):
            st.append(str(args[0]))
        elif op == 'pushint':
            st.append(str(abc.ints[args[0]]))
        elif op == 'pushuint':
            st.append(str(abc.uints[args[0]]))
        elif op == 'pushdouble':
            st.append(repr(abc.doubles[args[0]]))
        elif op in ('pushtrue', 'pushfalse', 'pushnull', 'pushundefined', 'pushnan'):
            st.append({'pushtrue': 'true', 'pushfalse': 'false', 'pushnull': 'null',
                       'pushundefined': 'undefined', 'pushnan': 'NaN'}[op])
        elif op == 'pushnamespace':
            st.append('ns(%s)' % abc.ns_name(args[0]))
        elif op in ('getlex', 'findpropstrict', 'findproperty', 'finddef'):
            if op == 'getlex':
                st.append(abc.short(args[0]))
            else:
                if name_with_late(args[0]):
                    pop()
                st.append('')
        elif op == 'getproperty':
            st.append(prop(None, args[0]))
        elif op in ('setproperty', 'initproperty'):
            v = pop()
            target = prop(None, args[0])
            emit('%s = %s;' % (target, v))
        elif op == 'deleteproperty':
            st.append('delete ' + prop(None, args[0]))
        elif op == 'getsuper':
            pop()
            st.append('super.' + abc.short(args[0]))
        elif op == 'setsuper':
            v = pop()
            pop()
            emit('super.%s = %s;' % (abc.short(args[0]), v))
        elif op in ('callproperty', 'callproplex', 'callpropvoid', 'constructprop', 'callsuper',
                    'callsupervoid'):
            a = popn(args[1])
            if op.startswith('callsuper'):
                pop()
                expr = 'super.%s(%s)' % (abc.short(args[0]), ', '.join(a))
            else:
                f = prop(None, args[0])
                expr = ('new ' if op == 'constructprop' else '') + '%s(%s)' % (f, ', '.join(a))
            if op.endswith('void'):
                emit(expr + ';')
            else:
                st.append(expr)
        elif op == 'callmethod' or op == 'callstatic':
            a = popn(args[1])
            o = pop()
            st.append('%s.method#%d(%s)' % (o, args[0], ', '.join(a)))
        elif op == 'call':
            a = popn(args[0])
            recv = pop()
            f = pop()
            st.append('%s(%s)' % (f, ', '.join(a)))
        elif op == 'construct':
            a = popn(args[0])
            st.append('new %s(%s)' % (pop(), ', '.join(a)))
        elif op == 'constructsuper':
            a = popn(args[0])
            pop()
            emit('super(%s);' % ', '.join(a))
        elif op == 'newobject':
            kv = popn(args[0] * 2)
            st.append('{' + ', '.join('%s:%s' % (kv[i], kv[i + 1]) for i in range(0, len(kv), 2)) + '}')
        elif op == 'newarray':
            st.append('[' + ', '.join(popn(args[0])) + ']')
        elif op == 'newfunction':
            st.append('function#%d' % args[0])
        elif op == 'newclass':
            pop()
            st.append('class#%d' % args[0])
        elif op == 'newactivation':
            st.append('activation')
        elif op == 'newcatch':
            st.append('catch#%d' % args[0])
        elif op in BINOPS:
            r_ = pop()
            l_ = pop()
            st.append('(%s %s %s)' % (l_, BINOPS[op], r_))
        elif op == 'not':
            st.append('!' + pop())
        elif op in ('negate', 'negate_i'):
            st.append('-' + pop())
        elif op == 'bitnot':
            st.append('~' + pop())
        elif op in ('increment', 'increment_i'):
            st.append('(%s + 1)' % pop())
        elif op in ('decrement', 'decrement_i'):
            st.append('(%s - 1)' % pop())
        elif op in ('inclocal', 'inclocal_i'):
            emit('%s++;' % loc(args[0]))
        elif op in ('declocal', 'declocal_i'):
            emit('%s--;' % loc(args[0]))
        elif op == 'typeof':
            st.append('typeof ' + pop())
        elif op in ('convert_s', 'convert_i', 'convert_u', 'convert_d', 'convert_b', 'convert_o',
                    'coerce_a', 'coerce_s', 'coerce_i', 'coerce_d', 'coerce_b', 'coerce_u',
                    'coerce_o', 'checkfilter', 'esc_xelem', 'esc_xattr'):
            if op in ('esc_xelem', 'esc_xattr'):
                st.append('esc(%s)' % pop())
        elif op in ('coerce', 'astype'):
            if op == 'astype':
                st.append('(%s as %s)' % (pop(), abc.short(args[0])))
        elif op == 'istype':
            st.append('(%s is %s)' % (pop(), abc.short(args[0])))
        elif op == 'dup':
            v = pop()
            st.append(v)
            st.append(v)
        elif op == 'swap':
            a_ = pop()
            b_ = pop()
            st.append(a_)
            st.append(b_)
        elif op == 'pop':
            v = pop()
            if '(' in v:
                emit(v + ';')
        elif op == 'kill':
            pass
        elif op == 'getslot':
            st.append('%s.slot%d' % (pop(), args[0]))
        elif op == 'setslot':
            v = pop()
            emit('%s.slot%d = %s;' % (pop(), args[0], v))
        elif op == 'getglobalscope':
            st.append('global')
        elif op == 'getscopeobject':
            st.append('scope%d' % args[0])
        elif op == 'returnvoid':
            emit('return;')
        elif op == 'returnvalue':
            emit('return %s;' % pop())
        elif op == 'throw':
            emit('throw %s;' % pop())
        elif op == 'jump':
            emit('goto L%d;' % (off + ln + args[0]))
        elif op in ('iftrue', 'iffalse'):
            c = pop()
            emit('if (%s%s) goto L%d;' % ('' if op == 'iftrue' else '!', c, off + ln + args[0]))
        elif op in CONDS:
            r_ = pop()
            l_ = pop()
            emit('if (%s %s %s) goto L%d;' % (l_, CONDS[op], r_, off + ln + args[0]))
        elif op == 'lookupswitch':
            emit('switch (%s) default:L%d cases:%s;' % (pop(), off + args[0], ['L%d' % (off + c) for c in args[1]]))
        elif op in ('hasnext2',):
            st.append('hasnext2(%s,%s)' % (loc(args[0]), loc(args[1])))
        elif op in ('nextname', 'nextvalue'):
            i_ = pop()
            o_ = pop()
            st.append('%s(%s,%s)' % (op, o_, i_))
        elif op == 'applytype':
            a = popn(args[0])
            st.append('%s.<%s>' % (pop(), ','.join(a)))
        elif op == 'getdescendants':
            st.append('%s..%s' % (pop(), abc.short(args[0])))
        else:
            emit('/* %s %s */' % (op, txt))
    return out


def dump_class(abc, ci):
    inst = abc.instances[ci]
    cls = abc.classes[ci]
    out = ['class %s extends %s' % (abc.mn(inst['name']), abc.mn(inst['super']))]
    for prefix, traits in (('static ', cls['traits']), ('', inst['traits'])):
        tmp = []
        swfabc.dump_traits(abc, [t for t in traits if t['kind'] not in (1, 2, 3)], tmp, prefix)
        out += tmp
    for prefix, traits in (('static ', cls['traits']), ('', inst['traits'])):
        for t in traits:
            if t['kind'] in (1, 2, 3):
                kind = swfabc.TRAIT_KIND[t['kind']]
                out.append('  %s%s %s {' % (prefix, kind, swfabc.method_sig(abc, t['method'], abc.short(t['name']))))
                out += decompile(abc, t['method'])
                out.append('  }')
    out.append('  static_init {')
    out += decompile(abc, cls['cinit'])
    out.append('  }')
    out.append('  constructor %s {' % swfabc.method_sig(abc, inst['iinit'], 'ctor'))
    out += decompile(abc, inst['iinit'])
    out.append('  }')
    return '\n'.join(out)


def main():
    path, outdir = sys.argv[1], sys.argv[2]
    flt = sys.argv[3] if len(sys.argv) > 3 else ''
    os.makedirs(outdir, exist_ok=True)
    swf = swfabc.read_swf(path)
    for _, _, data, _ in swfabc.abc_tags(swf):
        abc = swfabc.ABC(data)
        for ci, inst in enumerate(abc.instances):
            nm = abc.mn(inst['name'])
            if flt and flt not in nm:
                continue
            fn = nm.replace('::', '.').replace('/', '_').replace(':', '_')
            try:
                txt = dump_class(abc, ci)
            except Exception as e:  # keep going
                txt = 'ERROR %r' % e
            with open(os.path.join(outdir, fn + '.as'), 'w') as f:
                f.write(txt)
        fn_out = []
        for mi in range(len(abc.methods)):
            pass


if __name__ == '__main__':
    main()
