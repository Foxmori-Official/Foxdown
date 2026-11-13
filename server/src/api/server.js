import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { isIP } from 'node:net';
import express from 'express';
import { WebSocketServer } from 'ws';
import { API_PORT, API_HOST, WEB_DIST, loadSettings, saveSettings, hasFfmpeg, hasExternalStreamEngine } from '../config.js';
import { isMagnet, isTorrentUrl, isStreamUrl, guessFilename, sanitizeFilename } from '../util/helpers.js';
import { probeUrl } from './probe.js';

const ARIA2_KEYS = [
  'gid', 'status', 'totalLength', 'completedLength', 'uploadLength', 'downloadSpeed',
  'uploadSpeed', 'connections', 'dir', 'files', 'bittorrent', 'infoHash', 'errorCode',
  'errorMessage', 'followedBy', 'following', 'belongsTo', 'numSeeders', 'seeder',
];

function isLoopbackRequest(req) {
  const host = req.headers.host?.match(/^(\[::1\]|localhost\.?|127(?:\.\d{1,3}){3})(?::\d+)?$/i)?.[1];
  const peer = req.socket.remoteAddress?.replace(/^::ffff:/, '');
  const loopbackV4 = address => address?.startsWith('127.') && isIP(address) === 4;
  return (host === '[::1]' || /^localhost\.?$/i.test(host || '') || loopbackV4(host)) &&
    (peer === '::1' || loopbackV4(peer));
}

function isSameOrigin(req) {
  const { host, origin } = req.headers;
  // A reverse proxy may terminate TLS, but must preserve the public Host.
  return Boolean(host && (origin === `http://${host}` || origin === `https://${host}`));
}

