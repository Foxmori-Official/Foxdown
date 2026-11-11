import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../web/package.json', import.meta.url));
const { parse } = require('@vue/compiler-sfc');
const { baseParse } = require('@vue/compiler-dom');
const { parse: parseJs } = require('@babel/parser');
const read = file => fs.readFileSync(new URL('../../' + file, import.meta.url), 'utf8');

test('all template icons and dynamic navigation icons remain registered after tree-shaking', () => {
  const main = parseJs(read('web/src/main.js'), { sourceType: 'module' });
  const iconsImport = main.program.body.find(node => node.type === 'ImportDeclaration' && node.source.value === '@element-plus/icons-vue');
  assert.ok(iconsImport);
  assert.ok(iconsImport.specifiers.every(node => node.type === 'ImportSpecifier'), 'namespace import would defeat tree-shaking');
  const imported = new Set(iconsImport.specifiers.map(node => node.local.name));
  const registry = main.program.body.flatMap(node => node.type === 'VariableDeclaration' ? node.declarations : [])
    .find(node => node.id.name === 'ElementPlusIconsVue');
  assert.ok(registry?.init?.properties);
  const registered = new Set(registry.init.properties.map(node => node.key.name));
  for (const name of registered) assert.ok(imported.has(name), `unimported registration ${name}`);
  const files = fs.readdirSync(new URL('../../web/src', import.meta.url), { recursive: true }).filter(file => file.endsWith('.vue'));
  for (const file of files) {
    const source = read(`web/src/${file}`);
    const { descriptor } = parse(source);
    const script = parseJs(descriptor.scriptSetup?.content || descriptor.script?.content || '', { sourceType: 'module' });
    const localNames = new Set(script.program.body.flatMap(node => node.type === 'ImportDeclaration' ? node.specifiers.map(spec => spec.local.name) :
      node.type === 'VariableDeclaration' ? node.declarations.map(decl => decl.id.name) : []));
    const visit = node => {
      if (node.type === 1 && /^[A-Z]/.test(node.tag)) {
        assert.ok(registered.has(node.tag) || localNames.has(node.tag), `${file}: missing component / icon ${node.tag}`);
      }
      for (const child of node.children || []) visit(child);
    };
    visit(baseParse(descriptor.template.content));
  }
  for (const [, icon] of read('web/src/App.vue').matchAll(/icon:\s*'([^']+)'/g)) {
    assert.ok(registered.has(icon), `dynamic navigation icon ${icon} is missing`);
  }
});

test('web REST client retains session credentials, supplies auth, and exposes status for localized startup errors', async t => {
  const previous = { fetch: globalThis.fetch, sessionStorage: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage') };
  t.after(() => {
    globalThis.fetch = previous.fetch;
    if (previous.sessionStorage) Object.defineProperty(globalThis, 'sessionStorage', previous.sessionStorage);
    else delete globalThis.sessionStorage;
  });
  const session = new Map([['rdown:api-token', 'initial-test-token']]);
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: key => session.get(key), setItem: (key, value) => session.set(key, value), removeItem: key => session.delete(key),
  } });
  const client = await import('../../web/src/api/client.js?session-test');
  assert.equal(client.getAuthToken(), 'initial-test-token');
  let options;
  globalThis.fetch = async (_url, supplied) => { options = supplied; return Response.json({ locale: 'en' }); };
  await client.api.getSettings();
  assert.equal(options.headers.Authorization, 'Bearer initial-test-token');
  assert.ok(options.signal instanceof AbortSignal);
  client.setAuthToken('rotated-test-token');
  assert.equal(session.get('rdown:api-token'), 'rotated-test-token');
  globalThis.fetch = async () => Response.json({ error: 'unauthorized' }, { status: 401 });
  await assert.rejects(client.api.getSettings(), { message: 'unauthorized', status: 401 });
  client.setAuthToken('');
  assert.equal(session.has('rdown:api-token'), false);
  assert.equal(client.getAuthToken(), '');
});

test('web REST auth also works with sessionStorage disabled', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous); else delete globalThis.sessionStorage; });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new Error('storage disabled'); } });
  const client = await import('../../web/src/api/client.js?no-session-test');
  assert.doesNotThrow(() => client.setAuthToken('test-only-in-memory'));
  assert.equal(client.getAuthToken(), 'test-only-in-memory');
});

