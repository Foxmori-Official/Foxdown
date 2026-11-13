# Foxdown 桌面端

Foxdown 用 Electron 启动 Node 后端，默认在 `127.0.0.1:16801` 提供界面和 API。桌面壳提供系统托盘、登录时启动和磁力链接／种子文件关联。

## 本地运行

```sh
npm ci
npm --prefix server ci
npm --prefix web ci
npm run engines
npm run build:web
npm run dev-electron
```

安装包在构建阶段准备并校验引擎。开发模式先运行 `npm run engines`，按平台架构写入 `bin/mac-arm64`、`bin/mac-x64`、`bin/win-x64` 或 `bin/win-arm64`。安装版从应用的 `runtime/bin` 读取内置引擎，启动时无需下载。启动失败时可展开「错误详情」定位缺少组件或端口冲突。

## 验证

在仓库根目录运行以下命令：

| 命令 | 用途 |
| --- | --- |
| `npm test` | 验证任务、接口、扩展逻辑与多语言文案 |
| `npm run test:web-build` | 验证网页生产构建、按需加载与资源大小 |
| `npm run test:desktop-engine` | 使用本地测试服务验证 HTTP 下载和 HLS 转 MP4 |
| `npm run test:desktop-extension` | 验证桌面启动、设置导航和真实浏览器下载接管 |
| `npm run test:desktop-multiconnection` | 实际下载大文件，校验并发连接、分段、暂停恢复及 SHA-256 |
| `npm run pack:extension` | 生成浏览器扩展 ZIP |

运行真实浏览器测试前，先执行 `npx playwright install chromium`。可用 `FOXDOWN_PACKAGED_EXE` 指定打包后的可执行文件，验证安装包内的运行环境。多连接测试会下载外部文件并清理临时文件，验证范围见[下载与资源检测记录](download-and-detection-verification.md)。

如需独立运行本地服务与网页界面，在引擎和网页构建完成后执行 `npm start`，默认访问 `http://127.0.0.1:16801`。

## 数据与升级

- macOS 的数据默认位于 `~/Library/Application Support/Foxdown/data`。
- Windows 的数据默认位于 `%APPDATA%\Foxdown\data`。
- 桌面安装版的引擎位于应用资源目录 `runtime/bin`，下载默认保存到用户的 `Downloads/Foxdown`。
- 在「设置 → 应用 → 查看更新」打开 Releases，选与当前系统架构相符的安装包。关闭旧版再安装新版。同名 Foxdown 更新使用现有用户目录。
- 从旧版本迁移时先退出两个程序，再备份和复制旧目录下的 `data` 内容。保留原下载目录，未完成任务的会话可能记录原文件路径。确认 Web API Token 后再连接浏览器扩展。

## 打包

```sh
npm run pack -- --mac --arm64
npm run pack -- --mac --x64
npm run pack -- --win --x64
npm run pack -- --win --arm64
```

在对应系统执行命令，产物位于 `dist-electron/`。Windows ARM64 的 Electron 进程为 ARM64，下载引擎通过 Windows 11 的 x64 模拟层运行。macOS 安装包支持 macOS 13 或更新版本，需要配置发布者签名和公证才能获得正式分发体验。当前构建使用临时签名，Windows 构建未做发布者签名。

首次打开时，如 macOS 提示无法验证开发者，确认安装包来源后，可在「系统设置 → 隐私与安全性」中对 Foxdown 选择「仍要打开」。操作步骤见 [Apple 支持](https://support.apple.com/en-euro/guide/mac-help/mh40617/27/mac/27)。

打包后，运行时后端和 Web UI 在应用资源目录 `runtime/` 中。日志和会话位于用户可写目录。安装文件路径与下载路径分开。

## macOS 提示组件将不兼容未来系统

Apple 芯片 Mac 运行 Intel 应用或组件时，系统可能提示未来 macOS 将结束兼容。这与 [Rosetta 支持变化](https://support.apple.com/en-us/102527) 有关。Apple 芯片请安装 `Foxdown-<版本>-mac-arm64.dmg`；`mac-x64.dmg` 供 Intel Mac 使用。

Foxdown 的 ARM64 包包含原生 ARM64 Electron、aria2、FFmpeg、FFprobe 和媒体共享库。打包流程逐一检查 Mach-O 组件架构，发现不匹配就停止构建。关闭旧版后，将 ARM64 版拖入「应用程序」替换已有 Foxdown。
