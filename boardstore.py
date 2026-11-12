"""直接读写画板文件的函数，给 mcp_server.py（AI 伴读）用。只用标准库。

AI 新增 / 改动 / 挪动的节点都会带上 ai=True，页面上显示成虚线「待确认」。
"""
import json
import os
import random
import re
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG = ROOT / 'mindboard.config.json'
EXT = '.mindboard.json'
KINDS = ('topic', 'sticky', 'card')
COLORS = ('yellow', 'orange', 'pink', 'purple', 'blue', 'teal', 'green', 'gray')
INBOX_TITLE = '📥 收件箱'


class BoardError(Exception):
    pass


def data_dir():
    """和正在运行的 MindBoard 用同一个文件夹；服务没开就看环境变量、配置文件、默认 ./boards。"""
    try:
        url = os.environ.get('MINDBOARD_URL', 'http://127.0.0.1:5178').rstrip('/') + '/api/ping'
        with urllib.request.urlopen(url, timeout=0.6) as r:
            return Path(json.loads(r.read())['dataDir'])
    except Exception:
        pass
    d = os.environ.get('MINDBOARD_DATA')
    if not d and CONFIG.exists():
        try:
            d = json.loads(CONFIG.read_text('utf-8'))['dataDir']
        except Exception:
            d = None
    p = Path(d) if d else ROOT / 'boards'
    p.mkdir(parents=True, exist_ok=True)
    return p


def _files():
    return sorted(data_dir().glob('*' + EXT))


def _read(p):
    return json.loads(p.read_text('utf-8'))


def list_boards():
    out = []
    for p in _files():
        try:
            b = _read(p)
        except Exception:
            continue
        nodes = b.get('nodes', {})
        inbox = next((n for n in nodes.values() if n.get('inbox')), None)
        out.append({'id': b['id'], 'name': b.get('name', ''), 'nodes': len(nodes),
                    'pending': sum(1 for n in nodes.values() if n.get('ai')),
                    'inbox': len(inbox['children']) if inbox else 0, 'updated': b.get('updated', 0)})
    return sorted(out, key=lambda x: -x['updated'])


def load(ref):
    """ref 可以是画板 id、完整名字，或名字里独一无二的一段。"""
    boards = []
    for p in _files():
        try:
            boards.append((p, _read(p)))
        except Exception:
            pass
    ref = str(ref or '').strip()
    if not ref and len(boards) == 1:
        return boards[0]
    hit = [x for x in boards if x[1].get('id') == ref] or [x for x in boards if x[1].get('name') == ref] \
        or [x for x in boards if ref and ref.lower() in x[1].get('name', '').lower()]
    if len(hit) == 1:
        return hit[0]
    names = '、'.join(f'{b.get("name")} ({b.get("id")})' for _, b in boards) or '（还没有画板）'
    raise BoardError(('找不到画板' if not hit else '有多个画板匹配') + f'「{ref}」。现有画板：{names}')


def save(b, old_path=None):
    b['updated'] = max(int(time.time() * 1000), int(b.get('updated', 0)) + 1)
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', str(b.get('name', ''))).strip(' .')[:60] or 'board'
    target = data_dir() / f'{name}-{b["id"]}{EXT}'
    tmp = target.with_name(target.name + '.tmp')
    tmp.write_text(json.dumps(b, ensure_ascii=False, separators=(',', ':')), 'utf-8')
    os.replace(tmp, target)
    if old_path and Path(old_path) != target and Path(old_path).exists():
        Path(old_path).unlink()
    return target


def _new_id(taken):
    while True:
        i = ''.join(random.choices('abcdefghijklmnopqrstuvwxyz0123456789', k=8))
        if i not in taken:
            return i


def create_board(name):
    b = {'id': _new_id({x['id'] for x in list_boards()}), 'name': str(name).strip() or '未命名画板',
         'created': int(time.time() * 1000), 'updated': 0, 'view': {'x': 0, 'y': 0, 'k': 1},
         'nodes': {}, 'links': [], 'assets': {}}
    save(b)
    return b


def _node(b, nid):
    n = b['nodes'].get(str(nid))
    if not n:
        raise BoardError(f'画板里没有 id 为 {nid} 的节点，先用 read_board 看一下现在的 id')
    return n


def _free_spot(b):
    roots = [n for n in b['nodes'].values() if not n.get('parent')]
    if not roots:
        return 0, 0
    return min(n['x'] for n in roots), max(n['y'] for n in roots) + 240


def _make(b, spec, parent, ai, made):
    if isinstance(spec, str):
        spec = {'text': spec}
    kind = spec.get('kind') if spec.get('kind') in KINDS else 'topic'
    color = spec.get('color') if spec.get('color') in COLORS else None
    x, y = (0, 0) if parent else _free_spot(b)
    if kind == 'sticky' and not color and not parent:
        color = 'yellow'
    n = {'id': _new_id(b['nodes']), 'kind': kind, 'text': str(spec.get('text', '')).strip(), 'x': x, 'y': y,
         'color': color, 'parent': parent, 'children': [], 'collapsed': False}
    if ai:
        n['ai'] = True
    b['nodes'][n['id']] = n
    if parent:
        p = b['nodes'][parent]
        p['children'].append(n['id'])
        p['collapsed'] = False
    made.append(n)
    for c in spec.get('children') or []:
        _make(b, c, n['id'], ai, made)
    return n


