import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ARIA2_BIN, ARIA2_RPC_PORT, DATA_DIR } from '../config.js';

const SESSION_FILE = path.join(DATA_DIR, 'aria2.session');
const LOG_FILE = path.join(DATA_DIR, 'aria2.log');

/**
 * Manages the aria2c daemon process lifecycle (Motrix-style):
 * spawns it with a curated argument set derived from user settings,
 * restarts it on crash, and applies changed settings on restart.
 */
export class Aria2Engine extends EventEmitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.proc = null;
    this.lastError = null;
    this.stopping = false;
    this.restartTimer = null;
  }

  buildArgs(s = this.settings) {
    if (!fs.existsSync(SESSION_FILE)) fs.writeFileSync(SESSION_FILE, '');
    const args = [
      '--enable-rpc=true',
      `--rpc-listen-all=${s.rpcListenAll === true}`,
      `--rpc-listen-port=${s.rpcPort || ARIA2_RPC_PORT}`,
      `--rpc-secret=${s.rpcSecret}`,
      '--rpc-max-request-size=16M',
      // session persistence (crash recovery, Motrix-style)
      `--save-session=${SESSION_FILE}`,
      `--input-file=${SESSION_FILE}`,
      '--save-session-interval=20',
      // performance
      `--max-concurrent-downloads=${s.maxConcurrentDownloads}`,
      `--max-connection-per-server=${s.maxConnectionPerServer}`,
      `--split=${s.split}`,
      `--min-split-size=${s.minSplitSize}`,
      `--max-overall-download-limit=${s.maxOverallDownloadLimit}`,
      `--max-overall-upload-limit=${s.maxOverallUploadLimit}`,
      `--continue=${s.continueDownloads}`,
      `--file-allocation=${s.fileAllocation}`,
      `--disk-cache=${s.diskCache}`,
      `--user-agent=${s.userAgent}`,
      `--check-certificate=${s.checkCertificate !== false}`,
      `--ca-certificate=${path.join(DATA_DIR, 'cacert.pem')}`,
      '--allow-overwrite=false',
      '--auto-file-renaming=true',
      '--retry-wait=2',
      '--max-tries=0',
      '--connect-timeout=15',
      '--timeout=30',
      // bittorrent
      `--enable-dht=${s.enableDht}`,
      `--bt-enable-lpd=${s.btEnableLpd}`,
      `--bt-max-peers=${s.btMaxPeers}`,
      `--listen-port=${s.listenPort}`,
      `--seed-ratio=${s.seedRatio}`,
      `--seed-time=${s.seedTime}`,
      `--follow-torrent=${s.followTorrent}`,
      '--bt-save-metadata=true',
      '--bt-load-saved-metadata=true',
      '--bt-hash-check-seed=true',
      '--bt-require-crypto=false',
      `--enable-peer-exchange=${s.btEnablePex !== false}`,
      `--dir=${s.downloadDir}`,
      `--log=${LOG_FILE}`,
      '--log-level=warn',
      '--summary-interval=0',
      '--show-console-readout=false',
      '--quiet=true',
    ];
    if (s.btTracker) args.push(`--bt-tracker=${s.btTracker}`);
    // 代理（aria2 --all-proxy 系）
    if (s.proxyEnabled && s.proxyServer) {
      args.push(`--all-proxy=${s.proxyServer}`);
      if (s.proxyUser) args.push(`--all-proxy-user=${s.proxyUser}`);
      if (s.proxyPasswd) args.push(`--all-proxy-passwd=${s.proxyPasswd}`);
      if (s.noProxy) args.push(`--no-proxy=${s.noProxy}`);
    }
    return args;
  }

  start() {
    if (this.proc) return;
    this.stopping = false;
    const args = this.buildArgs();
    this.proc = spawn(ARIA2_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    this.proc.on('error', (err) => {
      this.lastError = err;
      this.emit('error', err);
    });
    let errBuf = '';
    this.proc.stderr.on('data', (d) => { errBuf += d; if (errBuf.length > 4096) errBuf = errBuf.slice(-4096); });
    this.proc.on('close', (code) => {
      this.proc = null;
      this.emit('exit', code);
      if (!this.stopping) {
        if (code && errBuf.trim()) this.lastError = new Error(errBuf.trim());
        this.restartTimer = setTimeout(() => this.start(), 1500);
      }
    });
    this.emit('start');
  }

  /** Restart with (possibly new) settings. */
  async restart(settings) {
    if (settings) this.settings = settings;
    await this.stop();
    this.start();
  }

  stop() {
    this.stopping = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    return new Promise((resolve) => {
      if (!this.proc) return resolve();
      const p = this.proc;
      const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 3000);
      p.once('close', () => { clearTimeout(t); resolve(); });
      try { p.kill(); } catch { resolve(); }
    });
  }
}
