import test from 'node:test';
import assert from 'node:assert/strict';
import { isolateServer } from '../helpers/server-fixture.mjs';

test('page resolver presents complete videos and keeps their discovery order', async t => {
  isolateServer(t);
  const { pageVideoResources } = await import('../../server/src/media/yt-dlp.js');
  const base = 'https://media.example.test/';
  const manifest = base + 'playlist?format=hls';
  const source = { title: 'First video', formats: [
    { url: base + '720.mp4', protocol: 'https', ext: 'mp4', width: 1280, height: 720 },
    { url: base + '2160-video.mp4', protocol: 'https', ext: 'mp4', width: 3840, height: 2160, acodec: 'none' },
    { url: base + 'audio-track', manifest_url: manifest, protocol: 'm3u8_native', vcodec: 'none', acodec: 'aac' },
    { url: base + '1080-track', manifest_url: manifest, protocol: 'm3u8_native', ext: 'mp4',
      width: 1920, height: 1080, vcodec: 'avc1', acodec: 'none' },
  ] };
  const second = { title: 'Second video', formats: [
    { url: base + 'file.ogv', protocol: 'https', ext: 'ogv' },
    { url: base + 'file.mp4', protocol: 'https', ext: 'mp4', http_headers: {
      'User-Agent': 'resolver test', Referer: 'https://page.example.test/watch',
      Cookie: 'fixture-auth=secret', Authorization: 'fixture-auth',
    } },
  ] };
  const videos = pageVideoResources([source, second, { ...second, title: 'Duplicate' }]);
  assert.deepEqual(videos.map(video => [video.url, video.type]), [[manifest, 'HLS'], [base + 'file.mp4', 'MP4']]);
  assert.equal(videos[1].filename, 'Second video.mp4');
  assert.deepEqual(videos[1].headers, { 'user-agent': 'resolver test', referer: 'https://page.example.test/watch' });
  assert.deepEqual(pageVideoResources([{ formats: [source.formats[1], source.formats[3]] }]), []);
});
