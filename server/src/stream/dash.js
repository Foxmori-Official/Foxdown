/**
 * DASH MPD parser (MPD = Media Presentation Description, ISO/IEC 23009-1).
 * Minimal hand-rolled XML tokenizer (no external XML library), then
 * Period > AdaptationSet > Representation semantics aligned with
 * N_m3u8DL-RE's DASHExtractor2.
 *
 * Supported segment addressing:
 *  - SegmentTemplate: $Number$ / $Time$ / $RepresentationID$ with
 *    startNumber, timescale, duration, and SegmentTimeline (S@t, S@d, S@r)
 *  - SegmentList: Initialization + SegmentURL list
 *  - SegmentBase: indexRange only -> treated as one whole segment
 */

const MAX_SEGMENTS = 100000;
const MAX_URL_CHARACTERS = 32 * 1024 * 1024;

function accountUrl(url, budget) {
  budget.characters += url?.length || 0;
  if (budget.characters > MAX_URL_CHARACTERS) throw new Error('DASH expanded URLs exceed supported limit');
}

function addSegment(segments, segment, budget) {
  checkSegmentCount(++budget.count);
  accountUrl(segment.url, budget);
  segments.push(segment);
}

function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, key) => {
    if (!key.startsWith('#')) return named[key] || entity;
    const point = key[1].toLowerCase() === 'x' ? Number.parseInt(key.slice(2), 16) : Number(key.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : entity;
  });
}

function checkSegmentCount(count) {
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_SEGMENTS) throw new Error('DASH segment count exceeds supported limit');
}

function findTagEnd(text, start) {
  let quote = '';
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '>') return index;
  }
  return -1;
}

/** Tiny tolerant XML tokenizer -> { name, attrs, children, text } tree. */
function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  let nodes = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      stack[stack.length - 1].text += decodeEntities(text.slice(i));
      break;
    }
    if (lt > i) stack[stack.length - 1].text += decodeEntities(text.slice(i, lt));
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt);
      stack[stack.length - 1].text += text.slice(lt + 9, end < 0 ? n : end);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (text.startsWith('<?', lt) || text.startsWith('<!', lt)) {
      const end = text.indexOf('>', lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const gt = findTagEnd(text, lt + 1);
    if (gt < 0) break;
    const inner = text.slice(lt + 1, gt);
    i = gt + 1;
    if (inner.startsWith('/')) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const selfClose = inner.endsWith('/');
    const body = selfClose ? inner.slice(0, -1) : inner;
    // split name / attrs
    let sp = 0;
    while (sp < body.length && !/[\s]/.test(body[sp])) sp++;
    const name = body.slice(0, sp);
    const attrText = body.slice(sp);
    const attrs = {};
    const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(attrText))) attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? '');
    const node = { name, attrs, children: [], text: '' };
    if (++nodes > 100000 || stack.length > 64) throw new Error('DASH XML structure exceeds supported limit');
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

const kids = (node, name) => node.children.filter(c => c.name === name);
const kid = (node, name) => node.children.find(c => c.name === name);
const num = (v, d = 0) => {
  if (v === undefined || v === null || v === '') return d;
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
};

/** Expand a SegmentTimeline into [{t, duration, repeat}] entries. */
function expandTimeline(tl, timescale) {
  const out = [];
  if (!tl) return out;
  for (const s of kids(tl, 'S')) {
    out.push({
      t: s.attrs.t !== undefined ? num(s.attrs.t) : null,
      d: num(s.attrs.d),
      r: num(s.attrs.r, 0),
    });
  }
  return out;
}

function substitute(url, repId, number, time) {
  const padded = (value, width) => {
    if (Number(width) > 64) throw new Error('DASH template padding exceeds supported limit');
    return String(value).padStart(Number(width), '0');
  };
  return url
    .replace(/\$RepresentationID\$/g, repId)
    .replace(/\$Number%0(\d+)d\$/g, (_, w) => padded(number, w))
    .replace(/\$Number\$/g, String(number))
    .replace(/\$Time%0(\d+)d\$/g, (_, w) => padded(time, w))
    .replace(/\$Time\$/g, String(time));
}

const abs = (uri, base) => {
  try { return new URL(uri, base).href; } catch { return uri; }
};

const inheritedBase = (node, parent) => {
  const value = kid(node, 'BaseURL')?.text.trim();
  return value ? abs(value, parent) : parent;
};

