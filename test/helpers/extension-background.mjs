import fs from 'node:fs';
import vm from 'node:vm';

export function backgroundFixture({ persisted = {}, missingWindows = [] } = {}) {
  const session = structuredClone(persisted);
  const local = { enabled: true, askBeforeDownload: true, domainMode: 'off', extMode: 'off', minSizeMB: 0, captureUnknownSize: true };
  const listeners = {};
  const calls = { resume: [], cancel: [], erase: [], windows: [], fetch: [], sockets: [], alarms: [], rules: [], badges: [], badgeColors: [], titles: [] };
  const handlers = {};
  const event = key => ({ addListener: callback => {
    (handlers[key] ||= []).push(callback);
    listeners[key] = (...args) => handlers[key].forEach(listener => listener(...args));
  } });
  const noopEvent = () => ({ addListener: () => {} });
  const chrome = {
    storage: {
      local: { get: async defaults => ({ ...defaults, ...local }), set: async patch => Object.assign(local, patch) },
      session: {
        get: async key => structuredClone(typeof key === 'string' ? { [key]: session[key] } : session),
        set: async patch => Object.assign(session, structuredClone(patch)),
        remove: async key => { delete session[key]; },
      },
      onChanged: event('storageChanged'),
    },
    downloads: {
      onDeterminingFilename: event('download'), pause: async () => {},
      resume: async id => { calls.resume.push(id); },
      cancel: async id => { calls.cancel.push(id); },
      erase: async q => { calls.erase.push(q.id); },
    },
    windows: {
      create: async options => { calls.windows.push(options); return { id: 100 }; },
      get: async id => { if (missingWindows.includes(id)) throw new Error('No window'); return { id }; },
      onRemoved: event('windowRemoved'),
    },
    webRequest: {
      onBeforeSendHeaders: event('headers'), onSendHeaders: event('sniffHeaders'),
      onResponseStarted: event('response'), onErrorOccurred: event('requestError'),
    },
    tabs: { onRemoved: event('tabRemoved'), onUpdated: event('tabUpdated'), query: async () => [], sendMessage: async () => [] },
    cookies: { getAll: async () => [] },
    contextMenus: { removeAll: () => {}, create: () => {}, onClicked: noopEvent() },
    runtime: {
      id: 'isolated-test', getURL: path => `chrome-extension://isolated-test/${path}`,
      onInstalled: noopEvent(), onStartup: noopEvent(), onMessage: event('message'), onMessageExternal: event('externalMessage'),
      onConnect: event('connect'),
    },
    notifications: { create: () => {} },
    declarativeNetRequest: {
      getSessionRules: async () => [],
      updateSessionRules: async options => calls.rules.push(options),
    },
    alarms: { create: (name, options) => calls.alarms.push({ name, ...options }), onAlarm: event('alarm') },
    action: {
      setBadgeText: options => calls.badges.push(options),
      setTitle: options => calls.titles.push(options),
      setBadgeBackgroundColor: options => calls.badgeColors.push(options), setPopup: () => {}, onClicked: noopEvent(),
    },
    commands: { onCommand: noopEvent() }, i18n: { getMessage: key => key },
  };
  const controls = {
    post: async () => ({ ok: true, json: async () => ({ id: 'fake-task' }) }),
    get: async () => ({ ok: true, json: async () => ({ tasks: [], numActive: 0 }) }), timeouts: [],
  };
  const context = vm.createContext({
    chrome, console, URL, AbortController, importScripts: () => {},
    readSettings: defaults => chrome.storage.local.get(defaults),
    writeSettings: patch => chrome.storage.local.set(patch),
    AbortSignal: { timeout: milliseconds => {
      const controller = new AbortController();
      controls.timeouts.push({ milliseconds, controller });
      return controller.signal;
    } }, navigator: { userAgent: 'Test' },
    setInterval: () => 0, setTimeout, clearTimeout, clearInterval: () => {},
    fetch: (...args) => {
      if (args[1]?.method !== 'POST') return controls.get(...args);
      calls.fetch.push(args); return controls.post(...args);
    },
    WebSocket: class {
      constructor(url) { this.url = url; this.closed = false; calls.sockets.push(this); }
      close() { this.closed = true; this.onclose?.(); }
    },
  });
  const read = file => fs.readFileSync(new URL(`../../extension/${file}`, import.meta.url), 'utf8');
  vm.runInContext(read('lib.js') + '\n' + read('background.js') + `\n;globalThis.testing = {
    addPendingConfirm, getPendingConfirm, pendingConfirms, confirmPendingDownload, cancelPendingDownload,
    pendingRestore, sweepPendingConfirms, sniffedMedia, sniffHeaderMap, addDeepSearchMedia, connectEvents,
    mediaRestore, confirmPageLinks, submitPageLinks, maybeAutoDownload, refreshBadge, downloadStatus,
  };`, context);
  return { ...context.testing, chrome, calls, controls, session, local, listeners };
}

export async function waitFor(predicate) {
  const until = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() >= until) throw new Error('Timed out waiting for extension mock');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
