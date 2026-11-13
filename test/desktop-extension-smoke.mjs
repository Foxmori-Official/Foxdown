import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import playwright from 'playwright';
const require = createRequire(import.meta.url);

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'foxdown-ui-'));
const shots = process.env.FOXDOWN_SCREENSHOT_DIR || path.join(temp, 'screenshots');
await fs.mkdir(shots, { recursive: true });
const chrome = process.env.FOXDOWN_CHROME_PATH || playwright.chromium.executablePath();
async function freePort() {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const port = await freePort();
const origin = 'http://127.0.0.1:' + port;
const data = path.join(temp, 'data');
const downloads = path.join(temp, 'downloads');
const engineDir = process.env.FOXDOWN_TEST_ENGINES || path.join(root, 'bin', (process.platform === 'darwin' ? 'mac' : 'win') + '-' + process.arch);
const token = 'foxdown-ui-fixture';
await fs.mkdir(data);
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({
  locale: 'en', btTrackerAutoUpdate: false, enableDht: false, btEnableLpd: false, rpcPort: await freePort(),
}));
let desktop;
let browser;
let mediaFixture;
try {
  const packagedDirectory = process.platform === 'darwin'
    ? (process.arch === 'arm64' ? 'mac-arm64' : 'mac')
    : (process.arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked');
  const packaged = process.env.FOXDOWN_PACKAGED_EXE || (process.env.FOXDOWN_TEST_PACKAGED === '1'
    ? path.join(root, 'dist-electron', packagedDirectory, process.platform === 'darwin'
      ? 'Foxdown.app/Contents/MacOS/Foxdown' : 'Foxdown.exe') : undefined);
  const env = { ...process.env, FOXDOWN_PORT: String(port), DATA_DIR: data, DOWNLOAD_DIR: downloads, API_TOKEN: token };
  if (!packaged) env.FOXDOWN_BIN_DIR = engineDir;
  desktop = await playwright._electron.launch({
    executablePath: packaged || require('electron'),
    args: [...(packaged ? [] : [root]), '--user-data-dir=' + path.join(temp, 'desktop-profile')],
    cwd: root,
    env,
  });

  const app = await desktop.firstWindow();
  const jsErrors = [];
  app.on('pageerror', error => jsErrors.push(error.message));
  try { await app.waitForURL(origin + '/', { timeout: 20000 }); }
  catch (error) { console.error(await app.locator('body').innerText()); throw error; }
  await app.locator('.conn-status.unauthorized').waitFor();
  await app.locator('#connectionToken').fill(token);
  await app.locator('.connection-card button[type=submit]').click();
  await app.locator('.conn-status.online').waitFor();
  const packageBin = packaged ? (process.platform === 'darwin'
    ? path.join(path.dirname(path.dirname(packaged)), 'Resources/runtime/bin')
    : path.join(path.dirname(packaged), 'resources/runtime/bin')) : engineDir;
  await fs.access(path.join(packageBin, process.platform === 'darwin' ? 'media/bin/ffprobe' : 'ffprobe.exe'));
  const settingsToggle = app.getByRole('button', { name: 'Settings', exact: true });
  await settingsToggle.click();
  const settingsNavigation = app.locator('.side-nav .settings-subnav');
  await settingsNavigation.waitFor();
  await app.getByRole('tabpanel').first().waitFor();
  assert.equal(await settingsToggle.getAttribute('aria-expanded'), 'true');
  await settingsToggle.click();
  assert.equal(await settingsNavigation.isVisible(), false);
  assert.equal(await app.getByRole('tabpanel').count(), 1, 'Collapsing the sidebar must keep the current settings panel');
  await settingsToggle.click();
  await settingsNavigation.waitFor();
  const settingsTabs = settingsNavigation.getByRole('tab');
  assert.equal(await settingsTabs.count(), 7);
  const sidebarLayout = await app.evaluate(() => {
    const sidebar = document.querySelector('.side-nav').getBoundingClientRect();
    const workspace = document.querySelector('.main-area').getBoundingClientRect();
    return { direction: getComputedStyle(document.querySelector('.app-layout')).flexDirection,
      sidebarRight: sidebar.right, workspaceLeft: workspace.left,
      horizontalCategoryBars: document.querySelectorAll('.settings-view [role=tablist]').length };
  });
  assert.equal(sidebarLayout.direction, 'row');
  assert.ok(sidebarLayout.sidebarRight <= sidebarLayout.workspaceLeft + 1, JSON.stringify(sidebarLayout));
  assert.equal(sidebarLayout.horizontalCategoryBars, 0);
  for (const tab of await settingsTabs.all()) {
    await tab.click();
    assert.equal(await app.getByRole('tabpanel').count(), 1, 'Only the selected settings category should be visible');
    const overflow = await app.evaluate(() => [...document.querySelectorAll('.side-nav, .settings-subnav, .main-body, .settings-view, .settings-form, .group-card')]
      .filter(element => element.getBoundingClientRect().width > 0 && element.scrollWidth > element.clientWidth + 1)
      .map(element => ({ className: element.className, width: element.clientWidth, content: element.scrollWidth })));
    assert.deepEqual(overflow, [], 'Settings must fit the desktop window without horizontal scrolling');
  }
  await app.getByRole('tab', { name: 'RPC / Remote Access', exact: true }).click();
  await app.locator('#sec-rpc .el-switch').click();
  await app.locator('.el-message-box').waitFor();
  await delay(700);
  const pendingSettings = await (await fetch(origin + '/api/v1/settings', { headers: { Authorization: 'Bearer ' + token } })).json();
  assert.equal(pendingSettings.rpcListenAll, false, 'An unconfirmed switch must not autosave remote RPC access');
  await app.locator('.el-message-box').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await app.locator('#sec-rpc').getByRole('switch').getAttribute('aria-checked'), 'false');
  await app.getByRole('tab', { name: 'Application', exact: true }).click();
  await app.getByText('Open Foxdown at login', { exact: true }).waitFor();
  await app.getByRole('tab', { name: 'General', exact: true }).click();
  await settingsTabs.first().focus();
  await app.keyboard.press('ArrowDown');
  assert.equal(await app.getByRole('tab', { name: 'RPC / Remote Access', exact: true }).getAttribute('aria-selected'), 'true');
  await app.keyboard.press('Home');
  assert.equal(await settingsTabs.first().getAttribute('aria-selected'), 'true');
  await app.keyboard.press('ArrowLeft');
  assert.equal(await settingsToggle.getAttribute('aria-expanded'), 'false');
  await app.keyboard.press('ArrowRight');
  assert.equal(await settingsToggle.getAttribute('aria-expanded'), 'true');
  const concurrency = app.locator('#sec-basic .num-stepper input').first();
  await concurrency.fill('6');
  await app.getByRole('tab', { name: 'RPC / Remote Access', exact: true }).click();
  await app.getByRole('button', { name: 'Tasks', exact: true }).click();
  assert.equal(await settingsNavigation.isVisible(), false);
  for (let attempt = 0; ; attempt++) {
    const saved = await (await fetch(origin + '/api/v1/settings', { headers: { Authorization: 'Bearer ' + token } })).json();
    if (saved.maxConcurrentDownloads === 6) break;
    assert.ok(attempt < 30, 'Pending settings must still save after leaving the settings view');
    await delay(100);
  }
  await settingsToggle.click();
  assert.equal(await app.getByRole('tab', { name: 'RPC / Remote Access', exact: true }).getAttribute('aria-selected'), 'true');
  await app.getByRole('tab', { name: 'General', exact: true }).click();
  assert.equal(await concurrency.inputValue(), '6');
  await concurrency.fill('5');
  await settingsTabs.first().focus();
  // Download settings restart aria2; wait for the saved value and RPC readiness before testing the extension.
  for (let attempt = 0; ; attempt++) {
    const headers = { Authorization: 'Bearer ' + token };
    const [saved, health] = await Promise.all([
      fetch(origin + '/api/v1/settings', { headers }).then(response => response.json()),
      fetch(origin + '/api/v1/health', { headers }).then(response => response.json()),
    ]);
    if (saved.maxConcurrentDownloads === 5 && health.aria2) break;
    assert.ok(attempt < 100, 'Saved settings must leave the bundled download engine ready: ' + JSON.stringify(health));
    await delay(100);
  }
  const generalLayout = await app.evaluate(() => {
    const main = document.querySelector('.main-body');
    return { height: innerHeight, scrollHeight: main.scrollHeight, clientHeight: main.clientHeight,
      nestedScrollers: [...document.querySelectorAll('.settings-view, .settings-form, .group-card')].filter(element =>
        element.getBoundingClientRect().height > 0 && /auto|scroll/.test(getComputedStyle(element).overflowY)).length };
  });
  assert.equal(generalLayout.nestedScrollers, 0, 'Settings must use the main workspace scroll only');
  if (generalLayout.height >= 800) assert.ok(generalLayout.scrollHeight <= generalLayout.clientHeight + 1, JSON.stringify(generalLayout));
  await desktop.evaluate(({ dialog }, selected) => {
    globalThis.fixtureOpenDialog = dialog.showOpenDialog;
    globalThis.fixtureDialogCalls = [];
    dialog.showOpenDialog = async (_window, options) => {
      fixtureDialogCalls.push(options);
      return options.properties.includes('openFile') ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [selected] };
    };
  }, downloads);
  try {
    await app.locator('#sec-basic').getByRole('button', { name: 'Browse…', exact: true }).click();
    assert.equal(await app.locator('#sec-basic .el-input input').first().inputValue(), downloads);
    await app.getByRole('tab', { name: 'Post-processing', exact: true }).click();
    await app.locator('#sec-post').getByRole('button', { name: 'Browse…', exact: true }).click();
    assert.equal(await app.locator('#sec-post .el-input input').last().inputValue(), '');
    await app.getByRole('button', { name: 'Tasks', exact: true }).click();
    await app.getByRole('button', { name: 'New Task', exact: true }).click();
    const newTask = app.getByRole('dialog');
    await newTask.locator('.el-collapse-item__header').click();
    await newTask.getByRole('button', { name: 'Browse…', exact: true }).click();
    assert.equal(await newTask.locator('.el-collapse-item__content .el-input input').first().inputValue(), downloads);
    await newTask.getByRole('button', { name: 'Cancel', exact: true }).click();
    await settingsToggle.click();
    await app.getByRole('tab', { name: 'General', exact: true }).click();
  } finally {
    await desktop.evaluate(({ dialog }) => {
      dialog.showOpenDialog = fixtureOpenDialog;
      delete globalThis.fixtureOpenDialog;
    });
  }
  const dialogCalls = await desktop.evaluate(() => fixtureDialogCalls);
  assert.deepEqual(dialogCalls.map(call => call.properties), [
    ['openDirectory', 'createDirectory'], ['openFile'], ['openDirectory', 'createDirectory'],
  ]);
  await app.screenshot({ path: path.join(shots, 'settings.png'), animations: 'disabled' });
  await app.getByRole('button', { name: 'Tasks', exact: true }).click();
  await app.getByRole('tab', { name: 'All', exact: true, selected: true }).waitFor();
  console.log(`Electron ${packaged ? 'packaged app' : 'host development runtime'} passed: expandable sidebar settings, category memory, pending autosave and login controls.`);

  await fs.mkdir(path.join(temp, 'browser/Default'), { recursive: true });
  await fs.writeFile(path.join(temp, 'browser/Default/Preferences'), JSON.stringify({ download: { default_directory: path.join(temp, 'browser-downloads'), prompt_for_download: false } }));
  browser = await playwright.chromium.launchPersistentContext(path.join(temp, 'browser'), {
    executablePath: chrome,
    headless: true,
    locale: 'en-US',
    viewport: { width: 1120, height: 820 },
    downloadsPath: path.join(temp, 'browser-downloads'),
    acceptDownloads: true,
    args: ['--disable-extensions-except=' + path.join(root, 'extension'), '--load-extension=' + path.join(root, 'extension')],
    ignoreDefaultArgs: ['--disable-extensions'],
  });

  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker', { timeout: 15000 });
  const extension = new URL(worker.url()).origin;
  // chrome-extension URLs are parsed as opaque origins by Node URL.
  const extensionBase = worker.url().slice(0, worker.url().lastIndexOf('/'));
  assert.ok(extensionBase.startsWith('chrome-extension://'), extension);
  const guide = browser.pages().find(page => page.url().endsWith('/onboarding.html')) || await browser.newPage();
  if (!guide.url().endsWith('/onboarding.html')) await guide.goto(extensionBase + '/onboarding.html');
  await guide.waitForFunction(() => document.getElementById('serverUrl').value.length > 0);
  await guide.locator('#serverUrl').fill(origin);
  assert.ok(await guide.locator('#nextBtn').isDisabled());
  await guide.locator('#testBtn').click();
  await guide.getByText('Check the Web API token in Foxdown’s settings.', { exact: true }).waitFor();
  await guide.locator('#apiToken').fill(token);
  await guide.locator('#testBtn').click();
  await guide.locator('.test-state.ok').waitFor();
  await guide.screenshot({ path: path.join(shots, 'extension-guide.png'), animations: 'disabled' });
  await guide.locator('#nextBtn').click();
  await guide.locator('#nextBtn').click();
  const nextTab = browser.waitForEvent('page');
  await guide.locator('#demoBtn').click();
  const demo = await nextTab;
  await demo.waitForURL(origin + '/demo.html');
  const session = await browser.newCDPSession(demo);
  // Playwright's allowAndName behavior bypasses Chrome's filename interception event.
  await session.send('Browser.setDownloadBehavior', { behavior: 'default' });
  await worker.evaluate(() => {
    globalThis.fixtureDownloadEvents = [];
    chrome.downloads.onCreated.addListener(item => fixtureDownloadEvents.push({ created: item.url, id: item.id }));
  });
  await demo.locator('a[href="/api/v1/demo-file"]').click({ noWaitAfter: true });
  await guide.locator('#finishBtn').click();
  await guide.locator('[data-step="done"]').waitFor();

  const result = await app.locator('.task-name').filter({ hasText: /Foxdown-demo-file\.bin/ }).first();
  try { await result.waitFor({ timeout: 12000 }); }
  catch (error) {
    console.error('Extension cfg', await worker.evaluate(() => cfg()));
    console.error('Download events', await worker.evaluate(() => fixtureDownloadEvents));
    console.error('Downloads', await worker.evaluate(() => chrome.downloads.search({})));
    console.error('Backend tasks', await app.evaluate(async token => (await fetch('/api/v1/tasks', {headers:{Authorization: 'Bearer '+token}})).json(), token));
    throw error;
  }
  let length = 0;
  for (let attempt = 0; attempt < 30; attempt++) {
    length = await fs.stat(path.join(downloads, 'Foxdown-demo-file.bin')).then(stat => stat.size).catch(() => 0);
    if (length === 128 * 1024) break;
    await delay(250);
  }
  assert.equal(length, 128 * 1024);
  await app.screenshot({ path: path.join(shots, 'tasks.png'), animations: 'disabled' });
  const clearCompleted = app.getByRole('button', { name: 'Clear completed tasks', exact: true });
  await clearCompleted.click();
  const clearDialog = app.locator('.el-message-box');
  await clearDialog.getByText('Downloaded files will stay on disk.', { exact: false }).waitFor();
  await clearDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await result.isVisible(), true);
  await clearCompleted.click();
  await clearDialog.getByRole('button', { name: 'Clear records', exact: true }).click();
  await result.waitFor({ state: 'hidden' });
  assert.equal((await fs.stat(path.join(downloads, 'Foxdown-demo-file.bin'))).size, length);
  const options = await browser.newPage();
  await options.goto(extensionBase + '/options.html');
  await options.waitForFunction(() => document.getElementById('serverUrl').value.startsWith('http'));
  assert.equal(await options.locator('#serverUrl').inputValue(), origin);
  await options.locator('#test').click();
  await options.locator('#status.ok').filter({ hasText: /1\.36\.0/ }).waitFor();
  await options.waitForFunction(() => document.getElementById('dashboardConnection').textContent === 'Connected');
  assert.match(await options.locator('#dashboardDownload').innerText(), /^\d+(?:\.\d+)? (?:B|KB|MB|GB)\/s$/);
  const settingsLayout = await options.evaluate(() => {
    const left = document.querySelector('.dashboard').getBoundingClientRect();
    const right = document.querySelector('.settings-content').getBoundingClientRect();
    return { leftEdge: left.right, rightEdge: right.left, columns: getComputedStyle(document.querySelector('.settings-layout')).gridTemplateColumns };
  });
  assert.ok(settingsLayout.leftEdge < settingsLayout.rightEdge, JSON.stringify(settingsLayout));
  await options.screenshot({ path: path.join(shots, 'options-dashboard.png'), animations: 'disabled' });
  await options.setViewportSize({ width: 390, height: 844 });
  assert.ok(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Settings must fit a narrow viewport');
  await options.setViewportSize({ width: 1120, height: 820 });
  await options.locator('#enabled').uncheck();
  await options.locator('#save').click();
  const popup = await browser.newPage();
  await popup.goto(extensionBase + '/popup.html');
  await popup.waitForFunction(() => document.getElementById('state').textContent.length > 0);
  assert.equal(await popup.locator('#capture').isChecked(), false);
  await popup.screenshot({ path: path.join(shots, 'extension-popup.png'), animations: 'disabled' });

  // Exercise the real Chrome APIs used by the review fixes, including header
  // modification for a protected media resource and user-selected batch links.
  const mediaPath = path.join(temp, 'preview.webm');
  const ffmpeg = path.join(packageBin, process.platform === 'darwin' ? 'media/bin/ffmpeg' : 'ffmpeg.exe');
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=128x96:r=10',
    '-t', '1', '-c:v', 'libvpx', mediaPath], { stdio: 'pipe', timeout: 20000 });
  const mediaBytes = await fs.readFile(mediaPath);
  const previewRequests = [];
  const slowFile = Buffer.alloc(32 * 1024 * 1024, 0x66);
  let mediaOrigin;
  mediaFixture = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/watch') {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><title>Media fixture</title>
        <a href="/archive.zip">Archive</a><a href="/navigation.html">Navigation</a>
        <a href="/slow.bin" download>Slow download</a><img src="/favicon.png">
        <script>
          window.__INITIAL_STATE__ = {video: '${mediaOrigin}/hidden.mp4'};
          fetch('/preview.webm');
        </script>`);
    } else if (pathname === '/preview.webm') {
      previewRequests.push({ referer: request.headers.referer });
      if (request.headers.referer !== mediaOrigin + '/watch') return response.writeHead(403).end();
      response.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': mediaBytes.length });
      response.end(mediaBytes);
    } else if (pathname === '/slow.bin') {
      const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      let offset = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Number(range[2]) : slowFile.length - 1;
      response.writeHead(range ? 206 : 200, {
        'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="slow.bin"',
        'Content-Length': end - offset + 1, 'Accept-Ranges': 'bytes',
        ...(range ? { 'Content-Range': `bytes ${offset}-${end}/${slowFile.length}` } : {}),
      });
      const timer = setInterval(() => {
        if (response.writableNeedDrain) return;
        const next = Math.min(offset + 64 * 1024, end + 1);
        response.write(slowFile.subarray(offset, next));
        offset = next;
        if (offset > end) { clearInterval(timer); response.end(); }
      }, 100);
      response.once('close', () => clearInterval(timer));
    } else if (pathname === '/archive.zip') {
      response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': 7 });
      response.end('fixture');
    } else response.writeHead(404).end();
  });
  mediaFixture.listen(0, '127.0.0.1');
  await once(mediaFixture, 'listening');
  mediaOrigin = 'http://127.0.0.1:' + mediaFixture.address().port;
  const watch = await browser.newPage();
  await watch.goto(mediaOrigin + '/watch');
  await watch.evaluate(origin => window.postMessage({
    type: 'kimi-deep-search-result', urls: [origin + '/forged.mp4'],
  }, location.origin), mediaOrigin);
  const mediaTabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, mediaOrigin + '/watch');
  await popup.waitForFunction(async ({ tabId, url }) => {
    const media = await chrome.runtime.sendMessage({ type: 'getSniffedMedia', tabId });
    return media.some(entry => entry.url === url && entry.source === 'network');
  }, { tabId: mediaTabId, url: mediaOrigin + '/preview.webm' });
  await popup.waitForFunction(async tabId => {
    const media = await chrome.runtime.sendMessage({ type: 'getSniffedMedia', tabId });
    return media.length > 0 && await chrome.action.getBadgeText({ tabId }) === String(media.length);
  }, mediaTabId);
  assert.deepEqual(await worker.evaluate(tabId => chrome.action.getBadgeBackgroundColor({ tabId }), mediaTabId), [37, 99, 235, 255]);
  await options.bringToFront();
  const resourceWindow = browser.waitForEvent('page');
  await options.locator('#dashboardResources').click();
  const resources = await resourceWindow;
  await resources.waitForURL(new RegExp('popup\\.html\\?tabId=' + mediaTabId));
  await resources.locator('.media-item').filter({ hasText: 'preview.webm' }).waitFor();
  assert.equal(await resources.locator('#sniffCapture').isChecked(), true);
  await resources.close();
  await popup.evaluate(() => loadMedia());
  await popup.locator('#mediaBox').waitFor();
  assert.equal(await popup.locator('#sniffCapture').isChecked(), true);
  await popup.locator('.media-item').filter({ hasText: 'preview.webm' }).waitFor();
  await popup.evaluate(async tabId => {
    const media = await chrome.runtime.sendMessage({ type: 'getSniffedMedia', tabId });
    await previewMedia(media.find(entry => entry.url.endsWith('/preview.webm')), tabId);
  }, mediaTabId);
  await popup.locator('#previewPlayer video').waitFor();
  try { await popup.waitForFunction(() => document.querySelector('#previewPlayer video')?.readyState >= 2, null, { timeout: 10000 }); }
  catch (error) {
    console.error('Preview requests', previewRequests);
    console.error('Preview rules', await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules()));
    console.error('Preview state', await popup.locator('#previewPlayer video').evaluate(player => ({
      readyState: player.readyState, error: player.error && { code: player.error.code, message: player.error.message },
    })));
    throw error;
  }
  assert.ok(previewRequests.length >= 2);
  assert.ok(previewRequests.every(request => request.referer === mediaOrigin + '/watch'));
  await popup.locator('#previewClose').click();
  await worker.evaluate(async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await chrome.declarativeNetRequest.getSessionRules()).length === 0) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Preview header rules were not removed after closing the player');
  });
  await popup.evaluate(tabId => chrome.runtime.sendMessage({ type: 'triggerDeepSearch', tabId }), mediaTabId);
  const scanned = await popup.evaluate(tabId => chrome.runtime.sendMessage({ type: 'getSniffedMedia', tabId }), mediaTabId);
  assert.ok(scanned.some(entry => entry.url === mediaOrigin + '/hidden.mp4' && entry.source === 'deepSearch'));
  assert.ok(!scanned.some(entry => entry.url === mediaOrigin + '/forged.mp4'));
  const links = await worker.evaluate(tabId => chrome.tabs.sendMessage(tabId, { type: 'kimi-collect-links' }), mediaTabId);
  assert.ok(links.includes(mediaOrigin + '/archive.zip'));
  assert.ok(!links.includes(mediaOrigin + '/navigation.html') && !links.includes(mediaOrigin + '/favicon.png'));
  const batchPage = browser.waitForEvent('page');
  await worker.evaluate(({ links, referer }) => confirmPageLinks(links, referer), { links, referer: mediaOrigin + '/watch' });
  const batch = await batchPage;
  await batch.waitForURL(/popup\.html\?mode=batch/);
  await batch.locator('#batchFilter').fill('.zip');
  await batch.locator('#batchAll').check();
  await batch.locator('#batchStart').click();
  for (let attempt = 0; ; attempt++) {
    const contents = await fs.readFile(path.join(downloads, 'archive.zip'), 'utf8').catch(() => '');
    if (contents === 'fixture') break;
    assert.ok(attempt < 60, 'Confirmed batch selection must reach the download service');
    await delay(100);
  }
  await batch.locator('#batchCancel').click();
  console.log('Review regression checks passed in Chromium: protected preview Referer, rule cleanup, direct deep-search results and confirmed batch download.');

  await worker.evaluate(() => writeSettings({ enabled: true, notifyComplete: false }));
  await watch.getByRole('link', { name: 'Slow download', exact: true }).click({ noWaitAfter: true });
  await worker.evaluate(async tabId => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const [global, local] = await Promise.all([
        chrome.action.getBadgeText({}), chrome.action.getBadgeText({ tabId }),
      ]);
      if (global === '1' && local === '1') return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('An intercepted download must display badge 1 on every tab');
  }, mediaTabId);
  const repeatedCapture = await worker.evaluate(({ url, referer }) => sendToKimi(url, {
    referer, filename: 'slow.bin', reuseActive: true,
  }), { url: mediaOrigin + '/slow.bin', referer: mediaOrigin + '/watch' });
  assert.equal(repeatedCapture.reused, true, 'A repeated automatic handoff should return the active task');
  for (let attempt = 0; ; attempt++) {
    const length = await fs.stat(path.join(downloads, 'slow.bin')).then(stat => stat.size).catch(() => 0);
    const tasks = await (await fetch(origin + '/api/v1/tasks', { headers: { Authorization: 'Bearer ' + token } })).json();
    if (length === slowFile.length && tasks.tasks.some(task => task.name === 'slow.bin' && task.status === 'complete')) break;
    assert.ok(attempt < 200, 'The intercepted slow file must finish downloading');
    await delay(100);
  }
  await worker.evaluate(url => sendToKimi(url), mediaOrigin + '/missing.bin');
  await worker.evaluate(async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await chrome.action.getBadgeText({}) === 'X') return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('A failed backend task must display X even with notifications disabled');
  });
  await popup.evaluate(() => loadTaskStatus());
  await popup.locator('#taskErrors').waitFor();
  assert.match(await popup.locator('#taskErrorList').innerText(), /missing\.bin/);
  await popup.evaluate(async () => { await load(); await loadTaskStatus(); await loadMedia(); });
  await popup.locator('body').screenshot({ path: path.join(shots, 'resource-and-error-status.png'), animations: 'disabled' });
  const failedTasks = await (await fetch(origin + '/api/v1/tasks', { headers: { Authorization: 'Bearer ' + token } })).json();
  const failedTask = failedTasks.tasks.find(task => task.name === 'missing.bin' && task.status === 'error');
  assert.ok(failedTask);
  await fetch(origin + '/api/v1/tasks/aria2/' + failedTask.id + '/action', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete', deleteFiles: true }),
  });
  console.log('Live status passed: per-tab blue resource counts, browser interception badge 1, failed task X, visible error details and default page-resource detection.');
  // A failed backend handoff must resume the browser's download.
  const closedPort = await freePort();
  await worker.evaluate(serverUrl => chrome.storage.local.set({ enabled: true, serverUrl }), 'http://127.0.0.1:' + closedPort);
  const priorIds = await worker.evaluate(async () => (await chrome.downloads.search({})).map(item => item.id));
  await demo.locator('a[href="/api/v1/demo-file"]').click({ noWaitAfter: true });
  let fallback;
  for (let attempt = 0; attempt < 50; attempt++) {
    const downloads = await worker.evaluate(() => chrome.downloads.search({}));
    fallback = downloads.find(item => !priorIds.includes(item.id) && item.state === 'complete');
    if (fallback) break;
    await delay(200);
  }
  assert.equal(fallback?.bytesReceived, 128 * 1024, 'Browser download must resume when Foxdown is unreachable');
  assert.deepEqual(jsErrors, []);
  console.log('Real Chromium MV3 passed: 401 → authenticated setup → tested origin demo → actual captured 128 KiB → settings and popup synchronization → browser fallback.');
} finally {
  await browser?.close();
  await desktop?.close();
  mediaFixture?.closeAllConnections();
  mediaFixture?.close();
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
