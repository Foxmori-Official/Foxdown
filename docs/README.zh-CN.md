# Foxdown

Foxdown 是 macOS 和 Windows 上的下载管理器，支持 HTTP、BT／磁力和 HLS／DASH。Chrome 和 Edge 扩展可以接管浏览器下载，也可以发现并发送网页媒体。

[English](../README.md) · [API](api.md) · [更新与维护](updates.md) · [界面复核](design-review.md)

## 安装桌面版

- **macOS** 选择对应的 `mac-arm64.dmg`（Apple 芯片）或 `mac-x64.dmg`（Intel 芯片）。
- **Windows** 选择 `win-x64.exe`（Intel／AMD）或 `win-arm64.exe`（Windows 11 on Arm）。ARM64 应用通过 Windows 模拟层运行 x64 引擎。

到 [Releases](https://github.com/Foxmori-Official/Foxdown/releases) 获取已发布的安装包，也可从成功的 [Actions 构建](https://github.com/Foxmori-Official/Foxdown/actions/workflows/desktop.yml) 下载开发包。开发包采用 Windows 未签名和 macOS 临时签名。安装包内置 aria2、FFmpeg 和 FFprobe，首次打开即可在离线环境启动。看到「已连接」后即可添加任务，默认文件夹是「下载/Foxdown」。

## 安装浏览器扩展

1. 启动 Foxdown 桌面版并等待服务连接。
2. 解压 `Foxdown-extension.zip`。打开 Chrome 的 `chrome://extensions` 或 Edge 的 `edge://extensions`，开启开发者模式，选择「加载已解压的扩展程序」。
3. 在引导里测试 `http://127.0.0.1:16801`。如果在 Foxdown「设置 → RPC」中设置了 Web API Token，请填写相同令牌。
4. 固定扩展图标，打开演示页并点击下载链接。回到 Foxdown 的「全部」任务列表查看结果。

可从扩展设置重开引导、修改接管规则，或设置多个服务器。桌面版的「设置 → 应用」提供扩展安装说明、登录时启动和更新入口。

## 从源码运行

需要 Node.js 22。

```sh
npm ci
npm --prefix server ci
npm --prefix web ci
npm run engines
npm run build:web
npm run dev-electron
```

`npm test` 运行自动化测试。执行 `npm run engines` 后，`npm run test:desktop-engine` 会验证本地 HTTP 下载和 HLS 转封装。运行 `npm run pack:extension` 生成扩展 ZIP。

## 参考项目

Foxdown 基于 [Rdown](https://github.com/aimaonews/Rdown) 的代码继续开发，保留其 MIT 许可证和原作者版权声明。

aria2 提供下载引擎，Motrix 提供桌面引擎管理和会话持久化参考，N_m3u8DL-RE 提供选流和分片下载参考。Gopeed 与 Gopeed 浏览器扩展提供任务接口及请求头透传参考。Aria2-Explorer 提供浏览器接管、多服务器路由和回退参考，cat-catch 提供媒体嗅探、过滤和预览参考。另使用 ffmpeg-static 的 Windows 二进制、ffmpeg-macos-builds 的 macOS LGPL 二进制和 hls.js 播放器。每个项目的链接和具体用途见 [参考项目表](../README.md#reference-projects)。

项目代码使用 [MIT](../LICENSE) 许可证。外部引擎和第三方代码遵循各自的许可证。 [第三方声明](third-party.md)
