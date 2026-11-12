#!/usr/bin/env python3
"""MindBoard 的 MCP 服务：让 Claude 能读、写你的画板，当伴读速记员。

只用标准库，走 stdio。接入方式见 README「和 AI 一起读文献」。
"""
import json
import sys

import boardstore as bs

INSTRUCTIONS = """你通过这些工具读写用户的 MindBoard 画板（思维导图 / 文献笔记）。用户通常一边读论文一边和你说话，你是速记员兼讨论对象。

怎么做：
- 开始前先 list_boards，再 read_board 看清现有结构和节点 id。写入前如果不确定 id，重新 read_board。
- 用户随口说的想法、疑问：用 capture 原话记进收件箱，不要改写、不要替他归类，然后只用一句话确认。只有当他明确说了放哪（「记到局限下面」），才用 add_nodes 直接加到那个节点下。
- 论文里的事实、数据、引文：用 add_nodes 加，文末带出处，格式「作者 年份 · p.页码」。你没在原文里核实过的内容不要写成事实。
- 一篇新论文：在合适的主题下加一张 kind=card 的卡片，首行「作者 (年份) 标题」，后面几行写 方法 / 主要发现 / 局限，可带 #标签。
- 用户说「整理」：read_board，把收件箱里的速记用 move_nodes 挪到合适的分支下（没有合适的分支就先 add_nodes 建一个），顺手用 update_node 修正语音识别造成的错别字和术语，但保留用户的原意和口吻。整理完用几句话说明挪了什么、哪几条你拿不准。
- 论文之间有引用、反驳、扩展关系时用 add_link，label 写关系。
- 用户提问时先回答问题，回答要短、指出页码；值得留下的结论再问一句要不要记。

约定：
- 你新增、修改、挪动的节点在画板上都会显示为虚线「AI 待确认」，由用户自己确认，所以不用每一步都征求同意，但也不要大段重写他已经写好的内容。
- delete_nodes 只在用户明确要求删除时用。
- 节点文字要短：主题一行，卡片几行。长段解释留在对话里，不要塞进画板。"""

S = lambda **p: {'type': 'object', 'properties': p, 'required': [k for k in p if not p[k].pop('optional', False)]}
BOARD = {'type': 'string', 'description': '画板 id 或名字（名字的一部分也行）'}
NODE_SPEC = {'type': 'object', 'properties': {
    'text': {'type': 'string', 'description': '节点文字。卡片的第一行是标题。可以用 #标签 和 **加粗**'},
    'kind': {'type': 'string', 'enum': list(bs.KINDS), 'description': 'topic=导图分支（默认），card=文献 / 资料卡片，sticky=便签'},
    'color': {'type': 'string', 'enum': list(bs.COLORS)},
    'children': {'type': 'array', 'items': {'type': 'object'}, 'description': '子节点，结构相同，可以嵌套'},
}, 'required': ['text']}

TOOLS = [
    ('list_boards', '列出所有画板：名字、id、节点数、收件箱里未整理的条数、AI 待确认的条数。', S()),
    ('read_board', '把一个画板读成带节点 id 的缩进大纲（含收件箱和连线）。写入前先读。', S(board=BOARD)),
    ('create_board', '新建一个空画板。', S(name={'type': 'string'})),
    ('capture', '把用户刚说的想法原话记进收件箱（速记）。不改写、不归类。', S(
        board=BOARD, notes={'type': 'array', 'items': {'type': 'string'}, 'description': '每条一句话，尽量带页码，如「p.5 样本只有 32 人？」'})),
    ('add_nodes', '在某个节点下新增子节点（可嵌套）。parent_id 留空则作为独立节点放在画布上。', S(
        board=BOARD, parent_id={'type': 'string', 'description': '父节点 id；留空 = 独立节点', 'optional': True},
        nodes={'type': 'array', 'items': NODE_SPEC})),
    ('move_nodes', '把节点（连同其子节点）挪到另一个节点下，用于整理收件箱。', S(
        board=BOARD, ids={'type': 'array', 'items': {'type': 'string'}},
        parent_id={'type': 'string', 'description': '新的父节点 id；留空 = 变成独立节点', 'optional': True})),
    ('update_node', '修改一个节点的文字、类型或颜色。', S(
        board=BOARD, id={'type': 'string'}, text={'type': 'string', 'optional': True},
        kind={'type': 'string', 'enum': list(bs.KINDS), 'optional': True},
        color={'type': 'string', 'enum': list(bs.COLORS), 'optional': True})),
    ('add_link', '在两个节点之间画一条带文字的连线，比如论文之间的「反驳」「扩展」。', S(
        board=BOARD, from_id={'type': 'string'}, to_id={'type': 'string'}, label={'type': 'string', 'optional': True})),
    ('delete_nodes', '删除节点及其所有子节点。只在用户明确要求时使用。', S(
        board=BOARD, ids={'type': 'array', 'items': {'type': 'string'}})),
]


