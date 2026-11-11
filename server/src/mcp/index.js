import { ARIA2_BIN, FFMPEG_BIN, FFPROBE_BIN, NM3U8_BIN, DOWNLOAD_DIR, DATA_DIR, hasExternalStreamEngine } from '../config.js';
import { isStreamUrl } from '../util/helpers.js';

/**
 * MCP Server（Model Context Protocol），工具语义参考 Gopeed pkg/mcpserver/server.go：
 * Streamable HTTP、无状态、JSON 响应；9 大标准工具直接映射下载管理操作。
 * 端点：POST /mcp（JSON-RPC 2.0）
 */

const PROTOCOL_VERSION = '2025-03-26';

const SERVER_INFO = {
  name: 'foxdown',
  version: '0.0.1',
};

const INSTRUCTIONS = 'Foxdown is a download manager for HTTP/HTTPS, FTP/SFTP, BitTorrent, magnet and HLS/DASH streams. ' +
  'When the user asks to download a resource and provides a URL or URI, use create_task. ' +
  'Use resolve_task first when the user needs metadata or wants to select files/quality before creating the task. ' +
  'If the user has not provided a concrete URL or URI, ask for one instead of inventing it.';

function tool(name, description, properties, required = []) {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required },
  };
}

const TOOLS = [
  tool('resolve_task', 'Resolve a download URL or URI and return its resource metadata and files before creating a task.',
    { url: { type: 'string', description: 'Download URL (http/https/ftp/magnet/.torrent/m3u8/mpd)' } }, ['url']),
  tool('create_task', 'Create and start a task from a direct download request.',
    {
      url: { type: 'string', description: 'Download URL' },
      options: { type: 'object', description: 'Optional: {dir,out,referer,userAgent,headers,cookie,split,maxConnectionPerServer,selectFile,checksum}' },
      stream: { type: 'object', description: 'For m3u8/mpd: {select,key,liveRecordLimitMin,mux}' },
    }, ['url']),
  tool('list_tasks', 'List tasks, optionally filtering them by status.',
    { status: { type: 'string', description: 'all|active|waiting|stopped', enum: ['all', 'active', 'waiting', 'stopped'] } }),
  tool('get_task', 'Get the request, resource, options and current progress for one task.',
    { id: { type: 'string' } }, ['id']),
  tool('get_task_status', 'Get lightweight runtime status and per-file progress for one task.',
    { id: { type: 'string' } }, ['id']),
  tool('get_task_stats', 'Get protocol-specific statistics: HTTP connections or BitTorrent peers and seeding data.',
    { id: { type: 'string' } }, ['id']),
  tool('pause_task', 'Pause a task.', { id: { type: 'string' } }, ['id']),
  tool('continue_task', 'Continue a paused or failed task.', { id: { type: 'string' } }, ['id']),
  tool('delete_task', 'Delete a task, optionally deleting its downloaded files.',
    { id: { type: 'string' }, deleteFiles: { type: 'boolean', description: 'Also delete downloaded files from disk' } }, ['id']),
];

export class McpServer {
  /** @param {import('../api/server.js').ApiServer} api */
  constructor(api) {
    this.api = api;
  }

