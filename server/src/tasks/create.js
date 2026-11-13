import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { guessFilename, sanitizeFilename, isMagnet, isTorrentUrl, isStreamUrl } from '../util/helpers.js';

const pendingCaptures = new WeakMap();

function availableFilename(dir, name) {
  const { name: base, ext } = path.parse(name);
  for (let index = 0; index < 10000; index++) {
    const candidate = index ? `${base} (${index})${ext}` : name;
    const file = path.join(dir, candidate);
    const occupied = [file, file + '.aria2'].some(target => fs.lstatSync(target, { throwIfNoEntry: false }));
    if (!occupied) return candidate;
  }
  throw new Error('Could not find an unused download filename');
}

function partialDownloadName(dir, url) {
  const filename = guessFilename(url);
  if (!filename || filename !== sanitizeFilename(filename)) return '';
  const file = path.join(dir, filename);
  if (fs.lstatSync(file + '.aria2', { throwIfNoEntry: false })) return filename;
  return '';
}

async function addCapturedFile(api, key, add) {
  let pending = pendingCaptures.get(api);
  if (!pending) pendingCaptures.set(api, pending = new Map());
  if (pending.has(key)) return { ...await pending.get(key), reused: true };

  const submission = (async () => {
    for (const id of api.store.findDownloads(key)) {
      const task = await api.rpc.tellStatus(id, ['status']).catch(() => null);
      if (task && ['active', 'waiting'].includes(task.status)) return { id, engine: 'aria2', reused: true };
    }
    return add();
  })();
  pending.set(key, submission);
  try { return await submission; }
  finally { pending.delete(key); }
}

/**
 * 任务创建核心逻辑（REST 与 MCP 共用）。
 * 从 ApiServer 的 POST /api/v1/tasks 路由提取，行为保持一致。
 */
export async function createTaskFromBody(api, b) {
  const url = b.url || (Array.isArray(b.urls) ? b.urls[0] : '');
  if (!url && !b.torrentBase64 && !b.metalinkBase64) throw new Error('url, torrentBase64 or metalinkBase64 required');

  const opt = {};
  const o = b.options || {};
  // Validate before creating anything: an invalid schedule must not leave a
  // paused orphan (or briefly start a real stream request).
  const hasSchedule = o.startAt !== undefined && o.startAt !== null && o.startAt !== '';
  const startAt = hasSchedule ? (typeof o.startAt === 'number' ? o.startAt : Date.parse(o.startAt)) : null;
  if (hasSchedule && !Number.isFinite(startAt)) throw new Error('invalid startAt');
  if (hasSchedule && !api.scheduler) throw new Error('scheduler unavailable');
  if (o.dir) opt.dir = o.dir;
  if (o.out) opt.out = sanitizeFilename(o.out);
  if (o.referer) opt.referer = o.referer;
  if (o.userAgent) opt['user-agent'] = o.userAgent;
  if (o.split) opt.split = String(o.split);
  if (o.maxConnectionPerServer) opt['max-connection-per-server'] = String(o.maxConnectionPerServer);
  if (o.header || o.headers) {
    const h = o.header || o.headers;
    opt.header = Array.isArray(h) ? h : [h];
  }
  if (o.cookie) opt.header = [...(opt.header || []), `Cookie: ${o.cookie}`];
  if (o.selectFile !== undefined) {
    // Explicit empty/zero/invalid selections must never silently become 'all files'.
    const selection = String(o.selectFile).trim();
    const valid = /^(?:[1-9]\d*)(?:-[1-9]\d*)?(?:,(?:[1-9]\d*)(?:-[1-9]\d*)?)*$/.test(selection) &&
      selection.split(',').every(part => {
        const [first, last = first] = part.split('-').map(Number);
        return Number.isSafeInteger(first) && Number.isSafeInteger(last) && first <= last;
      });
    if (!valid) throw new Error('invalid selectFile: select at least one positive file index');
    opt['select-file'] = selection;
  }
  if (o.seedTime !== undefined) opt['seed-time'] = String(o.seedTime);
  if (o.checksum) opt.checksum = o.checksum;   // 形如 "sha-1=BASE32..."（aria2 --checksum）

  // 流媒体任务
  const streamReq = b.stream || (url && isStreamUrl(url) ? {} : null);
  if (url && streamReq !== null && !b.torrentBase64) {
    const task = await api.stream.create({
      url,
      paused: hasSchedule,
      headers: opt.header || [],
      saveDir: o.dir || api.settings.downloadDir,
      saveName: o.out ? sanitizeFilename(o.out) : undefined,
      select: streamReq.select || 'best',
      key: streamReq.key,
      iv: streamReq.iv,
      drop: streamReq.drop,
      adKeywords: streamReq.adKeywords,
      customRange: streamReq.customRange,
      liveRecordLimitMin: streamReq.liveRecordLimitMin ?? api.settings.streamLiveRecordLimitMin,
      mux: streamReq.mux ?? api.settings.streamMuxAfterDownload,
      referer: o.referer,
      userAgent: o.userAgent,
    });
    if (hasSchedule) api.scheduler.schedule('stream', task.id, startAt);
    return { id: task.id, engine: 'stream' };
  }

  if (hasSchedule) opt.pause = 'true';
  const torrent = isMagnet(url) || isTorrentUrl(url) || Boolean(b.torrentBase64);
  const uris = Array.isArray(b.urls) && !isMagnet(url) ? b.urls : [url];
  const plainFile = !torrent && !b.metalinkBase64;
  const dir = opt.dir || api.settings?.downloadDir;
  let downloadKey;
  if (plainFile) {
    // Let aria2 choose a new name instead of treating unrelated bytes as
    // progress. Pausing and unpausing the same task still use its control file.
    opt.continue = 'false';
    downloadKey = createHash('sha256').update(JSON.stringify([
      uris, dir ? path.resolve(dir) : '', opt.out || '', opt.header || [], opt.referer || '',
      opt['user-agent'] || '', opt.checksum || '',
    ])).digest('hex');
  }
  const add = async () => {
    if (plainFile && dir) {
      const name = opt.out || partialDownloadName(dir, url);
      if (name) opt.out = availableFilename(dir, name);
    }
    let gid;
    if (b.metalinkBase64) {
      const results = await api.rpc.addMetalink(b.metalinkBase64, opt);
      gid = Array.isArray(results) ? results[0] : results;
    } else if (b.torrentBase64) {
      gid = await api.rpc.addTorrent(b.torrentBase64, [], opt);
    } else {
      gid = await api.rpc.addUri(uris, opt);
    }
    api.store.setMeta(gid, { name: opt.out || '', createdAt: Date.now(), kind: torrent ? 'torrent' : 'file', downloadKey });
    if (hasSchedule) api.scheduler.schedule('aria2', gid, startAt);
    return { id: gid, engine: 'aria2' };
  };
  return plainFile && b.reuseActive === true && !hasSchedule ? addCapturedFile(api, downloadKey, add) : add();
}
