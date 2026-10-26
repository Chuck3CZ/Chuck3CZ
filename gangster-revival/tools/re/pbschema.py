"""Extract protobuf schemas (netease as3 protobuf) from a SWF into JSON.

python3 -I pbschema.py FILE.swf OUT.json
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import swfabc  # noqa: E402
import pseudo  # noqa: E402

PKG = 'com.goodgamestudios.mafia.controller.protobuf'
FD_RE = re.compile(r"(\w+) = new (Repeated)?FieldDescriptor\$TYPE_(\w+)\('([^']+)', '([^']+)', \((\d+) \| (\d+)\)(?:, (\w+))?\);")


def main():
    path, out = sys.argv[1], sys.argv[2]
    swf = swfabc.read_swf(path)
    messages = {}
    enums = {}
    for _, _, data, _ in swfabc.abc_tags(swf):
        abc = swfabc.ABC(data)
        for ci, inst in enumerate(abc.instances):
            full = abc.mn(inst['name'])
            if not full.startswith(PKG):
                continue
            short = abc.short(inst['name'])
            sup = abc.mn(inst['super'])
            cls = abc.classes[ci]
            if sup.endswith('::Message'):
                body = '\n'.join(pseudo.decompile(abc, cls['cinit']))
                fields = []
                proto_name = None
                for m in FD_RE.finditer(body):
                    const, rep, typ, fqn, name, num8, wire, ref = m.groups()
                    proto_name = fqn.rsplit('.', 1)[0]
                    fields.append({'name': name, 'id': int(num8) >> 3, 'type': typ.lower(),
                                   'repeated': bool(rep), 'ref': ref})
                messages[short] = {'package': full.split('::')[0], 'proto': proto_name, 'fields': fields}
            elif sup == 'Object':
                vals = {}
                ok = True
                for t in cls['traits']:
                    if t['kind'] == 6 and t.get('vkind') == 0x03:
                        vals[abc.strings[abc.multinames[t['name']][2]]] = abc.ints[t['vindex']]
                    elif t['kind'] in (0, 6):
                        ok = False
                if ok and vals:
                    enums[short] = vals
    json.dump({'messages': messages, 'enums': enums}, open(out, 'w'), indent=1, sort_keys=True)
    print('messages', len(messages), 'enums', len(enums))


if __name__ == '__main__':
    main()
