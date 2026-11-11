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

/** Tiny tolerant XML tokenizer -> { name, attrs, children, text } tree. */
function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      stack[stack.length - 1].text += text.slice(i);
      break;
    }
    if (lt > i) stack[stack.length - 1].text += text.slice(i, lt);
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
    const gt = text.indexOf('>', lt);
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
    while ((m = re.exec(attrText))) attrs[m[1]] = m[2] ?? m[3] ?? '';
    const node = { name, attrs, children: [], text: '' };
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
  return url
    .replace(/\$RepresentationID\$/g, repId)
    .replace(/\$Number%0(\d+)d\$/g, (_, w) => String(number).padStart(Number(w), '0'))
    .replace(/\$Number\$/g, String(number))
    .replace(/\$Time%0(\d+)d\$/g, (_, w) => String(time).padStart(Number(w), '0'))
    .replace(/\$Time\$/g, String(time));
}

const abs = (uri, base) => {
  try { return new URL(uri, base).href; } catch { return uri; }
};

/** Collect segment refs from a SegmentTemplate element. */
function segmentsFromTemplate(st, rep, baseUrl) {
  const timescale = num(st.attrs.timescale, 1) || 1;
  const media = st.attrs.media || '';
  const initTpl = st.attrs.initialization || '';
  const startNumber = num(st.attrs.startNumber, 1);
  const duration = num(st.attrs.duration, 0); // in timescale units
  const timeline = kid(st, 'SegmentTimeline');
  const repId = rep.attrs.id || '';
  const segments = [];
  let initUrl = null;
  if (initTpl) initUrl = abs(substitute(initTpl, repId, startNumber, 0), baseUrl);

  if (timeline) {
    const entries = expandTimeline(timeline, timescale);
    let curTime = entries.length && entries[0].t != null ? entries[0].t : 0;
    for (const e of entries) {
      if (e.t != null) curTime = e.t;
      const count = e.r >= 0 ? e.r + 1 : 1;
      for (let k = 0; k < count; k++) {
        const url = abs(substitute(media, repId, startNumber + segments.length, curTime), baseUrl);
        segments.push({ url, duration: e.d / timescale, number: startNumber + segments.length, time: curTime });
        curTime += e.d;
      }
    }
  } else if (media && duration > 0) {
    // static MPD without timeline: derive count from period duration
    // caller may pass rep.durationHint; default to a single segment if unknown
    const segs = num(rep._segmentCountHint, 0);
    if (segs > 0) {
      for (let i = 0; i < segs; i++) {
        const n0 = startNumber + i;
        segments.push({ url: abs(substitute(media, repId, n0, 0), baseUrl), duration: duration / timescale, number: n0 });
      }
    } else {
      const n0 = startNumber;
      segments.push({ url: abs(substitute(media, repId, n0, 0), baseUrl), duration: duration / timescale, number: n0 });
    }
  }
  return { initUrl, segments };
}

/** Collect segment refs from a SegmentList element. */
function segmentsFromList(sl, rep, baseUrl) {
  const init = kid(sl, 'Initialization');
  const initUrl = init && init.attrs.sourceURL ? abs(init.attrs.sourceURL, baseUrl) : null;
  const segments = [];
  for (const su of kids(sl, 'SegmentURL')) {
    if (!su.attrs.media) continue;
    segments.push({
      url: abs(su.attrs.media, baseUrl),
      duration: num(su.attrs.duration, 0),
      mediaRange: su.attrs.mediaRange || null,
    });
  }
  return { initUrl, segments };
}

/** Collect segment ref from a SegmentBase element (whole file, index ignored). */
function segmentsFromBase(sb, rep, baseUrl) {
  const init = kid(sb, 'Initialization');
  let initUrl = init && init.attrs.sourceURL ? abs(init.attrs.sourceURL, baseUrl) : null;
  if (!initUrl && init && init.attrs.range) {
    // range-limited init on the representation URL itself; keep rep URL
    initUrl = abs(rep.attrs._base || '', baseUrl);
  }
  const url = abs(rep._baseUrl || rep.attrs._base || '', baseUrl);
  return { initUrl, segments: url ? [{ url, duration: 0 }] : [] };
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

  const periods = kids(mpd, 'Period');
  for (const period of periods) {
    let periodDur = durationSec;
    if (period.attrs.duration) periodDur = parseDuration(period.attrs.duration);
    const sets = kids(period, 'AdaptationSet');
    for (const as of sets) {
      const asMime = as.attrs.mimeType || '';
      const asCodecs = as.attrs.codecs || '';
      const reps = kids(as, 'Representation');
      for (const rep of reps) {
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
        const base = kid(rep, 'BaseURL') || kid(as, 'BaseURL');
        if (base && base.text.trim()) {
          entry.baseUrl = abs(base.text.trim(), baseUrl);
          rep._baseUrl = entry.baseUrl;
        } else {
          rep._baseUrl = baseUrl;
        }
        rep.attrs._base = rep._baseUrl;

        if (st) {
          // hint for count derivation on static template-without-timeline
          if (!st.attrs.duration && periodDur && st.attrs.duration) { /* noop */ }
          if (st.attrs.duration && periodDur) {
            const ts = num(st.attrs.timescale, 1) || 1;
            rep._segmentCountHint = Math.ceil(periodDur / (num(st.attrs.duration) / ts));
          }
          const r = segmentsFromTemplate(st, rep, rep._baseUrl);
          entry.initUrl = r.initUrl;
          entry.segments = r.segments;
        } else if (sl) {
          const r = segmentsFromList(sl, rep, rep._baseUrl);
          entry.initUrl = r.initUrl;
          entry.segments = r.segments;
        } else if (sb) {
          const r = segmentsFromBase(sb, rep, rep._baseUrl);
          entry.initUrl = r.initUrl;
          entry.segments = r.segments;
        } else {
          // plain BaseURL -> single segment
          if (rep._baseUrl) entry.segments = [{ url: rep._baseUrl, duration: periodDur }];
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
