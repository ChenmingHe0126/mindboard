'use strict';
/* MindBoard — 无依赖的思维导图 / 头脑风暴白板。数据存在浏览器 IndexedDB。 */

const $ = (s, el = document) => el.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const COLORS = ['yellow', 'orange', 'pink', 'purple', 'blue', 'teal', 'green', 'gray'];
const BRANCH = ['blue', 'teal', 'green', 'orange', 'pink', 'purple', 'yellow'];
const HGAP = 52, VGAP = 12;

const vp = $('#viewport'), world = $('#world');

// ---------------------------------------------------------------- storage
const db = {
  _p: null,
  open() {
    return this._p ||= new Promise((res, rej) => {
      const r = indexedDB.open('mindboard', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('boards', { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async tx(mode, fn) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const t = d.transaction('boards', mode);
      const rq = fn(t.objectStore('boards'));
      t.oncomplete = () => res(rq && rq.result);
      t.onerror = () => rej(t.error);
    });
  },
  all() { return this.tx('readonly', s => s.getAll()); },
  get(id) { return this.tx('readonly', s => s.get(id)); },
  put(b) { return this.tx('readwrite', s => s.put(b)); },
  del(id) { return this.tx('readwrite', s => s.delete(id)); },
};

// ---------------------------------------------------------------- state
let board = null;
const els = new Map();   // id -> DOM element
const geo = new Map();   // id -> {x,y,w,h} for visible nodes
const meta = new Map();  // id -> {d: depth, c: effective color} for visible nodes
let sel = new Set();
let selLink = null;
let editing = null;
let drag = null;
let query = '';
let undoStack = [], redoStack = [], lastSnap = '';
let clip = null;
let saveTimer = 0;

const N = id => board.nodes[id];
const roots = () => Object.values(board.nodes).filter(n => !n.parent);

function addNode(props, parentId, index) {
  const n = Object.assign({ id: uid(), kind: 'topic', text: '', x: 0, y: 0, color: null, parent: null, children: [], collapsed: false }, props);
  board.nodes[n.id] = n;
  if (parentId) attach(n.id, parentId, index);
  return n;
}
function detach(id) {
  const n = N(id);
  if (!n.parent) return;
  const p = N(n.parent);
  p.children = p.children.filter(c => c !== id);
  n.parent = null;
}
function attach(id, pid, index) {
  detach(id);
  const p = N(pid);
  N(id).parent = pid;
  if (index == null) p.children.push(id); else p.children.splice(index, 0, id);
  p.collapsed = false;
}
function subtree(id, out = []) {
  out.push(id);
  N(id).children.forEach(c => subtree(c, out));
  return out;
}
function removeNode(id) {
  if (!N(id)) return;
  const ids = new Set(subtree(id));
  detach(id);
  ids.forEach(i => delete board.nodes[i]);
  board.links = board.links.filter(l => !ids.has(l.from) && !ids.has(l.to));
}
const firstLine = n => n.kind === 'image' ? '（图片）' : (n.text.split('\n')[0] || '（空）');

// ---------------------------------------------------------------- history & save
const snap = () => JSON.stringify({ nodes: board.nodes, links: board.links });
function commit() {
  undoStack.push(lastSnap);
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
  lastSnap = snap();
  saveSoon();
  render();
}
function restore(s) {
  lastSnap = s;
  const o = JSON.parse(s);
  board.nodes = o.nodes; board.links = o.links;
  sel = new Set([...sel].filter(i => board.nodes[i]));
  selLink = null;
  saveSoon();
  render();
}
function undo() { if (undoStack.length) { finishEdit(); redoStack.push(lastSnap); restore(undoStack.pop()); } }
function redo() { if (redoStack.length) { finishEdit(); undoStack.push(lastSnap); restore(redoStack.pop()); } }
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 400);
}
async function flush() {
  clearTimeout(saveTimer); saveTimer = 0;
  if (!board) return;
  board.updated = Date.now();
  await db.put(board);
}

// ---------------------------------------------------------------- rendering
function fmt(n) {
  let html = esc(n.text).split('\n')
    .map((l, i) => (n.kind === 'card' && i === 0) ? `<span class="title">${l}</span>` : l).join('\n');
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|\s)#([\p{L}\p{N}_-]+)/gu, '$1<span class="tag">#$2</span>');
  return html || '<span class="ph">…</span>';
}

function applyView() {
  const v = board.view;
  world.style.transform = `translate(${v.x}px,${v.y}px) scale(${v.k})`;
  vp.style.backgroundPosition = `${v.x}px ${v.y}px`;
  vp.style.backgroundSize = `${24 * v.k}px ${24 * v.k}px`;
  $('#zoom-label').textContent = Math.round(v.k * 100) + '%';
}

function makeEl(id) {
  const el = document.createElement('div');
  el.dataset.id = id;
  el.innerHTML = '<div class="body"></div><button class="fold" tabindex="-1"></button><i class="link-handle" title="拖到另一个节点上建立连线"></i><i class="resize" title="拖动调整宽度"></i>';
  world.appendChild(el);
  els.set(id, el);
  return el;
}

