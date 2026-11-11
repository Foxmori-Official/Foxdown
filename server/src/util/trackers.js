const FALLBACK_SOURCES = [
  'https://fastly.jsdelivr.net/gh/ngosang/trackerslist@master/trackers_best.txt',
  'https://gcore.jsdelivr.net/gh/ngosang/trackerslist@master/trackers_best.txt',
  'https://testingcf.jsdelivr.net/gh/ngosang/trackerslist@master/trackers_best.txt',
  'https://trackerslist.com/best.txt',
];

/** Fetch the best-tracker list, trying the configured source then fallbacks. */
export async function fetchTrackerList(primarySource) {
  const sources = [primarySource, ...FALLBACK_SOURCES].filter(Boolean);
  let lastErr;
  for (const src of [...new Set(sources)]) {
    try {
      const resp = await fetch(src, { signal: AbortSignal.timeout(12000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const trackers = resp.text ? (await resp.text()).split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')) : [];
      if (!trackers.length) throw new Error('empty list');
      // truncate to stay under Windows command-line length limits (Motrix lesson)
      let joined = '';
      for (const t of trackers) { if ((joined + ',' + t).length > 6000) break; joined = joined ? joined + ',' + t : t; }
      return { source: src, trackers: joined, count: joined.split(',').length };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('all tracker sources failed');
}
