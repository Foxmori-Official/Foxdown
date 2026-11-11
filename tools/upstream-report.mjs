import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const references = JSON.parse(await fs.readFile(new URL('../docs/upstreams.json', import.meta.url), 'utf8'));
const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Foxdown-upstream-report' };
if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;

async function github(endpoint) {
  const response = await fetch('https://api.github.com' + endpoint, { headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status} for ${endpoint}`);
  return response.json();
}

function oneLine(text) {
  return String(text || '').replace(/\s+/g, ' ').replace(/[<>\[\]]/g, '').trim();
}

async function review({ repo, baseline, focus }) {
  const meta = await github(`/repos/${repo}`);
  const head = await github(`/repos/${repo}/commits/${encodeURIComponent(meta.default_branch)}`);
  const compare = `/repos/${repo}/compare/${baseline}...${head.sha}`;
  const [changes, releases] = await Promise.all([
    github(compare + '?per_page=12'),
    github(`/repos/${repo}/releases?per_page=5`),
  ]);
  const range = `https://github.com/${repo}/compare/${baseline}...${head.sha}`;
  const lines = [
    `## ${repo}`, '', focus, '',
    `- Review checkpoint \`${baseline}\``,
    `- Current default branch \`${meta.default_branch}\` at \`${head.sha}\``,
    `- [Compare checkpoint to current head](${range}) · ${changes.ahead_by} new commits · ${changes.status}`,
    '', '### Recent releases', '',
  ];
  const latest = releases.filter(release => !release.draft).slice(0, 3);
  if (!latest.length) lines.push('- See the commit comparison for this repository.');
  for (const release of latest) {
    const note = oneLine(release.body).slice(0, 360);
    lines.push(`- [${oneLine(release.tag_name)}](${release.html_url}) · ${release.published_at?.slice(0, 10) || 'undated'}${release.prerelease ? ' · pre-release' : ''}`);
    if (note) lines.push(`  ${note}`);
  }
  lines.push('', '### Commits in the comparison', '');
  for (const item of changes.commits.slice(0, 12)) {
    lines.push(`- [\`${item.sha.slice(0, 8)}\`](${item.html_url}) ${oneLine(item.commit.message.split('\n')[0])}`);
  }
  if (!changes.commits.length) lines.push('- No commits after the checkpoint.');
  if (changes.ahead_by > 12) lines.push('- Open the comparison for the full list.');
  return lines.join('\n');
}

function fallbackReport({ repo, baseline, focus }, error) {
  const remote = `https://github.com/${repo}`;
  const head = execFileSync('git', ['ls-remote', remote + '.git', 'HEAD'], { encoding: 'utf8', timeout: 20000 }).split(/\s+/)[0];
  if (!/^[a-f0-9]{40}$/.test(head)) throw error;
  return [
    `## ${repo}`, '', focus, '',
    `- [Compare checkpoint to current head](${remote}/compare/${baseline}...${head})`,
    `- [Release notes](${remote}/releases)`,
    head === baseline ? '- The default branch is at the review checkpoint.' : '- The default branch has moved since the review checkpoint.',
    `- API details unavailable. ${error.message}`,
  ].join('\n');
}

const report = ['# Foxdown upstream changes', '', `Checked ${new Date().toISOString().slice(0, 10)} UTC.`];
for (const reference of references) {
  try { report.push('', await review(reference)); }
  catch (error) {
    try { report.push('', fallbackReport(reference, error)); }
    catch {
      process.exitCode = 1;
      report.push('', `## ${reference.repo}`, '', `Review incomplete. ${error.message}`);
    }
  }
}
const markdown = report.join('\n') + '\n';
if (process.argv[2]) await fs.writeFile(process.argv[2], markdown);
else process.stdout.write(markdown);
