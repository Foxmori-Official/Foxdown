# Foxdown

Foxdown 是面向 macOS 和 Windows 的桌面下载管理器，支持 HTTP、BT／磁力链接和 HLS／DASH 流媒体下载。Chrome 与 Edge 扩展可以接管浏览器下载，也可以发现并发送网页媒体。

**简体中文** · [English](docs/README.en.md)

[下载版本](https://github.com/Foxmori-Official/Foxdown/releases) · [接口文档](docs/api.md) · [Docker 部署](docs/docker.md) · [更新与维护](docs/updates.md) · [界面复核](docs/design-review.md) · [隐私说明](PRIVACY.md)

## 安装桌面版

从 [Releases](https://github.com/Foxmori-Official/Foxdown/releases) 选择与你的系统和芯片对应的安装包。开发构建也可从成功的 [GitHub Actions 运行](https://github.com/Foxmori-Official/Foxdown/actions/workflows/desktop.yml) 下载。

| 系统与芯片 | 安装包 |
|---|---|
| macOS 13 及以上，Apple 芯片 | `Foxdown-版本号-mac-arm64.dmg` |
| macOS 13 及以上，Intel 芯片 | `Foxdown-版本号-mac-x64.dmg` |
| Windows，Intel／AMD 处理器 | `Foxdown-版本号-win-x64.exe` |
| Windows 11 on Arm | `Foxdown-版本号-win-arm64.exe` |

安装包内置 aria2、FFmpeg 和 FFprobe，首次启动无需下载引擎，也无需安装 Node.js。默认下载目录为用户的 `Downloads/Foxdown`。启动后等待「已连接」，即可添加下载任务。

应用采用左右布局。点击左侧「设置」可以展开分类，右侧显示对应设置内容。修改会自动保存，保存失败时会显示原因和重试入口。在「设置 → 应用」中可设置登录时启动、查看扩展安装说明和检查更新。

Windows ARM64 应用通过 Windows 11 的 x64 模拟层运行所带下载引擎。当前构建采用 macOS 临时签名，Windows 尚未配置发布者签名。安装文件、用户数据和升级方式见 [桌面端说明](docs/electron.md)。

<a id="browser-extension"></a>

## 安装浏览器扩展

1. 安装并打开 Foxdown 桌面版，等待「已连接」。
2. 下载并解压 `Foxdown-extension.zip`。打开 Chrome 的 `chrome://extensions` 或 Edge 的 `edge://extensions`，开启「开发者模式」，选择「加载已解压的扩展程序」，选中包含 `manifest.json` 的文件夹。
3. 在引导中测试 `http://127.0.0.1:16801`。如果在桌面版设置了 Web API Token，请填写同一个令牌。
4. 固定扩展图标，打开演示页并点击下载链接，再到 Foxdown 的「全部」列表查看结果。若接管规则排除了演示文件，也可通过链接右键菜单手动发送。

扩展设置提供下载接管、多服务器路由、通知和媒体嗅探选项。可从扩展菜单重新打开引导。

工具栏角标显示进行中的任务数量，失败或服务不可达时显示红色 `X`。点击扩展可查看失败原因。“本页资源”默认开启自动嗅探，播放媒体或刷新网页后会列出捕获的媒体与附件，也可从扩展设置左侧的仪表盘打开资源窗口。

## 命令行与 MCP

启动 Foxdown 后，可以用命令行查看任务或发送下载。

```sh
node cli/foxdown.mjs list
node cli/foxdown.mjs add "https://example.com/file.zip"
```

`FOXDOWN_SERVER` 指定服务地址，`FOXDOWN_TOKEN` 指定访问令牌。MCP JSON-RPC 接口位于 `POST /mcp`，使用相同的 Web API 令牌。工具列表与请求格式见 [接口文档](docs/api.md)，容器部署见 [Docker 文档](docs/docker.md)。

## 从源码运行

开发环境需要 Node.js 22。构建阶段会下载并校验引擎，再将它们放入安装包。

```sh
npm ci
npm --prefix server ci
npm --prefix web ci
npm run engines
npm run build:web
npm run dev-electron
```

| 命令 | 用途 |
|---|---|
| `npm test` | 验证任务、接口、扩展逻辑与多语言文案 |
| `npm run test:web-build` | 验证网页生产构建、按需加载与资源大小 |
| `npm run test:desktop-engine` | 使用本地测试服务验证 HTTP 下载和 HLS 转 MP4 |
| `npm run test:desktop-extension` | 验证桌面启动、侧边设置导航和真实浏览器下载接管 |
| `npm run pack:extension` | 生成浏览器扩展 ZIP |
| `npm run pack -- --mac --arm64` | 在 macOS 上构建 Apple 芯片安装包 |
| `npm run pack -- --win --x64` | 在 Windows 上构建 x64 安装包 |

打包时使用 `--x64` 或 `--arm64` 选择架构，并在对应系统执行。运行真实浏览器测试前，先执行 `npx playwright install chromium`。可用 `FOXDOWN_PACKAGED_EXE` 指定打包后的可执行文件，验证安装包内的运行环境。

独立运行本地服务与网页界面时，在引擎和网页构建完成后执行 `npm start`，默认访问地址为 `http://127.0.0.1:16801`。

<a id="reference-projects"></a>

## 参考项目

| 项目 | 使用内容或参考方向 |
|---|---|
| [aria2](https://github.com/aria2/aria2) | HTTP、FTP、SFTP、Metalink 和 BT 下载引擎及 JSON-RPC |
| [Motrix](https://github.com/agalwood/Motrix) | 桌面引擎管理、会话恢复、Tracker 设置及固定版本的 aria2 构建 |
| [N_m3u8DL-RE](https://github.com/nilaoda/N_m3u8DL-RE) | 流媒体选流、分片过滤、转封装及可选外部流媒体引擎 |
| [Gopeed](https://github.com/GopeedLab/gopeed) | 资源解析与任务创建接口、任务模型、命令行及 MCP 设计 |
| [Aria2-Explorer](https://github.com/alexhua/Aria2-Explorer) | 浏览器下载接管、确认对话框、多服务器规则与失败回退 |
| [Gopeed Browser Extension](https://github.com/GopeedLab/browser-extension) | 浏览器下载转交与请求头透传 |
| [cat-catch](https://github.com/xifangczy/cat-catch) | 网页媒体发现、深度搜索、过滤与预览 |
| [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) | Windows FFmpeg 和 FFprobe 分发版本 |
| [ffmpeg-macos-builds](https://github.com/dfloresc/ffmpeg-macos-builds) | macOS LGPL FFmpeg、FFprobe、共享库及源码声明 |
| [hls.js](https://github.com/video-dev/hls.js) | 扩展媒体预览中的 HLS 播放 |

[更新维护文档](docs/updates.md) 说明如何查看参考项目的变化、选择适用改动、完成验证并构建新版本。

## 数据与许可证

桌面服务默认仅监听本机回环地址。任务状态和设置保存在系统用户数据目录。浏览器扩展会向选中的下载服务传递完成下载所需的请求头。配置远程服务前，请阅读隐私说明与接口文档。

项目代码使用 [MIT 许可证](LICENSE)。外部引擎和第三方代码遵循各自的许可证，详见 [第三方声明](docs/third-party.md)。
