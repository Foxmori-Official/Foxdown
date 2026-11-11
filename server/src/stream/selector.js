/**
 * 流选择 DSL（参考 N_m3u8DL-RE ComplexParamParser / FilterUtil.DoFilterKeep）：
 *   子键以 ":" 分隔，支持 \" 转义冒号与成对引号剥离；
 *   单词形式（best/worst/all）等价于 for=...
 *   过滤键：id/lang/name/codecs/res/frame/channel/range/url/period/role（正则）
 *           segsMin/segsMax（分片数）、plistDurMin/plistDurMax（hms 时长）、bwMin/bwMax（Kbps）
 *   for=best[N]|worst[N]|all：先按 Bandwidth desc 排序再截取（N_m3u8DL 语义）
 */

/** "1h20m30s" / "90s" / "05:00" → 秒 */
export function parseHms(s) {
  if (!s) return 0;
  const hms = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s?)?$/.exec(String(s).trim());
  if (hms && (hms[1] || hms[2] || hms[3])) {
    return Number(hms[1] || 0) * 3600 + Number(hms[2] || 0) * 60 + Number(hms[3] || 0);
  }
  const colon = /^(\d+):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?$/.exec(String(s).trim());
  if (colon) {
    // 两段 = MM:SS；三段 = HH:MM:SS（N_m3u8DL --custom-range 语义）
    if (colon[3] !== undefined) return Number(colon[1]) * 3600 + Number(colon[2]) * 60 + Number(colon[3]);
    return Number(colon[1]) * 60 + Number(colon[2]);
  }
  return Number(s) || 0;
}

/** ComplexParamParser：":" 分隔 + \" 转义 + 成对引号剥离 */
export function parseSelector(expr) {
  const out = { filters: [], for: { mode: 'best', n: 1 } };
  if (!expr) return out;
  const s = String(expr).trim();
  if (/^(best|worst|all)$/i.test(s) || /^best\d+$/i.test(s) || /^worst\d+$/i.test(s)) {
    const m = /^(best|worst)(\d*)$/i.exec(s);
    if (m) { out.for = { mode: m[1].toLowerCase(), n: Number(m[2]) || 1 }; }
    else out.for = { mode: 'all', n: Infinity };
    return out;
  }
  // 按未转义的 : 切分
  const parts = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === ':') { cur += ':'; i++; continue; }
    if (s[i] === ':') { parts.push(cur); cur = ''; continue; }
    cur += s[i];
  }
  if (cur) parts.push(cur);
  for (let p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    let key = p.slice(0, eq).trim();
    let val = p.slice(eq + 1).trim();
    // 成对引号剥离
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key === 'for') {
      const m = /^(best|worst)(\d*)$/i.exec(val);
      if (m) out.for = { mode: m[1].toLowerCase(), n: Number(m[2]) || 1 };
      else if (/^all$/i.test(val)) out.for = { mode: 'all', n: Infinity };
    } else {
      out.filters.push({ key, value: val });
    }
  }
  return out;
}

function variantField(v, key) {
  switch (key) {
    case 'id': return v.id;
    case 'lang': return v.lang || v.language;
    case 'name': return v.name;
    case 'codecs': return v.codecs;
    case 'res': return v.resolution || (v.width ? `${v.width}x${v.height}` : undefined);
    case 'frame': return v.frameRate;
    case 'channel': return v.channels;
    case 'range': return v.videoRange;
    case 'url': return v.url || v.uri;
    case 'period': return v.periodId;
    case 'role': return v.role;
    default: return undefined;
  }
}

function matchFilter(v, f) {
  const { key, value } = f;
  if (key === 'bwMin') return (v.bandwidth || 0) >= Number(value) * 1000;
  if (key === 'bwMax') return (v.bandwidth ?? Infinity) <= Number(value) * 1000;
  if (key === 'segsMin') return (v.segments ?? Infinity) >= Number(value);
  if (key === 'segsMax') return (v.segments ?? -Infinity) <= Number(value);
  if (key === 'plistDurMin') return (v.duration ?? Infinity) >= parseHms(value);
  if (key === 'plistDurMax') return (v.duration ?? -Infinity) <= parseHms(value);
  const field = variantField(v, key);
  if (field === undefined || field === null) return false;
  let str = String(field);
  if (key === 'role') str = str.replace(/-/g, '').toLowerCase();
  try { return new RegExp(value, key === 'role' ? 'i' : '').test(str); } catch { return str.includes(value); }
}

/**
 * 按 DSL 过滤变体。返回排序截取后的数组（Bandwidth desc）。
 * 未知字段的过滤键不会误杀（字段缺失即不匹配，与 N_m3u8DL 一致）。
 */
export function filterVariants(variants, expr) {
  const sel = parseSelector(expr);
  let list = variants.filter(v => sel.filters.every(f => matchFilter(v, f)));
  list = [...list].sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
  const { mode, n } = sel.for;
  if (mode === 'all') return list;
  if (mode === 'best') return list.slice(0, n);
  return list.slice(-n); // worst
}

/** 广告分片关键词剔除：分片 URI 命中任一正则即剔除（N_m3u8DL --ad-keyword 语义） */
export function filterAdSegments(segments, adKeywords) {
  if (!adKeywords || !adKeywords.length) return segments;
  const res = adKeywords.map(k => { try { return new RegExp(k); } catch { return null; } }).filter(Boolean);
  if (!res.length) return segments;
  return segments.filter(seg => !res.some(re => re.test(seg.uri)));
}

/**
 * custom-range 截取（N_m3u8DL --custom-range 语义）：
 *   分片序号："0-10" / "10-" / "-99"
 *   时间轴："05:00-20:00" / "00:26-"（按 EXTINF 累计换算为分片区间）
 * 返回 [startIdx, endIdxExclusive]
 */
export function parseCustomRange(str, segments) {
  const n = segments.length;
  if (!str || !n) return [0, n];
  const s = String(str).trim();
  // 时间轴形式（含 :）
  if (s.includes(':')) {
    const m = /^([\d:]+(?:\.\d+)?)?-([\d:]+(?:\.\d+)?)?$/.exec(s);
    if (!m) return [0, n];
    const t0 = m[1] ? parseHms(m[1]) : 0;
    const t1 = m[2] ? parseHms(m[2]) : Infinity;
    let acc = 0, start = 0, end = n;
    for (let i = 0; i < n; i++) {
      const segStart = acc;
      acc += segments[i].duration || 0;
      if (segStart < t0) start = i + 1;          // 起点落在该分片之前
      if (segStart < t1) end = i + 1;            // 终点区间包含边界分片
    }
    return [Math.min(start, n), Math.max(start, Math.min(end, n))];
  }
  // 序号形式
  const m = /^(\d*)-(\d*)$/.exec(s);
  if (!m) return [0, n];
  const start = m[1] === '' ? 0 : Number(m[1]);
  const end = m[2] === '' ? n : Number(m[2]) + 1;
  return [Math.max(0, Math.min(start, n)), Math.max(0, Math.min(end, n))];
}
