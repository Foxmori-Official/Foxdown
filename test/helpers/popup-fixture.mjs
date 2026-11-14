import fs from 'node:fs';
import vm from 'node:vm';

export function popupFixture() {
  const controls = {
    storage: async defaults => defaults,
    fetch: async () => ({ ok: true, json: async () => ({ numActive: 1, numWaiting: 0, downloadSpeed: 1024, uploadSpeed: 0 }) }),
    message: async () => ({ error: 'expired' }),
    nativeHls: false,
  };
  const elements = new Map();
  const scripts = [];
  const timers = new Map();
  let timerId = 0;
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag; this.style = {}; this.children = []; this.listeners = {};
      this.textContent = ''; this.classList = { add: () => {} };
    }
    set innerHTML(value) { this.children = []; this._html = value; }
    get innerHTML() { return this._html || ''; }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { this.children.push(...children); }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    remove() { this.removed = true; }
    canPlayType() { return controls.nativeHls ? 'probably' : ''; }
    play() { this.played = true; return Promise.resolve(); }
  }
  const document = {
    documentElement: {}, body: new Element(), hidden: false,
    head: { appendChild: script => scripts.push(script) },
    getElementById: id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    querySelectorAll: () => [], createElement: tag => new Element(tag),
  };
  const window = { addEventListener: () => {}, close: () => {} };
  const chrome = {
    storage: { local: { get: defaults => controls.storage(defaults) }, onChanged: { addListener: () => {} } },
    runtime: { getURL: file => `chrome-extension://test/${file}`, sendMessage: message => controls.message(message), getManifest: () => ({ version: '0.0.2' }) },
    i18n: { getUILanguage: () => 'en' },
    tabs: { query: async () => [{ id: 1, active: true, url: 'https://example.invalid/page' }] },
  };
  const context = vm.createContext({
    window, document, chrome, console, readSettings: defaults => controls.storage(defaults), URL, URLSearchParams, AbortController,
    location: { search: '?mode=confirm&token=test' },
    i18n: (key, value) => key + (value ? ':' + value : ''), loadI18nOverride: async () => {},
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => 0, clearInterval: () => {},
    fetch: (...args) => controls.fetch(...args),
  });
  Object.defineProperty(context, 'Hls', { get: () => window.Hls });
  vm.runInContext(fs.readFileSync(new URL('../../extension/popup.js', import.meta.url), 'utf8') +
    '\n;globalThis.testing = { load, loadMedia, previewMedia, closePreview, loadHlsLibrary };', context);
  return { ...context.testing, controls, elements, scripts, timers, window, document };
}
