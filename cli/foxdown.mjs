#!/usr/bin/env node
// Foxdown CLI —— 参考 N_m3u8DL-RE 命令行形态（优先级：命令行 > 环境变量 > 默认值）
// 用法:
//   node cli/foxdown.mjs add <url> [--out name] [--dir path] [--header "K: V"]... [--referer u] [--checksum "sha-1=..."]
//   node cli/foxdown.mjs resolve <url>
//   node cli/foxdown.mjs list [--status active|waiting|stopped|all]
//   node cli/foxdown.mjs pause|resume|delete <id> [--files]
//   node cli/foxdown.mjs watch [--stats]        # NDJSON 每行 {ts,tasks:[...]}，1Hz
//   node cli/foxdown.mjs doctor
// 配置: --server URL / --token T（或环境变量 FOXDOWN_SERVER / FOXDOWN_TOKEN）
const BASE = ((process.env.FOXDOWN_SERVER || process.env.RDOWN_SERVER) || 'http://127.0.0.1:16801').replace(/\/+$/, '');
const TOKEN = (process.env.FOXDOWN_TOKEN || process.env.RDOWN_TOKEN) || '';

// 管道被下游（如 head）关闭时安静退出
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });

function args() { return process.argv.slice(2); }
function opt(name) {
  const i = args().indexOf('--' + name);
  return i >= 0 ? args()[i + 1] : undefined;
}
function allOpts(name) {
  const out = []; const a = args();
  for (let i = 0; i < a.length; i++) if (a[i] === '--' + name) out.push(a[i + 1]);
  return out;
}
function has(name) { return args().includes('--' + name); }
function positional() { return args().filter((x, i) => !x.startsWith('--') && (i === 0 || args()[i - 1] !== '--out' && args()[i - 1] !== '--dir' && args()[i - 1] !== '--header' && args()[i - 1] !== '--referer' && args()[i - 1] !== '--checksum' && args()[i - 1] !== '--server' && args()[i - 1] !== '--token' && args()[i - 1] !== '--status')); }

async function api(method, path, body) {
  const h = { 'Content-Type': 'application/json' };
  if (TOKEN) h['Authorization'] = 'Bearer ' + TOKEN;
  const res = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || ('HTTP ' + res.status));
  return j;
}

const cmd = args()[0];

async function main() {
  switch (cmd) {
    case 'add': {
      const url = positional()[1];
      if (!url) throw new Error('usage: add <url>');
      const options = {};
      if (opt('out')) options.out = opt('out');
      if (opt('dir')) options.dir = opt('dir');
      if (opt('referer')) options.referer = opt('referer');
      const headers = allOpts('header');
      if (headers.length) options.headers = headers;
      if (opt('checksum')) options.checksum = opt('checksum');
      const r = await api('POST', '/api/v1/tasks', { url, options });
      console.log(JSON.stringify(r));
      break;
    }
    case 'resolve': {
      const url = positional()[1];
      if (!url) throw new Error('usage: resolve <url>');
      console.log(JSON.stringify(await api('POST', '/api/v1/resolve', { url }), null, 1));
      break;
    }
    case 'list': {
      const status = opt('status') || 'all';
      const r = await api('GET', '/api/v1/tasks?status=' + status);
      for (const t of r.tasks) {
        console.log([t.id, t.engine, t.status, t.name, (t.completedLength || 0) + '/' + (t.totalLength || 0), (t.downloadSpeed || 0) + 'B/s'].join('\t'));
      }
      break;
    }
    case 'pause': case 'resume': case 'delete': {
      const id = positional()[1];
      if (!id) throw new Error('usage: ' + cmd + ' <id>');
      const engine = id.length === 16 ? 'aria2' : 'stream';
      const r = await api('POST', `/api/v1/tasks/${engine}/${id}/action`, { action: cmd === 'delete' ? 'delete' : cmd, deleteFiles: has('files') });
      console.log(JSON.stringify(r));
      break;
    }
    case 'watch': {
      const statsOnly = has('stats');
      process.on('SIGINT', () => process.exit(0));
      for (;;) {
        const r = await api('GET', '/api/v1/tasks?status=all').catch(() => null);
        if (r) {
          const line = {
            ts: new Date().toISOString(),
            tasks: r.tasks.map(t => ({
              id: t.id, name: t.name, status: t.status,
              completed: t.completedLength || 0, total: t.totalLength || 0,
              speed: t.downloadSpeed || 0,
              segs: t.progress ? `${t.progress.doneSegments}/${t.progress.totalSegments}` : undefined,
            })),
          };
          if (statsOnly) {
            for (const t of line.tasks) process.stdout.write(JSON.stringify({ ts: line.ts, ...t }) + '\n');
          } else {
            process.stdout.write(JSON.stringify(line) + '\n');
          }
        }
        await new Promise(r2 => setTimeout(r2, 1000));
      }
      break;
    }
    case 'doctor': {
      console.log(JSON.stringify(await api('GET', '/api/v1/doctor'), null, 1));
      break;
    }
    default:
      console.log('Foxdown CLI\n\ncommands: add <url> [--out --dir --header --referer --checksum] | resolve <url> | list [--status] | pause|resume|delete <id> [--files] | watch [--stats] | doctor\nconfig: --server URL --token T, or env FOXDOWN_SERVER / FOXDOWN_TOKEN');
  }
}

main().catch(e => { console.error('error:', e.message); process.exit(1); });
