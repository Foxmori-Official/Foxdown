/**
 * Mux/remux helpers: ffmpeg-based remux to MP4 / track muxing to MKV,
 * with a pure-binary TS concat fallback when ffmpeg is unavailable.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { FFMPEG_BIN, hasFfmpeg } from '../config.js';

/** Binary concat of files -> outFile. Returns outFile. */
export async function concatFiles(inputFiles, outFile) {
  await fs.promises.mkdir(path.dirname(outFile), { recursive: true });
  const out = await fs.promises.open(outFile, 'w');
  try {
    for (const f of inputFiles) {
      const src = await fs.promises.open(f, 'r');
      try {
        const { size } = await src.stat();
        const buf = Buffer.alloc(Math.min(size, 8 * 1024 * 1024));
        let pos = 0;
        while (pos < size) {
          const { bytesRead } = await src.read(buf, 0, buf.length, pos);
          if (bytesRead <= 0) break;
          await out.write(buf, 0, bytesRead);
          pos += bytesRead;
        }
      } finally {
        await src.close();
      }
    }
  } finally {
    await out.close();
  }
  return outFile;
}

/** Run ffmpeg, capture stderr, reject on non-zero exit. */
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args, { windowsHide: true });
    let stderr = '';
    let stdout = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

/**
 * Remux (concatenated) TS input(s) into an MP4.
 * Without ffmpeg, binary-concatenates into a `.ts` file instead.
 * @returns {Promise<string>} the actual output path
 */
export async function remuxToMp4(inputFiles, outFile) {
  if (!hasFfmpeg()) {
    const tsOut = outFile.replace(/\.mp4$/i, '.ts');
    return concatFiles(inputFiles, tsOut);
  }
  await fs.promises.mkdir(path.dirname(outFile), { recursive: true });
  const args = ['-y'];
  for (const f of inputFiles) args.push('-i', f);
  args.push('-c', 'copy');
  // H.264 in TS uses ADTS AAC audio; MP4 needs ASC headers
  args.push('-bsf:a', 'aac_adtstoasc');
  args.push('-movflags', '+faststart', outFile);
  await runFfmpeg(args);
  return outFile;
}

/**
 * Mux a separate video file and audio file into a container (MKV).
 * @returns {Promise<string>} the actual output path
 */
export async function muxTracks(videoFile, audioFile, outFile) {
  if (!hasFfmpeg()) {
    // no way to interleave; keep video stream only
    const fallback = outFile.replace(/\.mkv$/i, '.m4s.mp4');
    await fs.promises.copyFile(videoFile, fallback);
    return fallback;
  }
  await fs.promises.mkdir(path.dirname(outFile), { recursive: true });
  const args = ['-y', '-i', videoFile, '-i', audioFile, '-c', 'copy'];
  if (/\.(mp4|mov|m4v)$/i.test(outFile)) args.push('-movflags', '+faststart');
  args.push(outFile);
  await runFfmpeg(args);
  return outFile;
}
