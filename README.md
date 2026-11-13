<div align="center">
  <img src="extension/icons/icon-source.png" alt="Foxdown 软件图标" width="80" height="80">
  <h1>Foxdown</h1>
  <p>面向 macOS 和 Windows 的下载管理器，支持浏览器下载接管与网页资源发现</p>
  <p><a href="https://github.com/Foxmori-Official/Foxdown/releases/latest">下载安装包</a> · <a href="#快速安装">安装步骤</a> · <a href="docs/README.en.md">English</a></p>
</div>

## 快速安装

<a id="安装桌面版"></a>

### 桌面应用

1. 从 [GitHub Releases](https://github.com/Foxmori-Official/Foxdown/releases/latest) 下载适合系统和芯片的安装包。
2. macOS 打开 DMG，将 Foxdown 拖入「应用程序」；Windows 运行 EXE 安装包。
3. 启动 Foxdown，等待「已连接」，点击新建任务并粘贴下载链接。文件默认保存在 `Downloads/Foxdown`。

| 系统与芯片 | 安装包 |
| --- | --- |
| macOS 13 及以上，Apple 芯片 | `Foxdown-版本号-mac-arm64.dmg` |
| macOS 13 及以上，Intel 芯片 | `Foxdown-版本号-mac-x64.dmg` |
| Windows，Intel／AMD 处理器 | `Foxdown-版本号-win-x64.exe` |
| Windows 11 on Arm | `Foxdown-版本号-win-arm64.exe` |

安装包内置 aria2、FFmpeg 和 FFprobe，首次启动无需下载引擎或安装 Node.js。当前 macOS 版本采用临时签名、尚未公证，Windows 尚未配置发布者签名。Windows ARM64 的下载引擎通过 Windows 11 的 x64 模拟层运行。安装提示、数据目录和升级步骤见[桌面端说明](docs/electron.md)。

<a id="browser-extension"></a>

### 浏览器扩展

1. 保持 Foxdown 桌面版运行，从同一版本的发布附件下载并解压 `Foxdown-extension.zip`。
2. 打开 Chrome 的 `chrome://extensions` 或 Edge 的 `edge://extensions`，开启「开发者模式」，点击「加载已解压的扩展程序」，选择包含 `manifest.json` 的文件夹。
3. 按引导测试 `http://127.0.0.1:16801`。如果桌面版设置了 Web API Token，请填写同一个令牌。
4. 将扩展固定到工具栏，打开引导中的演示页测试下载接管。在 Foxdown 的任务列表中确认结果。

扩展更新后，刷新已打开的网页。此 README 介绍当前源码，下载包的功能以对应的[发布说明](https://github.com/Foxmori-Official/Foxdown/releases)为准。

## 可以用它做什么

- **管理文件下载**。支持多连接和分段下载、暂停与恢复、批量任务和失败重试。同名文件保留副本，一键清空已完成记录会保留磁盘文件。
- **下载种子与磁力链接**。添加种子文件或磁力链接，在桌面应用中查看任务和下载进度。
- **保存流媒体**。支持 HLS／DASH 下载、音视频选轨及下载完成后转封装为 MP4。
- **接管浏览器下载**。按域名、文件类型或大小设置接管规则，也可通过链接右键菜单手动发送。转交失败时恢复浏览器下载。
- **发现网页资源**。默认开启资源嗅探，刷新网页或播放媒体后，在「本页资源」中查看媒体与附件，预览或选择需要下载的内容。

桌面应用和扩展提供简体中文、英语界面，可跟随系统自动选择。

扩展设置左侧的仪表盘可以打开资源窗口并查看连接状态。工具栏角标帮助你随时了解任务与当前页面的情况：

| 角标 | 含义 |
| --- | --- |
| 蓝色数字 | 空闲时显示当前标签页发现的资源数量 |
| 绿色数字 | 显示进行中和等待中的下载任务总数 |
| 红色 `X` | 任务失败、转交失败或下载服务不可达，点击扩展查看原因 |

## 隐私

桌面服务默认仅监听本机回环地址，任务状态和设置保存在系统用户数据目录，扩展配置保存在浏览器本地。扩展会向你选中的下载服务传递下载所需的链接和请求头。配置远程服务前，请阅读[隐私说明](PRIVACY.md)与[接口文档](docs/api.md)。

## 从源码构建

使用 Node.js 22.12 或更新版本和 npm，在 macOS 或 Windows 上运行：

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

引擎在构建阶段下载并校验。测试命令和安装包构建方式见[桌面端开发与验证](docs/electron.md)，版本维护流程见[更新与发布指南](docs/updates.md)。开发构建可从成功的 [GitHub Actions 运行](https://github.com/Foxmori-Official/Foxdown/actions/workflows/desktop.yml)下载。

更多用法：[命令行、API 与 MCP](docs/api.md) · [Docker 部署](docs/docker.md) · [功能、性能与安全验证](docs/verification.md)

<a id="reference-projects"></a>

## 致谢与许可

Foxdown 的项目代码使用 [MIT 许可证](LICENSE)。感谢 [aria2](https://github.com/aria2/aria2)、[Motrix](https://github.com/agalwood/Motrix)、[N_m3u8DL-RE](https://github.com/nilaoda/N_m3u8DL-RE)、[Gopeed](https://github.com/GopeedLab/gopeed)、[Aria2-Explorer](https://github.com/alexhua/Aria2-Explorer)、[Gopeed Browser Extension](https://github.com/GopeedLab/browser-extension) 和[猫抓](https://github.com/xifangczy/cat-catch)的作者与贡献者。

外部引擎、分发包和第三方代码遵循各自的许可证。具体采用内容、参考方向与分发来源见[第三方归属与参考记录](docs/third-party.md)。