function render() {
  if (!board) return;
  applyView();
  for (const [id, el] of els) if (!board.nodes[id]) { el.remove(); els.delete(id); }

  meta.clear();
  const walk = (n, d, col) => {
    const c = n.color || col;
    meta.set(n.id, { d, c });
    if (!n.collapsed) n.children.forEach((id, i) => walk(N(id), d + 1, d === 0 ? BRANCH[i % BRANCH.length] : c));
  };
  roots().forEach(r => walk(r, 0, null));

  const q = query.toLowerCase();
  for (const n of Object.values(board.nodes)) {
    const el = els.get(n.id) || makeEl(n.id);
    const m = meta.get(n.id);
    el.hidden = !m;
    if (!m) continue;
    const cls = ['node', n.kind, 'd' + Math.min(m.d, 2)];
    if (sel.has(n.id)) cls.push('sel', sel.size === 1 ? 'solo' : '');
    if (n.children.length) cls.push('parent');
    if (n.collapsed) cls.push('collapsed');
    if (editing === n.id) cls.push('editing');
    if (drag && drag.ids && drag.ids.has(n.id)) cls.push('dragging');
    if (drag && drag.target === n.id) cls.push('drop');
    if (q) cls.push(n.text.toLowerCase().includes(q) ? 'hit' : 'dim');
    el.className = cls.join(' ');
    if (m.c) el.dataset.color = m.c; else delete el.dataset.color;
    el.style.width = n.w && n.kind !== 'topic' ? n.w + 'px' : '';
    const key = n.kind + '|' + n.text + '|' + (n.src || '');
    if (editing !== n.id && el._k !== key) {
      el.firstChild.innerHTML = n.kind === 'image'
        ? `<img draggable="false" alt="" src="${board.assets[n.src] || ''}" style="aspect-ratio:${n.ar || 1}">`
        : fmt(n);
      el._k = key;
    }
    el.children[1].textContent = n.collapsed ? subtree(n.id).length - 1 : '';
  }

  geo.clear();
  for (const id of meta.keys()) { const el = els.get(id); geo.set(id, { x: 0, y: 0, w: el.offsetWidth, h: el.offsetHeight }); }
  layout();
  for (const id of meta.keys()) {
    const g = geo.get(id);
    let x = g.x, y = g.y;
    if (drag && drag.child && drag.ids.has(id)) { x += drag.dx; y += drag.dy; }
    els.get(id).style.transform = `translate(${x}px,${y}px)`;
  }
  drawEdges();
  updateChrome();
}

// 向右展开的树布局：根节点位置由用户决定，后代位置自动计算
function layout() {
  const sub = new Map();
  const kids = n => n.collapsed ? [] : n.children.map(N);
  const measure = n => {
    let t = 0;
    kids(n).forEach((c, i) => { t += measure(c) + (i ? VGAP : 0); });
    const s = Math.max(geo.get(n.id).h, t);
    sub.set(n.id, { s, t });
    return s;
  };
  const place = (n, x, cy) => {
    const g = geo.get(n.id);
    g.x = x; g.y = cy - g.h / 2;
    n.x = g.x; n.y = g.y;
    let y = cy - sub.get(n.id).t / 2;
    for (const c of kids(n)) {
      const s = sub.get(c.id).s;
      place(c, x + g.w + HGAP, y + s / 2);
      y += s + VGAP;
    }
  };
  for (const r of roots()) { measure(r); place(r, r.x, r.y + geo.get(r.id).h / 2); }
}

function clipPt(a, b) {
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2, dx = b.x + b.w / 2 - ax, dy = b.y + b.h / 2 - ay;
  if (!dx && !dy) return [ax, ay];
  const t = Math.min(dx ? (a.w / 2 + 6) / Math.abs(dx) : Infinity, dy ? (a.h / 2 + 6) / Math.abs(dy) : Infinity, 1);
  return [ax + dx * t, ay + dy * t];
}

function drawEdges() {
  let s = '';
  for (const [id, m] of meta) {
    const n = N(id);
    if (!n.parent || (drag && drag.child && drag.ids.has(id))) continue;
    const a = geo.get(n.parent), b = geo.get(id);
    const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2, mx = (x1 + x2) / 2;
    s += `<path class="tree" style="stroke:var(--c-${m.c || 'gray'})" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}"/>`;
  }
  for (const l of board.links) {
    const a = geo.get(l.from), b = geo.get(l.to);
    if (!a || !b) continue;
    let d, lx, ly, anchor = 'middle';
    if (a.x < b.x + b.w && b.x < a.x + a.w) {
      // 上下堆叠的节点（比如同一分支下的两张卡片）：从右侧绕一道弧线，避免被中间的节点挡住
      const x1 = a.x + a.w + 4, y1 = a.y + a.h / 2, x2 = b.x + b.w + 6, y2 = b.y + b.h / 2, bx = Math.max(x1, x2) + 30 + Math.abs(y2 - y1) * 0.22;
      d = `M${x1},${y1} C${bx},${y1} ${bx},${y2} ${x2},${y2}`;
      lx = Math.max(x1, x2) + (bx - Math.max(x1, x2)) * 0.75 + 8; ly = (y1 + y2) / 2 + 4; anchor = 'start';
    } else {
      const [x1, y1] = clipPt(a, b), [x2, y2] = clipPt(b, a);
      d = `M${x1},${y1} L${x2},${y2}`;
      lx = (x1 + x2) / 2; ly = (y1 + y2) / 2 + 4;
    }
    s += `<path class="hit" data-link="${l.id}" d="${d}"/><path class="link${selLink === l.id ? ' sel' : ''}" marker-end="url(#arrow)" d="${d}"/>`;
    if (l.label) s += `<text class="lbl" text-anchor="${anchor}" x="${lx}" y="${ly}">${esc(l.label)}</text>`;
  }
  if (drag && drag.type === 'link' && drag.moved) {
    const a = geo.get(drag.from);
    s += `<path class="link sel" d="M${a.x + a.w / 2},${a.y + a.h / 2} L${drag.x},${drag.y}"/>`;
  }
  $('#edge-g').innerHTML = s;
}

function updateChrome() {
  const bar = $('#propbar');
  bar.hidden = !sel.size || !!editing;
  if (sel.size) {
    const kinds = new Set([...sel].map(i => N(i).kind));
    bar.querySelectorAll('[data-kind]').forEach(b => b.classList.toggle('on', kinds.size === 1 && kinds.has(b.dataset.kind)));
  }
  $('#empty').hidden = Object.keys(board.nodes).length > 0;
  $('#btn-undo').disabled = !undoStack.length;
  $('#btn-redo').disabled = !redoStack.length;
}

