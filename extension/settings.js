// Migrate the previous sync store once per extension context. A lock shared by
// the worker and extension pages prevents stale sync data from overwriting a save.
let settingsReady;

function prepareSettings() {
  if (!settingsReady) {
    settingsReady = navigator.locks.request('foxdown-settings-migration', async () => {
      const previous = await chrome.storage.sync.get(null);
      const keys = Object.keys(previous);
      const local = await chrome.storage.local.get(keys);
      const missing = Object.fromEntries(keys.filter(key => !Object.hasOwn(local, key)).map(key => [key, previous[key]]));
      if (Object.keys(missing).length) await chrome.storage.local.set(missing);
      await chrome.storage.sync.remove(keys);

    }).catch(error => {
      settingsReady = undefined;
      throw error;
    });
  }
  return settingsReady;
}

async function readSettings(defaults) {
  await prepareSettings();
  return chrome.storage.local.get(defaults);
}

async function writeSettings(patch) {
  await prepareSettings();
  return chrome.storage.local.set(patch);
}