/** Collect segment refs from a SegmentTemplate element. */
function segmentsFromTemplate(st, rep, baseUrl, budget) {
  const timescale = num(st.attrs.timescale, 1) || 1;
  const media = st.attrs.media || '';
  const initTpl = st.attrs.initialization || '';
  const startNumber = num(st.attrs.startNumber, 1);
  const duration = num(st.attrs.duration, 0); // in timescale units
  const presentationOffset = num(st.attrs.presentationTimeOffset, 0);
  const timeline = kid(st, 'SegmentTimeline');
  const repId = rep.attrs.id || '';
  const segments = [];
  let initUrl = null;
  if (initTpl) initUrl = abs(substitute(initTpl, repId, startNumber, 0), baseUrl);
  accountUrl(initUrl, budget);

  if (timeline) {
    const entries = expandTimeline(timeline, timescale);
    let curTime = entries.length && entries[0].t != null ? entries[0].t : 0;
    for (const [index, e] of entries.entries()) {
      if (e.t != null) curTime = e.t;
      if (!(e.d > 0)) throw new Error('invalid DASH segment duration');
      const end = entries[index + 1]?.t ?? (rep._periodDuration ? rep._periodDuration * timescale + presentationOffset : 0);
      const count = e.r >= 0 ? e.r + 1 : Math.ceil((end - curTime) / e.d);
      if (e.r < 0 && !(count > 0)) throw new Error('DASH repeat has no finite end');
      checkSegmentCount(budget.count + count);
      for (let k = 0; k < count; k++) {
        const url = abs(substitute(media, repId, startNumber + segments.length, curTime), baseUrl);
        addSegment(segments, { url, duration: e.d / timescale, number: startNumber + segments.length, time: curTime }, budget);
        curTime += e.d;
      }
    }
  } else if (media && duration > 0) {
    // static MPD without timeline: derive count from period duration
    // caller may pass rep.durationHint; default to a single segment if unknown
    const segs = num(rep._segmentCountHint, 0);
    checkSegmentCount(budget.count + segs);
    if (segs > 0) {
      for (let i = 0; i < segs; i++) {
        const n0 = startNumber + i;
        addSegment(segments, { url: abs(substitute(media, repId, n0, 0), baseUrl), duration: duration / timescale, number: n0 }, budget);
      }
    } else {
      const n0 = startNumber;
      addSegment(segments, { url: abs(substitute(media, repId, n0, 0), baseUrl), duration: duration / timescale, number: n0 }, budget);
    }
  }
  return { initUrl, segments };
}

/** Collect segment refs from a SegmentList element. */
function segmentsFromList(sl, rep, baseUrl, budget) {
  const init = kid(sl, 'Initialization');
  const initUrl = init && init.attrs.sourceURL ? abs(init.attrs.sourceURL, baseUrl) : null;
  accountUrl(initUrl, budget);
  const segments = [];
  for (const su of kids(sl, 'SegmentURL')) {
    if (!su.attrs.media) continue;
    addSegment(segments, {
      url: abs(su.attrs.media, baseUrl),
      duration: num(su.attrs.duration, 0),
      mediaRange: su.attrs.mediaRange || null,
    }, budget);
  }
  return { initUrl, segments };
}

/** Collect segment ref from a SegmentBase element (whole file, index ignored). */
function segmentsFromBase(sb, rep, baseUrl, budget) {
  const init = kid(sb, 'Initialization');
  let initUrl = init && init.attrs.sourceURL ? abs(init.attrs.sourceURL, baseUrl) : null;
  // SegmentBase downloads the whole representation (including its init range).
  // Prepending that same file as an init would duplicate the MP4 headers/media.
  const url = abs(rep._baseUrl || rep.attrs._base || '', baseUrl);
  accountUrl(initUrl, budget);
  const segments = [];
  if (url) addSegment(segments, { url, duration: 0 }, budget);
  return { initUrl, segments };
}

/**
 * Parse an MPD document.
 * @returns {{live:boolean, durationSec:number, minimumUpdatePeriodSec:number,
 *   representations:Array, audioRepresentations:Array}}
 * representation: {id, bandwidth, width, height, frameRate, codecs, mimeType,
 *   audioSamplingRate, segments:[{url,duration?}], initUrl?, baseUrl?}
 */
