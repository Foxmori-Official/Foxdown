import crypto from 'node:crypto';

/**
 * 命名模板与 UTF-8 安全截断（参考 N_m3u8DL-RE --save-pattern 变量集与超长截断规则）。
 * 变量：<SaveName> <Id> <Codecs> <Language> <Resolution> <Bandwidth> <MediaType>
 *        <Channels> <FrameRate> <VideoRange> <GroupId> <Name> <Host> <Date>
 */

// 同时兼容 {Var}（推荐，Windows 直觉安全）与 <Var>（N_m3u8DL-RE 旧习惯）两种写法
const VAR_RE = /{([A-Za-z]+)}|<([A-Za-z]+)>/g;

export function renderNameTemplate(pattern, vars = {}) {
  if (!pattern) return vars.SaveName || vars.Name || '';
  const map = {
    SaveName: vars.SaveName, Id: vars.Id, Codecs: vars.Codecs, Language: vars.Language,
    Resolution: vars.Resolution, Bandwidth: vars.Bandwidth != null ? String(vars.Bandwidth) : undefined,
    MediaType: vars.MediaType, Channels: vars.Channels != null ? String(vars.Channels) : undefined,
    FrameRate: vars.FrameRate != null ? String(vars.FrameRate) : undefined,
    VideoRange: vars.VideoRange, GroupId: vars.GroupId, Name: vars.Name,
    Host: vars.Host, Date: vars.Date || new Date().toISOString().slice(0, 10).replace(/-/g, ''),
  };
  return String(pattern).replace(VAR_RE, (_, k1, k2) => {
    const v = map[k1 || k2];
    return v === undefined || v === null || v === '' ? '' : String(v);
  });
}

/**
 * 超长文件名 UTF-8 字节安全截断（N_m3u8DL-RE 规则）：
 *  - 按 UTF-8 字节数截断，绝不截断半个中文字符/Emoji
 *  - 自动保留扩展名空间
 *  - 附加 8 位短哈希防重名冲突
 */
export function utf8SafeTruncate(name, maxBytes = 200) {
  if (!name) return 'download';
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : '';
  const stem = dot > 0 && name.length - dot <= 10 ? name.slice(0, dot) : name;
  const budget = maxBytes - Buffer.byteLength(ext, 'utf8');
  if (Buffer.byteLength(stem, 'utf8') <= budget) return stem + ext;

  const hash = crypto.createHash('md5').update(stem).digest('hex').slice(0, 8);
  const suffix = '-' + hash;
  const stemBudget = budget - Buffer.byteLength(suffix, 'utf8');

  // 按字节截断到边界：逐字节累积，遇到多字节字符放不下就停
  const buf = Buffer.from(stem, 'utf8');
  let cut = Math.min(stemBudget, buf.length);
  // 回退到完整 UTF-8 字符边界：若 cut 处是多字节序列中间，向前退
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return buf.subarray(0, cut).toString('utf8') + suffix + ext;
}

/** 清洗 + 模板 + 截断的一站式入口 */
export function buildSaveName(pattern, vars, { maxBytes = 200 } = {}) {
  const raw = renderNameTemplate(pattern, vars);
  const clean = raw.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim();
  return utf8SafeTruncate(clean || 'download', maxBytes);
}
