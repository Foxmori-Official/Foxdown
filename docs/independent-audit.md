# 独立功能、性能与安全审查

日期：2026-11-13。此次从代码入口、实际网络响应与进程生命周期独立检查，未引用其他 AI 的审查结论或基准数字。此前报告的逐项核实另见[审查报告核实记录](audit-investigation-verification.md)。

环境：macOS ARM64，Node.js 22.23.5，Electron 45.3.2，Playwright Chromium，内置 aria2 1.36.0 与 FFmpeg。测试使用独立临时数据和下载目录。

## 界面语言

Web、组件库和扩展只保留简体中文、英语及自动选择。已移除旧语言偏好的转换与写回，不再将旧偏好迁移成新版设置。自动选择根据系统／浏览器语言决定中文或英语，这是新版正常功能。

API 只接受 `auto`、`zh-CN`、`en`。扩展 ZIP 仅含 `_locales/en`、`_locales/zh_CN`，共 25 个文件。

## 独立发现并修复的问题

| 问题 | 复现与影响 | 修复及验证 |
| --- | --- | --- |
| 截断 torrent 导致同步死循环 | 修复前 `parseTorrent(Buffer.from('d4:info'))` 被独立子进程超时终止，解析器越过缓冲区后仍继续循环，阻塞服务 | 检查 EOF、整数、字符串长度、尾随数据；限制 64 层嵌套与 100,000 个条目；使用无原型字典。子进程测试确保截断输入快速失败。 |
| 网络元数据无读取上限 | torrent、播放列表、Tracker 列表和密钥直接读入内存 | 元数据上限 16 MiB，AES-128 密钥上限 16 字节，同时检查声明长度及流式累计，超限取消读取。覆盖无 Content-Length 的响应。 |
| torrent 探测只获得首字节 | 探测的 `Range: bytes=0-0` 返回 206 后，被当作完整种子解析 | 确认为 torrent 后去掉 Range 重取完整内容。真实 HTTP 测试核对两次请求及字节；普通文件探测的 HTTP 404 也会明确报错。 |
| 原生流媒体重名输出覆盖文件 | 合并写入和 FFmpeg `-y` 使用固定输出路径 | 使用 `wx` 原子预留文件名，重名添加 `(1)`、`(2)` 后缀；任务显示实际文件名，失败清理本次预留文件。并发预留、符号链接及真实并发 HLS 转封装验证原文件保留。 |
| HLS 字节区间及初始化片段错误 | `4@100` 后的隐式区间曾从 4 开始；EXT-X-MAP 的 BYTERANGE 被忽略 | 偏移改为前一区间起点加长度；初始化片段沿用媒体的 206、Content-Range 与长度检查。回归确认 `[100,4]`、`[104,4]`、`[108,4]` 及真实 HTTP 初始化请求。 |
| DASH 合法资源地址解析错误 | `&amp;` 留在签名 URL；上层 BaseURL 被忽略；末尾负重复未展开 | 解码 XML 内置／数字实体，逐层继承 BaseURL，按后继时间或有限 Period 展开 `r=-1`，计入 presentationTimeOffset。SegmentBase 整文件下载不再重复前置同一文件。 |
| DASH 无界展开与分配 | 小文档可通过巨量重复、极小 duration 或超宽补零生成巨量工作 | 单 MPD 全轨道合计最多 100,000 个分片，展开 URL 合计最多 32 Mi 个 UTF-16 字符；XML 最多 100,000 节点、64 层，补零宽度最多 64。超限快速报错。 |
| 纯音频 DASH 无法下载 | 只从视频轨选择主轨，音频 MPD 报无可用视频 | 无视频时选择音轨，探测同步返回音轨。真实 FFmpeg 生成双轨 DASH 与纯音频 MPD，输出分别验证为视频＋音频、仅音频。 |
| 恢复接口阻塞、退出未等待收尾 | Native.start 等下载结束才返回，影响恢复、全部继续和调度；退出仅发出 abort | 启动后立即应答，保留后台完成 Promise；重启等待旧运行结束，关机等待活动任务及 manifest 写入。受控任务验证应答与退出等待顺序。 |
| 容量设置可使 aria2 重启失败 | 曾接受 `minSplitSize=0`、`1.5M`、`1G`；表单将 1K 四舍五入为零 | 按内置 aria2 的整数、K、M 格式验证，分片范围 1 KiB 至 1 GiB；换算保留小容量及原始字节精度，表单设置对应边界。 |
| 可选外部引擎状态错误 | 速度正则分组错误；spawn 失败未正确入库；旧进程退出干扰新进程 | 修正单位、持久化启动错误，按进程身份处理退出。用缺失程序和临时模拟进程验证。 |
| UPnP 过时依赖与配置竞争 | 旧 nat-api 带有漏洞告警；快速切换端口时映射可重叠 | 替换维护分支，使用 Promise 并处理 false 返回；串行配置／销毁，先解除旧端口。模拟网关验证顺序与失败处理。 |

回归代码：[独立审查测试](../test/reliability/independent-audit.test.mjs)、[字节区间测试](../test/reliability/range.test.mjs)、[真实引擎测试](../test/desktop-engine-smoke.mjs)。

## 安全依赖与权限

| 范围 | 原 npm audit 告警 | 更新后 |
| --- | --- | --- |
| 根项目／桌面构建 | 8 项：2 高危、6 中危 | 0 |
| 后端 | 7 项：2 严重、5 中危 | 0 |
| Web | 4 项高危 | 0 |

