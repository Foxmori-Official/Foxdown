import { DEFAULT_SETTINGS } from './config.js';

const ranges = {
  maxConcurrentDownloads: [1, 1000], maxConnectionPerServer: [1, 64], split: [1, 64],
  rpcPort: [1, 65535], listenPort: [1, 65535], streamThreadCount: [1, 64],
  streamRetryCount: [0, 20], streamTimeoutMs: [1000, 300000],
  activeSpeedProfile: [-1, Number.MAX_SAFE_INTEGER],
};

export function validateSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('settings must be an object');
  const clean = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) throw new Error(`unknown setting: ${key}`);
    const expected = DEFAULT_SETTINGS[key];
    if (Array.isArray(expected)) {
      if (!Array.isArray(value) || value.length > 100 || value.some(profile =>
        !profile || typeof profile.name !== 'string' || !profile.name.trim() || profile.name.length > 200 ||
        !Number.isSafeInteger(profile.down) || profile.down < 0 || !Number.isSafeInteger(profile.up) || profile.up < 0)) {
        throw new Error('invalid speedProfiles');
      }
      clean[key] = value.map(({ name, down, up }) => ({ name, down, up }));
      continue;
    }
    if (typeof value !== typeof expected) throw new Error(`${key} must be a ${typeof expected}`);
    if (typeof value === 'number') {
      const [minimum, maximum] = ranges[key] || [0, Number.MAX_SAFE_INTEGER];
      if (!Number.isFinite(value) || value < minimum || value > maximum ||
          (key !== 'seedRatio' && !Number.isSafeInteger(value))) throw new Error(`invalid ${key}`);
    }
    if (typeof value === 'string' && (value.length > 65536 || /[\x00-\x1f\x7f]/.test(value))) throw new Error(`invalid ${key}`);
    clean[key] = value;
  }
  if (clean.theme !== undefined && !['auto', 'light', 'dark'].includes(clean.theme)) throw new Error('invalid theme');
  if (clean.locale !== undefined && !['auto', 'en', 'zh-CN'].includes(clean.locale)) throw new Error('invalid locale');
  if (clean.fileAllocation !== undefined && !['none', 'prealloc', 'trunc', 'falloc'].includes(clean.fileAllocation)) {
    throw new Error('invalid fileAllocation');
  }
  for (const key of ['minSplitSize', 'diskCache']) {
    if (clean[key] === undefined) continue;
    const match = /^(\d+)([KM])?$/i.exec(clean[key]);
    const bytes = match && Number(match[1]) * ({ K: 1024, M: 1024 ** 2 }[match[2]?.toUpperCase()] || 1);
    if (!match || !Number.isSafeInteger(bytes) || (key === 'minSplitSize' && (bytes < 1024 || bytes > 1024 ** 3))) {
      throw new Error(`invalid ${key}`);
    }
  }
  if (clean.downloadDir !== undefined && !clean.downloadDir.trim()) throw new Error('downloadDir is required');
  for (const key of ['webhookUrl', 'btTrackerSource']) {
    if (clean[key] && !['http:', 'https:'].includes(new URL(clean[key]).protocol)) throw new Error(`invalid ${key}`);
  }
  return clean;
}
