/**
 * NativeStreamEngine: built-in HLS/DASH download pipeline.
 *
 *  - master playlist variant selection (best | worst | id | WxH | bandwidth)
 *  - concurrent segment downloads with per-segment retries + timeout
 *  - AES-128-CBC decryption (EXT-X-KEY), EXT-X-BYTERANGE, EXT-X-MAP init
 *  - live playlists: refresh by targetDuration, dedupe by media sequence,
 *    optional recording time limit (task.options.liveRecordLimitMin)
 *  - resume via manifest.json in the task tmp dir (<DATA_DIR>/.kimi-stream/<id>)
 *  - merge -> ffmpeg remux (MP4/MKV) or raw binary concat fallback
 *
 * Events: 'progress' (task), 'done' (task), 'error' (task)
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, hasFfmpeg } from '../config.js';
import { probeStream } from './probe-native.js';
import { filterVariants, filterAdSegments, parseCustomRange } from './selector.js';
import { buildSaveName } from '../util/naming.js';
import { parseMaster, parseMedia, isMasterPlaylist } from './hls.js';
import { parseMpd } from './dash.js';
import { remuxToMp4, muxTracks, concatFiles } from './mux.js';
import { sanitizeFilename } from '../util/helpers.js';

const TMP_ROOT = path.join(DATA_DIR, '.kimi-stream');
const PAUSE = Symbol('pause');
const CANCEL = Symbol('cancel');
const SPEED_WINDOW_MS = 5000;
const EMIT_INTERVAL_MS = 500;

export class NativeStreamEngine extends EventEmitter {
  constructor(store, settings) {
    super();
    this.store = store;
    this.settings = settings;
    this.runs = new Map(); // id -> ctx
  }

  /* ------------------------------------------------ public API ------- */

  probe(url, headers) { return probeStream(url, headers); }

  async start(task) {
    const existing = this.runs.get(task.id);
    if (existing) {
      await existing.settled.catch(() => {});
      const t0 = this.store.getStreamTask(task.id);
      // a finished task must not restart itself; paused/waiting ones may
      if (t0 && !['paused', 'waiting'].includes(t0.status)) return;
    }
    const ctx = this._mkCtx(task);
    const run = this._execute(task, ctx);
    ctx.settled = run;
    this.runs.set(task.id, ctx);
    await run;
  }

  async _execute(task, ctx) {
    try {
      await this._run(task, ctx);
    } catch (err) {
      if (err === PAUSE || err === CANCEL) return;
      const t = this.store.getStreamTask(task.id);
      if (!t || ['paused', 'cancelled'].includes(t.status)) return;
      this.store.updateStreamTask(task.id, {
        status: 'error',
        errorMessage: err.message || String(err),
        downloadSpeed: 0,
      });
      this.emit('error', this.store.getStreamTask(task.id));
    } finally {
      this.runs.delete(task.id);
      clearInterval(ctx.emitTimer);
    }
  }

  async pause(task) {
    const ctx = this.runs.get(task.id);
    if (ctx) {
      ctx.paused = true;
      ctx.abort.abort();
    }
    const t = this.store.getStreamTask(task.id);
    if (t && !['complete', 'cancelled', 'error'].includes(t.status)) {
      this.store.updateStreamTask(task.id, { status: 'paused', downloadSpeed: 0 });
      this.emit('progress', this.store.getStreamTask(task.id));
    }
  }

  async resume(task, { restart } = {}) {
    if (restart) {
      await fs.promises.rm(this._dir(task.id), { recursive: true, force: true }).catch(() => {});
      this.store.updateStreamTask(task.id, {
        status: 'waiting',
        progress: { totalSegments: 0, doneSegments: 0, bytesDownloaded: 0, speed: 0, eta: 0, live: false },
        totalLength: 0, completedLength: 0, downloadSpeed: 0, outputFiles: [], errorMessage: '',
      });
    } else if (!this.runs.has(task.id)) {
      this.store.updateStreamTask(task.id, { status: 'waiting', downloadSpeed: 0 });
    }
    return this.start(task);
  }

  async cancel(task, { deleteFiles } = {}) {
    const ctx = this.runs.get(task.id);
    if (ctx) { ctx.cancelled = true; ctx.abort.abort(); }
    if (deleteFiles) {
      for (const f of task.outputFiles || []) { try { await fs.promises.unlink(f); } catch {} }
    }
    this.store.updateStreamTask(task.id, { status: 'cancelled', downloadSpeed: 0 });
    this.store.removeStreamTask(task.id);
  }

  async shutdownAll() {
    for (const ctx of this.runs.values()) {
      ctx.paused = true;
      ctx.abort.abort();
    }
  }

  /* ------------------------------------------------ internals -------- */

  _dir(id) { return path.join(TMP_ROOT, id); }

  _mkCtx(task) {
    return {
      taskId: task.id,
      abort: new AbortController(),
      paused: false,
      cancelled: false,
      samples: [],           // speed sliding window: {t, bytes}
      bytesDownloaded: 0,
      live: false,
      startTime: Date.now(),
      emitTimer: null,
      keyCache: new Map(),   // key uri -> Buffer
      manifest: null,
      manifestDirty: false,
      initFile: null,        // downloaded init segment (HLS map / DASH init)
      audioInitFile: null,
    };
  }

  _settings() {
    const s = this.settings || {};
    return {
      threads: Math.max(1, Number(s.streamThreadCount) || 8),
      retries: Math.max(0, Number(s.streamRetryCount ?? 5)),
      timeoutMs: Math.max(1000, Number(s.streamTimeoutMs) || 20000),
    };
  }

  _headers(task) {
    const o = task.options || {};
    const h = {};
    for (const raw of o.headers || []) {
      const i = raw.indexOf(':');
      if (i > 0) h[raw.slice(0, i).trim()] = raw.slice(i + 1).trim();
    }
    if (o.referer) h['Referer'] = o.referer;
    if (o.userAgent) h['User-Agent'] = o.userAgent;
    return h;
  }

  async _fetch(url, headers, ctx, { isPlaylist = false } = {}) {
    const { timeoutMs } = this._settings();
    const tries = isPlaylist ? 3 : 1;
    let lastErr;
    for (let i = 0; i < tries; i++) {
      if (ctx.abort.signal.aborted) throw ctx.cancelled ? CANCEL : PAUSE;
      try {
        const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ctx.abort.signal]);
        const resp = await fetch(url, { headers, redirect: 'follow', signal });
        if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
        return resp;
      } catch (err) {
        if (err === PAUSE || err === CANCEL || ctx.abort.signal.aborted) throw ctx.cancelled ? CANCEL : PAUSE;
        lastErr = err;
        if (i < tries - 1) await new Promise(r => setTimeout(r, 400 * (i + 1)));
      }
    }
    throw lastErr;
  }

  /* ---- manifest (resume state) ---- */

  _loadManifest(task) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this._dir(task.id), 'manifest.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  _saveManifest(ctx) {
    if (!ctx.manifest || !ctx.manifestDirty) return;
    ctx.manifestDirty = false;
    try {
      fs.writeFileSync(path.join(this._dir(ctx.taskId), 'manifest.json'), JSON.stringify(ctx.manifest));
    } catch {}
  }

  _saveManifestNow(ctx) {
    ctx.manifestDirty = true;
    this._saveManifest(ctx);
  }

  /* ---- speed ---- */

  _addBytes(ctx, n) {
    const now = Date.now();
    ctx.samples.push({ t: now, bytes: n });
    const cut = now - SPEED_WINDOW_MS;
    while (ctx.samples.length && ctx.samples[0].t < cut) ctx.samples.shift();
    ctx.bytesDownloaded += n;
  }

  _speed(ctx) {
    const now = Date.now();
    const cut = now - SPEED_WINDOW_MS;
    const s = ctx.samples.filter(x => x.t >= cut);
    if (!s.length) return 0;
    const total = s.reduce((a, x) => a + x.bytes, 0);
    const span = Math.max(0.2, (now - s[0].t) / 1000);
    return Math.round(total / span);
  }

  /* ---- progress ---- */

  _startProgressTicker(task, ctx) {
    clearInterval(ctx.emitTimer);
    ctx.emitTimer = setInterval(() => {
      const t = this.store.getStreamTask(task.id);
      if (!t) return;
      const done = Object.keys(ctx.manifest?.segments || {}).length;
      const total = Math.max(ctx.manifest?.totalSegments ?? 0, done);
      const speed = this._speed(ctx);
      const remaining = Math.max(0, total - done);
      const eta = speed > 0 && !ctx.live && done > 0
        ? Math.round((remaining * (ctx.bytesDownloaded / done)) / speed)
        : 0;
      this.store.updateStreamTask(task.id, {
        status: 'downloading',
        downloadSpeed: speed,
        completedLength: ctx.bytesDownloaded,
        totalLength: ctx.live ? ctx.bytesDownloaded
          : (total ? Math.round((ctx.bytesDownloaded / Math.max(1, done)) * total) : ctx.bytesDownloaded),
        progress: {
          totalSegments: total,
          doneSegments: done,
          bytesDownloaded: ctx.bytesDownloaded,
          speed,
          eta,
          live: ctx.live,
        },
      });
      this.emit('progress', this.store.getStreamTask(task.id));
    }, EMIT_INTERVAL_MS);
    ctx.emitTimer.unref?.();
  }

  /* ---- main pipeline ---- */

  async _run(task, ctx) {
    const dir = this._dir(task.id);
    await fs.promises.mkdir(dir, { recursive: true });
    ctx.manifest = this._loadManifest(task) || {
      version: 1, format: null, playlistUrl: task.url, segments: {}, totalSegments: 0,
    };
    ctx.manifest.playlistUrl = task.url;
    const headers = this._headers(task);
    const { threads } = this._settings();

    this.store.updateStreamTask(task.id, { status: 'downloading', errorMessage: '' });

    // 1. fetch top-level manifest
    const resp = await this._fetch(task.url, headers, ctx, { isPlaylist: true });
    const text = await resp.text();

    let plan;
    if (/<MPD[\s>]/.test(text)) {
      plan = this._planDash(task, ctx, text);
    } else if (isMasterPlaylist(text)) {
      plan = await this._planHlsMaster(task, ctx, text, headers);
    } else {
      plan = this._planHlsMedia(task, ctx, text, task.url);
    }
    ctx.manifest.format = plan.format;

    // 2.5 广告分片剔除 + custom-range 截取（N_m3u8DL --ad-keyword / --custom-range 语义）
    plan.segments = filterAdSegments(plan.segments, task.options?.adKeywords);
    if (plan.audio) plan.audio.segments = filterAdSegments(plan.audio.segments, task.options?.adKeywords);
    if (!plan.live && task.options?.customRange) {
      const [s, e] = parseCustomRange(task.options.customRange, plan.segments);
      plan.segments = plan.segments.slice(s, e);
      // ctx.manifest.segments 是按 manifestKey 的对象映射：同步裁剪为保留下来的键
      const kept = new Set(plan.segments.map(seg => String(seg.manifestKey)));
      for (const k of Object.keys(ctx.manifest.segments)) {
        if (!kept.has(k)) delete ctx.manifest.segments[k];
      }
    }

    // 2. init segment (HLS EXT-X-MAP / DASH init)
    if (plan.init?.uri) ctx.initFile = await this._ensureInit(task, ctx, plan.init.uri, headers, 'init.bin');
    if (plan.audio?.init?.uri) ctx.audioInitFile = await this._ensureInit(task, ctx, plan.audio.init.uri, headers, 'audio_init.bin');

    this._startProgressTicker(task, ctx);
    this.emit('progress', this.store.getStreamTask(task.id));

    // 3. download segments
    if (plan.live) {
      await this._runLive(task, ctx, plan, headers, threads);
    } else {
      await this._downloadSegments(task, ctx, plan.segments, headers, threads, '');
      if (plan.audio) {
        await this._downloadSegments(task, ctx, plan.audio.segments, headers, threads, 'audio_');
      }
    }
    this._saveManifestNow(ctx);

    if (ctx.abort.signal.aborted) throw ctx.cancelled ? CANCEL : PAUSE;

    // 4. merge + mux
    await this._finalize(task, ctx, plan);
  }

  async _ensureInit(task, ctx, uri, headers, fname) {
    const p = path.join(this._dir(task.id), fname);
    try {
      const st = await fs.promises.stat(p);
      if (st.size > 0) return p;
    } catch {}
    const resp = await this._fetch(uri, headers, ctx);
    const buf = Buffer.from(await resp.arrayBuffer());
    await fs.promises.writeFile(p, buf);
    return p;
  }

  /* ---- planning ---- */

  _selectVariant(variants, select) {
    if (!variants.length) return null;
    return this._pickVariant(variants, select, null);
  }

  _pickVariant(variants, select, drop) {
    // N_m3u8DL -dv/-da/-ds：先反向剔除匹配项
    if (drop) {
      const dropped = new Set(filterVariants(variants, drop).map(v => v.id ?? v.uri ?? v));
      variants = variants.filter(v => !dropped.has(v.id ?? v.uri ?? v));
    }
    if (!variants.length) return null;
    // N_m3u8DL 风格 DSL：含子键（冒号分隔）或 for= 语法时走完整选择器
    if (select && /[:=]/.test(String(select)) && !/^https?:/i.test(String(select))) {
      const picked = filterVariants(variants, select);
      return picked[0] || null;
    }
    if (!select || select === 'best') {
      return variants.reduce((a, b) => (b.bandwidth > (a?.bandwidth ?? -1) ? b : a), null);
    }
    if (select === 'worst') {
      return variants.reduce((a, b) => (b.bandwidth < (a?.bandwidth ?? Infinity) ? b : a), null);
    }
    const s = String(select).trim().toLowerCase();
    let v = variants.find(x => String(x.id).toLowerCase() === s);
    if (v) return v;
    const res = /^(\d+)x(\d+)$/.exec(s) || /^(\d+)p$/.exec(s);
    if (res) {
      const w = res[1], h = res[2];
      v = variants.find(x => x.resolution === `${w}x${h}` ||
        (x.width && String(x.width) === w) ||
        (x.height && String(x.height) === h));
      if (v) return v;
    }
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      const sorted = [...variants].sort((a, b) => a.bandwidth - b.bandwidth);
      return sorted.find(x => x.bandwidth >= n * 1000) || sorted[sorted.length - 1];
    }
    return variants[0];
  }

  async _planHlsMaster(task, ctx, text, headers) {
    const master = parseMaster(text, task.url);
    const sel = this._pickVariant(master.variants, task.options?.select, task.options?.drop);
    if (!sel) throw new Error('master playlist has no variants');
    const resp = await this._fetch(sel.uri, headers, ctx, { isPlaylist: true });
    const plan = this._planHlsMedia(task, ctx, await resp.text(), sel.uri);
    plan.variant = sel;

    if (sel.audio) {
      const track = master.audioTracks.find(a => a.groupId === sel.audio && a.uri);
      if (track) {
        const aresp = await this._fetch(track.uri, headers, ctx, { isPlaylist: true });
        const aMedia = parseMedia(await aresp.text(), track.uri);
        plan.audio = this._hlsSegmentPlan(aMedia);
      }
    }
    return plan;
  }

  _planHlsMedia(task, ctx, text, playlistUrl) {
    const media = parseMedia(text, playlistUrl);
    ctx.live = !media.endList;
    const plan = this._hlsSegmentPlan(media);
    plan.format = 'hls';
    plan.playlistUrl = playlistUrl;
    plan.targetDuration = media.targetDuration || 4;
    plan.endList = media.endList;
    plan.live = !media.endList;
    return plan;
  }

  _hlsSegmentPlan(media) {
    // expand byteranges: "n" without offset continues from previous segment end
    let offset = 0;
    const segments = media.segments.map((seg, i) => {
      let br = null;
      if (seg.byterange) {
        if (seg.byterange.includes('@')) {
          const [n, o] = seg.byterange.split('@').map(Number);
          br = [o, n];
        } else {
          br = [offset, Number(seg.byterange)];
        }
        offset += br[1];
      } else {
        offset = 0;
      }
      return {
        index: i,
        seq: seg.sequence,
        manifestKey: 's' + seg.sequence,   // stable across playlist refreshes
        uri: seg.uri,
        duration: seg.duration,
        key: seg.key || null,
        map: seg.map || null,
        byterange: br,
        discontinuity: !!seg.discontinuity,
      };
    });
    return { format: 'hls', segments, init: media.map || null, mediaSequence: media.mediaSequence };
  }

  _planDash(task, ctx, text) {
    const mpd = parseMpd(text, task.url);
    ctx.live = mpd.live;
    const sel = this._pickVariant(
      mpd.representations.map(r => ({ ...r, resolution: r.width && r.height ? `${r.width}x${r.height}` : '' })),
      task.options?.select,
    );
    if (!sel) throw new Error('MPD has no usable video representations');

    const toSeg = (rep) => rep.segments.map((s, i) => ({
      index: i,
      seq: s.number ?? (s.time != null ? s.time : i),
      manifestKey: s.url,                 // urls are stable identifiers for DASH
      uri: s.url,
      duration: s.duration || 0,
      key: null,
      map: null,
      byterange: s.mediaRange ? (() => {
        const [a, b] = s.mediaRange.split('-').map(Number);
        return [a, b - a + 1];
      })() : null,
      discontinuity: false,
    }));

    const plan = {
      format: 'dash',
      playlistUrl: task.url,
      segments: toSeg(sel),
      init: sel.initUrl ? { uri: sel.initUrl } : null,
      mediaSequence: 0,
      targetDuration: 4,
      endList: !mpd.live,
      live: mpd.live,
      variant: sel,
      updatePeriodSec: mpd.minimumUpdatePeriodSec || 5,
    };

    if (mpd.audioRepresentations.length) {
      const bestAudio = mpd.audioRepresentations.reduce((a, b) => (b.bandwidth > (a?.bandwidth ?? -1) ? b : a), null);
      plan.audio = {
        format: 'dash',
        segments: toSeg(bestAudio),
        init: bestAudio.initUrl ? { uri: bestAudio.initUrl } : null,
      };
    }
    return plan;
  }

  /* ---- live loop ---- */

  async _runLive(task, ctx, plan, headers, threads) {
    const limitMin = Number(task.options?.liveRecordLimitMin) || 0;
    const deadline = limitMin > 0 ? Date.now() + limitMin * 60000 : Infinity;
    const isDash = plan.format === 'dash';
    const waitSec = isDash ? Math.max(1, plan.updatePeriodSec || 5) : Math.max(1, plan.targetDuration || 4);

    let current = plan;
    while (true) {
      if (ctx.abort.signal.aborted) throw ctx.cancelled ? CANCEL : PAUSE;
      if (Date.now() >= deadline) break;

      // download whatever is new in the current snapshot
      await this._downloadSegments(task, ctx, current.segments, headers, threads, '');
      if (current.audio) {
        await this._downloadSegments(task, ctx, current.audio.segments, headers, threads, 'audio_');
      }
      this._saveManifestNow(ctx);
      if (current.endList) return;

      // wait then refresh the playlist
      await this._sleep(waitSec * 1000, ctx);
      const resp = await this._fetch(current.playlistUrl, headers, ctx, { isPlaylist: true });
      const text = await resp.text();
      current = isDash
        ? this._planDash(task, ctx, text)
        : this._planHlsMedia(task, ctx, text, current.playlistUrl);
    }
  }

  _sleep(ms, ctx) {
    return new Promise((resolve, reject) => {
      const onAbort = () => { cleanup(); reject(ctx.cancelled ? CANCEL : PAUSE); };
      const cleanup = () => { clearTimeout(to); ctx.abort.signal.removeEventListener('abort', onAbort); };
      const to = setTimeout(() => { cleanup(); resolve(); }, ms);
      ctx.abort.signal.addEventListener('abort', onAbort);
    });
  }

  /* ---- segment downloading ---- */

  _mkey(prefix, seg) { return prefix + (seg.manifestKey ?? seg.index); }

  async _downloadSegments(task, ctx, segments, headers, threads, prefix) {
    const store2 = ctx.manifest.segments;
    const pending = segments.filter(s => !store2[this._mkey(prefix, s)]);
    if (pending.length) {
      ctx.manifest.totalSegments = Object.keys(store2).length + pending.length;
      this._saveManifestNow(ctx);
    }

    let cursor = 0;
    const self = this;
    async function worker() {
      while (cursor < pending.length) {
        if (ctx.abort.signal.aborted) throw ctx.cancelled ? CANCEL : PAUSE;
        const seg = pending[cursor++];
        await self._downloadOne(task, ctx, seg, headers, prefix);
      }
    }
    await Promise.all(Array.from({ length: Math.min(threads, Math.max(1, pending.length)) }, worker));
  }

  async _downloadOne(task, ctx, seg, headers, prefix) {
    const { retries } = this._settings();
    const mkey = this._mkey(prefix, seg);
    // hash of the manifest key -> stable unique file name across playlist refreshes
    const fname = `${prefix}seg-${crypto.createHash('md5').update(mkey).digest('hex').slice(0, 16)}.bin`;
    const file = path.join(this._dir(task.id), fname);
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (ctx.abort.signal.aborted) throw ctx.cancelled ? CANCEL : PAUSE;
      try {
        const data = await this._fetchSegment(ctx, seg, headers);
        const plain = await this._maybeDecrypt(task, ctx, seg, data);
        await fs.promises.writeFile(file, plain);
        this._addBytes(ctx, data.length);
        ctx.manifest.segments[mkey] = {
          file: fname,
          size: plain.length,
          rawSize: data.length,
          uri: seg.uri,
          seq: seg.seq,
          idx: seg.seq ?? seg.index,
        };
        ctx.manifestDirty = true;
        if (attempt > 0 || (seg.index % 8) === 0) this._saveManifestNow(ctx);
        return;
      } catch (err) {
        if (err === PAUSE || err === CANCEL) throw err;
        lastErr = err;
      }
    }
    throw new Error(`segment ${seg.seq} failed after ${retries + 1} attempts: ${lastErr?.message || lastErr}`);
  }

  async _fetchSegment(ctx, seg, headers) {
    const { timeoutMs } = this._settings();
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ctx.abort.signal]);
    const h = new Headers(headers);
    if (seg.byterange) {
      const [start, length] = seg.byterange;
      if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(start + length)) {
        throw new Error('Invalid byte-range request');
      }
      h.set('Range', `bytes=${start}-${start + length - 1}`);
      h.set('Accept-Encoding', 'identity');
    }
    const resp = await fetch(seg.uri, { headers: h, redirect: 'follow', signal });
    if (!resp.ok) {
      await resp.body?.cancel();
      throw new Error(`HTTP ${resp.status}`);
    }
    if (seg.byterange) {
      const [start, length] = seg.byterange;
      const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(resp.headers.get('content-range') || '');
      const encoding = resp.headers.get('content-encoding');
      if ((encoding && encoding.toLowerCase() !== 'identity') || resp.status !== 206 || !match || Number(match[1]) !== start || Number(match[2]) !== start + length - 1 ||
          (match[3] !== '*' && (!Number.isSafeInteger(Number(match[3])) || Number(match[3]) <= Number(match[2])))) {
        await resp.body?.cancel();
        throw new Error('Invalid byte-range response: expected HTTP 206 with matching Content-Range');
      }
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (seg.byterange && buf.length !== seg.byterange[1]) throw new Error('Incomplete byte-range response');
    return buf;
  }

  async _getKey(task, ctx, seg, headers) {
    if (task.options?.key) {
      const hex = String(task.options.key).replace(/^0x/i, '');
      const b = Buffer.from(hex, 'hex');
      if (b.length !== 16) throw new Error('options.key must be 16 bytes of hex');
      return b;
    }
    if (!seg.key?.uri) return null;
    if (ctx.keyCache.has(seg.key.uri)) return ctx.keyCache.get(seg.key.uri);
    const resp = await this._fetch(seg.key.uri, headers, ctx);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length !== 16) throw new Error(`key from ${seg.key.uri} is ${buf.length} bytes, expected 16`);
    ctx.keyCache.set(seg.key.uri, buf);
    return buf;
  }

  _ivFor(seg) {
    if (seg.key?.iv) {
      let b = Buffer.from(String(seg.key.iv).replace(/^0x/i, ''), 'hex');
      if (b.length < 16) b = Buffer.concat([Buffer.alloc(16 - b.length), b]);
      if (b.length > 16) b = b.subarray(b.length - 16);
      return b;
    }
    // RFC 8216 5.2: default IV = media sequence number as big-endian 16-byte
    const iv = Buffer.alloc(16);
    iv.writeBigUInt64BE(BigInt(seg.seq), 8);
    return iv;
  }

  async _maybeDecrypt(task, ctx, seg, data) {
    if (!seg.key || seg.key.method === 'NONE') return data;
    if (seg.key.method !== 'AES-128') throw new Error(`unsupported key method ${seg.key.method}`);
    const key = await this._getKey(task, ctx, seg, this._headers(task));
    // 任务级自定义 IV 覆盖（对齐猫抓/N_m3u8DL-RE --custom-hls-iv）
    let iv;
    if (task.options?.iv) {
      iv = Buffer.from(String(task.options.iv).replace(/^0x/i, ''), 'hex');
      if (iv.length !== 16) throw new Error('options.iv must be 16 bytes of hex');
    } else {
      iv = this._ivFor(seg);
    }
    const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
    return Buffer.concat([d.update(data), d.final()]);
  }

  /* ---- finalize: merge + mux ---- */

  _collectPrefix(ctx, prefix, exclude) {
    return Object.entries(ctx.manifest.segments)
      .filter(([k]) => k.startsWith(prefix) && (!exclude || !k.startsWith(exclude)))
      .map(([, v]) => ({ file: v.file, idx: v.idx ?? 0 }))
      .sort((a, b) => a.idx - b.idx)
      .map(x => path.join(this._dir(ctx.taskId), x.file));
  }

  async _finalize(task, ctx, plan) {
    const dir = this._dir(task.id);
    const id = task.id;
    this.store.updateStreamTask(id, { status: 'muxing', downloadSpeed: 0 });
    this.emit('progress', this.store.getStreamTask(id));

    let base = task.name;
    if (!base) {
      try { base = decodeURIComponent(new URL(task.url).pathname.split('/').filter(Boolean).pop() || ''); } catch {}
      base = base.replace(/\.[^.]+$/, '');
    }
    // 命名模板（N_m3u8DL --save-pattern 变量集 + UTF-8 字节安全截断）：
    // 用户显式命名且未指定任务级模板时尊重原名；否则按模板渲染
    const pattern = task.options?.savePattern || (task.name ? null : (this.settings?.savePattern || '<SaveName>'));
    let name;
    if (pattern) {
      const vars = {
        SaveName: base || 'stream',
        Host: (() => { try { return new URL(task.url).hostname; } catch { return ''; } })(),
        Resolution: plan.variant?.resolution,
        Codecs: plan.variant?.codecs,
        Bandwidth: plan.variant?.bandwidth ? Math.round(plan.variant.bandwidth / 1000) : undefined,
        FrameRate: plan.variant?.frameRate,
        MediaType: 'video',
        Id: task.id,
      };
      name = buildSaveName(pattern, vars, { maxBytes: 200 });
      if (!name) name = sanitizeFilename(base || 'stream');
    } else {
      name = sanitizeFilename(base || 'stream');
    }
    const wantMux = (task.options?.mux !== false) && hasFfmpeg();

    const videoFiles = [
      ...(ctx.initFile ? [ctx.initFile] : []),
      ...this._collectPrefix(ctx, '', 'audio_'),
    ];
    const hasAudio = Object.keys(ctx.manifest.segments).some(k => k.startsWith('audio_'));

    const outputFiles = [];
    let mainOut;

    if (plan.format === 'hls') {
      const outExt = wantMux ? '.mp4' : '.ts';
      mainOut = path.join(task.saveDir, name + outExt);
      if (wantMux) {
        const merged = path.join(dir, 'merged.ts');
        await concatFiles(videoFiles, merged);
        mainOut = await remuxToMp4([merged], mainOut);
      } else {
        mainOut = await concatFiles(videoFiles, mainOut);
      }
      outputFiles.push(mainOut);
    } else {
      // dash
      const mergedV = path.join(dir, 'video.m4s');
      await concatFiles(videoFiles, mergedV);
      if (hasAudio) {
        const aFiles = [
          ...(ctx.audioInitFile ? [ctx.audioInitFile] : []),
          ...this._collectPrefix(ctx, 'audio_', null),
        ];
        const mergedA = path.join(dir, 'audio.m4s');
        await concatFiles(aFiles, mergedA);
        if (wantMux) {
          mainOut = path.join(task.saveDir, name + '.mkv');
          mainOut = await muxTracks(mergedV, mergedA, mainOut);
          outputFiles.push(mainOut);
        } else {
          mainOut = path.join(task.saveDir, name + '.mp4');
          await concatFiles([mergedV], mainOut);
          const aOut = path.join(task.saveDir, name + '.audio.m4s');
          await concatFiles([mergedA], aOut);
          outputFiles.push(mainOut, aOut);
        }
      } else {
        mainOut = path.join(task.saveDir, name + '.mp4');
        if (wantMux) mainOut = await remuxToMp4([mergedV], mainOut);
        else await concatFiles([mergedV], mainOut);
        outputFiles.push(mainOut);
      }
    }

    const stat = await fs.promises.stat(mainOut).catch(() => null);
    this.store.updateStreamTask(id, {
      status: 'complete',
      downloadSpeed: 0,
      completedLength: ctx.bytesDownloaded,
      totalLength: ctx.bytesDownloaded,
      outputFiles,
      outputSize: stat?.size || 0,
      progress: {
        ...(this.store.getStreamTask(id)?.progress || {}),
        doneSegments: Object.keys(ctx.manifest.segments).length,
        totalSegments: ctx.manifest.totalSegments,
        speed: 0, eta: 0, live: ctx.live,
      },
    });
    this.emit('done', this.store.getStreamTask(id));
    this.emit('progress', this.store.getStreamTask(id));

    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