  async handle(req, res) {
    let msg;
    try { msg = req.body; } catch { msg = null; }
    res.setHeader('Content-Type', 'application/json');
    if (!msg || msg.jsonrpc !== '2.0') {
      return res.status(400).json({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid Request' } });
    }
    try {
      const result = await this._dispatch(msg);
      res.json({ jsonrpc: '2.0', id: msg.id, result });
    } catch (e) {
      res.json({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: String(e.message || e) } });
    }
  }

  async _dispatch(msg) {
    switch (msg.method) {
      case 'initialize':
        return {
          protocolVersion: msg.params?.protocolVersion || PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        };
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: TOOLS };
      case 'tools/call': {
        const name = msg.params?.name;
        const args = msg.params?.arguments || {};
        const fn = this['_t_' + name];
        if (!fn) throw new Error(`unknown tool: ${name}`);
        const data = await fn.call(this, args);
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 1) }], structuredContent: data };
      }
      default:
        // notifications/initialized 等通知：按 JSON-RPC 规范静默忽略
        if (typeof msg.id === 'undefined' || msg.id === null) return {};
        throw new Error(`unknown method: ${msg.method}`);
    }
  }

  // ---- 工具实现（复用 REST 同源逻辑） ----

  async _t_resolve_task({ url }) {
    if (!url) throw new Error('url required');
    const { probeUrl } = await import('../api/probe.js');
    return probeUrl(url, { stream: this.api.stream });
  }

  async _t_create_task(args) {
    const { url } = args;
    if (!url) throw new Error('url required');
    const b = { url, options: args.options || {}, stream: args.stream };
    if (args.options?.checksum) b.options.checksum = args.options.checksum;
    // 与 POST /api/v1/tasks 相同的路径
    const { createTaskFromBody } = await import('../tasks/create.js');
    return createTaskFromBody(this.api, b);
  }

  async _t_list_tasks({ status } = {}) {
    return { tasks: await this.api._listMergedTasks(status || 'all') };
  }

  async _t_get_task({ id }) {
    const t = await this.api._findTask(id);
    if (!t) throw new Error('task not found: ' + id);
    return t;
  }

  async _t_get_task_status({ id }) {
    const { engine } = await this.api._findEngine(id);
    if (engine === 'aria2') {
      const t = await this.api.rpc.tellStatus(id, ['gid', 'status', 'completedLength', 'totalLength', 'downloadSpeed', 'uploadSpeed', 'files']);
      return {
        id, status: t.status,
        completedLength: Number(t.completedLength || 0),
        totalLength: Number(t.totalLength || 0),
        downloadSpeed: Number(t.downloadSpeed || 0),
        files: (t.files || []).map(f => ({ path: f.path, completedLength: Number(f.completedLength || 0), length: Number(f.length || 0) })),
      };
    }
    const t = this.api.store.getStreamTask(id);
    if (!t) throw new Error('task not found: ' + id);
    return { id, status: t.status, progress: t.progress, downloadSpeed: t.downloadSpeed || 0 };
  }

  async _t_get_task_stats({ id }) {
    const { engine } = await this.api._findEngine(id);
    if (engine === 'aria2') {
      const t = await this.api.rpc.tellStatus(id, ['status', 'connections', 'numSeeders', 'uploadLength', 'downloadSpeed', 'uploadSpeed', 'infoHash', 'bittorrent']);
      const isBt = !!t.bittorrent;
      const out = {
        id, engine, protocol: isBt ? 'bittorrent' : 'http',
        connections: Number(t.connections || 0),
        numSeeders: Number(t.numSeeders || 0),
        uploadLength: Number(t.uploadLength || 0),
        downloadSpeed: Number(t.downloadSpeed || 0),
        uploadSpeed: Number(t.uploadSpeed || 0),
      };
      if (isBt) {
        out.infoHash = t.infoHash || '';
        out.peers = await this.api.rpc.getPeers(id).catch(() => []);
      }
      return out;
    }
    const t = this.api.store.getStreamTask(id);
    if (!t) throw new Error('task not found: ' + id);
    return {
      id, engine: 'stream', protocol: t.streamMeta?.format || 'hls',
      segments: { done: t.progress?.doneSegments || 0, total: t.progress?.totalSegments || 0 },
      downloadSpeed: t.downloadSpeed || 0,
    };
  }

  async _t_pause_task({ id }) {
    await this.api._actOnTask(id, 'pause');
    return { ok: true };
  }

  async _t_continue_task({ id }) {
    await this.api._actOnTask(id, 'resume');
    return { ok: true };
  }

  async _t_delete_task({ id, deleteFiles } = {}) {
    await this.api._actOnTask(id, 'delete', { deleteFiles: !!deleteFiles });
    return { ok: true };
  }
}

/** doctor 自检（语义参考 N_m3u8DL-RE doctor：版本/路径/可用性 + 目录可写） */
export async function runDoctor() {
  const execFileAsync = (await import('node:child_process')).execFile;
  const run = (bin, arg) => new Promise((resolve) => {
    execFileAsync(bin, [arg], { timeout: 10000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ ok: false, version: '', error: String(err.message || err).slice(0, 120) });
      const m = /(\d+\.\d+(?:\.\d+)?)/.exec(stdout);
      resolve({ ok: true, version: m ? m[1] : 'unknown' });
    });
  });
  const fs = await import('node:fs');
  const dirCheck = (p) => {
    try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; }
  };
  const [aria2, ffmpeg, ffprobe, nm3u8] = await Promise.all([
    run(ARIA2_BIN, '--version'),
    run(FFMPEG_BIN, '-version'),
    run(FFPROBE_BIN, '-version'),
    hasExternalStreamEngine() ? run(NM3U8_BIN, '--version') : Promise.resolve({ ok: false, version: '', error: 'not installed (optional)' }),
  ]);
  return {
    tools: [
      { name: 'aria2c', path: ARIA2_BIN, ...aria2 },
      { name: 'ffmpeg', path: FFMPEG_BIN, ...ffmpeg },
      { name: 'ffprobe', path: FFPROBE_BIN, ...ffprobe },
      { name: 'N_m3u8DL-RE', path: NM3U8_BIN, ...nm3u8, optional: true },
    ],
    dirs: [
      { path: DOWNLOAD_DIR, writable: dirCheck(DOWNLOAD_DIR), purpose: 'downloads' },
      { path: DATA_DIR, writable: dirCheck(DATA_DIR), purpose: 'data/sessions' },
    ],
    externalStreamEngine: hasExternalStreamEngine(),
  };
}