function allowsBrowserRequest(req) {
  const { origin } = req.headers;
  if (!origin) return req.headers['sec-fetch-site'] !== 'cross-site';
  return isSameOrigin(req) || /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

function isAuthorized(req, token, queryToken) {
  if (!token) return isLoopbackRequest(req);
  return (req.headers.authorization?.replace(/^Bearer /i, '') || queryToken) === token;
}

function mapAria2Task(t, meta = {}) {
  let name = t.bittorrent?.info?.name || '';
  if (!name && t.files?.length) {
    const p = t.files[0].path;
    if (p) name = path.basename(p);
    else name = meta.name || guessFilename(t.files[0].uris?.[0]?.uri);
  }
  if (!name) name = meta.name || t.gid;
  const isBt = !!t.bittorrent;
  return {
    id: t.gid,
    engine: 'aria2',
    kind: isBt ? 'torrent' : (meta.kind || 'file'),
    name,
    status: t.status, // active|waiting|paused|error|complete|removed
    totalLength: Number(t.totalLength || 0),
    completedLength: Number(t.completedLength || 0),
    uploadLength: Number(t.uploadLength || 0),
    downloadSpeed: Number(t.downloadSpeed || 0),
    uploadSpeed: Number(t.uploadSpeed || 0),
    connections: Number(t.connections || 0),
    numSeeders: Number(t.numSeeders || 0),
    dir: t.dir,
    infoHash: t.infoHash || '',
    errorCode: t.errorCode,
    errorMessage: t.errorMessage,
    files: (t.files || []).map(f => ({
      index: Number(f.index),
      path: f.path,
      length: Number(f.length || 0),
      completedLength: Number(f.completedLength || 0),
      selected: f.selected === 'true',
    })),
    createdAt: meta.createdAt,
  };
}

export class ApiServer {
  /**
   * @param {object} deps
   * @param {import('../aria2/engine.js').Aria2Engine} deps.engine
   * @param {import('../aria2/rpc.js').Aria2Rpc} deps.rpc
   * @param {import('../tasks/store.js').TaskStore} deps.store
   * @param {import('../stream/index.js').StreamManager} deps.stream
   * @param {import('../upnp/index.js').UpnpManager} [deps.upnp]
   * @param {object} deps.settings
   */
  constructor({ engine, rpc, store, stream, settings, upnp, scheduler, hooks, speedHistory }) {
    this.engine = engine;
    this.rpc = rpc;
    this.store = store;
    this.stream = stream;
    this.settings = settings;
    this.upnp = upnp;
    this.scheduler = scheduler;
    this.hooks = hooks;
    this.speedHistory = speedHistory;
    this.app = express();
    this._setupMiddleware();
    this.app.use(express.json({ limit: '64mb' }));
    this.app.use(express.text({ type: ['text/plain'], limit: '8mb' }));
    this._setupRoutes();
  }

  _auth(req, res, next) {
    if (isAuthorized(req, this.settings.apiToken, req.query.token)) return next();
    res.status(401).json({ error: 'unauthorized' });
  }

  _setupMiddleware() {
    this.app.use(['/api', '/mcp'], (req, res, next) => {
      res.vary('Origin');
      if (!allowsBrowserRequest(req)) return res.status(403).json({ error: 'forbidden origin' });
      if (req.headers.origin) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });
    this.app.use('/api', (req, res, next) => {
      // The demo is a fixed, public fixture. Browser downloads do not carry an API token.
      if (req.method === 'GET' && req.path === '/v1/demo-file') return next();
      return this._auth(req, res, next);
    });
    this.app.use('/mcp', (req, res, next) => this._auth(req, res, next));
  }

  async _listAria2Tasks() {
    const [active, waiting, stopped] = await Promise.all([
      this.rpc.tellActive(ARIA2_KEYS).catch(() => []),
      this.rpc.tellWaiting(0, 500, ARIA2_KEYS).catch(() => []),
      this.rpc.tellStopped(0, 500, ARIA2_KEYS).catch(() => []),
    ]);
    const all = [...active, ...waiting, ...stopped];
    return all.map(t => mapAria2Task(t, this.store.getMeta(t.gid)));
  }

  /** 合并任务列表（REST 与 MCP 共用）；search 按名称/URL 关键词过滤 */
  async _listMergedTasks(status = 'all', search = '') {
    const [aria2Tasks, streamTasks] = await Promise.all([
      this._listAria2Tasks(),
      Promise.resolve(this.stream.listTasks()),
    ]);
    let all = [...aria2Tasks, ...streamTasks];
    if (status !== 'all') {
      const map = {
        active: ['active', 'downloading', 'muxing'],
        waiting: ['waiting'],
        stopped: ['paused', 'error', 'complete', 'removed', 'cancelled'],
      };
      const set = map[status];
      if (set) all = all.filter(t => set.includes(t.status));
    }
    if (search) {
      const q = String(search).toLowerCase();
      all = all.filter(t => (t.name || '').toLowerCase().includes(q) || (t.dir || '').toLowerCase().includes(q));
    }
    return all;
  }

  async _clearCompletedTasks() {
    const completed = new Set();
    const pageSize = 200;
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.rpc.tellStopped(offset, pageSize, ['gid', 'status']);
      for (const task of page) if (task.status === 'complete') completed.add(task.gid);
      if (page.length < pageSize) break;
    }
    let removed = 0;
    let failed = 0;
    for (const id of completed) {
      try {
        await this.rpc.removeDownloadResult(id);
        this.store.removeMeta(id);
        removed++;
      } catch { failed++; }
    }
    for (const task of this.store.listStreamTasks().filter(task => task.status === 'complete')) {
      this.store.removeStreamTask(task.id);
      this.store.removeMeta(task.id);
      removed++;
    }
    return { removed, failed };
  }

  /** 按 id 找任务（先 aria2 后 stream），返回 {engine, task} 或 null */
  async _findTask(id) {
    const { engine } = await this._findEngine(id);
    if (engine === 'aria2') {
      const t = await this.rpc.tellStatus(id);
      return { engine, task: mapAria2Task(t, this.store.getMeta(id)) };
    }
    const t = this.stream.getTask(id);
    return t ? { engine: 'stream', task: t } : null;
  }

  async _findEngine(id) {
    // stream 任务 id 在本地 store；其余视为 aria2 gid
    if (this.store.getStreamTask(id)) return { engine: 'stream' };
    return { engine: 'aria2' };
  }

  /** 统一任务操作（REST action 路由与 MCP 工具共用） */
  async _actOnTask(id, action, { deleteFiles } = {}) {
    const { engine } = await this._findEngine(id);
    if (engine === 'aria2') {
      switch (action) {
        case 'pause': await this.rpc.pause(id); break;
        case 'resume': await this.rpc.unpause(id); break;
        case 'retry': {
          const t = await this.rpc.tellStatus(id);
          const uris = t.files?.[0]?.uris?.map(u => u.uri) || [];
          const meta = this.store.getMeta(id);
          const opt = await this.rpc.getOption(id);
          delete opt.gid;
          delete opt.pause;
          if (t.dir) opt.dir = t.dir;
          if (meta?.kind === 'file' && t.files?.[0]?.path) {
            opt.out = path.basename(t.files[0].path);
            opt.continue = 'false';
          }
          if (typeof opt.header === 'string') opt.header = opt.header.split(/\r?\n/).filter(Boolean);
          const gid = await this.rpc.addUri(uris, opt);
          await this.rpc.removeDownloadResult(id).catch(() => {});
          this.store.removeMeta(id);
          this.store.setMeta(gid, { ...meta, createdAt: Date.now() });
          return { id: gid };
        }
        case 'delete': {
          const t = await this.rpc.tellStatus(id).catch(() => null);
          if (t && ['active', 'waiting', 'paused'].includes(t.status)) {
            await this.rpc.remove(id).catch(() => this.rpc.forceRemove(id));
          }
          await this.rpc.removeDownloadResult(id).catch(() => {});
          this.store.removeMeta(id);
          if (deleteFiles && t?.files) {
            for (const f of t.files) {
              if (f.path) { try { fs.unlinkSync(f.path); } catch {} try { fs.unlinkSync(f.path + '.aria2'); } catch {} }
            }
          }
          break;
        }
        default: throw new Error('unknown action: ' + action);
      }
      return { ok: true };
    }
    switch (action) {
      case 'pause': await this.stream.pause(id); break;
      case 'resume': await this.stream.resume(id); break;
      case 'delete': await this.stream.cancel(id, { deleteFiles }); break;
      case 'retry': await this.stream.resume(id, { restart: true }); break;
      default: throw new Error('unknown action: ' + action);
    }
    return { ok: true };
  }

  _setupRoutes() {
    const r = this.app;

    // ---- 首次引导演示页与演示文件（供扩展 onboarding 第 3 步的真实接管链路演示） ----
    r.get('/demo.html', (req, res) => {
      res.type('html').send(`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Foxdown 接管演示</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
         display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #faf9f4; }
  .card { background: #fffefa; border: 1px solid #e0e3d6; border-radius: 10px; padding: 40px 48px; text-align: center; max-width: 460px; box-shadow: 0 1px 2px rgba(15,23,42,.04); }
  h1 { font-size: 20px; margin: 0 0 8px; color: #293d33; }
  p { font-size: 14px; color: #596957; line-height: 1.7; margin: 0 0 24px; }
  a.btn { display: inline-block; background: #2e5943; color: #fffefa; text-decoration: none; font-size: 15px; font-weight: 500; padding: 12px 28px; border-radius: 6px; }
  a.btn:hover { background: #42644c; }
  .tip { font-size: 12px; color: #596957; margin-top: 16px; margin-bottom: 0; }
  @media (prefers-color-scheme: dark) {
    body { background: #1c291f; }
    .card { background: #26342a; border-color: #414f3b; }
    h1 { color: #eeeddf; } p { color: #b0b9a3; } .tip { color: #b0b9a3; }
    a.btn { background: #42644c; } a.btn:hover { background: #a1b88b; }
  }
</style></head>
<body>
  <div class="card">
    <h1>Foxdown 接管演示</h1>
    <p>点击下方按钮开始下载。如果 Foxdown 扩展的"接管浏览器下载"已开启，<br>这个下载会被自动接管并出现在下载管理器中。</p>
    <a class="btn" href="/api/v1/demo-file" download>⬇ 下载演示文件（128 KB）</a>
    <p class="tip">文件由本地服务即时生成，内容随机，仅用于演示。</p>
  </div>
</body></html>`);
    });

    r.get('/api/v1/demo-file', (req, res) => {
      // 128KB 确定性伪随机内容（可重复校验），仅用于演示接管
      const size = 128 * 1024;
      const buf = Buffer.alloc(size);
      let x = 0x2f6e2b1;
      for (let i = 0; i < size; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; buf[i] = x & 0xff; }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment; filename="Foxdown-demo-file.bin"');
      res.setHeader('Content-Length', String(size));
      res.end(buf);
    });

    r.get('/api/v1/health', async (req, res) => {
      let aria2 = false, version = '';
      try { const v = await this.rpc.getVersion(); aria2 = true; version = v.version; } catch {}
      res.json({
        ok: true, app: 'foxdown', aria2, aria2Version: version,
        stream: true, ffmpeg: hasFfmpeg(), externalStreamEngine: hasExternalStreamEngine(),
      });
    });

    // ---- resolve (Gopeed-style two-step) ----
    r.post('/api/v1/resolve', async (req, res) => {
      try {
        const { url, headers } = req.body || {};
        if (!url) return res.status(400).json({ error: 'url required' });
        const info = await probeUrl(url, { headers, stream: this.stream });
        res.json(info);
      } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ---- create task ----
    r.post('/api/v1/tasks', async (req, res) => {
      try {
        const { createTaskFromBody } = await import('../tasks/create.js');
        const out = await createTaskFromBody(this, req.body || {});
        res.json(out);
      } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ---- list tasks (merged aria2 + stream) ----
    r.get('/api/v1/tasks', async (req, res) => {
      try {
        const status = req.query.status || 'all';
        const search = req.query.search || '';
        res.json({ tasks: await this._listMergedTasks(status, search) });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ---- task priority（aria2 changePosition） ----
    r.post('/api/v1/tasks/:engine/:id/priority', async (req, res) => {
      try {
        const { id } = req.params;
        const { direction } = req.body || {};
        const { engine } = await this._findEngine(id);
        if (engine === 'stream') {
          // 流任务无队列优先级概念，前端应隐藏该操作
          return res.status(400).json({ error: 'stream tasks do not support priority' });
        }
        // aria2 changePosition: POS_SET 绝对定位（0=队首）
        const queue = await this.rpc.tellWaiting(0, 100, ['gid']);
        const idx = queue.findIndex(t => t.gid === id);
        if (idx < 0) return res.json({ ok: true, note: 'not in waiting queue' });
        let target = idx;
        if (direction === 'top') target = 0;
        else if (direction === 'bottom') target = queue.length - 1;
        else if (direction === 'up') target = Math.max(0, idx - 1);
        else if (direction === 'down') target = Math.min(queue.length - 1, idx + 1);
        if (target !== idx) await this.rpc.changePosition(id, target, 'POS_SET');
        res.json({ ok: true, position: target });
      } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ---- 限速预设（Motrix 多档方案） ----
    r.post('/api/v1/speed-profiles/apply', async (req, res) => {
      try {
        const { index } = req.body || {};
        const profiles = this.settings.speedProfiles || [];
        if (index < 0 || index >= profiles.length) throw new Error('profile index out of range');
        const p = profiles[index];
        await this.rpc.changeGlobalOption({
          'max-overall-download-limit': String(p.down || 0),
          'max-overall-upload-limit': String(p.up || 0),
        });
        this.settings.activeSpeedProfile = index;
        const { saveSettings } = await import('../config.js');
        saveSettings(this.settings);
        res.json({ ok: true, profile: p });
      } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ---- 数据看板 ----
    r.get('/api/v1/dashboard', (req, res) => {
      res.json(this.speedHistory ? this.speedHistory.snapshot() : { history: [], totals: {} });
    });

    r.get('/api/v1/tasks/:engine/:id', async (req, res) => {
      try {
        const { engine, id } = req.params;
        if (engine === 'aria2') {
          const t = await this.rpc.tellStatus(id);
          return res.json(mapAria2Task(t, this.store.getMeta(id)));
        }
        const t = this.stream.getTask(id);
        if (!t) return res.status(404).json({ error: 'not found' });
        res.json(t);
      } catch (e) { res.status(404).json({ error: e.message }); }
    });

    // ---- task control ----
    r.post('/api/v1/tasks/:engine/:id/action', async (req, res) => {
      const { engine, id } = req.params;
      const { action, deleteFiles } = req.body || {};
      try {
        // engine 参数保留在路由中以兼容前端；实际引擎探测以任务归属为准
        const out = await this._actOnTask(id, action, { deleteFiles });
        res.json(out);
      } catch (e) { res.status(400).json({ error: e.message }); }
    });

    r.post('/api/v1/tasks/pause-all', async (req, res) => {
      try { await this.rpc.pauseAll(); await this.stream.pauseAll(); res.json({ ok: true }); }
      catch (e) { res.status(400).json({ error: e.message }); }
    });
    r.post('/api/v1/tasks/resume-all', async (req, res) => {
      try { await this.rpc.unpauseAll(); await this.stream.resumeAll(); res.json({ ok: true }); }
      catch (e) { res.status(400).json({ error: e.message }); }
    });
    r.post('/api/v1/tasks/clear-completed', async (req, res) => {
      try {
        res.json(await this._clearCompletedTasks());
        this.pushState().catch(() => {});
      } catch (e) { res.status(503).json({ error: e.message }); }
    });

    // ---- stats ----
    r.get('/api/v1/stats', async (req, res) => {
      try {
        const s = await this.rpc.getGlobalStat();
        const ss = this.stream.globalStats();
        res.json({
          downloadSpeed: Number(s.downloadSpeed || 0) + ss.downloadSpeed,
          uploadSpeed: Number(s.uploadSpeed || 0),
          numActive: Number(s.numActive || 0) + ss.numActive,
          numWaiting: Number(s.numWaiting || 0),
          numStopped: Number(s.numStopped || 0),
        });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ---- settings ----
    r.get('/api/v1/settings', (req, res) => {
      // rpcSecret 一并返回：本接口仅监听 127.0.0.1 或已由 apiToken 鉴权，
      // 且外部工具（AriaNG 等）需要该密钥才能接入 RPC
      res.json(this.settings);
    });

    // ---- 重新生成 RPC 密钥（同时重启引擎并重连 RPC 客户端） ----
    r.post('/api/v1/settings/regenerate-secret', async (req, res) => {
      try {
        const crypto = await import('node:crypto');
        this.settings.rpcSecret = crypto.randomBytes(16).toString('hex');
        saveSettings(this.settings);
        await this.engine.restart(this.settings);
        await this.rpc.reconnect(this.settings.rpcSecret, this.settings.rpcPort);
        res.json({ ok: true, rpcSecret: this.settings.rpcSecret });
      } catch (e) { res.status(400).json({ error: e.message }); }
    });

    r.put('/api/v1/settings', async (req, res) => {
      try {
        const patch = req.body || {};
        if (Object.hasOwn(patch, 'postScript') && patch.postScript !== this.settings.postScript) {
          const bearer = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
          if (!isSameOrigin(req) && !(bearer && bearer === this.settings.apiToken)) {
            return res.status(403).json({ error: 'changing postScript requires the Web UI or a Bearer token' });
          }
          if (typeof patch.postScript !== 'string') return res.status(400).json({ error: 'postScript must be a string' });
        }
        const restartNeeded = [
          'maxConcurrentDownloads', 'maxConnectionPerServer', 'split', 'minSplitSize',
          'maxOverallDownloadLimit', 'maxOverallUploadLimit', 'continueDownloads',
          'fileAllocation', 'diskCache', 'userAgent', 'enableDht', 'btEnableLpd',
          'btMaxPeers', 'btTracker', 'seedRatio', 'seedTime', 'listenPort', 'downloadDir', 'btEnablePex',
          'proxyEnabled', 'proxyServer', 'proxyUser', 'proxyPasswd', 'noProxy', 'checkCertificate',
          'rpcPort', 'rpcListenAll',
        ];
        const rpcChanged = patch.rpcPort !== undefined || patch.rpcListenAll !== undefined;
        const needRestart = Object.keys(patch).some(k => restartNeeded.includes(k));
        const previousToken = this.settings.apiToken;
        Object.assign(this.settings, patch);
        if (previousToken !== this.settings.apiToken) {
          // Existing sockets were authorized with the previous credential.
          for (const client of this.wss?.clients || []) client.close(1008, 'Authentication changed');
        }
        saveSettings(this.settings);
        if (needRestart) await this.engine.restart(this.settings);
        if (rpcChanged) {
          await this.rpc.reconnect(this.settings.rpcSecret, this.settings.rpcPort).catch(() => {});
        }
        if (this.upnp && (patch.upnpEnabled !== undefined || patch.listenPort !== undefined)) {
          this.upnp.apply(this.settings).catch(() => {});
        }
        res.json({ ok: true, restarted: needRestart });
      } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ---- tracker auto update (Motrix feature) ----
    r.post('/api/v1/trackers/update', async (req, res) => {
      try {
        const { fetchTrackerList } = await import('../util/trackers.js');
        const { source, trackers, count } = await fetchTrackerList(this.settings.btTrackerSource);
        this.settings.btTracker = trackers;
        saveSettings(this.settings);
        await this.rpc.changeGlobalOption({ 'bt-tracker': trackers }).catch(async () => {
          await this.engine.restart(this.settings);
        });
        res.json({ ok: true, count, source });
      } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ---- 后处理 Webhook 测试（发送测试请求按钮） ----
    r.post('/api/v1/hooks/test', async (req, res) => {
      try {
        const url = this.settings.webhookUrl || req.body?.url;
        if (!url) return res.status(400).json({ error: 'webhookUrl not configured' });
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'test', task: { id: 'test', name: 'Foxdown 测试任务', status: 'complete' }, message: 'Foxdown webhook test' }),
          signal: AbortSignal.timeout(10000),
        });
        res.json({ ok: resp.ok, status: resp.status });
      } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // ---- MCP（Model Context Protocol）端点：POST /mcp ----
    r.post('/mcp', async (req, res) => {
      try {
        if (!this.mcp) this.mcp = new (await import('../mcp/index.js')).McpServer(this);
        await this.mcp.handle(req, res);
      } catch (e) { res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: e.message } }); }
    });
    r.get('/mcp', (req, res) => res.status(405).json({ error: 'MCP endpoint requires POST (JSON-RPC 2.0)' }));

    // ---- 环境自检 doctor（语义参考 N_m3u8DL-RE） ----
    r.get('/api/v1/doctor', async (req, res) => {
      try {
        const { runDoctor } = await import('../mcp/index.js');
        res.json(await runDoctor());
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ---- open folder (used by desktop shell / dev) ----
    r.post('/api/v1/reveal', async (req, res) => {
      const { path: p } = req.body || {};
      if (typeof p !== 'string' || !p.trim()) return res.status(400).json({ error: 'path required' });
      try {
        const { spawn } = await import('node:child_process');
        const target = path.resolve(p);
        const folder = (await fs.promises.stat(target)).isDirectory() ? target : path.dirname(target);
        const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        await new Promise((resolve, reject) => {
          const child = spawn(command, [folder], { detached: true, stdio: 'ignore', windowsHide: true });
          child.once('error', reject);
          child.once('spawn', () => { child.unref(); resolve(); });
        });
        res.json({ ok: true });
      } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // static web ui
    if (fs.existsSync(WEB_DIST)) {
      this.app.use(express.static(WEB_DIST));
      this.app.get(/^\/(?!api|ws).*/, (req, res) => res.sendFile(path.join(WEB_DIST, 'index.html')));
    }
  }

  /** Periodic merged-state push for the UI. */
  startEventPush(server) {
    const wss = new WebSocketServer({
      server, path: '/ws',
      verifyClient: (info, done) => {
        try {
          if (!allowsBrowserRequest(info.req)) return done(false, 403, 'Forbidden origin');
          const url = new URL(info.req.url, 'http://localhost');
          done(isAuthorized(info.req, this.settings.apiToken, url.searchParams.get('token')), 401, 'Unauthorized');
        } catch { done(false, 400, 'Bad request'); }
      },
    });
    this.wss = wss;
    const broadcast = (obj) => {
      const s = JSON.stringify(obj);
      for (const c of wss.clients) if (c.readyState === 1) c.send(s);
    };
    this.broadcast = broadcast;
    wss.on('connection', () => { this.pushState().catch(() => {}); });
    // Unregister only our own listeners when this HTTP server is closed.
    const subscriptions = [];
    const on = (emitter, event, listener) => {
      emitter.on(event, listener);
      subscriptions.push([emitter, event, listener]);
    };
    server.once('close', () => {
      clearInterval(this._poll);
      for (const [emitter, event, listener] of subscriptions) emitter.removeListener(event, listener);
      wss.close();
    });

    // aria2 notifications -> instant events + 后处理钩子
    on(this.rpc, 'notify', (method, params) => {
      broadcast({ type: 'event', name: method, gid: params.gid });
      if (method === 'onDownloadComplete' || method === 'onDownloadError' || method === 'onDownloadStop') {
        this.pushState().catch(() => {});
        if (method !== 'onDownloadStop' && this.hooks) {
          this._findTask(params.gid).then(({ task }) => {
            this.hooks.fire(method === 'onDownloadComplete' ? 'complete' : 'error', task).catch(() => {});
          }).catch(() => {});
        }
      }
    });
    // stream engine events
    on(this.stream, 'progress', () => this._throttledPush());
    on(this.stream, 'done', (t) => {
      this.pushState().catch(() => {});
      if (this.hooks && t) this.hooks.fire('complete', t).catch(() => {});
    });
    on(this.stream, 'error', (t) => {
      this.pushState().catch(() => {});
      if (this.hooks && t) this.hooks.fire('error', t).catch(() => {});
    });

    // 1s polling: 速度采样（看板数据源，无客户端也记录）+ 状态推送
    this._poll = setInterval(async () => {
      if (this._polling) return;
      this._polling = true;
      try {
        const gs = await this.rpc.getGlobalStat();
        const ss = this.stream.globalStats();
        if (gs && this.speedHistory) {
          this.speedHistory.sample(Number(gs.downloadSpeed || 0) + ss.downloadSpeed, Number(gs.uploadSpeed || 0));
        }
        if (this.speedHistory || wss.clients.size) {
          const all = await this._listMergedTasks('all');
          this.speedHistory?.accumulate(all);
          if (wss.clients.size) await this.pushState(all, gs);
        }
      } catch {}
      finally { this._polling = false; }
    }, 1000);
  }

  _throttledPush() {
    const now = Date.now();
    if (!this._lastPush || now - this._lastPush > 800) {
      this._lastPush = now;
      this.pushState().catch(() => {});
    }
  }

  async pushState(snapshot = null, globalStats = null) {
    if (!this.wss || this.wss.clients.size === 0 || this._pushing) return;
    this._pushing = true;
    try {
      const [aria2Tasks, stats] = await Promise.all([
        snapshot ? Promise.resolve(snapshot.filter(t => t.engine !== 'stream')) : this._listAria2Tasks(),
        globalStats ? Promise.resolve(globalStats) : this.rpc.getGlobalStat().catch(() => null),
      ]);
      const ss = this.stream.globalStats();
      this.broadcast({
        type: 'state',
        tasks: [...aria2Tasks, ...this.stream.listTasks()],
        stats: stats ? {
          downloadSpeed: Number(stats.downloadSpeed || 0) + ss.downloadSpeed,
          uploadSpeed: Number(stats.uploadSpeed || 0),
          numActive: Number(stats.numActive || 0) + ss.numActive,
          numWaiting: Number(stats.numWaiting || 0),
          numStopped: Number(stats.numStopped || 0),
        } : null,
      });
    } finally { this._pushing = false; }
  }

  listen() {
    return new Promise((resolve, reject) => {
      const server = http.createServer(this.app);
      server.once('error', reject);
      server.listen(API_PORT, API_HOST, () => {
        server.removeListener('error', reject);
        this.startEventPush(server);
        console.log(`[api] http://${API_HOST}:${API_PORT}`);
        resolve(server);
      });
    });
  }
}
