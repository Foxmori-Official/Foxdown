# Foxdown 审查报告核实与修复记录

核实日期为 2026-11-13。输入文件为 `foxdown_project_review_report.md`，对照源码为 `4f3e30b3ad5a823dfc56ec4215e686a8ecc998b8` 的本地副本。GitHub MCP 查询确认主分支仍指向该提交，Release 和 Tag 列表为空。

本次逐项核对源文件、复现相关接口行为，并验证修复后的运行入口。报告提到的八张截图未随文件提供，截图里的像素、布局比例和对比度数字只能作为描述参考。

## 后端与桌面端

| 报告条目 | 核实结论 | 处理结果 |
|---|---|---|
| 2.1 任意网页可调用本地 API | 成立。修复前，携带不可信 Origin 的设置 PUT 返回 200，并实际更新 postScript，响应 CORS 为 *。 | REST、MCP、WebSocket 共用 Origin 校验，空令牌时同时检查回环 Host 与对端地址，覆盖 DNS rebinding。修改脚本需要同源 Web UI 或有效 Bearer 令牌。 |
| 2.1 下载脚本即可在全部平台零点击执行 | 攻击后果需要结合平台、脚本权限和执行方式判断。macOS／Linux 上普通下载文件通常没有执行权限，报告给出的三步描述不足以证明每个平台都能直接执行。设置写入和任务创建权限缺陷已能独立复现。 | 对执行链路的入口增加来源、Host 与脚本设置写权限检查。 |
| 2.1 只收紧 CORS 就能防 DNS rebinding | 报告代码仅检查 Origin 中的回环域名，缺少 Host／对端校验，也未覆盖 WebSocket。 | 补齐 Host 和 WebSocket 检查，保留同源远程 Web UI 与带令牌 CLI 的访问方式。Vite 代理保留原 Host。 |
| 2.2 没有目录／脚本文件选择器 | 成立，原 preload 只提供启动和登录项接口。 | 增加使用既有 sender／顶层 frame 校验的 IPC。设置和新建任务支持目录选择，后处理支持脚本选择，取消选择时保留表单内容。 |
| 2.3 导出文件名与脚本变量仍使用旧品牌 | 成立，配置导出名为 rdown-config，脚本环境变量实际只有 RDOWN_*。报告所说的 FDOWN_* 注入不符合当前代码。 | 导出名改为 foxdown-config，新增 FOXDOWN_* 变量并保留 RDOWN_*。九种语言的提示同步更新。 |
| 2.3 旧环境变量、内部菜单 ID 都应删除 | KIMI_*、RDOWN_* 环境变量和 rdown CLI 是旧调用方的兼容入口，内部消息名称没有独立的功能故障证据。 | 用户可见品牌统一，旧调用入口继续兼容。深度搜索旧消息桥接已因权限问题移除。 |
| 2.4 seedTime=0 会停止做种 | 成立，随项目打包的 aria2 1.36 帮助也说明，时间与分享率条件任一满足就停止。原配置注释把 0 写为 unlimited，UI 的时间提示已写为立即停止。 | 保留既有默认策略，修正注释和分享率说明，在做种时间为 0 时禁用分享率输入。自动把默认值改为 60 分钟属于下载后的行为策略调整。 |