// ---------------------------------------------------------------- view helpers
const pt = e => { const r = vp.getBoundingClientRect(); return { sx: e.clientX - r.left, sy: e.clientY - r.top }; };
const toWorld = (sx, sy) => ({ x: (sx - board.view.x) / board.view.k, y: (sy - board.view.y) / board.view.k });
const center = () => toWorld(vp.clientWidth / 2, vp.clientHeight / 2);
const nodeAt = (cx, cy) => { const el = document.elementFromPoint(cx, cy); const n = el && el.closest('.node'); return n ? n.dataset.id : null; };

function zoomAt(sx, sy, f) {
  const v = board.view, k = Math.min(3, Math.max(0.12, v.k * f));
  v.x = sx - (sx - v.x) * k / v.k;
  v.y = sy - (sy - v.y) * k / v.k;
  v.k = k;
  applyView(); saveSoon();
}
function bounds() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const g of geo.values()) { x0 = Math.min(x0, g.x); y0 = Math.min(y0, g.y); x1 = Math.max(x1, g.x + g.w); y1 = Math.max(y1, g.y + g.h); }
  return geo.size ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}
function fit() {
  render();
  const b = bounds(), v = board.view, W = vp.clientWidth, H = vp.clientHeight;
  if (!b) { v.x = W / 2; v.y = H / 2; v.k = 1; }
  else {
    if (W < 300 || H < 300) return; // 窗口被隐藏或太小时不动视图
    v.k = Math.max(0.12, Math.min(1.1, (W - 200) / b.w, (H - 200) / b.h));
    v.x = W / 2 + 20 - (b.x + b.w / 2) * v.k;
    v.y = H / 2 + 20 - (b.y + b.h / 2) * v.k;
  }
  applyView(); saveSoon();
}
function reveal(id) {
  const g = geo.get(id), v = board.view;
  if (!g) return;
  const l = g.x * v.k + v.x, t = g.y * v.k + v.y, r = l + g.w * v.k, b = t + g.h * v.k;
  const W = vp.clientWidth, H = vp.clientHeight;
  if (l < 90) v.x += 90 - l; else if (r > W - 40) v.x -= r - (W - 40);
  if (t < 120) v.y += 120 - t; else if (b > H - 60) v.y -= b - (H - 60);
  applyView();
}
function centerOn(id) {
  const g = geo.get(id), v = board.view;
  if (!g) return;
  v.x = vp.clientWidth / 2 - (g.x + g.w / 2) * v.k;
  v.y = vp.clientHeight / 2 - (g.y + g.h / 2) * v.k;
  applyView(); saveSoon();
}

// ---------------------------------------------------------------- editing
function startEdit(id) {
  finishEdit();
  const n = N(id);
  if (!n || n.kind === 'image') return;
  editing = id;
  sel = new Set([id]); selLink = null;
  const el = els.get(id), b = el.firstChild;
  b.textContent = n.text;
  b.contentEditable = 'plaintext-only';
  if (b.contentEditable !== 'plaintext-only') b.contentEditable = 'true';
  render();
  b.focus();
  const r = document.createRange();
  r.selectNodeContents(b); r.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}
function finishEdit() {
  if (!editing) return;
  const id = editing, n = N(id), el = els.get(id);
  editing = null;
  if (el) {
    const b = el.firstChild;
    const t = b.innerText.replace(/ /g, ' ').replace(/\n+$/, '');
    b.contentEditable = 'false';
    el._k = null;
    if (n) {
      if (!t.trim() && !n.children.length) { removeNode(id); sel.delete(id); commit(); return; }
      if (t !== n.text) { n.text = t; commit(); return; }
    }
  }
  render();
}

function addChild(pid) {
  const n = addNode({ kind: 'topic' }, pid);
  sel = new Set([n.id]);
  commit(); reveal(n.id); startEdit(n.id);
}
function addSibling(id) {
  const o = N(id), g = geo.get(id);
  const props = { kind: o.kind === 'image' ? 'topic' : o.kind, w: o.kind === 'image' ? undefined : o.w };
  let n;
  if (o.parent) n = addNode(props, o.parent, N(o.parent).children.indexOf(id) + 1);
  else n = addNode({ ...props, color: o.color, x: o.x, y: o.y + (g ? g.h : 60) + 28 });
  sel = new Set([n.id]);
  commit(); reveal(n.id); startEdit(n.id);
}
function addFree(kind, at) {
  if (kind === 'image') { $('#file-img').click(); return; }
  const c = center(), j = (Object.keys(board.nodes).length % 6) * 22;
  const p = at || { x: c.x - 90 + j, y: c.y - 40 + j };
  const n = addNode({ kind, x: p.x, y: p.y, color: kind === 'sticky' ? 'yellow' : null });
  sel = new Set([n.id]);
  commit(); startEdit(n.id);
}
function deleteSelection() {
  if (selLink) { board.links = board.links.filter(l => l.id !== selLink); selLink = null; commit(); return; }
  if (!sel.size) return;
  let next = null;
  if (sel.size === 1) {
    const n = N([...sel][0]);
    if (n.parent) { const sib = N(n.parent).children, i = sib.indexOf(n.id); next = sib[i + 1] || sib[i - 1] || n.parent; }
  }
  sel.forEach(removeNode);
  sel = new Set(next ? [next] : []);
  commit();
}
function toggleFold(id) {
  const n = N(id);
  if (!n.children.length) return;
  n.collapsed = !n.collapsed;
  commit();
}
function reorder(id, dir) {
  const n = N(id);
  if (!n.parent) return;
  const a = N(n.parent).children, i = a.indexOf(id), j = i + dir;
  if (j < 0 || j >= a.length) return;
  [a[i], a[j]] = [a[j], a[i]];
  commit();
}
function navigate(key) {
  const id = [...sel][0], a = geo.get(id);
  if (!a) return;
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
  let best = null, bs = Infinity;
  for (const i of meta.keys()) {
    if (i === id) continue;
    const g = geo.get(i), dx = g.x + g.w / 2 - ax, dy = g.y + g.h / 2 - ay;
    const [p, s] = key === 'ArrowRight' ? [dx, dy] : key === 'ArrowLeft' ? [-dx, dy] : key === 'ArrowDown' ? [dy, dx] : [-dy, dx];
    if (p <= 1) continue;
    const score = p + Math.abs(s) * 2.5;
    if (score < bs) { bs = score; best = i; }
  }
  if (best) { sel = new Set([best]); render(); reveal(best); }
}