数字包含受影响的上层依赖，并非互不重复的漏洞数，也不代表每条上游漏洞均已在 Foxdown 复现。已更新 Electron 至 45.3.2、vue-i18n 至 11.4.19，以 `@silentbot1/nat-api` 0.4.9 替换旧依赖链。仅覆盖 electron-builder 两处 minimatch 到修复分支，锁文件实际为 11.0.8；旧版 glob 所需的其他主版本保持其依赖约束。

依据：[Electron 45 官方说明](https://www.electronjs.org/blog/electron-45-0)、[vue-i18n 安全公告](https://github.com/intlify/vue-i18n/security/advisories/GHSA-8rc2-428q-7ww3)、[minimatch 安全公告](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249)、[nat-api 维护分支](https://github.com/silentbot1/nat-api)。开发 Node.js 下限同步为 22.12；macOS 安装包下限继续为 13。

另外检查并运行既有 API／WebSocket 鉴权、Origin、回环 Host、查询令牌、配置白名单、原型键、符号链接越界、reveal 路径及 IPC 来源检查。真实 Chromium worker 验证免令牌状态无法读取凭据或指定外部目录，仍可正常发送下载。Electron 已启用 contextIsolation、sandbox，关闭 Node 集成；此前报告中的 sandbox:false 不是真实缺陷。

## 性能实测

`npm run test:backend-performance` 启动真实后端与 aria2，预置 500 条模拟已完成任务，16 个并发客户端交替请求四类接口，共 10,000 次。每次校验 HTTP 状态和任务数。

| 接口 | 次数 | P50 | P95 | 最大 |
| --- | ---: | ---: | ---: | ---: |
| tasks | 2,500 | 2.76 ms | 4.17 ms | 9.63 ms |
| stats | 2,500 | 1.99 ms | 3.45 ms | 9.28 ms |
| dashboard | 2,500 | 1.66 ms | 2.91 ms | 9.14 ms |
| health | 2,500 | 1.97 ms | 3.45 ms | 11.03 ms |

总计 1.41 秒，约 7,083 请求／秒，失败 0。后端 RSS 从 83.64 MiB 至 169.48 MiB，结束时堆使用 70.19 MiB。事件循环采样分辨率 10 ms，P95 为 10.78 ms，最大 11.50 ms。这是本机短时突发负载，未覆盖长期内存趋势、大量任务的浏览器渲染或公网吞吐。

网页初始 JS 为 387,051 字节，gzip 140,641 字节；CSS 为 88,224 字节，gzip 14,099 字节，三个构建预算检查通过。

### 真实大文件与分段正确性

| 文件 | 字节 | 最大连接 | 耗时 | 校验 |
| --- | ---: | ---: | ---: | --- |
| 本地 Range 服务 | 536,870,912（512 MiB） | 8 | 36.170 s | 暂停／恢复后 SHA-256 与源内容一致 |
| Node.js 官方源码包 | 106,194,544 | 8 | 41.326 s | 与官方 SHA-256 清单一致 |

本地记录 16 次请求，包含不同非零偏移的 HTTP 206，峰值 8 个并发请求。配置总限速 16 MiB/s，耗时用于验证连接、分段和恢复正确性，不代表设备最大速度。外部文件 SHA-256 为 `5ae198a2ec0513ea8b7ef28f71094c9a7931a44e4db17b1734d76fe958e0ff36`，依据为 [Node.js 官方清单](https://nodejs.org/dist/v22.23.5/SHASUMS256.txt)。临时下载在测试后清理。

## 验证与边界

- `npm test`：105 项 Node 可靠性／回归检查通过，另含扩展逻辑、页面、双语及单位换算检查。
- `npm run test:web-build`：生产构建及 3 项资源预算检查通过。
- `npm run test:desktop-engine`：真实 aria2 重名与重试、清空记录保留文件、多分片 HLS、AES-128、并发重名转封装、DASH 双轨及纯音频通过。
- `npm run test:desktop-multiconnection`：两份大文件、8 连接、Range、暂停恢复与 SHA-256 通过。
- `npm run test:desktop-extension`：开发环境及打包应用内，真实 Electron／Chromium 的语言切换、设置保存、资源数量与任务状态角标、下载接管和失败回退通过。
- `npm run pack:extension`：25 个文件、两份语言 JSON 与 ZIP 结构通过。

本机未运行 Windows、Intel Mac，未测试公共 BT 网络及长期直播录制，也未使用真实路由器或安装可选 N_m3u8DL-RE。UPnP 客户端真实初始化与销毁通过，端口映射和外部引擎生命周期通过模拟覆盖。AES 解密仍按分片缓冲，DASH 多轨仍使用中间文件，超大分片的长期内存压力和多轨磁盘峰值仍需单独验证。

完整打包入口在重新下载固定版本 FFmpeg 时遇到 npm 源 TLS／连接中断。随后使用本机既有同版本引擎及已安装 Electron，执行 electron-builder 的 `--dir --publish never --config.electronDist=node_modules/electron/dist` 完成本地应用打包。应用通过严格签名校验，24 个 Mach-O 组件通过 ARM64 架构检查，并从包内完成上述桌面与扩展联动。本次未创建发布标签或发布新 GitHub Release。

本地测试安装包为 `dist-electron/Foxdown-0.0.1-mac-arm64.dmg`，重新生成后通过 `hdiutil verify` 校验；扩展包为 `Foxdown-extension.zip`。

原始日志为本机 `.scratch/independent-*.log`；依赖扫描为 `.scratch/independent-audit-final-{root,server,web}.json`，接口负载为 `.scratch/independent-performance.json`，大文件记录为 `.scratch/independent-downloads.json`。按仓库规则不提交这些临时文件。
