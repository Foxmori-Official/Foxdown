# Foxdown reliability regression tests

Run from the repository root after installing the root, `server`, and `web`
dependencies:

```sh
npm test
npm run test:web-build # production bundle graph + initial JS/CSS budgets
```

`npm test` preserves the existing extension/UI/i18n/unit-conversion checks, then
runs these Node built-in tests with at most three test files concurrently:

- `scheduler.test.mjs`: boot restoration, retries and capped backoff, overlapping
  ticks, long-running streams, cancel/reschedule races, invalid timestamps.
- `persistence.test.mjs`: actual TaskStore load/save/reload for failed and
  successful schedules in a fresh temporary data directory.
- `scheduled-create.test.mjs`: scheduled streams created paused without touching
  the network; invalid schedules rejected before task creation.
- `range.test.mjs`: loopback HTTP server serving controlled segment bytes; strict
  206/Content-Range/body-length validation, identity encoding, inherited header
  replacement, invalid requests and abort.
- `extension-background.test.mjs`: VM-loaded production background script with
  mocked Chrome APIs, including confirmation window X-close/expiry/restart,
  confirmation/cancel races, retrying browser resume, tab navigation cleanup,
  authenticated event sockets and disabling/reconnecting notifications.
- `popup.test.mjs`: VM-loaded popup, single-flight statistics/media queries,
  aborting a stalled response body, HLS lazy loading/retry and stale preview
  cancellation.
- `api-auth.test.mjs`: real loopback HTTP/WebSocket server with fake engines;
  missing/wrong/correct credentials, initial and periodic state delivery,
  single-flight snapshots, token rotation and unauthenticated local mode.
- `web.test.mjs`: parsed Vue template/dynamic-nav icon registration coverage,
  REST credentials/status handling and unavailable session storage.
- `i18n.test.mjs`: late locale responses cannot overwrite a newer selection or
  its HTML language metadata. The existing UI tests cover title/lang updates.
- `audit-investigation.test.mjs`: settings validation, tokenless browser permissions,
  symlink confinement, atomic persistence and configuration restart behavior.
- `independent-audit.test.mjs`: malformed torrents, bounded metadata, DASH expansion,
  output collisions, stream lifecycle, simulated external processes and UPnP gateways.
- `release.test.mjs`: version consistency and Chinese-only release notes.

No real engine subprocesses, remote API services, user credentials or real file
transfers are used. Server tests bind only to `127.0.0.1` on an ephemeral port;
persistent data is isolated in disposable temporary directories. Extension/UI
checks are mock/VM regressions, not real-browser extension end-to-end tests.

## Second-round UI delivery checks

The Web UI registers only the Element Plus components used by each Vue file,
including their component styles. Loading/message/message-box services remain
explicitly registered. `web.test.mjs` verifies template registration, accessible
navigation and icon-only action labels, both locale message syntax trees,
and literal filename-pattern brace rendering.

`npm run test:web-build` writes a production Vite manifest, then checks the entire
initial **static** JS/CSS closure, not just the entry filename. Budgets are 500KB
raw / 175KB gzip JS and 100KB raw / 17KB gzip CSS. Settings, NewTaskDialog and
TaskRow must remain dynamic entries outside that closure. These are build-size
regressions, not claims about actual cold-start latency or runtime memory.