def brief(nodes):
    return '\n'.join(f'- [{n["id"]}] {n["text"].splitlines()[0] if n["text"] else "（空）"}' for n in nodes)


def call(name, a):
    if name == 'list_boards':
        rows = bs.list_boards()
        if not rows:
            return '还没有画板。可以用 create_board 建一个。'
        return '\n'.join(f'- {r["name"]}  (id: {r["id"]})  {r["nodes"]} 个节点，收件箱 {r["inbox"]} 条，AI 待确认 {r["pending"]} 条' for r in rows)
    if name == 'create_board':
        b = bs.create_board(a.get('name', ''))
        return f'已新建画板「{b["name"]}」 (id: {b["id"]})'
    path, b = bs.load(a.get('board'))
    if name == 'read_board':
        return bs.outline(b)
    if name == 'capture':
        made = bs.capture(b, a.get('notes') or [])
        out = f'已记进「{b["name"]}」的收件箱 {len(made)} 条：\n{brief(made)}'
    elif name == 'add_nodes':
        made = bs.add_nodes(b, a.get('parent_id'), a.get('nodes') or [])
        out = f'已新增 {len(made)} 个节点（画板上显示为待确认）：\n{brief(made)}'
    elif name == 'move_nodes':
        bs.move_nodes(b, a.get('ids') or [], a.get('parent_id'))
        out = f'已挪动 {len(a.get("ids") or [])} 个节点（显示为待确认）'
    elif name == 'update_node':
        n = bs.update_node(b, a.get('id'), a.get('text'), a.get('kind'), a.get('color'))
        out = f'已修改 [{n["id"]}]（显示为待确认）'
    elif name == 'add_link':
        bs.add_link(b, a.get('from_id'), a.get('to_id'), a.get('label'))
        out = '已添加连线'
    elif name == 'delete_nodes':
        out = f'已删除 {bs.delete_nodes(b, a.get("ids") or [])} 个节点（含子节点）'
    else:
        raise bs.BoardError(f'没有这个工具：{name}')
    bs.save(b, path)
    return out


def handle(msg):
    method, mid = msg.get('method'), msg.get('id')
    if method == 'initialize':
        result = {'protocolVersion': (msg.get('params') or {}).get('protocolVersion', '2024-11-05'),
                  'capabilities': {'tools': {}}, 'serverInfo': {'name': 'mindboard', 'version': '0.1.0'},
                  'instructions': INSTRUCTIONS}
    elif method == 'tools/list':
        result = {'tools': [{'name': n, 'description': d, 'inputSchema': s} for n, d, s in TOOLS]}
    elif method == 'tools/call':
        p = msg.get('params') or {}
        try:
            result = {'content': [{'type': 'text', 'text': call(p.get('name'), p.get('arguments') or {})}]}
        except bs.BoardError as e:
            result = {'content': [{'type': 'text', 'text': str(e)}], 'isError': True}
        except Exception as e:  # 不让一次出错把整个服务带崩
            result = {'content': [{'type': 'text', 'text': f'出错了：{type(e).__name__}: {e}'}], 'isError': True}
    elif method == 'ping':
        result = {}
    elif mid is None:
        return None  # 通知，不用回
    else:
        return {'jsonrpc': '2.0', 'id': mid, 'error': {'code': -32601, 'message': f'unknown method {method}'}}
    return None if mid is None else {'jsonrpc': '2.0', 'id': mid, 'result': result}


def main():
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8', newline='\n')
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            reply = handle(json.loads(line))
        except Exception as e:
            reply = {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32700, 'message': str(e)}}
        if reply is not None:
            sys.stdout.write(json.dumps(reply, ensure_ascii=False) + '\n')
            sys.stdout.flush()


if __name__ == '__main__':
    main()