// ---------------------------------------------------------------- specs: templates / copy / outline
function build(spec, parent, x = 0, y = 0, index) {
  const props = { text: spec.t || '', kind: spec.k || 'topic', color: spec.color || null, x, y };
  if (spec.w) props.w = spec.w;
  if (spec.ar) props.ar = spec.ar;
  if (spec.collapsed) props.collapsed = true;
  if (spec.data) { props.src = uid(); board.assets[props.src] = spec.data; }
  const n = addNode(props, parent, index);
  (spec.c || []).forEach(c => build(c, n.id));
  return n;
}
function toSpec(id) {
  const n = N(id);
  return { t: n.text, k: n.kind, color: n.color, w: n.w, ar: n.ar, data: n.kind === 'image' ? board.assets[n.src] : undefined, c: n.children.map(toSpec) };
}
function specText(s, d = 0, out = []) {
  const [first, ...rest] = (s.k === 'image' ? '（图片）' : s.t).split('\n');
  out.push('  '.repeat(d) + '- ' + first);
  rest.forEach(r => r.trim() && out.push('  '.repeat(d + 1) + r));
  s.c.forEach(c => specText(c, d + 1, out));
  return out;
}
function parseOutline(text) {
  const out = [], stack = [];
  let base = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let level, t, m;
    if ((m = raw.match(/^\s*(#{1,6})\s+(.*)/))) { level = m[1].length - 1; t = m[2]; base = level + 1; }
    else {
      m = raw.match(/^(\s*)(?:[-*+•]\s+|\d+[.)、]\s*)?(.*)/);
      level = base + Math.floor(m[1].replace(/\t/g, '  ').length / 2);
      t = m[2];
    }
    const node = { t: t.trim(), c: [] };
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    (stack.length ? stack[stack.length - 1].node.c : out).push(node);
    stack.push({ level, node });
  }
  return out;
}
function topSelected() {
  return [...sel].filter(id => { for (let p = N(id).parent; p; p = N(p).parent) if (sel.has(p)) return false; return true; });
}
function placeSpecs(specs, parent) {
  const c = center();
  const made = specs.map((s, i) => build(s, parent, c.x - 90 + i * 26, c.y - 40 + i * 26));
  sel = new Set(made.map(n => n.id));
  commit();
  if (made[0]) reveal(made[0].id);
}
function duplicate() {
  const made = topSelected().map(id => {
    const o = N(id), s = toSpec(id);
    return o.parent ? build(s, o.parent, 0, 0, N(o.parent).children.indexOf(id) + 1) : build(s, null, o.x + 30, o.y + 30);
  });
  if (!made.length) return;
  sel = new Set(made.map(n => n.id));
  commit();
}

const T = (t, c = [], o = {}) => ({ t, c, ...o });
const C = (t, o = {}) => ({ t, c: [], k: 'card', ...o });
const S = (t, color = 'yellow') => ({ t, c: [], k: 'sticky', color });
const TEMPLATES = [
  { id: 'blank', em: '⬜', name: '空白画板', desc: '什么都没有，从零开始。', make() {} },
  {
    id: 'video', em: '🎬', name: '视频策划', desc: '选题定位 → 钩子 → 脚本结构 → 镜头素材 → 标题封面 → 发布，外加分镜卡片。',
    make() {
      build(T('🎬 视频标题：一句话说清这期讲什么', [
        T('选题与定位', [T('目标观众是谁？'), T('他们为什么要点进来？'), T('一句话核心观点'), T('对标 / 参考视频')]),
        T('开头钩子（前 5 秒）', [T('第一个画面'), T('第一句话'), T('留给观众的悬念')]),
        T('脚本结构', [T('开场：抛出问题'), T('正文 ①'), T('正文 ②'), T('正文 ③'), T('结尾：总结 + 行动号召')]),
        T('镜头与素材', [T('A-roll：口播 / 出镜'), T('B-roll：补充画面'), T('录屏 / 演示'), T('音乐与音效')]),
        T('标题与封面', [T('备选标题 A'), T('备选标题 B'), T('封面构图与大字')]),
        T('发布', [T('平台与时间'), T('简介与标签'), T('置顶评论')]),
      ]), null, 0, 0);
      build(T('🎞 分镜表', [
        C('镜头 01 · 开场\n画面：\n台词：\n时长：5s #A-roll'),
        C('镜头 02\n画面：\n台词：\n时长： #B-roll'),
        C('镜头 03\n画面：\n台词：\n时长： #录屏'),
      ], { color: 'purple' }), null, 0, 570);
      build(S('💡 灵感停车场\n想到什么先丢这里，之后再拖到对应分支上'), null, -260, -150);
      build(S('❓ 还没想清楚的问题', 'pink'), null, -260, 10);
    },
  },
  {
    id: 'lit', em: '📚', name: '文献综述', desc: '研究问题 → 按主题归类论文卡片（方法 / 发现 / 局限）→ 研究空白 → 我的切入点。',
    make() {
      const paper = (who, tag) => C(`${who}\n标题：\n方法：\n主要发现：\n局限：\n${tag}`);
      const r = build(T('📚 研究问题：我想回答什么？', [
        T('背景与关键概念', [T('核心术语的定义'), T('这个问题为什么重要')]),
        T('主题 A', [paper('作者 A 等 (2023)', '#主题A #待精读'), paper('作者 B (2021)', '#主题A')]),
        T('主题 B', [paper('作者 C 等 (2024)', '#主题B')]),
        T('方法对比', [T('常用数据 / 实验设置'), T('评价指标'), T('各方法的优缺点')]),
        T('研究空白 Gap', [T('大家都没解决的'), T('结论互相矛盾的')]),
        T('我的切入点', [T('假设'), T('计划怎么验证')]),
      ]), null, 0, 0);
      const a = N(N(r.children[1]).children[1]), b = N(N(r.children[2]).children[0]);
      board.links.push({ id: uid(), from: b.id, to: a.id, label: '扩展 / 反驳' });
      build(S('📌 用法\n每读一篇就加一张卡片（选中主题按 Tab，再在上方工具条切成「卡片」）。\n论文之间有引用、反驳关系就拉一条连线。'), null, -270, -120);
      build(S('📝 待读清单', 'blue'), null, -270, 80);
    },
  },
  {
    id: 'storm', em: '⚡', name: '头脑风暴', desc: '中心问题 + 一片彩色便签：想法 / 疑问 / 下一步，先发散再归类。',
    make() {
      build(T('⚡ 我们要解决的问题是？'), null, 150, -110);
      const cols = [['想法', 'yellow'], ['疑问', 'pink'], ['下一步', 'green']];
      cols.forEach(([name, color], i) => {
        build(T(name, [], { color }), null, i * 230 + 40, 0);
        for (let j = 0; j < 2; j++) build(S(`${name} ${j + 1}`, color), null, i * 230, 60 + j * 140);
      });
    },
  },
];

// ---------------------------------------------------------------- boards
async function openBoard(id) {
  finishEdit();
  if (saveTimer) await flush();
  const b = await db.get(id);
  if (!b) return false;
  board = b;
  board.assets ||= {}; board.links ||= []; board.view ||= { x: 0, y: 0, k: 1 };
  const used = new Set(Object.values(board.nodes).map(n => n.src));
  for (const k of Object.keys(board.assets)) if (!used.has(k)) delete board.assets[k];
  els.forEach(el => el.remove()); els.clear();
  sel = new Set(); selLink = null; undoStack = []; redoStack = []; query = ''; $('#search').value = '';
  lastSnap = snap();
  localStorage.setItem('mb_current', id);
  $('#board-name').value = board.name;
  document.title = board.name + ' · MindBoard';
  render();
  return true;
}
async function newBoard(tpl, name) {
  finishEdit();
  if (saveTimer) await flush();
  board = { id: uid(), name: name || (tpl.id === 'blank' ? '未命名画板' : tpl.name), created: Date.now(), updated: Date.now(), view: { x: 0, y: 0, k: 1 }, nodes: {}, links: [], assets: {} };
  tpl.make();
  await db.put(board);
  await openBoard(board.id);
  fit();
}
async function renderDrawer() {
  const list = (await db.all()).sort((a, b) => b.updated - a.updated);
  const box = $('#board-list');
  box.innerHTML = '';
  for (const b of list) {
    const row = document.createElement('div');
    row.className = 'board-row' + (b.id === board.id ? ' cur' : '');
    row.innerHTML = `<div class="nm"><b>${esc(b.name)}</b><small>${Object.keys(b.nodes).length} 个节点 · ${new Date(b.updated).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small></div><button class="rm" title="删除画板">✕</button>`;
    row.onclick = async e => {
      if (e.target.closest('.rm')) {
        if (!confirm(`删除画板「${b.name}」？此操作无法撤销。`)) return;
        await db.del(b.id);
        if (b.id === board.id) {
          clearTimeout(saveTimer); saveTimer = 0;
          const rest = list.filter(x => x.id !== b.id);
          if (rest.length) await openBoard(rest[0].id); else await newBoard(TEMPLATES[0]);
        }
        renderDrawer();
      } else { await openBoard(b.id); $('#drawer').hidden = true; }
    };
    box.appendChild(row);
  }
}

// ---------------------------------------------------------------- import / export
function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2200);
}
function toMarkdown() {
  const out = [`# ${board.name}`, ''];
  const line = (n, d) => {
    const [first, ...rest] = n.kind === 'image' ? ['（图片）'] : n.text.split('\n');
    if (d === 0) { out.push(`## ${first}`); rest.forEach(r => r.trim() && out.push(r)); out.push(''); }
    else {
      const ind = '  '.repeat(d - 1);
      out.push(`${ind}- ${first}`);
      rest.forEach(r => r.trim() && out.push(`${ind}  ${r}`));
    }
    n.children.forEach(c => line(N(c), d + 1));
    if (d === 0) out.push('');
  };
  roots().sort((a, b) => a.y - b.y || a.x - b.x).forEach(r => line(r, 0));
  if (board.links.length) {
    out.push('## 关联', '');
    board.links.forEach(l => out.push(`- ${firstLine(N(l.from))} → ${firstLine(N(l.to))}${l.label ? `（${l.label}）` : ''}`));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}
async function exportPNG() {
  finishEdit();
  sel = new Set(); selLink = null; query = ''; render();
  const b = bounds();
  if (!b) return toast('画板是空的');
  toast('正在生成图片…');
  try {
    const { toBlob } = await import('https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/+esm');
    const pad = 48, w = Math.ceil(b.w + pad * 2), h = Math.ceil(b.h + pad * 2);
    const blob = await toBlob(world, {
      width: w, height: h, pixelRatio: Math.min(2, 8000 / Math.max(w, h)),
      backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
      style: { transform: `translate(${pad - b.x}px,${pad - b.y}px)` },
    });
    download(board.name + '.png', blob);
    toast('PNG 已导出');
  } catch (err) {
    console.error(err);
    toast('导出失败：PNG 导出需要联网加载一个小组件');
  }
}
function loadImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), im = new Image();
    im.onload = () => {
      const s = Math.min(1, 1600 / Math.max(im.width, im.height));
      const c = document.createElement('canvas');
      c.width = Math.round(im.width * s); c.height = Math.round(im.height * s);
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      res({ data: c.toDataURL('image/webp', 0.85), w: c.width, h: c.height });
    };
    im.onerror = rej;
    im.src = url;
  });
}
async function addImages(files, at) {
  let i = 0;
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    try {
      const { data, w, h } = await loadImage(f);
      const src = uid(), c = at || center(), W = Math.min(320, w);
      board.assets[src] = data;
      const n = addNode({ kind: 'image', src, w: W, ar: w / h, x: c.x - W / 2 + i * 26, y: c.y - W * h / w / 2 + i * 26 });
      sel = new Set([n.id]);
      i++;
    } catch { toast('有一张图片读不出来'); }
  }
  if (i) commit();
}

