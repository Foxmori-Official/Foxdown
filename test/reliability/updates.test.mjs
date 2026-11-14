import assert from 'node:assert/strict';
import test from 'node:test';
import { checkReleaseUpdate } from '../../extension/release-updates.mjs';

const releases = 'https://github.com/Foxmori-Official/Foxdown/releases';
const stableRelease = { ok: true, url: `${releases}/tag/v0.0.10` };

test('checks for updates numerically and links only to the Foxdown repository', async () => {
  const update = await checkReleaseUpdate('0.0.9', async (url, options) => {
    assert.equal(url, `${releases}/latest`);
    assert.equal(options.method, 'HEAD');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers, undefined);
    return stableRelease;
  });
  assert.deepEqual(update, {
    version: '0.0.10', available: true,
    releaseUrl: 'https://github.com/Foxmori-Official/Foxdown/releases/tag/v0.0.10',
    extensionUrl: 'https://github.com/Foxmori-Official/Foxdown/releases/download/v0.0.10/Foxdown-extension.zip',
  });
  for (const installed of ['0.0.10', '0.0.11', '1.0.0']) {
    assert.equal((await checkReleaseUpdate(installed, async () => stableRelease)).available, false);
  }
});

test('network failures and invalid release metadata do not appear as a current version', async () => {
  await assert.rejects(checkReleaseUpdate('0.0.2', async () => new Response(null, { status: 403 })), /403/);
  await assert.rejects(checkReleaseUpdate('0.0.2', async () => { throw new Error('offline'); }), /offline/);
  for (const url of [`${releases}/latest`, `${releases}/tag/v0.0.3\n`, `${releases}/tag/v0.0.3-beta`,
    `${releases}/tag/v0.0.3?other`, 'https://untrusted.invalid/releases/tag/v0.0.3']) {
    await assert.rejects(checkReleaseUpdate('0.0.2', async () => ({ ok: true, url })), /Invalid Foxdown/);
  }
});