做种语义可核对 [aria2 官方手册](https://aria2.github.io/manual/en/html/aria2c.html#cmdoption-seed-time)。报告建议把 aria2 的“监听所有网卡”开关放进 Web API 区块，但该开关实际只影响 aria2 RPC，修复后的设置页将其放在 aria2 区块。

## 浏览器扩展

| 报告条目 | 核实结论 | 处理结果 |
|---|---|---|
| 3.1 网页可通过 externally_connectable 请求下载 | 成立，前提是用户打开 allowExternalRequest。manifest 包含全网 matches，消息处理器未验证 sender.id。默认开关为关闭。 | 删除网页 matches，仅接受扩展 sender.id，保留其他扩展的可选接入。 |
| 3.1 dir 可以修改保存目录 | 成立，原外部选项白名单直接透传 dir。 | 外部消息不再接受 dir，只接受安全文件名和指定下载选项。filename 和 options.out 两条入口都校验。 |
| 3.1 out=../../ 可直接路径穿越 | 这条具体路径在当前后端被 createTaskFromBody 的 sanitizeFilename 清洗，原报告漏查了最终任务创建入口。 | 扩展入口同时拒绝路径、隐藏启动文件和 Windows 保留设备名，使约束在转交前生效。 |
| 3.2 两端模板语法不一致 | 成立，后端原先会在 ${fileName} 中留下美元符号，扩展只识别 ${var}。两端可获取的元数据也有差异。 | 通用变量 SaveName／fileName、Host 和 Date 兼容三种括号写法与大小写别名。title／ext 仍来自扩展，Resolution／Codecs 等来自桌面引擎。 |
| 3.3 sync 存放令牌和长列表 | 成立。8 KiB 是每项配额，触发取决于每项实际大小，与服务器条数没有固定对应关系。local 存储仍是扩展本机存储。 | 配置迁移到 local。跨 worker／页面的迁移有锁，已有本机值优先，写入成功后清除旧 sync 项，失败可以重试。隐私说明同步更新。 |
| 3.4 页面链接全部立即串行提交 | 成立，原内容脚本会收集导航和图片，后台直接逐条提交。 | 先过滤常见导航与装饰图片，再应用用户规则，打开选择窗口。支持链接／后缀筛选，用户确认后每批最多 5 项并发发送，成功项移除，失败项可重试。 |
| 3.5 防盗链媒体预览缺少 Referer | 成立，但补一个请求头无法保证所有站点、跨域分片、登录态、编码和 DRM 内容都可播放。报告里的 tabIds=-1 也只匹配没有标签页的请求。 | 仅为当前扩展预览、对应媒体 URL／HLS 同源分片添加会话 Referer 规则，使用实际标签页 ID 或 TAB_ID_NONE，关闭预览或端口断开时清理。 |
| 3.6.1 选中文本菜单漏注册 | 成立，语言包已有 menuSel，后台没有对应菜单。 | 新菜单提取 HTTP／HTTPS／magnet 链接，并复用批量选择确认。 |
| 3.6.2 顶层定时器与内存防重状态会丢失 | 自动发送成功记录和媒体列表确实只在内存。短期请求头缓存在 worker 停止后自然消失，因此定时器自身不是同等严重的持久化故障。 | 清理并入已有一分钟 alarm，读取时也检查头缓存时效。媒体和成功发送记录存入 session，标签页导航／关闭清理对应媒体。 |
| 3.6.3 静态语言提示矛盾 | 成立，但正常运行后 i18n 会覆盖静态文字，影响主要是未完成加载的状态。 | 静态文字与语言包同步。 |
| 3.6.4 网页可以伪造深度搜索消息 | 可以往候选列表注入 URL。自动发送还取决于开关、体积阈值和媒体类型，原报告省略了条件。把 nonce 放到页面注入脚本中仍可被同页脚本观察，不能形成可信边界。 | 使用 chrome.scripting.executeScript 的直接返回值，移除 postMessage 接收桥。深度搜索候选项只供用户选择，自动发送以实际网络嗅探为依据。 |

扩展行为依据 [externally_connectable 文档](https://developer.chrome.com/docs/extensions/reference/manifest/externally-connectable)、[Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)、[Scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting) 和 [declarativeNetRequest 文档](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest) 核对。媒体规则不会补齐站点特有的全部鉴权条件。

## UI／UX 与仓库说明

| 报告条目 | 核实结论 | 处理结果 |
|---|---|---|
| 4.1 全部暂停／继续没有禁用态 | 误报，Tasks.vue 已按活跃和暂停任务绑定 disabled。 | 复核现有代码与桌面流程。 |
| 4.1 速度图、等待数、搜索排序、完成时间、文件分类、批量清理、删除文件确认 | 属于功能或呈现增强，不能据缺少这些能力判定现有流程有错误。底层任务删除 API 已支持 deleteFiles。 | 本次记录为后续产品建议。 |
| 4.2 缺少目录选择 | 成立，与 2.2 相同。 | 已实现。 |
| 4.2 限速预设没有高亮 | 当前已有按钮类型绑定和数值 watcher。原实现可能被持久化的 activeSpeedProfile=-1 覆盖，且输入值不变时 watcher 不再触发。 | 改为直接按上下行限速计算当前预设，并增加 aria-pressed。 |
| 4.2 夜间预设名称、步进器宽度 | 属于命名和布局偏好，报告所引截图未提供。 | 记录为呈现建议。 |
| 4.3 Web API 与 aria2 RPC 容易混淆 | 成立，原界面没有显示 Web API 实际地址。API 令牌原本已有密码显隐。 | 在现有分类下显示两个区块、Web API 实际地址与复制按钮，aria2 的设置归入对应区块。 |
| 4.4 模板变量无法点击插入 | 误报，已有 @click=insertVar，并处理光标位置。实时预览和流媒体引擎状态属于新增功能。 | 保留已有交互，修复模板语法。 |
| 4.5 Tracker 更新没有加载态 | 误报，按钮已有 loading=trackerUpdating。条数、时间和订阅源选择是增强建议。 | 保留现有加载状态，修正做种提示。 |
| 4.6 后处理变量和脚本选择 | 成立。脚本“测试运行”属于新增的执行入口。 | 更新变量并增加选择器。 |
| 4.7 代理关闭后标签过淡 | 源码中整组 opacity=0.5 成立，报告给出的 WCAG 数值缺少实测依据。 | 移除整组透明度，输入框继续使用 disabled。 |
| 4.7 代理密码没有显隐 | 误报，输入框原本已有 show-password。测试代理属于新功能。 | 复核原实现。 |
| 4.8 应用页没有版本与引擎诊断卡 | 描述符合现状，/health 与 /doctor 已有接口，但增加诊断卡及报告导出属于新功能。 | 记录为后续产品建议。 |
| 5.1.1 中英文 README 错把主题／语言放在应用页 | 误报。当前两份文档实际写的是启动项、扩展指南和更新，报告引用的两句话不存在。 | 复核文档原文。 |
| 5.1.2 没有公开 Release／Tag | GitHub MCP 返回空列表，事实成立。现 README 也已经提供 Actions 产物作为开发版本来源。 | 记录发布状态，未把报告内的发布指令当作用户授权。 |
| 5.1.3 缺少截图、徽章和 Topics | 展示改进建议，访客“80% 划走”的说法没有数据依据。 | 记录为仓库展示建议。 |
| 5.1.4 CLI／Docker／MCP 入口不明显 | 成立，功能存在，主 README 缺少使用入口。 | 在现有中英文文档增加简短用法和真实文档链接。 |
| 5.1.5 macOS 必须执行 sudo xattr | 报告把未公证与必然损坏提示、必须使用命令行等同，结论过度。 | 桌面文档补充来源确认和系统隐私与安全性入口，按 Apple 的说明操作。 |
| 5.2 直接替换完整 README | 模板含搜索结果形式的文档链接，部分发布状态和能力描述未经运行证明。 | 按核实结果做局部文档更新。 |

macOS 打开应用的操作参考 [Apple 支持文档](https://support.apple.com/en-euro/guide/mac-help/mh40617/27/mac/27)。报告的阶段清单重复了以上条目，可按这些核实结论追踪。

## 验证中额外发现的问题

- 扩展预览将 display 设为空字符串时，样式表的 display:none 仍然生效，播放器和错误提示一直隐藏。已明确显示预览区域，真实浏览器播放验证覆盖该回归。
- 桌面启动把默认下载目录当成 DOWNLOAD_DIR 环境强制覆盖，重启会丢失用户选择的下载路径。已区分默认目录与显式环境覆盖，并增加持久化回归测试。
- 桌面自动测试原先与用户运行中的 Foxdown 共用单实例目录，可能提前退出。测试使用独立临时 profile。
- 复制 aria2 地址原先在剪贴板写入失败时也显示成功。现在使用与其他复制操作相同的错误反馈。
- aria2“监听所有网卡”的旧 v-model 会在确认对话框仍打开时触发自动保存。现在等确认完成后再更新表单，测试覆盖等待期间和取消后的设置值。

## 验证结果

测试环境为本机 macOS ARM64、Node.js 22.23.5、Electron 39.8.10 和 Playwright 的 Chromium。测试用临时数据目录与下载目录。

| 验证入口 | 结果 |
|---|---|
| npm test | 77 个可靠性／回归用例通过，扩展逻辑 113 项、扩展 UI 67 项、语言切换 17 项和单位转换 30 项通过，多语言完整性检查通过 |
| npm run test:web-build | 生产构建和 3 项资源／按需加载检查通过 |
| npm run test:desktop-engine | 令牌校验、HTTP 字节一致性和 HLS 转 MP4 通过 |
| npm run test:desktop-extension | 开发运行环境下的桌面设置、实际下载接管和浏览器失败回退通过，真实 Chromium 中的受保护媒体预览、规则清理、深度搜索和批量确认通过 |
| macOS ARM64 安装包 | 成功构建，25 个 Mach-O 组件通过架构检查，应用签名与 DMG 校验通过 |
| FOXDOWN_TEST_PACKAGED=1 npm run test:desktop-extension | 打包应用通过目录／脚本选择、取消选择、新建任务目录、RPC 确认前阻止自动保存，以及上述桌面／扩展联动验证 |
| npm run pack:extension | 32 个文件通过 ZIP、manifest 与九种语言 JSON 校验 |

产物为 `dist-electron/Foxdown-0.0.1-mac-arm64.dmg` 和 `Foxdown-extension.zip`。macOS 构建使用临时签名。Windows、Intel Mac 和外部 N_m3u8DL-RE 的原生运行验证需要对应环境。