// ---------------------------------------------------------------- pointer
vp.addEventListener('pointerdown', e => {
  const t = e.target, nodeEl = t.closest('.node');
  if (editing && nodeEl && nodeEl.dataset.id === editing) return;
  finishEdit();
  if (t.closest('a')) return;
  const v = board.view, base = { sx: e.clientX, sy: e.clientY, moved: false };
  if (e.button !== 0) { drag = { ...base, type: 'pan', vx: v.x, vy: v.y }; return; }
  if (t.closest('.fold')) return;
  if (nodeEl) {
    const id = nodeEl.dataset.id;
    if (t.closest('.link-handle')) { drag = { ...base, type: 'link', from: id }; return; }
    if (t.closest('.resize')) { drag = { ...base, type: 'resize', id, w: geo.get(id).w }; return; }
    selLink = null;
    if (e.shiftKey) { sel.has(id) ? sel.delete(id) : sel.add(id); }
    else if (!sel.has(id)) sel = new Set([id]);
    drag = { ...base, type: 'node', id, shift: e.shiftKey };
    render();
    return;
  }
  const lk = t.closest('[data-link]');
  if (lk) { selLink = lk.dataset.link; sel = new Set(); render(); return; }
  drag = e.shiftKey ? { ...base, type: 'marquee', p: pt(e) } : { ...base, type: 'pan', vx: v.x, vy: v.y };
});

