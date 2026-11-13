import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);

async function replaceFile(temporary, file) {
  for (let attempt = 0; ; attempt++) {
    try { return await fs.rename(temporary, file); }
    catch (error) {
      // Windows readers and virus scanners can briefly lock either file.
      // Keep the existing destination intact while retrying the same rename.
      if (!TRANSIENT_RENAME_ERRORS.has(error.code) || attempt >= 8) throw error;
      await delay(Math.min(15 * 2 ** attempt + 7, 250));
    }
  }
}

export async function writeJsonAtomic(file, data) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
    await replaceFile(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
