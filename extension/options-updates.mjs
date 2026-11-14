import { checkReleaseUpdate } from './release-updates.mjs';

const { version } = chrome.runtime.getManifest();
const button = document.getElementById('extensionCheckUpdates');
const status = document.getElementById('extensionUpdateStatus');
const link = document.getElementById('extensionUpdateLink');
document.getElementById('extensionVersion').textContent = `v${version}`;

let message;
let result;
function render() {
  status.textContent = message ? globalThis.i18n(message, result?.version) : '';
  const url = result?.available ? result.extensionUrl : null;
  if (url) link.href = url;
  else link.removeAttribute('href');
  link.hidden = !url;
}

document.addEventListener('foxdown-options-language', render);
button.addEventListener('click', async () => {
  if (button.disabled) return;
  button.disabled = true;
  result = null;
  message = 'updateChecking';
  render();
  try {
    result = await checkReleaseUpdate(version);
    message = result.available ? 'updateAvailable' : 'updateCurrent';
  } catch {
    message = 'updateError';
  } finally {
    button.disabled = false;
    render();
  }
});