window.addEventListener('pointermove', e => {
  if (!drag) return;
  const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy, v = board.view, k = v.k;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  const first = !drag.moved;
  drag.moved = true;
  if (drag.type === 'pan') {
    vp.classList.add('panning');
    v.x = drag.vx + dx; v.y = drag.vy + dy;
    applyView();
  } else if (drag.type === 'node') {
    if (first) {
      if (N(drag.id).parent) { drag.child = true; drag.ids = new Set(subtree(drag.id)); }
      else {
        drag.roots = [...sel].filter(i => !N(i).parent).map(i => ({ n: N(i), x: N(i).x, y: N(i).y }));
        drag.ids = new Set(drag.roots.flatMap(r => subtree(r.n.id)));
      }
    }
    if (drag.child) { drag.dx = dx / k; drag.dy = dy / k; }
    else drag.roots.forEach(r => { r.n.x = r.x + dx / k; r.n.y = r.y + dy / k; });
    render();
    let tid = e.altKey ? null : nodeAt(e.clientX, e.clientY);
    if (tid && drag.ids.has(tid)) tid = null;
    // 便签 / 图片叠在另一张便签 / 图片上只是摆放，不挂接（头脑风暴时经常这样堆）
    const loose = k => k === 'sticky' || k === 'image';
    if (tid && !drag.child && loose(N(drag.id).kind) && loose(N(tid).kind)) tid = null;
    if (tid !== (drag.target || null)) {
      if (drag.target && els.get(drag.target)) els.get(drag.target).classList.remove('drop');
      drag.target = tid;
      if (tid) els.get(tid).classList.add('drop');
    }
  } else if (drag.type === 'resize') {
    N(drag.id).w = Math.max(110, Math.round(drag.w + dx / k));
    render();
  } else if (drag.type === 'link') {
    const p = pt(e), w = toWorld(p.sx, p.sy);
    drag.x = w.x; drag.y = w.y;
    drawEdges();
  } else if (drag.type === 'marquee') {
    const p = pt(e), m = $('#marquee');
    const x0 = Math.min(p.sx, drag.p.sx), y0 = Math.min(p.sy, drag.p.sy), x1 = Math.max(p.sx, drag.p.sx), y1 = Math.max(p.sy, drag.p.sy);
    m.hidden = false;
    m.style.cssText = `left:${x0}px;top:${y0}px;width:${x1 - x0}px;height:${y1 - y0}px`;
    const a = toWorld(x0, y0), b = toWorld(x1, y1);
    sel = new Set([...geo].filter(([, g]) => g.x < b.x && g.x + g.w > a.x && g.y < b.y && g.y + g.h > a.y).map(([i]) => i));
    render();
  }
});

window.addEventListener('pointerup', e => {
  const d = drag;
  drag = null;
  if (!d) return;
  vp.classList.remove('panning');
  $('#marquee').hidden = true;
  if (d.type === 'node') {
    if (!d.moved) { if (!d.shift && sel.size > 1) sel = new Set([d.id]); render(); return; }
    if (d.target) (d.child ? [d.id] : d.roots.map(r => r.n.id)).forEach(i => attach(i, d.target));
    else if (d.child) {
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 40) { render(); return; }
      const g = geo.get(d.id), n = N(d.id);
      detach(d.id);
      n.x = g.x + d.dx; n.y = g.y + d.dy;
    }
    commit();
  } else if (d.type === 'link') {
    const tid = nodeAt(e.clientX, e.clientY);
    if (d.moved && tid && tid !== d.from && !board.links.some(l => l.from === d.from && l.to === tid)) {
      board.links.push({ id: uid(), from: d.from, to: tid, label: '' });
      commit();
    } else render();
  } else if (d.type === 'resize') {
    d.moved ? commit() : render();
  } else if (d.type === 'pan') {
    if (!d.moved && e.button === 0) { sel = new Set(); selLink = null; render(); }
    saveSoon();
  } else render();
});

