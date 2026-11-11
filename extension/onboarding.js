const $ = id => document.getElementById(id);
const DEFAULT_SERVER = 'http://127.0.0.1:16801';

let step = 1;
let testing = false;
let verified = null;
let routedServer;

async function applyI18nTexts() {
  await loadI18nOverride();
  document.documentElement.lang = getI18nLocale();
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = i18n(el.getAttribute('data-i18n'));
  }
  document.title = i18n('obTitle');
}

function renderStep() {
  for (const section of document.querySelectorAll('.step')) section.hidden = section.dataset.step !== String(step);
  for (const dot of document.querySelectorAll('[data-step-dot]')) {
    const n = Number(dot.dataset.stepDot);
    dot.classList.toggle('active', n === step);
    dot.classList.toggle('done', step === 'done' || n < step);
    dot.setAttribute('aria-current', n === step ? 'step' : 'false');
  }
  $('backBtn').hidden = step === 1 || step === 'done';
  $('nextBtn').hidden = step === 3 || step === 'done';
  $('nextBtn').disabled = step === 1 && !verified;
  $('finishBtn').hidden = step !== 3;
}

function setStatus(key, state = '', substitution) {
  $('testState').className = `test-state ${state}`.trim();
  $('testState').textContent = key ? i18n(key, substitution) : '';
}

function invalidateConnection() {
  verified = null;
  setStatus('obTestRequired');
  renderStep();
}

async function testConnection() {
  if (testing) return;
  testing = true;
  verified = null;
  $('testBtn').disabled = true;
  $('serverUrl').disabled = true;
  $('apiToken').disabled = true;
  renderStep();
  setStatus('statusTesting');
  try {
    const url = normalizeServerUrl($('serverUrl').value.trim() || DEFAULT_SERVER);
    const token = $('apiToken').value.trim();
    const health = await checkServerHealth(url, token);
    if (!routedServer) {
      try { await chrome.storage.sync.set({ serverUrl: url, apiToken: token }); }
      catch { throw new Error('settingsSaveFailed'); }
    }
    $('serverUrl').value = url;
    verified = url;
    setStatus('obTestOk', 'ok', health.aria2Version || i18n('versionUnknown'));
  } catch (error) {
    setStatus(error.message, 'err');
  } finally {
    testing = false;
    $('testBtn').disabled = false;
    $('serverUrl').disabled = Boolean(routedServer);
    $('apiToken').disabled = Boolean(routedServer);
    renderStep();
  }
}

$('serverUrl').addEventListener('input', invalidateConnection);
$('apiToken').addEventListener('input', invalidateConnection);
$('testBtn').addEventListener('click', testConnection);
$('backBtn').addEventListener('click', () => { if (step > 1) { step--; renderStep(); } });
$('nextBtn').addEventListener('click', () => { if (verified && step < 3) { step++; renderStep(); } });
$('demoBtn').addEventListener('click', () => { if (verified) chrome.tabs.create({ url: verified + '/demo.html' }); });
$('finishBtn').addEventListener('click', async () => {
  if (!verified || step !== 3) return;
  try {
    await chrome.storage.local.set({ onboardingCompleted: true });
    step = 'done';
    renderStep();
  } catch {
    $('finishState').textContent = i18n('settingsSaveFailed');
  }
});

$('enabled').addEventListener('change', async event => {
  try { await chrome.storage.sync.set({ enabled: event.target.checked }); }
  catch { event.target.checked = !event.target.checked; setStatus('settingsSaveFailed', 'err'); }
});
$('locale').addEventListener('change', async event => {
  try {
    await chrome.storage.sync.set({ locale: event.target.value || 'auto' });
    await applyI18nTexts();
    invalidateConnection();
  } catch { setStatus('settingsSaveFailed', 'err'); }
});

(async () => {
  await applyI18nTexts();
  try {
    const settings = await chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER, apiToken: '', enabled: true, locale: 'auto', servers: [] });
    routedServer = preferredServer(settings.servers);
    $('serverUrl').value = routedServer?.url || settings.serverUrl || DEFAULT_SERVER;
    $('apiToken').value = routedServer ? (routedServer.token || '') : settings.apiToken;
    $('serverUrl').disabled = $('apiToken').disabled = Boolean(routedServer);
    $('routingHint').hidden = !routedServer;
    $('enabled').checked = Boolean(settings.enabled);
    $('locale').value = settings.locale || 'auto';
    invalidateConnection();
  } catch { setStatus('settingsSaveFailed', 'err'); }
})();
