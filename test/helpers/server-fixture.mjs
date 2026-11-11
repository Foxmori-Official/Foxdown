import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Must run before importing modules that load config.js. Never use real user
// settings, download directories, binaries, trackers or external services.
export function isolateServer(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rdown-regression-'));
  const previous = {};
  for (const key of ['DATA_DIR', 'DOWNLOAD_DIR']) {
    previous[key] = process.env[key];
    process.env[key] = path.join(root, key);
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
