// Keep the packaged policy and GitHub Pages policy in sync with root PRIVACY.md.
// Run from any directory: node tools/sync-privacy-docs.mjs
import fs from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const policy = await fs.readFile(new URL('PRIVACY.md', root), 'utf8');
await fs.writeFile(new URL('extension/PRIVACY.md', root), policy);
const frontMatter = '---\nlayout: privacy\ntitle: "Foxdown 隐私政策 / Privacy Policy"\npermalink: /privacy.html\n---\n\n';
await fs.writeFile(new URL('docs/privacy.md', root), frontMatter + policy);
console.log('Synced extension/PRIVACY.md and docs/privacy.md from PRIVACY.md.');
