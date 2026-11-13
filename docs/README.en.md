<div align="center">
  <img src="../extension/icons/icon-source.png" alt="Foxdown app icon" width="80" height="80">
  <h1>Foxdown</h1>
  <p>A download manager for macOS and Windows, with browser download capture and page resource discovery</p>
  <p><a href="https://github.com/Foxmori-Official/Foxdown/releases/latest">Download</a> · <a href="#quick-install">Installation</a> · <a href="../README.md">简体中文</a></p>
</div>

## Quick install

### Desktop app

1. Download the installer matching your OS and architecture from [GitHub Releases](https://github.com/Foxmori-Official/Foxdown/releases/latest).
2. On macOS, open the DMG and drag Foxdown to Applications. On Windows, run the EXE installer.
3. Launch Foxdown, wait for **Connected**, and create a task with a download link. Files are saved to `Downloads/Foxdown` by default.

| Platform | Installer |
| --- | --- |
| macOS 13+, Apple Silicon | `Foxdown-*-mac-arm64.dmg` |
| macOS 13+, Intel | `Foxdown-*-mac-x64.dmg` |
| Windows, Intel or AMD | `Foxdown-*-win-x64.exe` |
| Windows 11 on Arm | `Foxdown-*-win-arm64.exe` |

Installers bundle aria2, FFmpeg, and FFprobe. No engine download or Node.js installation is needed at first launch. Current macOS builds are ad-hoc signed and not notarized; Windows builds have no publisher signature. The Windows ARM64 app runs its bundled engines through Windows 11 x64 emulation. See the [desktop guide](electron.md) for installation prompts, data locations, and upgrades.

### Browser extension

1. Keep the desktop app running. Download `Foxdown-extension.zip` from the same release and extract it.
2. Open `chrome://extensions` or `edge://extensions`, enable **Developer mode**, select **Load unpacked**, and choose the folder containing `manifest.json`.
3. Follow the setup guide to test `http://127.0.0.1:16801`. If you configured a Web API token in Foxdown, enter the same token.
4. Pin the extension and test a download on the guide’s demo page. Confirm the task appears in Foxdown.

Refresh open pages after updating the extension. This README describes the current source; see the corresponding [release notes](https://github.com/Foxmori-Official/Foxdown/releases) for features in a downloaded build.

## What you can do

- **Manage file downloads.** Use multiple connections and segments, pause and resume tasks, submit batches, and retry failed downloads.
- **Download torrents and magnet links.** Add a torrent file or magnet link and monitor the task in the desktop app.
- **Save streams.** Download HLS/DASH streams, select audio and video tracks, and remux completed downloads to MP4.
- **Capture browser downloads.** Apply domain, file-type, and size rules, or send a link from its context menu. Failed handoffs fall back to the browser.
- **Find page resources.** Detection is enabled by default. Reload a page or play media, then use **Page resources** to inspect media and attachments, preview them, or select downloads.

The extension settings dashboard opens the resource window and shows connection status. Toolbar badges provide a quick status check:

| Badge | Meaning |
| --- | --- |
| Blue number | Resources found in the current tab, shown when no downloads are ongoing |
| Green number | Total number of ongoing and waiting downloads |
| Red `X` | A failed task, failed handoff, or unreachable service; open the extension for details |

## Privacy

The desktop service listens on loopback by default. Task state and settings are stored in the OS user data directory; extension settings are stored locally in the browser. The extension forwards download links and required headers to your selected download service. Read the [privacy policy](../PRIVACY.md) and [API guide](api.md) before configuring a remote server.

## Build from source

Use Node.js 22 and npm on macOS or Windows:

```sh
git clone https://github.com/Foxmori-Official/Foxdown.git
cd Foxdown
npm ci
npm --prefix server ci
npm --prefix web ci
npm run engines
npm run build:web
npm run dev-electron
```

Engines are downloaded and verified during the build. See the [desktop development guide](electron.md) for tests and packaging commands, and the [update and release guide](updates.md) for maintenance. Development builds are available from successful [GitHub Actions runs](https://github.com/Foxmori-Official/Foxdown/actions/workflows/desktop.yml).

More: [CLI, API, and MCP](api.md) · [Docker deployment](docker.md) · [Download and resource detection verification](download-and-detection-verification.md)

## Acknowledgements and license

Foxdown’s project code uses the [MIT license](../LICENSE). Thanks to the authors and contributors of [aria2](https://github.com/aria2/aria2), [Motrix](https://github.com/agalwood/Motrix), [N_m3u8DL-RE](https://github.com/nilaoda/N_m3u8DL-RE), [Gopeed](https://github.com/GopeedLab/gopeed), [Aria2-Explorer](https://github.com/alexhua/Aria2-Explorer), [Gopeed Browser Extension](https://github.com/GopeedLab/browser-extension), and [cat-catch](https://github.com/xifangczy/cat-catch).

External engines, binary distributions, and third-party code retain their own licenses. See the [third-party credits and reference notes](third-party.md) for specific uses, design references, and distribution sources.
