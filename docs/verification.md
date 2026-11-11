# Foxdown 验证记录

2026-11-11，macOS Apple 芯片开发机。

- `npm test` 覆盖浏览器扩展逻辑、引导和选项界面、API、调度、持久化、批量重试、种子文件选择和九种语言。
- `npm run test:web-build` 验证生产构建依赖、按需加载和首屏资源预算。
- `npm run test:desktop-engine` 使用内置 aria2、FFmpeg、FFprobe，在临时目录校验 HTTP 文件字节、HLS 转 MP4、API Token 和引擎退出。
- `npm run test:desktop-extension` 用独立 Electron 和 Chromium 测试配置，验证桌面启动、令牌恢复、设置导航、Chrome MV3 引导、128 KiB 文件真实接管，以及服务不可达时恢复浏览器下载。测试结束后关闭进程并清理临时数据。
- 本地已打包 macOS ARM64 和 Intel 版本，并分别从包内启动。ARM64 包的 25 个 Mach-O 可执行组件均为 ARM64。打包脚本对每个组件执行架构校验，防止混入异构组件。
- 正式发布还需要配置发布者签名和 macOS 公证。当前构建采用 macOS 临时签名和 Windows 未签名。

[四个平台构建和测试的运行记录](https://github.com/Foxmori-Official/Foxdown/actions/workflows/desktop.yml) · [上游变化报告](https://github.com/Foxmori-Official/Foxdown/actions/workflows/upstream.yml)

Windows x64 与 Windows ARM64 的引擎测试及安装包构建由各自的 GitHub Actions runner 执行。以运行结果为准。Windows ARM64 桌面进程为原生 ARM64，所带下载引擎为 x64，依赖 Windows 11 的模拟支持。
