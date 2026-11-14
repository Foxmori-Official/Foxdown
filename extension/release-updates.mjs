const repository = 'Foxmori-Official/Foxdown';
const releasesUrl = `https://github.com/${repository}/releases`;

function versionParts(version) {
  const match = typeof version === 'string' && /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.exec(version);
  if (!match || match[0] !== version) throw new Error('Invalid Foxdown version');
  return match.slice(1).map(Number);
}

/** Query the public release on demand. Never forward Foxdown credentials. */
export async function checkReleaseUpdate(installedVersion, fetchRelease = fetch) {
  const installed = versionParts(installedVersion);
  // GitHub's public latest-release link redirects to the selected release.
  // A HEAD request only needs the final URL and does not use REST API quota.
  const response = await fetchRelease(`${releasesUrl}/latest`, {
    method: 'HEAD',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Release check failed (HTTP ${response.status})`);
  const prefix = `${releasesUrl}/tag/`;
  if (!response.url.startsWith(prefix)) throw new Error('Invalid Foxdown release URL');
  const tag = response.url.slice(prefix.length);
  const latest = versionParts(tag);
  const version = latest.join('.');
  const index = latest.findIndex((number, position) => number !== installed[position]);
  return {
    version,
    available: index !== -1 && latest[index] > installed[index],
    releaseUrl: response.url,
    extensionUrl: `${releasesUrl}/download/${tag}/Foxdown-extension.zip`,
  };
}