def add_nodes(b, parent, specs):
    if parent:
        _node(b, parent)
    made = []
    for s in specs:
        _make(b, s, parent or None, True, made)
    return made


def inbox(b, create=True):
    n = next((x for x in b['nodes'].values() if x.get('inbox')), None)
    if n or not create:
        return n
    roots = [x for x in b['nodes'].values() if not x.get('parent')]
    x = min((r['x'] for r in roots), default=0) - (460 if roots else 0)
    y = min((r['y'] for r in roots), default=0)
    n = {'id': _new_id(b['nodes']), 'kind': 'topic', 'text': INBOX_TITLE, 'x': x, 'y': y, 'color': 'gray',
         'parent': None, 'children': [], 'collapsed': False, 'inbox': True}
    b['nodes'][n['id']] = n
    return n


def capture(b, notes):
    """把用户的原话记进收件箱。这是用户自己的话，所以不打「AI 待确认」标记。"""
    box = inbox(b)
    made = []
    for t in notes:
        _make(b, {'text': t}, box['id'], False, made)
    return made


def _detach(b, n):
    if n.get('parent') and n['parent'] in b['nodes']:
        p = b['nodes'][n['parent']]
        p['children'] = [c for c in p['children'] if c != n['id']]
    n['parent'] = None


def _subtree(b, nid, out=None):
    out = [] if out is None else out
    out.append(nid)
    for c in b['nodes'][nid]['children']:
        _subtree(b, c, out)
    return out


def move_nodes(b, ids, parent):
    if parent:
        _node(b, parent)
    for nid in ids:
        n = _node(b, nid)
        if n.get('inbox'):
            raise BoardError('收件箱本身不能挪动')
        if parent and parent in _subtree(b, n['id']):
            raise BoardError(f'不能把 {nid} 挪到它自己的下级节点里')
        _detach(b, n)
        if parent:
            n['parent'] = parent
            b['nodes'][parent]['children'].append(n['id'])
            b['nodes'][parent]['collapsed'] = False
        else:
            n['x'], n['y'] = _free_spot(b)
        n['ai'] = True


def update_node(b, nid, text=None, kind=None, color=None):
    n = _node(b, nid)
    if text is not None:
        n['text'] = str(text).strip()
    if kind in KINDS and n.get('kind') != 'image':
        n['kind'] = kind
    if color in COLORS:
        n['color'] = color
    n['ai'] = True
    return n


def delete_nodes(b, ids):
    gone = set()
    for nid in ids:
        if nid in gone:
            continue
        n = _node(b, nid)
        sub = _subtree(b, n['id'])
        _detach(b, n)
        for i in sub:
            b['nodes'].pop(i, None)
        gone.update(sub)
    b['links'] = [l for l in b.get('links', []) if l['from'] not in gone and l['to'] not in gone]
    return len(gone)


def add_link(b, a, z, label=''):
    _node(b, a), _node(b, z)
    if a == z:
        raise BoardError('连线两头不能是同一个节点')
    l = {'id': _new_id({x['id'] for x in b.get('links', [])}), 'from': a, 'to': z, 'label': str(label or '').strip()}
    b.setdefault('links', []).append(l)
    return l


def outline(b):
    """把画板读成带 id 的缩进大纲，AI 用它来理解画板现在的样子。"""
    nodes = b['nodes']
    out = [f'# {b.get("name", "")}  (画板 id: {b["id"]})', '']

    def first(n):
        return '（图片）' if n.get('kind') == 'image' else (n.get('text', '').split('\n')[0] or '（空）')

    def walk(n, d):
        lines = ['（图片）'] if n.get('kind') == 'image' else (n.get('text', '') or '（空）').split('\n')
        tags = []
        if n.get('inbox'):
            tags.append('收件箱：以下是用户还没整理的速记')
        if n.get('kind') in ('card', 'sticky'):
            tags.append(n['kind'])
        if n.get('ai'):
            tags.append('AI 待确认')
        ind = '  ' * d
        out.append(f'{ind}- [{n["id"]}] {lines[0]}' + (f'  〈{"；".join(tags)}〉' if tags else ''))
        out.extend(f'{ind}    {x}' for x in lines[1:] if x.strip())
        for c in n['children']:
            if c in nodes:
                walk(nodes[c], d + 1)

    roots = sorted((n for n in nodes.values() if not n.get('parent')), key=lambda n: (not n.get('inbox'), n['y'], n['x']))
    if not roots:
        out.append('（空画板）')
    for r in roots:
        walk(r, 0)
        out.append('')
    links = [l for l in b.get('links', []) if l['from'] in nodes and l['to'] in nodes]
    if links:
        out.append('## 连线')
        for l in links:
            lab = f'  （{l["label"]}）' if l.get('label') else ''
            out.append(f'- [{l["from"]}] {first(nodes[l["from"]])} → [{l["to"]}] {first(nodes[l["to"]])}{lab}')
    return '\n'.join(out).rstrip() + '\n'
