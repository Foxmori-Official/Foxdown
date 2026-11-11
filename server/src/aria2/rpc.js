import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { ARIA2_RPC_PORT } from '../config.js';
import { sleep } from '../util/helpers.js';

/**
 * JSON-RPC over WebSocket client for aria2 (the interface Motrix/AriaNg use).
 * - auto reconnect with backoff
 * - request/response by id
 * - aria2 notifications -> 'notify' events (onDownloadStart/Complete/Stop/Error/Pause/BtComplete)
 */
export class Aria2Rpc extends EventEmitter {
  constructor(secret, port = ARIA2_RPC_PORT) {
    super();
    this.secret = secret;
    this.port = port;
    this.url = `ws://127.0.0.1:${port}/jsonrpc`;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
    this.connected = false;
    this.closed = false;
  }

  /** 端口或密钥变更后重连（先关旧连接再走正常重连流程） */
  async reconnect(secret, port) {
    this.secret = secret;
    this.port = port || this.port;
    this.url = `ws://127.0.0.1:${this.port}/jsonrpc`;
    try { this.ws?.close(); } catch {}
    // close 事件会触发 _reconnect；若旧连接已不存在则手动补一次
    setTimeout(() => { if (!this.ws && !this.closed) this.connect(); }, 50);
  }

  connect() {
    if (this.closed) return;
    const ws = new WebSocket(this.url, { handshakeTimeout: 5000 });
    this.ws = ws;
    ws.on('open', () => {
      this.connected = true;
      this.emit('connected');
    });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.method && msg.method.startsWith('aria2.on')) {
        this.emit('notify', msg.method.replace('aria2.', ''), msg.params?.[0] || {});
        return;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || 'aria2 rpc error'));
        else resolve(msg.result);
      }
    });
    ws.on('close', () => this._reconnect());
    ws.on('error', () => { /* close event follows */ });
  }

  async _reconnect() {
    if (this.connected) { this.connected = false; this.emit('disconnected'); }
    this.ws = null;
    for (const { reject } of this.pending.values()) reject(new Error('aria2 disconnected'));
    this.pending.clear();
    if (this.closed) return;
    await sleep(1000);
    this.connect();
  }

  async call(method, ...params) {
    if (!this.ws || !this.connected) throw new Error('aria2 not connected');
    const id = ++this.id;
    const token = `token:${this.secret}`;
    const payload = { jsonrpc: '2.0', id, method: `aria2.${method}`, params: [token, ...params] };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload), (err) => {
        if (err) { this.pending.delete(id); reject(err); }
      });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`rpc timeout: ${method}`)); }
      }, 30000);
    });
  }

  // ---- convenience wrappers ----
  addUri(uris, options = {}, position) {
    const p = [uris, options];
    if (position !== undefined) p.push(position);
    return this.call('addUri', ...p);
  }
  addTorrent(base64, uris = [], options = {}) { return this.call('addTorrent', base64, uris, options); }
  addMetalink(base64, options = {}) { return this.call('addMetalink', base64, options); }
  remove(gid) { return this.call('remove', gid); }
  forceRemove(gid) { return this.call('forceRemove', gid); }
  pause(gid) { return this.call('pause', gid); }
  forcePause(gid) { return this.call('forcePause', gid); }
  unpause(gid) { return this.call('unpause', gid); }
  pauseAll() { return this.call('pauseAll'); }
  unpauseAll() { return this.call('unpauseAll'); }
  tellStatus(gid, keys) { return keys ? this.call('tellStatus', gid, keys) : this.call('tellStatus', gid); }
  tellActive(keys) { return keys ? this.call('tellActive', keys) : this.call('tellActive'); }
  tellWaiting(offset = 0, num = 200, keys) { return keys ? this.call('tellWaiting', offset, num, keys) : this.call('tellWaiting', offset, num); }
  tellStopped(offset = 0, num = 200, keys) { return keys ? this.call('tellStopped', offset, num, keys) : this.call('tellStopped', offset, num); }
  getGlobalStat() { return this.call('getGlobalStat'); }
  getOption(gid) { return this.call('getOption', gid); }
  changeOption(gid, opts) { return this.call('changeOption', gid, opts); }
  getGlobalOption() { return this.call('getGlobalOption'); }
  changeGlobalOption(opts) { return this.call('changeGlobalOption', opts); }
  removeDownloadResult(gid) { return this.call('removeDownloadResult', gid); }
  purgeDownloadResult() { return this.call('purgeDownloadResult'); }
  getFiles(gid) { return this.call('getFiles', gid); }
  getPeers(gid) { return this.call('getPeers', gid); }
  changePosition(gid, pos, how = 'POS_CUR') { return this.call('changePosition', gid, pos, how); }
  getVersion() { return this.call('getVersion'); }
  saveSession() { return this.call('saveSession'); }
  shutdown() { return this.call('shutdown'); }

  close() {
    this.closed = true;
    try { this.ws?.close(); } catch {}
  }
}