vp.addEventListener('click', e => {
  const f = e.target.closest('.fold');
  if (f) toggleFold(f.parentNode.dataset.id);
});
vp.addEventListener('dblclick', e => {
  const t = e.target;
  if (t.closest('.fold,.link-handle,.resize,a')) return;
  const el = t.closest('.node');
  if (el) { if (editing !== el.dataset.id) startEdit(el.dataset.id); return; }
  const lk = t.closest('[data-link]');
  if (lk) {
    const l = board.links.find(x => x.id === lk.dataset.link);
    const s = prompt('连线上的文字（留空则不显示）', l.label || '');
    if (s !== null) { l.label = s.trim(); commit(); }
    return;
  }
  const p = pt(e), w = toWorld(p.sx, p.sy);
  addFree('sticky', { x: w.x - 90, y: w.y - 60 });
});
vp.addEventListener('contextmenu', e => e.preventDefault());
vp.addEventListener('input', () => { if (editing) render(); });
vp.addEventListener('focusout', e => { if (editing && e.target.classList && e.target.classList.contains('body')) finishEdit(); });
vp.addEventListener('wheel', e => {
  e.preventDefault();
  const v = board.view, p = pt(e);
  const mouse = e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50;
  if (e.ctrlKey || e.metaKey || mouse) zoomAt(p.sx, p.sy, Math.exp(-e.deltaY * (mouse ? 0.0015 : 0.01)));
  else { v.x -= e.deltaX; v.y -= e.deltaY; applyView(); saveSoon(); }
}, { passive: false });
vp.addEventListener('dragover', e => e.preventDefault());
vp.addEventListener('drop', e => {
  e.preventDefault();
  const p = pt(e);
  if (e.dataTransfer.files.length) addImages([...e.dataTransfer.files], toWorld(p.sx, p.sy));
});

// ---------------------------------------------------------------- keyboard & clipboard
window.addEventListener('keydown', e => {
  if (e.isComposing || e.keyCode === 229) return;
  const mod = e.ctrlKey || e.metaKey;
  if (editing) {
    const n = N(editing);
    if (e.key === 'Escape') { e.preventDefault(); finishEdit(); }
    else if (e.key === 'Tab') { e.preventDefault(); const id = editing; finishEdit(); if (N(id)) addChild(id); }
    else if (e.key === 'Enter' && (n.kind === 'topic' ? !e.shiftKey : mod)) { e.preventDefault(); finishEdit(); }
    return;
  }
  if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#search').focus(); $('#search').select(); return; }
  if (e.target.matches('input,textarea,select') || document.querySelector('dialog[open]')) return;
  const one = sel.size === 1 ? [...sel][0] : null, key = e.key;
  const done = () => e.preventDefault();
  if (mod && key.toLowerCase() === 'z') { done(); e.shiftKey ? redo() : undo(); }
  else if (mod && key.toLowerCase() === 'y') { done(); redo(); }
  else if (mod && key.toLowerCase() === 'a') { done(); sel = new Set(meta.keys()); render(); }
  else if (mod && key.toLowerCase() === 'd') { done(); duplicate(); }
  else if (mod || e.altKey && !key.startsWith('Arrow')) return;
  else if (key === 'Tab') { done(); if (one) addChild(one); }
  else if (key === 'Enter') { done(); if (one) addSibling(one); }
  else if (key === 'F2' || key === ' ') { done(); if (one) startEdit(one); }
  else if (key === 'Delete' || key === 'Backspace') { done(); deleteSelection(); }
  else if (key === '/') { done(); if (one) toggleFold(one); }
  else if (key === '1') { done(); fit(); }
  else if (key === 'Escape') { sel = new Set(); selLink = null; render(); }
  else if (key.startsWith('Arrow') && one) {
    done();
    if (e.altKey) { if (key === 'ArrowUp') reorder(one, -1); else if (key === 'ArrowDown') reorder(one, 1); }
    else navigate(key);
  }
});

function onCopy(e, cut) {
  if (editing || e.target.matches?.('input,textarea') || !sel.size) return;
  const specs = topSelected().map(toSpec);
  const text = specs.flatMap(s => specText(s)).join('\n');
  clip = { text, specs };
  e.clipboardData.setData('text/plain', text);
  e.preventDefault();
  if (cut) deleteSelection(); else toast('已复制');
}
document.addEventListener('copy', e => onCopy(e, false));
document.addEventListener('cut', e => onCopy(e, true));
document.addEventListener('paste', e => {
  if (editing || e.target.matches?.('input,textarea') || document.querySelector('dialog[open]')) return;
  const cd = e.clipboardData, imgs = [...cd.files].filter(f => f.type.startsWith('image/'));
  e.preventDefault();
  if (imgs.length) { addImages(imgs); return; }
  const tx = cd.getData('text/plain').replace(/\r\n/g, '\n').trim();
  if (!tx) return;
  const one = sel.size === 1 ? [...sel][0] : null;
  let specs;
  if (clip && clip.text.trim() === tx) specs = JSON.parse(JSON.stringify(clip.specs));
  else if (one || /^\s*(#{1,6}|[-*+•]|\d+[.)])\s/m.test(tx) && tx.includes('\n')) specs = parseOutline(tx);
  else specs = [S(tx)];
  placeSpecs(specs, one);
});

// ---------------------------------------------------------------- UI wiring
$('#board-name').addEventListener('change', e => {
  board.name = e.target.value.trim() || '未命名画板';
  e.target.value = board.name;
  document.title = board.name + ' · MindBoard';
  saveSoon();
});
$('#board-name').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
$('#btn-undo').onclick = undo;
$('#btn-redo').onclick = redo;
$('#tools').addEventListener('click', e => { const b = e.target.closest('[data-add]'); if (b) { finishEdit(); addFree(b.dataset.add); } });
$('#file-img').addEventListener('change', e => { addImages([...e.target.files]); e.target.value = ''; });

$('#swatches').innerHTML = '<button class="sw auto" data-color="" title="自动配色"></button>' +
  COLORS.map(c => `<button class="sw" data-color="${c}" style="background:var(--c-${c})" title="${c}"></button>`).join('');
$('#propbar').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b || !sel.size) return;
  const one = sel.size === 1 ? [...sel][0] : null;
  if ('color' in b.dataset) { sel.forEach(i => N(i).color = b.dataset.color || null); commit(); }
  else if (b.dataset.kind) {
    sel.forEach(i => {
      const n = N(i);
      if (n.kind === 'image') return;
      n.kind = b.dataset.kind;
      if (n.kind === 'topic') delete n.w;
      if (n.kind === 'sticky' && !n.color && !n.parent) n.color = 'yellow';
    });
    commit();
  }
  else if (b.dataset.act === 'child') { if (one) addChild(one); else toast('先只选中一个节点'); }
  else if (b.dataset.act === 'fold') sel.forEach(i => { const n = N(i); if (n.children.length) n.collapsed = !n.collapsed; }), commit();
  else if (b.dataset.act === 'del') deleteSelection();
});