test('Element Plus components are explicit local imports with per-component styles', () => {
  const main = read('web/src/main.js');
  assert.doesNotMatch(main, /app\.use\(ElementPlus\)/, 'full-library registration defeats code splitting');
  assert.doesNotMatch(main, /element-plus\/dist\/index\.css/, 'global component CSS would reintroduce the entire library');
  for (const file of fs.readdirSync(new URL('../../web/src', import.meta.url), { recursive: true }).filter(name => name.endsWith('.vue'))) {
    const { descriptor } = parse(read(`web/src/${file}`));
    const script = descriptor.scriptSetup.content;
    const ast = parseJs(script, { sourceType: 'module' });
    const imports = new Set(ast.program.body.filter(node => node.type === 'ImportDeclaration' && node.source.value === 'element-plus').flatMap(node => node.specifiers.map(spec => spec.local.name)));
    for (const [, tag] of descriptor.template.content.matchAll(/<(el-[a-z][a-z-]*)\b/g)) {
      const component = tag.split('-').map(part => part[0].toUpperCase() + part.slice(1)).join('');
      assert.ok(imports.has(component), `${file}: component ${component} must be explicitly imported`);
      assert.ok(script.includes(`element-plus/es/components/${tag.slice(3)}/style/css`), `${file}: missing CSS for ${tag}`);
    }
  }
  for (const plugin of ['ElLoading', 'ElMessage', 'ElMessageBox']) assert.ok(main.includes(`app.use(${plugin})`));
});

test('new-task dialog is conditionally lazy loaded, and task rows are split from the empty state', () => {
  const tasks = read('web/src/views/Tasks.vue');
  assert.match(tasks, /defineAsyncComponent\(\(\) => import\('\.\.\/components\/NewTaskDialog\.vue'\)\)/);
  assert.match(tasks, /<NewTaskDialog v-if="newTaskVisible" v-model="newTaskVisible"/);
  assert.match(tasks, /defineAsyncComponent\(\(\) => import\('\.\.\/components\/TaskRow\.vue'\)\)/);
});

test('navigation and theme actions are keyboard-operable buttons', () => {
  const { descriptor } = parse(read('web/src/App.vue'));
  const root = baseParse(descriptor.template.content);
  let navActions = 0;
  const visit = node => {
    if (node.type === 1) {
      const cls = node.props.find(prop => prop.type === 6 && prop.name === 'class')?.value?.content || '';
      if (cls.split(/\s+/).includes('nav-item')) {
        assert.equal(node.tag, 'button');
        assert.ok(node.props.some(prop => prop.type === 6 && prop.name === 'type' && prop.value?.content === 'button'));
        navActions++;
      }
    }
    for (const child of node.children || []) visit(child);
  };
  visit(root);
  assert.equal(navActions, 2);
});

test('icon-only task row actions have localized accessible labels', () => {
  const { descriptor } = parse(read('web/src/components/TaskRow.vue'));
  const root = baseParse(descriptor.template.content);
  let actions = 0;
  const visit = node => {
    if (node.type === 1 && node.tag === 'el-button' && node.props.some(prop => prop.type === 6 && prop.name === 'circle')) {
      assert.ok(node.props.some(prop => prop.type === 7 && prop.name === 'bind' && prop.arg?.content === 'aria-label'), 'circle action needs a localized aria-label');
      actions++;
    }
    for (const child of node.children || []) visit(child);
  };
  visit(root);
  assert.equal(actions, 5);
});

test('every locale message compiles, including literal filename-pattern braces', async () => {
  const { baseCompile } = require('@intlify/message-compiler');
  const { createI18n } = await import('../../web/node_modules/vue-i18n/dist/vue-i18n.mjs');
  const locales = ['en', 'de', 'es', 'fr', 'pt-BR', 'ja', 'zh-CN', 'zh-TW', 'ko'];
  for (const locale of locales) {
    const dict = (await import(`../../web/src/i18n/locales/${locale}.js`)).default;
    const walk = (obj, prefix = '') => {
      for (const [key, value] of Object.entries(obj)) {
        const full = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object') { walk(value, full); continue; }
        const errors = [];
        baseCompile(value, { onError: error => errors.push(error.message) });
        assert.deepEqual(errors, [], `${locale}:${full} must be a valid vue-i18n message`);
      }
    };
    walk(dict);
    const translator = createI18n({ legacy: false, locale, messages: { [locale]: dict } }).global;
    const hint = translator.t('settings.savePatternHint', { braces: '{ }', angles: '< >' });
    assert.ok(hint.includes('{ }') && hint.includes('< >'), `${locale}: syntax examples must render literally`);
  }
});
