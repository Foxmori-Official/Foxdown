import fs from 'node:fs';
import path from 'node:path';

// Resolve existing ancestors as well, so a new path below a symlink cannot
// escape the selected download directory.
export async function canonicalPath(target) {
  const absolute = path.resolve(target);
  try { return await fs.promises.realpath(absolute); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const entry = await fs.promises.lstat(absolute).catch(() => null);
    if (entry?.isSymbolicLink()) {
      const link = await fs.promises.readlink(absolute);
      return canonicalPath(path.resolve(path.dirname(absolute), link));
    }
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(await canonicalPath(parent), path.basename(absolute));
  }
}

export async function isWithinDirectory(target, directory) {
  const [resolved, base] = await Promise.all([canonicalPath(target), canonicalPath(directory)]);
  const relative = path.relative(base, resolved);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

export async function reserveOutputPath(directory, filename) {
  await fs.promises.mkdir(directory, { recursive: true });
  const { name, ext } = path.parse(filename);
  for (let index = 0; index < 10000; index++) {
    const candidate = index ? `${name} (${index})${ext}` : filename;
    const output = path.join(directory, candidate);
    try {
      const handle = await fs.promises.open(output, 'wx');
      await handle.close();
      return output;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('could not allocate a unique output filename');
}
