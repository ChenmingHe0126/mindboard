#!/usr/bin/env python3
"""MindBoard 本地服务：提供网页，并把每个画板存成一个 .mindboard.json 文件。

    python server.py                      # 画板存到上次设置的文件夹（默认 ./boards）
    python server.py --data "H:/我的云端硬盘/MindBoard"   # 存到网盘同步文件夹

只监听 127.0.0.1，只用标准库，不需要安装任何依赖。
"""
import argparse
import json
import os
import re
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
CONFIG = ROOT / 'mindboard.config.json'
EXT = '.mindboard.json'
ID_RE = re.compile(r'^[a-z0-9]{4,16}$')
STATIC = {'/': ('index.html', 'text/html'), '/index.html': ('index.html', 'text/html'),
          '/style.css': ('style.css', 'text/css'), '/app.js': ('app.js', 'text/javascript')}
state = {'dir': ROOT / 'boards', 'port': 5178}
lock = threading.Lock()


def find(bid):
    for p in state['dir'].glob('*' + EXT):
        if p.name == bid + EXT or p.name.endswith('-' + bid + EXT):
            return p
    return None


def safe_name(name):
    s = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', str(name)).strip(' .')[:60]
    return s or 'board'


def read_json(p):
    return json.loads(p.read_text('utf-8'))


_meta = {}


def updated_of(p):
    """画板的版本号。文件没变就用缓存，这样页面每几秒问一次也不用反复读大文件。"""
    st = p.stat()
    key = (st.st_mtime_ns, st.st_size)
    hit = _meta.get(str(p))
    if not hit or hit[0] != key:
        hit = (key, read_json(p).get('updated', 0))
        _meta[str(p)] = hit
    return hit[1]


def set_dir(path):
    d = Path(os.path.expandvars(str(path).strip().strip('"'))).expanduser()
    if not d.is_absolute():
        d = ROOT / d
    d.mkdir(parents=True, exist_ok=True)
    state['dir'] = d


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def send(self, code, body=b'', ctype='application/json'):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype + '; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def allowed(self):
        # 只接受来自本页面的请求，挡掉其他网站对 localhost 的跨站调用和 DNS rebinding
        hosts = {f'localhost:{state["port"]}', f'127.0.0.1:{state["port"]}'}
        origin = self.headers.get('Origin')
        return self.headers.get('Host') in hosts and (not origin or urlparse(origin).netloc in hosts)

    def body(self):
        return self.rfile.read(int(self.headers.get('Content-Length') or 0))

    def route(self, method):
        if not self.allowed():
            return self.send(403, {'error': 'forbidden'})
        url = urlparse(self.path)
        path = url.path
        if method == 'GET' and path in STATIC:
            name, ctype = STATIC[path]
            return self.send(200, (ROOT / name).read_bytes(), ctype)
        if not path.startswith('/api/'):
            return self.send(404, {'error': 'not found'})
        parts = path[5:].strip('/').split('/')
        with lock:
            if parts == ['ping'] and method == 'GET':
                return self.send(200, {'ok': True, 'dataDir': str(state['dir'])})
            if parts == ['config'] and method == 'POST':
                try:
                    set_dir(json.loads(self.body())['dataDir'])
                except Exception as e:
                    return self.send(400, {'error': str(e)})
                CONFIG.write_text(json.dumps({'dataDir': str(state['dir'])}, ensure_ascii=False, indent=2), 'utf-8')
                return self.send(200, {'ok': True, 'dataDir': str(state['dir'])})
            if parts == ['boards'] and method == 'GET':
                out = []
                for p in state['dir'].glob('*' + EXT):
                    try:
                        b = read_json(p)
                        out.append({'id': b['id'], 'name': b.get('name', ''), 'updated': b.get('updated', 0), 'count': len(b.get('nodes', {}))})
                    except Exception:
                        pass  # 同步中的半截文件或别的东西，跳过
                return self.send(200, out)
            if len(parts) == 2 and parts[0] == 'boards' and ID_RE.match(parts[1]):
                bid, p = parts[1], find(parts[1])
                if method == 'GET':
                    if not p:
                        return self.send(404, {'error': 'no such board'})
                    if url.query == 'meta=1':
                        return self.send(200, {'updated': updated_of(p)})
                    return self.send(200, p.read_bytes())
                if method == 'PUT':
                    raw = self.body()
                    b = json.loads(raw)
                    if b.get('id') != bid or not isinstance(b.get('nodes'), dict):
                        return self.send(400, {'error': 'bad board'})
                    base = self.headers.get('X-Base', '')
                    if p and base:
                        try:
                            disk = read_json(p).get('updated', 0)
                            if str(disk) != base:  # 文件在别处被改过（比如另一台设备同步过来）
                                return self.send(409, {'updated': disk})
                        except Exception:
                            pass
                    target = state['dir'] / f'{safe_name(b.get("name"))}-{bid}{EXT}'
                    tmp = target.with_name(target.name + '.tmp')
                    tmp.write_bytes(raw)
                    os.replace(tmp, target)
                    if p and p != target and p.exists():
                        p.unlink()
                    return self.send(200, {'ok': True})
                if method == 'DELETE':
                    if p:  # 不真删，挪进 .trash，手滑了还能捞回来
                        trash = state['dir'] / '.trash'
                        trash.mkdir(exist_ok=True)
                        os.replace(p, trash / p.name)
                    return self.send(200, {'ok': True})
        return self.send(404, {'error': 'not found'})

    def do_GET(self): self.route('GET')
    def do_PUT(self): self.route('PUT')
    def do_POST(self): self.route('POST')
    def do_DELETE(self): self.route('DELETE')


def main():
    ap = argparse.ArgumentParser(description='MindBoard local server')
    ap.add_argument('--data', help='画板文件夹（放进 Google Drive / OneDrive / iCloud 同步目录即可多设备同步）')
    ap.add_argument('--port', type=int, default=5178)
    ap.add_argument('--no-open', action='store_true', help='启动后不自动打开浏览器')
    args = ap.parse_args()
    try:
        sys.stdout.reconfigure(errors='replace')
    except Exception:
        pass
    state['port'] = args.port
    data = args.data or os.environ.get('MINDBOARD_DATA')
    if not data and CONFIG.exists():
        try:
            data = read_json(CONFIG)['dataDir']
        except Exception:
            pass
    set_dir(data or ROOT / 'boards')
    srv = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    url = f'http://localhost:{args.port}/'
    print(f'MindBoard  {url}\nboards -> {state["dir"]}\nCtrl+C to stop')
    if not args.no_open:
        threading.Timer(0.4, webbrowser.open, [url]).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
