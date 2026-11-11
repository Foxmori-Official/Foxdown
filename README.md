# Foxdown

Foxdown is a desktop download manager for HTTP, BitTorrent, magnet links, and HLS/DASH streams. Its Chrome and Edge extension hands browser downloads and discovered media to the desktop app.

[简体中文](docs/README.zh-CN.md) · [API](docs/api.md) · [维护与更新](docs/updates.md) · [Privacy](PRIVACY.md)

## Install Foxdown

| Platform | Installer |
|---|---|
| macOS 13+, Apple Silicon | `Foxdown-*-mac-arm64.dmg` |
| macOS 13+, Intel | `Foxdown-*-mac-x64.dmg` |
| Windows, Intel or AMD | `Foxdown-*-win-x64.exe` |
| Windows 11 on Arm | `Foxdown-*-win-arm64.exe` |

Get published installers from [Releases](https://github.com/Foxmori-Official/Foxdown/releases). Development builds are available as artifacts on successful [Desktop and extension builds](https://github.com/Foxmori-Official/Foxdown/actions/workflows/desktop.yml) runs.

The installers include aria2, FFmpeg, and FFprobe. Launch Foxdown to open the task list. Engine setup works offline. The default download folder is `Downloads/Foxdown`. Open **Settings → Application** for startup, browser extension, and update options.

The Windows ARM64 app uses x64 download engines through Windows 11 emulation. GitHub Actions builds are unsigned on Windows and ad-hoc signed on macOS. See the [desktop guide](docs/electron.md) for build and data locations.

## Browser extension

1. Install and open the desktop app. Wait for **Connected**.
2. Download and extract `Foxdown-extension.zip`. In Chrome or Edge, open `chrome://extensions` or `edge://extensions`, enable **Developer mode**, select **Load unpacked**, and choose the extracted folder containing `manifest.json`.
3. In the setup guide, test `http://127.0.0.1:16801`. If you set a Web API token in Foxdown, enter the same token in the guide.
4. Pin the extension and open the demo. Click the download link, then check the **All** tab in Foxdown. If your capture rules exclude the demo, use the extension’s link context menu to send it manually.

Open **Extension settings** to change download capture, server routing, notifications, or media detection. The setup guide is available again from the extension menu.

## Develop and verify

Use Node.js 22 on macOS or Windows. Release builds prepare and verify engine binaries before bundling them in the installers.

```sh
npm ci
npm --prefix server ci
npm --prefix web ci
npm run engines
npm run build:web
npm run dev-electron
```

- `npm test` runs task, API, extension, and localization checks.
- `npm run engines` installs verified local engine binaries. Run `npm run test:desktop-engine` to test HTTP downloads and HLS-to-MP4 remuxing against a loopback fixture.
- `npm run test:web-build` checks the production bundle.
- `npx playwright install chromium`, then `npm run test:desktop-extension`, verifies Electron startup and a real browser extension download. Set `FOXDOWN_PACKAGED_EXE` to a built application executable to test the installer contents.
- `npm run pack:extension` builds `Foxdown-extension.zip`. To load from the source directory, run `npm run assets` first.
- `npm run pack -- --mac --arm64` or `npm run pack -- --win --x64` packages a desktop build on the corresponding OS. Use `--x64` or `--arm64` to select the architecture.
- `npm start` starts the standalone local API and web interface after engines and the web build are ready. The default URL is `http://127.0.0.1:16801`.

## Reference projects

| Project | What Foxdown uses or takes inspiration from |
|---|---|
| [Rdown](https://github.com/aimaonews/Rdown) | Original project codebase, retained under its MIT license and copyright notice |
| [aria2](https://github.com/aria2/aria2) | Download engine and JSON-RPC for HTTP, FTP, SFTP, Metalink, and BitTorrent |
| [Motrix](https://github.com/agalwood/Motrix) | Desktop engine management, session recovery, tracker settings, and the pinned aria2 builds |
| [N_m3u8DL-RE](https://github.com/nilaoda/N_m3u8DL-RE) | Stream selectors, segment filtering, remuxing and the optional external stream engine |
| [Gopeed](https://github.com/GopeedLab/gopeed) | Resolve/create API, shared task model, CLI and MCP patterns |
| [Aria2-Explorer](https://github.com/alexhua/Aria2-Explorer) | Browser capture, confirmation dialog, multi-server URL rules and fallback |
| [Gopeed Browser Extension](https://github.com/GopeedLab/browser-extension) | Browser download handoff and request-header forwarding |
| [cat-catch](https://github.com/xifangczy/cat-catch) | Media discovery, deep search, filtering and preview |
| [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) | Windows FFmpeg and FFprobe distributions |
| [ffmpeg-macos-builds](https://github.com/dfloresc/ffmpeg-macos-builds) | macOS LGPL FFmpeg and FFprobe with shared libraries and source notices |
| [hls.js](https://github.com/video-dev/hls.js) | HLS playback in the extension’s media preview |

The [update guide](docs/updates.md) explains how to compare upstream changes, select a compatible fix, run the platform checks, and prepare a release.

## Data and licenses

The desktop service listens on loopback. Foxdown stores task state and settings under the OS user data directory. Browser capture forwards headers needed by the selected download. Use the privacy policy and API guide when configuring a remote server.

Foxdown’s project code is licensed under [MIT](LICENSE). Engine setup fetches third-party binaries from their upstream projects. Each upstream supplies its own license and distribution terms. [Third-party notices](docs/third-party.md)
