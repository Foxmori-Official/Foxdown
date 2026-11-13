// 扩展 UI 层功能测试：vm 加载真实 popup.js / options.js / onboarding.js，
// 配 mini DOM + chrome/storage/tabs/runtime/fetch mock，覆盖：
//   onboarding：三步导航、完成标记、serverUrl 即存清理、连接测试、开关/语言即存
//   options：表单回填、collect/save、多服务器增删收集、连接测试、导入、语言切换
//   popup：fmt/pickDefaultServer/extOf、接管开关、统计渲染、媒体列表、确认模式
//   i18n 集成：语言切换后 data-i18n 元素刷成对应语言真实文案
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const read = (f) => fs.readFileSync(path.join(EXT, f), 'utf8');
const msg = (dir, key) => JSON.parse(read(path.join('_locales', dir, 'messages.json')))[key].message;

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
}

// ============================================================
// mini DOM：仅覆盖扩展 UI 脚本用到的能力（平铺 innerHTML、classList、dataset、事件）
// ============================================================
class El {
  constructor(tag, attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.listeners = {};
    this.attrs = {};
    this.dataset = {};
    this.style = {};
    this.value = '';
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
    this.selectedIndex = -1;
    this.className = '';
    this._text = '';
    this.title = '';
    this.placeholder = '';
    this.type = attrs.type || '';
    this._html = '';
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') this.className = v;
      else if (k === 'id') this.attrs.id = v;
      else if (k.startsWith('data-')) {
        this.dataset[k.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = v;
      } else this.attrs[k] = v;
    }
  }
  get id() { return this.attrs.id || ''; }
  set id(v) { this.attrs.id = v; }
  // 与真实 DOM 一致：赋值即转字符串
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text; }
  get classList() {
    const self = this;
    const set = () => new Set(self.className.split(/\s+/).filter(Boolean));
    return {
      add: (...cs) => { const s = set(); cs.forEach(c => s.add(c)); self.className = [...s].join(' '); },
      remove: (...cs) => { const s = set(); cs.forEach(c => s.delete(c)); self.className = [...s].join(' '); },
      toggle: (c, force) => {
        const has = set().has(c);
        const want = force === undefined ? !has : !!force;
        if (want) this.classList.add(c); else this.classList.remove(c);
        return want;
      },
      contains: (c) => set().has(c),
    };
  }
  set innerHTML(html) {
    this._html = String(html);
    this.children = [];
    if (!html) return;
    // 平铺标签解析（serverRow：无嵌套的 <input>/<button>）
    for (const m of String(html).matchAll(/<([a-z]+)((?:\s+[\w-]+(?:="[^"]*")?)+)\s*\/?>/gi)) {
      const el = new El(m[1]);
      for (const a of m[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
        const [name, val] = [a[1], a[2] ?? ''];
        if (name === 'class') el.className = val;
        else if (name === 'value') el.value = val;
        else if (name === 'title') el.title = val;
        else if (name === 'placeholder') el.placeholder = val;
        else if (name === 'type') el.type = val;
        else el.attrs[name] = val;
      }
      el.parent = this;
      this.children.push(el);
    }
  }
  get innerHTML() { return this._html; }
  appendChild(el) { el.parent = this; this.children.push(el); return el; }
  append(...els) { els.forEach(e => this.appendChild(e)); }
  remove() {
    if (this.parent) {
      const i = this.parent.children.indexOf(this);
      if (i >= 0) this.parent.children.splice(i, 1);
      this.parent = null;
    }
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  setAttribute(name, value) { this.attrs[name] = value; }
  getAttribute(name) {
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase());
      return key in this.dataset ? this.dataset[key] : null;
    }
    return name in this.attrs ? this.attrs[name] : null;
  }
  async dispatch(type, ev = {}) {
    ev.target = ev.target || this;
    for (const f of this.listeners[type] || []) await f(ev);
  }
  click() { return this.dispatch('click'); }
  matches(sel) {
    for (const part of sel.split(',')) {
      const p = part.trim();
      if (!p) continue;
      if (p.startsWith('#') && this.id === p.slice(1)) return true;
      if (p.startsWith('.') && this.className.split(/\s+/).includes(p.slice(1))) return true;
      const attr = p.match(/^\[([\w-]+)\]$/);
      if (attr) {
        const key = attr[1].startsWith('data-') ? attr[1].slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase()) : null;
        if (key ? key in this.dataset : attr[1] in this.attrs) return true;
      }
      const tag = p.match(/^[a-z]+$/i);
      if (tag && this.tagName === p.toUpperCase()) return true;
    }
    return false;
  }
  _descendants(sel) {
    const parts = String(sel).split(/\s+/).map(s => s.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    const prefix = parts.slice(0, -1);
    // 宽松后代语义：prefix 各段依序出现在祖先链上即匹配
    const chainOk = (el) => {
      let idx = 0;
      for (let p = el.parent; p; p = p.parent) {
        if (idx < prefix.length && p.matches(prefix[idx])) idx++;
      }
      return idx >= prefix.length;
    };
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (c.matches(last) && chainOk(c)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) { return this._descendants(sel); }
}

function makeSandbox({ page, storage = {}, fetchRoutes = {}, messages = [], uiLang = 'ru', locationSearch = '' } = {}) {
  // ---- 页面元素注册（按各 HTML 的 id + 结构）----
  const body = new El('body');
  const byId = {};
  const reg = (id, tag = 'div', attrs = {}) => {
    const el = new El(tag, { id, ...attrs });
    byId[id] = el;
    body.appendChild(el);
    return el;
  };
  if (page === 'onboarding') {
    for (const s of ['1', '2', '3', 'done']) reg(`step${s}`, 'section', { class: 'step', 'data-step': s });
    for (const n of ['1', '2', '3']) reg(`dot${n}`, 'span', { 'data-step-dot': n });
    reg('backBtn', 'button'); reg('nextBtn', 'button'); reg('finishBtn', 'button');
    reg('serverUrl', 'input'); reg('apiToken', 'input'); reg('routingHint', 'a'); reg('finishState'); reg('enabled', 'input', { type: 'checkbox' });
    reg('locale', 'select'); reg('testBtn', 'button'); reg('testState', 'div', { class: 'test-state' });
    reg('demoBtn', 'button');
    // data-i18n 元素（applyI18nTexts 刷新对象）
    reg('obTitleEl', 'h1', { 'data-i18n': 'obWelcomeTitle' });
  } else if (page === 'options') {
    for (const id of ['serverUrl', 'apiToken', 'domainList', 'extList', 'fileNameTemplate', 'sniffRegexRules']) reg(id, 'input');
    for (const id of ['enabled', 'captureUnknownSize', 'captureMagnet', 'notifyComplete', 'sniffEnabled',
      'allowExternalRequest', 'deepSearch', 'autoDownloadSniffed', 'askBeforeDownload']) reg(id, 'input', { type: 'checkbox' });
    for (const id of ['minSizeMB', 'autoDownloadMinSizeMB']) reg(id, 'input', { type: 'number' });
    for (const id of ['domainMode', 'extMode', 'panelOpenStyle', 'locale']) reg(id, 'select');
    reg('serverList', 'div'); reg('addServer', 'button'); reg('status', 'div');
    reg('save', 'button'); reg('test', 'button'); reg('export', 'button');
    reg('import', 'button'); reg('importFile', 'input'); reg('reopenGuide', 'button');
    reg('langLabelEl', 'label', { 'data-i18n': 'langLabel' });
    reg('domainListPhEl', 'input', { 'data-i18n-ph': 'domainListPh' });
  } else if (page === 'popup') {
    reg('capture', 'input', { type: 'checkbox' }); reg('captureLabel', 'span', { 'data-i18n': 'captureLabel' });
    reg('active', 'span'); reg('waiting', 'span'); reg('speed', 'span'); reg('upspeed', 'span'); reg('state', 'span');
    reg('sniffCapture', 'input', { type: 'checkbox' });
    reg('mediaPage', 'div'); reg('mediaEmpty', 'p');
    reg('taskErrors', 'div'); reg('taskErrorTitle', 'strong'); reg('taskErrorList', 'ul'); reg('clearHandoffError', 'button');
    reg('mediaBox', 'div'); reg('mediaHead', 'div'); reg('mediaList', 'div'); reg('deepSearch', 'button');
    reg('open', 'button'); reg('options', 'button'); reg('guide', 'button');
    reg('previewBox', 'div'); reg('previewPlayer', 'div'); reg('previewName', 'div'); reg('previewErr', 'div');
    reg('cfState', 'div'); reg('cfName', 'input'); reg('cfReferer', 'input');
    reg('cfSplit', 'input'); reg('cfServer', 'select'); reg('cfStart', 'button'); reg('cfCancel', 'button');
  }

  // ---- chrome mock（i18n.getMessage 读真实 en messages.json，模拟 default_locale 兜底）----
  const EN = JSON.parse(read(path.join('_locales', 'en', 'messages.json')));
  const local = { ...storage };
  const onChanged = [];
  const sent = [];
  const createdTabs = [];
  const msgQueue = [...messages];
  const chrome = {
    storage: {
      local: {
        get: async (defaults) => ({ ...defaults, ...local }),
        set: async (obj) => {
          Object.assign(local, obj);
          const changes = {};
          for (const k of Object.keys(obj)) changes[k] = { newValue: obj[k] };
          for (const fn of onChanged) fn(changes, 'local');
        },
      },
      onChanged: { addListener: (fn) => onChanged.push(fn) },
    },
    runtime: {
      getURL: (p) => p,
      openOptionsPage: () => { sent.push({ __openOptions: true }); },
      sendMessage: async (m) => {
        sent.push(m);
        if (m.type === 'getDownloadStatus') return { errors: [], unavailable: 0 };
        const next = msgQueue.shift();
        if (typeof next === 'function') return next(m);
        return next;
      },
    },
    tabs: {
      query: async () => [{ id: 77, url: 'https://example.com/page' }],
      create: async (o) => { createdTabs.push(o); return { id: 1 }; },
    },
    i18n: {
      getMessage: (k, sub) => {
        const e = EN[k];
        if (!e) return '';
        let m = e.message;
        const arr = Array.isArray(sub) ? sub : (sub !== undefined && sub !== null ? [sub] : []);
        for (let i = 0; i < arr.length; i++) m = m.split('$' + (i + 1)).join(String(arr[i]));
        return m;
      },
      getUILanguage: () => uiLang,
    },
  };

  // ---- fetch mock：_locales/* 读真实文件，其余按路由 ----
  const fetch = async (url, options) => {
    const u = String(url);
    if (u.startsWith('_locales/')) {
      try {
        const text = fs.readFileSync(path.join(EXT, u.split('?')[0]), 'utf8');
        return { ok: true, json: async () => JSON.parse(text) };
      } catch { return { ok: false, status: 404, json: async () => { throw new Error('404'); } }; }
    }
    for (const [prefix, handler] of Object.entries(fetchRoutes)) {
      if (u.startsWith(prefix)) {
        const r = typeof handler === 'function' ? handler(u, options) : handler;
        if (r instanceof Error) throw r;
        return r;
      }
    }
    throw new Error('connect refused: ' + u);
  };

  const window = {
    addEventListener: () => {},
    close: () => { window.__closed = true; },
    __closed: false,
  };
  const sandbox = {
    console, chrome, fetch, window, document: null,
    readSettings: defaults => chrome.storage.local.get(defaults),
    writeSettings: patch => chrome.storage.local.set(patch), location: { search: locationSearch },
    URLSearchParams, URL, El, AbortController, AbortSignal, clearTimeout,
    setInterval: () => 0, clearInterval: () => {},
    setTimeout: (fn) => { fn(); return 0; },
    Blob: class { constructor(parts) { this.parts = parts; } },
    FileReader: class {
      readAsText(f) { this.result = f.content; this.onload && this.onload(); }
    },
  };
  sandbox.document = {
    createElement: (tag) => new El(tag),
    getElementById: (id) => byId[id] || null,
    querySelector: (sel) => body.querySelectorAll(sel)[0] || null,
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    body, documentElement: {},
    title: '',
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('connection.js'), sandbox);
  vm.runInContext(read('i18n.js'), sandbox); // 先装 i18n 覆盖层
  return { sandbox, byId, body, chrome, local, sent, createdTabs, window, msgQueue };
}

const run = (sb, file) => vm.runInContext(read(file), sb.sandbox);

// ============================================================
console.log('== onboarding：三步导航与完成标记 ==');
{
  const t = makeSandbox({
    page: 'onboarding',
    fetchRoutes: {
      'http://127.0.0.1:16801/api/v1/health': {
        ok: true, json: async () => ({ ok: true, app: 'foxdown', aria2: true, aria2Version: '1.37.0' })
      }
    },
  });
  run(t, 'onboarding.js');
  await new Promise(r => setTimeout(r, 30)); // 等 IIFE
  assert(t.sandbox.document.documentElement.lang === 'en' && t.sandbox.document.title === msg('en', 'obTitle'), '引导页 HTML lang 与标题随语言初始化');
  assert(t.byId.step1.hidden === false && t.byId.backBtn.hidden === true && t.byId.finishBtn.hidden === true, '初始 step1：back 隐藏、finish 隐藏');
  await t.byId.nextBtn.dispatch('click');
  assert(t.byId.step2.hidden === true, '连接未验证时无法继续');
  await t.byId.testBtn.dispatch('click');
  await t.byId.nextBtn.dispatch('click');
  assert(t.byId.step2.hidden === false && t.byId.step1.hidden === true && t.byId.backBtn.hidden === false, 'next → step2 显示、back 出现');
  assert(t.byId.dot2.classList.contains('active') && t.byId.dot1.classList.contains('done'), '进度点：dot1 done、dot2 active');
  await t.byId.backBtn.dispatch('click');
  assert(t.byId.step1.hidden === false, 'back → 回到 step1');
  await t.byId.nextBtn.dispatch('click');
  await t.byId.nextBtn.dispatch('click');
  assert(t.byId.step3.hidden === false && t.byId.finishBtn.hidden === false && t.byId.nextBtn.hidden === true, '到 step3：finish 出现、next 隐藏');
  await t.byId.finishBtn.dispatch('click');
  assert(t.local.onboardingCompleted === true, 'finish → chrome.storage.local.onboardingCompleted = true');
  assert(t.byId.step1.hidden === true && t.byId.done ? true : t.body.querySelectorAll('.step').every(s => s.hidden || s.dataset.step === 'done'), '完成后仅 done 区可见');
}

console.log('== onboarding：带令牌验证、保存与打开已验证服务器的演示页 ==');
{
  const server = 'http://192.168.1.5:16801';
  const t = makeSandbox({
    page: 'onboarding',
    fetchRoutes: {
      [server + '/api/v1/health']: (_url, options) => options.headers.Authorization === 'Bearer fixture-token'
        ? { ok: true, json: async () => ({ ok: true, app: 'foxdown', aria2: true, aria2Version: '1.37.0' }) }
        : { ok: false, status: 401 },
    },
  });
  run(t, 'onboarding.js');
  await new Promise(r => setTimeout(r, 30));
  t.byId.serverUrl.value = server + '/';
  await t.byId.serverUrl.dispatch('input');
  await t.byId.testBtn.dispatch('click');
  assert(t.byId.nextBtn.disabled && t.byId.testState.textContent === msg('en', 'serverTokenInvalid'), '缺少令牌时提示核对 Web API Token');
  assert(!t.local.serverUrl, '验证失败时不保存地址');
  t.byId.apiToken.value = 'fixture-token';
  await t.byId.testBtn.dispatch('click');
  assert(t.local.serverUrl === server && t.local.apiToken === 'fixture-token', '验证成功后保存地址和令牌');
  assert(t.byId.testState.className.includes('ok') && t.byId.testState.textContent.includes('1.37.0'), '连接测试成功 → 绿字含 aria2 版本');
  await t.byId.nextBtn.dispatch('click');
  await t.byId.nextBtn.dispatch('click');
  await t.byId.demoBtn.dispatch('click');
  assert(t.createdTabs.at(-1).url === server + '/demo.html', '演示页使用通过验证的地址');
  t.byId.enabled.checked = false;
  await t.byId.enabled.dispatch('change', { target: t.byId.enabled });
  assert(t.local.enabled === false, '接管开关即存 storage.local');
}

console.log('== onboarding：连接失败提示 ==');
{
  const t = makeSandbox({ page: 'onboarding' }); // 无 fetch 路由 → 抛错
  run(t, 'onboarding.js');
  await new Promise(r => setTimeout(r, 30));
  await t.byId.testBtn.dispatch('click');
  assert(t.byId.testState.className.includes('err') && t.byId.testState.textContent === msg('en', 'obTestFail'), '连接失败 → 红字 obTestFail（en 兜底文案）');
}

console.log('== options：表单回填与收集保存 ==');
{
  const t = makeSandbox({
    page: 'options',
    storage: {
      serverUrl: 'http://10.0.0.2:16801/', apiToken: 'tok1', enabled: false, minSizeMB: 8,
      domainMode: 'blacklist', domainList: 'a.com', sniffRegexRules: [{ url: 'r1', state: true }, { url: 'r2', state: false }, { url: 'r3', state: true }],
      servers: [{ name: 'S1', url: 'http://s1:16801', token: 't1', pattern: '*.example.com' }],
    },
  });
  run(t, 'options.js');
  await new Promise(r => setTimeout(r, 30));
  assert(t.byId.serverUrl.value === 'http://10.0.0.2:16801/' && t.byId.apiToken.value === 'tok1' && t.byId.minSizeMB.value === 8, 'load() 回填文本/数字字段');
  assert(t.byId.enabled.checked === false && t.byId.domainMode.value === 'blacklist', 'load() 回填开关/下拉');
  assert(t.byId.sniffRegexRules.value === 'r1\nr3', '嗅探正则数组 → 行文本（state:false 行被过滤）');
  assert(t.body.querySelectorAll('#serverList .server-row').length === 1, 'load() 渲染多服务器行');

  // collect：改表单后保存
  t.byId.serverUrl.value = 'http://10.0.0.9:16801///';
  t.byId.minSizeMB.value = '12';
  t.byId.sniffRegexRules.value = 'x.com\n\ny.com';
  await t.byId.save.dispatch('click');
  const saved = t.local;
  assert(saved.serverUrl === 'http://10.0.0.9:16801', 'save()：serverUrl 尾斜杠清理');
  assert(saved.minSizeMB === 12 && Array.isArray(saved.sniffRegexRules) && saved.sniffRegexRules.length === 2, 'save()：数字转换 + 正则行→数组');
  assert(saved.servers.length === 1 && saved.servers[0].pattern === '*.example.com' && saved.servers[0].url === 'http://s1:16801', 'save()：多服务器收集（url 尾斜杠清理）');
  assert(t.byId.status.className === 'ok', 'save() 后状态条显示成功');
}

console.log('== options：多服务器增删 ==');
{
  const t = makeSandbox({ page: 'options' });
  run(t, 'options.js');
  await new Promise(r => setTimeout(r, 30));
  await t.byId.addServer.dispatch('click');
  await t.byId.addServer.dispatch('click');
  let rows = t.body.querySelectorAll('#serverList .server-row');
  assert(rows.length === 2, 'addServer ×2 → 两行');
  rows[0].querySelector('.srv-url').value = 'http://a:16801';
  rows[1].querySelector('.srv-url').value = 'http://b:16801/';
  rows[1].querySelector('.srv-name').value = 'B机';
  await rows[0].querySelector('.srv-del').dispatch('click');
  rows = t.body.querySelectorAll('#serverList .server-row');
  assert(rows.length === 1 && rows[0].querySelector('.srv-url').value === 'http://b:16801/', '删除第一行后剩 B 机行');
  await t.byId.save.dispatch('click');
  assert(t.local.servers.length === 1 && t.local.servers[0].name === 'B机' && t.local.servers[0].url === 'http://b:16801' && t.local.servers[0].pattern === '*', 'collectServers：name/url/pattern 收集与默认值');
}

console.log('== options：连接测试（多服务器优先） ==');
{
  let hitUrl = '';
  const t = makeSandbox({
    page: 'options',
    fetchRoutes: {
      'http://s1:16801': { ok: true, json: async () => ({ ok: true, app: 'foxdown', aria2: true, aria2Version: '1.37', stream: true, ffmpeg: true }) },
      'http://fallback:16801': { ok: true, json: async () => ({ ok: true, app: 'rdown', aria2: true, aria2Version: '9.9', stream: false, ffmpeg: false }) },
    },
  });
  run(t, 'options.js');
  await new Promise(r => setTimeout(r, 30));
  // 列表为空 → 测单服务器字段
  t.byId.serverUrl.value = 'http://fallback:16801';
  await t.byId.test.dispatch('click');
  assert(t.byId.status.textContent.includes('9.9'), '无服务器列表 → 测 serverUrl 字段');
  // 列表第一项优先
  await t.byId.addServer.dispatch('click');
  const rows = t.body.querySelectorAll('#serverList .server-row');
  rows[0].querySelector('.srv-url').value = 'http://s1:16801';
  await t.byId.test.dispatch('click');
  assert(t.byId.status.textContent.includes('1.37') && t.byId.status.className === 'ok', '有服务器列表 → 优先测第一项');
  hitUrl = '';
  // 失败路径
  const t2 = makeSandbox({ page: 'options' });
  run(t2, 'options.js');
  await new Promise(r => setTimeout(r, 30));
  await t2.byId.test.dispatch('click');
  assert(t2.byId.status.className === 'err', '连接失败 → 状态条 err');
}

console.log('== options：导入配置 ==');
{
  const t = makeSandbox({ page: 'options' });
  run(t, 'options.js');
  await new Promise(r => setTimeout(r, 30));
  const cfg = JSON.stringify({ serverUrl: 'http://imported:16801', minSizeMB: 3, servers: [{ name: 'X', url: 'http://x:16801', token: '', pattern: '*' }], junkField: 'drop-me' });
  t.byId.importFile.files = [{ content: cfg }];
  await t.byId.importFile.dispatch('change', { target: t.byId.importFile });
  await new Promise(r => setTimeout(r, 30)); // 等 reader.onload 内的 load() 完成
  assert(t.local.serverUrl === 'http://imported:16801' && t.local.minSizeMB === 3, '导入：已知字段写入 storage');
  assert(!('junkField' in t.local), '导入：未知字段被丢弃');
  assert(t.byId.serverUrl.value === 'http://imported:16801', '导入后表单重刷');
}

console.log('== options：语言切换即时生效（i18n 集成） ==');
{
  const t = makeSandbox({ page: 'options' });
  run(t, 'options.js');
  await new Promise(r => setTimeout(r, 30));
  t.byId.locale.value = 'de';
  await t.byId.locale.dispatch('change', { target: t.byId.locale });
  assert(t.local.locale === 'de', '语言切换即存 storage.local');
  assert(t.sandbox.document.documentElement.lang === 'de' && t.sandbox.document.title === msg('de', 'optTitle'), '设置页 HTML lang 与标题同步切换');
  assert(t.byId.langLabelEl.textContent === msg('de', 'langLabel'), 'data-i18n 元素原地刷成德语文案');
  assert(t.byId.domainListPhEl.placeholder === msg('de', 'domainListPh'), 'data-i18n-ph 占位符刷成德语');
  t.byId.locale.value = 'ru-XX'; // 不支持值
  await t.byId.locale.dispatch('change', { target: t.byId.locale });
  assert(t.local.locale === 'ru-XX', '不支持语言值照存（用户显式选择）');
  assert(t.byId.langLabelEl.textContent === msg('en', 'langLabel'), '覆盖层解析不到 → 回退英语文案');
  assert(t.sandbox.document.documentElement.lang === 'en', '不支持语言时 HTML lang 同样回退英语');
}

console.log('== popup：格式化与默认服务器选择 ==');
{
  const t = makeSandbox({ page: 'popup' });
  run(t, 'popup.js');
  await new Promise(r => setTimeout(r, 30));
  const s = t.sandbox;
  assert(s.fmt(0) === '0 B/s' && s.fmt(150 * 1024) === '150 KB/s' && s.fmt(3 * 1024 * 1024).includes('MB/s'), 'fmt：0/KB/MB 速率格式化（≥100 取整）');
  assert(s.fmtSize(0) === '' && s.fmtSize(5 * 1024 * 1024).endsWith('MB'), 'fmtSize：空与 MB');
  assert(s.pickDefaultServer({ servers: [{ url: 'a', pattern: '*.site.com' }, { url: 'b', pattern: '*' }], serverUrl: 'x' }).url === 'b', 'pickDefaultServer：pattern=* 优先于具体规则');
  assert(s.pickDefaultServer({ servers: [{ url: 'a' }, { url: 'b' }], serverUrl: 'x' }).url === 'a', 'pickDefaultServer：无 * 取第一项');
  assert(s.pickDefaultServer({ servers: [], serverUrl: 'http://single:16801', apiToken: 'k' }).url === 'http://single:16801', 'pickDefaultServer：空列表回退单服务器字段');
  assert(s.extOf('https://x.com/path/video.MP4?x=1') === 'mp4' && s.extOf('https://x.com/a.m3u8') === 'm3u8' && s.extOf('not a url') === '', 'extOf：扩展名解析（大小写/无扩展）');
}

console.log('== popup：接管开关与统计渲染 ==');
{
  const t = makeSandbox({
    page: 'popup',
    fetchRoutes: {
      'http://127.0.0.1:16801/api/v1/stats': { ok: true, json: async () => ({ numActive: 3, numWaiting: 5, downloadSpeed: 250 * 1024, uploadSpeed: 0 }) },
    },
  });
  run(t, 'popup.js');
  await new Promise(r => setTimeout(r, 30));
  assert(t.byId.active.textContent === '3' && t.byId.waiting.textContent === '5', '统计：活动/等待数渲染');
  assert(t.byId.speed.textContent === '250 KB/s' && t.byId.upspeed.textContent === '0 B/s', '统计：速率格式化渲染');
  assert(t.byId.state.textContent.includes('127.0.0.1:16801'), '状态：已连接（含服务器地址）');
  t.byId.capture.checked = false;
  await t.byId.capture.dispatch('change', { target: t.byId.capture });
  assert(t.local.enabled === false, '接管开关 → storage.local.set');
  assert(t.sent.some(m => m.type === 'capture-toggled' && m.enabled === false), '接管开关 → 通知 background（capture-toggled）');
}

console.log('== popup：统计失败红字 ==');
{
  const t = makeSandbox({ page: 'popup' }); // fetch 抛错
  run(t, 'popup.js');
  await new Promise(r => setTimeout(r, 30));
  assert(t.byId.state.textContent.startsWith(msg('en', 'stateFailed').split('$1')[0]) && t.byId.state.textContent.includes('connect refused'), '后端未启动 → stateFailed 文案（en 兜底）');
  assert(t.byId.state.style.color === '#dc2626', '失败状态红字');
}

console.log('== popup：本页媒体列表 ==');
{
  const media = Array.from({ length: 25 }, (_, i) => ({ url: `https://x.com/v${i}.mp4`, filename: `v${i}.mp4`, type: 'VIDEO', size: 1024 * (i + 1) }));
  const t = makeSandbox({
    page: 'popup',
    messages: [media], // getSniffedMedia 响应
  });
  run(t, 'popup.js');
  await new Promise(r => setTimeout(r, 30));
  assert(t.body.querySelectorAll('.media-item').length === 25, '媒体列表：显示全部已捕获资源');
  const first = t.body.querySelectorAll('.media-item')[0];
  assert(first.querySelector('.mname').textContent === 'v24.mp4', '媒体列表：最新（v24）排最前');
  assert(first.querySelector('.msize').textContent.endsWith('KB'), '媒体列表：大小格式化');
  const dlBtn = first.querySelector('.mdl');
  t.msgQueue.push({ ok: true });
  await dlBtn.dispatch('click');
  assert(t.sent.some(m => m.type === 'downloadSniffed' && m.url === 'https://x.com/v24.mp4') && dlBtn.textContent === '✓', '下载按钮 → downloadSniffed 消息 + 成功态 ✓');
}

console.log('== popup：嗅探关闭时仍显示入口 ==');
{
  const t = makeSandbox({ page: 'popup', storage: { sniffEnabled: false } });
  run(t, 'popup.js');
  await new Promise(r => setTimeout(r, 30));
  assert(t.byId.mediaBox.style.display !== 'none' && t.byId.sniffCapture.checked === false &&
    t.byId.deepSearch.style.display === 'none', 'sniffEnabled=false → 保留资源入口并显示关闭状态');
}

console.log('== popup：默认嗅探入口与空状态 ==');
{
  const t = makeSandbox({ page: 'popup', messages: [[]] });
  run(t, 'popup.js');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert(t.byId.sniffCapture.checked === true && t.byId.mediaBox.style.display !== 'none', '新配置默认开启自动嗅探且资源入口可见');
  assert(t.byId.mediaEmpty.textContent === msg('en', 'sniffEmpty'), '未捕获资源时显示播放媒体或刷新网页的提示');
}

console.log('== popup：下载前确认模式 ==');
{
  const t = makeSandbox({
    page: 'popup',
    locationSearch: '?mode=confirm&token=tk1',
    messages: [
      { filename: 'movie.ts', referer: 'https://site.com/page', servers: [{ name: 'A机', url: 'http://a:16801' }, { url: 'http://b:16801' }], matchedIndex: 1 },
    ],
  });
  run(t, 'popup.js');
  await new Promise(r => setTimeout(r, 30));
  assert(t.body.classList.contains('confirm-mode'), '确认模式：body 加 confirm-mode 类');
  assert(t.byId.cfName.value === 'movie.ts' && t.byId.cfReferer.value === 'https://site.com/page', '确认模式：文件名/来源回填');
  assert(t.byId.cfServer.children.length === 2 && t.byId.cfServer.selectedIndex === 1, '确认模式：服务器下拉 2 项且预选 matchedIndex');
  t.msgQueue.push({ ok: true });
  t.byId.cfName.value = 'renamed.ts';
  t.byId.cfSplit.value = '8';
  await t.byId.cfStart.dispatch('click');
  const sent = t.sent.find(m => m.type === 'confirmDownload');
  assert(sent && sent.token === 'tk1' && sent.filename === 'renamed.ts' && sent.split === 8 && sent.serverIndex === 1, '开始下载 → confirmDownload（改名/分片/服务器序号）');
  assert(t.window.__closed === true, '确认成功 → 窗口关闭');
}

console.log('== popup：确认数据缺失 ==');
{
  const t = makeSandbox({
    page: 'popup',
    locationSearch: '?mode=confirm&token=bad',
    messages: [{ error: 'expired' }],
  });
  run(t, 'popup.js');
  await new Promise(r => setTimeout(r, 30));
  assert(t.byId.cfState.textContent === msg('en', 'confirmMissing') && t.byId.cfStart.disabled === true, 'token 失效 → confirmMissing + 开始按钮禁用');
}

console.log('== popup：语言变更事件重刷文案 ==');
{
  const t = makeSandbox({ page: 'popup', storage: { locale: 'ja' } });
  run(t, 'popup.js');
  await new Promise(r => setTimeout(r, 30));
  assert(t.byId.captureLabel.textContent === msg('ja', 'captureLabel'), '启动即按 storage 语言（ja）应用文案');
  await t.chrome.storage.local.set({ locale: 'ko' }); // 触发 onChanged
  await new Promise(r => setTimeout(r, 30));
  assert(t.byId.captureLabel.textContent === msg('ko', 'captureLabel'), 'storage.onChanged(locale) → popup 原地重刷韩语文案');
  assert(t.sandbox.document.documentElement.lang === 'ko', 'popup HTML lang 跟随即时切换');
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
