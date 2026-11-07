"""Merge Railway "Raw Editor" variables into a VPS app.env without printing any value.

usage: python3 import_env.py <railway-raw.txt> <app.env>

- Accepts KEY="value", KEY='value' and KEY=value lines; unescapes \" and \\ inside double quotes.
- Resolves ${{OTHER_VAR}} references from the same paste (Railway shared/service references).
- Skips variables the VPS sets itself (Railway internals, PORT, DB_PATH, NODE_ENV, WEBAPP_URL) and
  BACKUP_S3_* (pointed at the Railway bucket).
"""
import re
import sys

SKIP_PREFIXES = ('RAILWAY_', 'BACKUP_S3_')
SKIP = {'PORT', 'DB_PATH', 'NODE_ENV', 'WEBAPP_URL', 'PUBLIC_URL', 'BACKUP_DIR'}
LINE = re.compile(r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$')
REF = re.compile(r'\$\{\{\s*(?:shared\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\}\}')


def unquote(v):
    if len(v) >= 2 and v[0] == v[-1] == '"':
        return re.sub(r'\\(["\\])', r'\1', v[1:-1])
    if len(v) >= 2 and v[0] == v[-1] == "'":
        return v[1:-1]
    return v


def parse(text):
    out = {}
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith('#'):
            continue
        m = LINE.match(raw)
        if m:
            out[m.group(1)] = unquote(m.group(2))
    return out


def resolve(env):
    for _ in range(5):
        changed = False
        for k, v in env.items():
            def sub(m):
                ref = m.group(1)
                if ref in env and not REF.search(env[ref]):
                    return env[ref]
                return m.group(0)
            nv = REF.sub(sub, v)
            if nv != v:
                env[k] = nv
                changed = True
        if not changed:
            break
    return {k for k, v in env.items() if REF.search(v)}


def main(src, dest):
    env = parse(open(src, encoding='utf-8').read())
    still = resolve(env)
    keep = {k: v for k, v in env.items()
            if k not in SKIP and not k.startswith(SKIP_PREFIXES) and k not in still and '\n' not in v}

    lines = open(dest, encoding='utf-8').read().splitlines()
    seen = set()
    for i, line in enumerate(lines):
        m = LINE.match(line)
        if m and not line.lstrip().startswith('#') and m.group(1) in keep:
            lines[i] = f'{m.group(1)}={keep[m.group(1)]}'
            seen.add(m.group(1))
    extra = [k for k in keep if k not in seen]
    if extra:
        lines.append('')
        lines.append('# Dari Railway')
        lines.extend(f'{k}={keep[k]}' for k in extra)
    with open(dest, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')

    print(f'{len(keep)} variabel diimpor: {", ".join(sorted(keep))}')
    if still:
        print(f'PERHATIAN, referensi ${{{{...}}}} tak bisa diisi otomatis (isi manual): {", ".join(sorted(still))}')
    if 'BOT_TOKEN' not in keep:
        print('PERHATIAN: BOT_TOKEN tidak ada di tempelan.')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
