# 第三方归属与参考记录

Foxdown 的项目代码使用 [MIT 许可证](../LICENSE)。外部引擎、分发包与第三方代码遵循各自的许可，源文件中的版权、归属与许可说明随项目保留。

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

表中记录实际采用内容或功能设计参考，具体范围以对应实现和变更记录为准。采用上游实现时，应记录来源仓库、源路径、完整提交 SHA、许可证、采用范围和修改。参考项目的更新跟踪与验证流程见[更新维护文档](updates.md)。

## 随包组件与分发来源

- **aria2** 作为独立可执行文件随安装包分发。构建时从[固定提交的 Motrix 目录](https://github.com/agalwood/Motrix/tree/a0a1fe90f7e9f6d305ed2b512f62c8d36c2fb95a/extra)获取对应平台的二进制，并校验 SHA-256。许可与源码见 [aria2 仓库](https://github.com/aria2/aria2)。
- **Windows FFmpeg 与 FFprobe** 来自 [ffmpeg-static b6.1.1](https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1)，对应平台的许可和源码说明包含在引擎目录中。
- **macOS FFmpeg 与 FFprobe** 来自 [ffmpeg-macos-builds 9.0.1-1 的 LGPL 版本](https://github.com/dfloresc/ffmpeg-macos-builds/releases/tag/v9.0.1-1)。安装包包含共享库，组件声明、构建配置与源码校验值位于 `media/LICENSES` 和 `media/BUILDINFO.txt`。[对应源码归档](https://github.com/dfloresc/ffmpeg-macos-builds/releases/tag/v9.0.1-1) · [FFmpeg 许可说明](https://ffmpeg.org/legal.html)
- **N_m3u8DL-RE** 是可选的外部流媒体引擎，由用户自行安装。[项目仓库](https://github.com/nilaoda/N_m3u8DL-RE)
- **hls.js** 随浏览器扩展分发，用于 HLS 媒体预览，许可保存在 [extension/vendor/hls.LICENSE](../extension/vendor/hls.LICENSE)。[项目源码](https://github.com/video-dev/hls.js)
