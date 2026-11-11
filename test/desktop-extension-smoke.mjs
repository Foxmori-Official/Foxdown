import assert from 'node:assert/strict';
import { once } from 'node:events';
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
    args: packaged ? [] : [root],
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
  await app.screenshot({ path: path.join(shots, 'settings.png'), animations: 'disabled' });
  await app.getByRole('button', { name: 'Tasks', exact: true }).click();
  await app.getByRole('tab', { name: 'All', exact: true, selected: true }).waitFor();
  console.log('Electron used bundled native engines; expandable sidebar settings, category memory, pending autosave and login controls passed.');

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
  const options = await browser.newPage();
  await options.goto(extensionBase + '/options.html');
  await options.waitForFunction(() => document.getElementById('serverUrl').value.startsWith('http'));
  assert.equal(await options.locator('#serverUrl').inputValue(), origin);
  await options.locator('#test').click();
  await options.locator('#status.ok').filter({ hasText: /1\.36\.0/ }).waitFor();
  await options.locator('#enabled').uncheck();
  await options.locator('#save').click();
  const popup = await browser.newPage();
  await popup.goto(extensionBase + '/popup.html');
  await popup.waitForFunction(() => document.getElementById('state').textContent.length > 0);
  assert.equal(await popup.locator('#capture').isChecked(), false);
  await popup.screenshot({ path: path.join(shots, 'extension-popup.png'), animations: 'disabled' });
  // A failed backend handoff must resume the browser's download.
  const closedPort = await freePort();
  await worker.evaluate(serverUrl => chrome.storage.sync.set({ enabled: true, serverUrl }), 'http://127.0.0.1:' + closedPort);
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
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