$('#zoom').addEventListener('click', e => {
  const z = e.target.closest('[data-zoom]');
  if (!z) return;
  const W = vp.clientWidth / 2, H = vp.clientHeight / 2;
  if (z.dataset.zoom === 'in') zoomAt(W, H, 1.25);
  else if (z.dataset.zoom === 'out') zoomAt(W, H, 0.8);
  else if (z.dataset.zoom === 'reset') zoomAt(W, H, 1 / board.view.k);
  else fit();
});

const search = $('#search');
let hitIdx = -1;
search.addEventListener('input', () => { query = search.value.trim(); hitIdx = -1; render(); });
search.addEventListener('keydown', e => {
  if (e.key === 'Escape') { search.value = ''; query = ''; search.blur(); render(); }
  if (e.key !== 'Enter' || !query) return;
  const hits = Object.values(board.nodes).filter(n => n.text.toLowerCase().includes(query.toLowerCase()));
  if (!hits.length) return toast('没有找到');
  hitIdx = (hitIdx + 1) % hits.length;
  const n = hits[hitIdx];
  for (let p = N(n.parent); p; p = N(p.parent)) p.collapsed = false;
  sel = new Set([n.id]);
  render(); centerOn(n.id);
  toast(`${hitIdx + 1} / ${hits.length}`);
});

const fileMenu = $('#file-menu');
$('#btn-file').onclick = e => { e.stopPropagation(); fileMenu.hidden = !fileMenu.hidden; };
document.addEventListener('pointerdown', e => {
  if (!e.target.closest('.menu-wrap')) fileMenu.hidden = true;
  if (!e.target.closest('#drawer,#btn-boards')) $('#drawer').hidden = true;
});
fileMenu.addEventListener('click', async e => {
  const a = e.target.closest('button')?.dataset.act;
  if (!a) return;
  fileMenu.hidden = true;
  finishEdit();
  if (a === 'new') $('#dlg-tpl').showModal();
  else if (a === 'outline') { $('#outline-text').value = ''; $('#dlg-outline').showModal(); }
  else if (a === 'import-json') $('#file-json').click();
  else if (a === 'png') exportPNG();
  else if (a === 'md') download(board.name + '.md', new Blob([toMarkdown()], { type: 'text/markdown' }));
  else if (a === 'copy-md') { await navigator.clipboard.writeText(toMarkdown()); toast('Markdown 已复制'); }
  else if (a === 'json') { await flush(); download(board.name + '.mindboard.json', new Blob([JSON.stringify(board)], { type: 'application/json' })); }
});
$('#file-json').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const b = JSON.parse(await f.text());
    if (!b.nodes || typeof b.nodes !== 'object') throw 0;
    if (saveTimer) await flush();
    b.id = uid(); b.updated = Date.now(); b.name ||= f.name.replace(/\.(mindboard\.)?json$/, '');
    await db.put(b);
    await openBoard(b.id);
    toast('已导入为新画板');
  } catch { toast('这个文件不是 MindBoard 的备份'); }
});
$('#outline-ok').onclick = () => {
  const specs = parseOutline($('#outline-text').value);
  $('#dlg-outline').close();
  if (!specs.length) return;
  placeSpecs(specs, null);
  fit();
};

$('#tpl-list').innerHTML = TEMPLATES.map(t => `<button class="tpl" data-tpl="${t.id}"><span class="em">${t.em}</span><span><b>${t.name}</b><small>${t.desc}</small></span></button>`).join('');
$('#tpl-list').addEventListener('click', async e => {
  const b = e.target.closest('[data-tpl]');
  if (!b) return;
  $('#dlg-tpl').close();
  await newBoard(TEMPLATES.find(t => t.id === b.dataset.tpl));
});
$('#btn-boards').onclick = () => { const d = $('#drawer'); d.hidden = !d.hidden; if (!d.hidden) renderDrawer(); };
$('#drawer-new').onclick = () => { $('#drawer').hidden = true; $('#dlg-tpl').showModal(); };
$('#btn-help').onclick = () => $('#dlg-help').showModal();
document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));

const setTheme = t => { document.documentElement.dataset.theme = t; localStorage.setItem('mb_theme', t); };
$('#btn-theme').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
document.documentElement.dataset.theme = localStorage.getItem('mb_theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

window.addEventListener('resize', () => board && render());
document.addEventListener('visibilitychange', () => { if (document.hidden && saveTimer) flush(); });
window.addEventListener('pagehide', () => { if (saveTimer) flush(); });

// ---------------------------------------------------------------- boot
(async () => {
  const cur = localStorage.getItem('mb_current');
  if (cur && await openBoard(cur)) return;
  const all = await db.all();
  if (all.length) { await openBoard(all.sort((a, b) => b.updated - a.updated)[0].id); return; }
  await newBoard(TEMPLATES[0]);
  $('#dlg-tpl').showModal();
})();