export function parseMpd(text, baseUrl) {
  const tree = parseXml(text);
  const mpd = tree.children.find(c => c.name === 'MPD');
  if (!mpd) throw new Error('not a valid MPD document (no <MPD> root)');

  const live = (mpd.attrs.type || 'static') === 'dynamic';
  let durationSec = 0;
  if (mpd.attrs.mediaPresentationDuration) {
    durationSec = parseDuration(mpd.attrs.mediaPresentationDuration);
  } else if (mpd.attrs.duration) {
    durationSec = parseDuration(mpd.attrs.duration);
  }
  const minimumUpdatePeriodSec = mpd.attrs.minimumUpdatePeriod
    ? parseDuration(mpd.attrs.minimumUpdatePeriod) : 0;

  const representations = [];
  const audioRepresentations = [];
  const budget = { count: 0, characters: 0 };
  const mpdBase = inheritedBase(mpd, baseUrl);

  const periods = kids(mpd, 'Period');
  for (const period of periods) {
    const periodBase = inheritedBase(period, mpdBase);
    let periodDur = durationSec;
    if (period.attrs.duration) periodDur = parseDuration(period.attrs.duration);
    const sets = kids(period, 'AdaptationSet');
    for (const as of sets) {
      const adaptationBase = inheritedBase(as, periodBase);
      const asMime = as.attrs.mimeType || '';
      const asCodecs = as.attrs.codecs || '';
      const reps = kids(as, 'Representation');
      for (const rep of reps) {
        rep._periodDuration = periodDur;
        const mime = rep.attrs.mimeType || asMime;
        const codecs = rep.attrs.codecs || asCodecs;
        const width = num(rep.attrs.width, num(as.attrs.width, 0));
        const height = num(rep.attrs.height, num(as.attrs.height, 0));
        const bandwidth = num(rep.attrs.bandwidth, 0);
        const entry = {
          id: rep.attrs.id || `r${representations.length + audioRepresentations.length}`,
          bandwidth,
          width, height,
          frameRate: rep.attrs.frameRate || as.attrs.frameRate || '',
          codecs,
          mimeType: mime,
          audioSamplingRate: rep.attrs.audioSamplingRate || as.attrs.audioSamplingRate || undefined,
          segments: [],
          initUrl: null,
        };

        // segment info can live on Representation or be inherited from AdaptationSet
        let st = kid(rep, 'SegmentTemplate') || kid(as, 'SegmentTemplate');
        let sl = kid(rep, 'SegmentList') || kid(as, 'SegmentList');
        let sb = kid(rep, 'SegmentBase') || kid(as, 'SegmentBase');
        entry.baseUrl = inheritedBase(rep, adaptationBase);
        rep._baseUrl = entry.baseUrl;
        rep.attrs._base = rep._baseUrl;

        if (st) {
          // hint for count derivation on static template-without-timeline
          if (st.attrs.duration && periodDur) {
            const ts = num(st.attrs.timescale, 1) || 1;
            rep._segmentCountHint = Math.ceil(periodDur / (num(st.attrs.duration) / ts));
          }
          const r = segmentsFromTemplate(st, rep, rep._baseUrl, budget);
          entry.initUrl = r.initUrl;
          entry.segments = r.segments;
        } else if (sl) {
          const r = segmentsFromList(sl, rep, rep._baseUrl, budget);
          entry.initUrl = r.initUrl;
          entry.segments = r.segments;
        } else if (sb) {
          const r = segmentsFromBase(sb, rep, rep._baseUrl, budget);
          entry.initUrl = r.initUrl;
          entry.segments = r.segments;
        } else {
          // plain BaseURL -> single segment
          if (rep._baseUrl) addSegment(entry.segments, { url: rep._baseUrl, duration: periodDur }, budget);
        }

        const isAudio = (mime || '').startsWith('audio') ||
          (!width && !height && (mime || codecs).indexOf('video') !== 0 && /audio|mp4a|opus|ac-3|ec-3/i.test(mime + codecs));
        if (isAudio && !width && !height) audioRepresentations.push(entry);
        else representations.push(entry);
      }
    }
  }

  return { live, durationSec, minimumUpdatePeriodSec, representations, audioRepresentations };
}

/** Parse ISO 8601 duration (PnDTnHnMnS) -> seconds. */
export function parseDuration(s) {
  if (!s) return 0;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s); // bare seconds
  const m = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s);
  if (!m) return 0;
  return Number(m[1] || 0) * 31557600 +
    Number(m[2] || 0) * 2629800 +
    Number(m[3] || 0) * 86400 +
    Number(m[4] || 0) * 3600 +
    Number(m[5] || 0) * 60 +
    Number(m[6] || 0);
}
