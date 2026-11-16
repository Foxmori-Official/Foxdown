---
layout: privacy
title: "Foxdown 隐私政策 / Privacy Policy"
permalink: /privacy.html
---

# Foxdown 浏览器扩展隐私政策 / Browser Extension Privacy Policy

更新日期 / Updated: 2026-11-16

## 中文

Foxdown 扩展用于发现网页资源，并将浏览器下载交给你配置的 Foxdown 下载服务。默认服务地址为 `http://127.0.0.1:16801`。扩展不要求注册 Foxmori 账号。

### 处理的数据和用途

| 数据 | 用途与保存位置 |
| --- | --- |
| 下载地址、建议文件名、你选择的下载参数 | 发送给你配置的 Foxdown 服务以创建下载任务。 |
| 与资源相关的 HTTP 请求头，包括 Cookie、Authorization、User-Agent、Referer、Origin，以及下载站点 Cookie | 为需要登录态、签名或来源校验的下载提供请求信息；Cookies API 用作捕获请求头的补充。Cookie 和 Authorization 可能包含敏感认证信息。 |
| 当前标签页地址、标题、页面链接、发现的媒体地址、资源类型和大小 | 用于页面资源列表、数量角标、媒体预览、批量选择和文件名模板。深度搜索开启或由你手动触发时，还会在页面脚本文本及播放器相关变量中查找资源地址。 |
| 服务地址、API Token、语言、过滤规则及功能开关 | 保存于本设备 `chrome.storage.local`，用于连接服务并应用你的设置。 |
| 活跃、等待和失败任务的状态与速度 | 从你配置的服务读取，用于界面、角标和通知。 |

下载接管与媒体嗅探默认开启，可以分别关闭。自动下载嗅探资源、自动深度搜索及接收其他扩展的下载请求默认关闭。手动选择资源或开启对应自动功能后，扩展才会向下载服务提交这些资源。

### 数据去向和外部请求

下载地址、文件名、必要请求头和下载参数发送到你配置的服务；默认的扩展到服务连接是本机回环。Foxdown 服务随后会访问下载来源、重定向地址和媒体清单引用的资源，这些请求不局限于本机。当前服务版本可能把传入的下载凭据继续用于清单依赖资源或重定向请求，包括不同来源的资源；本政策不承诺跨域凭据隔离。

媒体预览会从资源所在站点读取媒体，临时请求规则可能为播放器附加捕获到的 Referer，关闭预览后移除。点击“检查更新”时，扩展向 GitHub 请求公开 Release 信息，不附加 Foxdown API Token、下载地址或页面历史；GitHub 会接收正常网络连接信息，例如 IP 地址。主动打开项目、帮助或下载链接时，浏览器按通常方式访问对应网站。

点击“解析页面视频”时，扩展会把当前网页地址发送给你配置的 Foxdown 服务。服务可以调用你安装的 yt-dlp 请求所在网站的媒体信息。X 帖子无法解析时，扩展还可以向 X 的公开嵌入接口提交帖子 ID 以取得媒体地址。此解析流程不发送浏览器的网站 Cookie 或登录凭据。自动发现媒体不会启动 yt-dlp。

Foxmori 不运营用于接收扩展浏览记录、下载记录或认证信息的收集服务器。若你配置远程 Foxdown 服务，这些下载信息会离开本机；请选择可信服务，并使用 HTTPS 和 API Token。

### 保存、删除和你的控制

配置和 API Token 保存在本设备扩展存储，不使用扩展专用加密保险库。旧版同步配置会迁移到本机并从同步区移除。嗅探资源、必要请求头和防重复状态使用浏览器会话存储，以支持后台休眠恢复。页面导航或关闭会清理该页嗅探媒体，浏览器会话结束会清理会话存储。

你可以在扩展内关闭接管或嗅探、配置过滤规则及管理导入导出。导出的配置可能包含令牌，应妥善保管。卸载扩展会删除其浏览器存储，但不会删除 Foxdown 服务上的任务记录、已下载文件或你手动导出的配置；这些数据需在服务或磁盘中分别管理。

### 使用限制

数据仅用于上述下载联动、资源发现、预览、设置及状态展示功能。不出售或出租用户数据，不用于广告、分析追踪、信用评估或其他无关用途。不主动采集支付、健康信息或个人通信正文，也不要求用户输入网站账号密码；下载地址和认证请求头仍可能包含个人或敏感信息。

通过 Chrome 扩展 API 获取的信息的使用遵循 Chrome Web Store User Data Policy，包括 Limited Use 要求。

联系与问题反馈：https://github.com/Foxmori-Official/Foxdown/issues

## English

Foxdown discovers page resources and sends browser downloads to the Foxdown service you configure, defaulting to `http://127.0.0.1:16801`. No Foxmori account is required.

### Data and purposes

The extension handles download URLs, suggested filenames and chosen download parameters to create tasks. It captures relevant request headers, including Cookie, Authorization, User-Agent, Referer and Origin, and can obtain cookies for the download site as a fallback. Cookies and Authorization headers may contain sensitive authentication information.

It handles tab URLs and titles, page links, media URLs, resource types and sizes for resource lists, badges, previews, batch selection and filename templates. When enabled or manually invoked, deep search looks for resource URLs in page script text and player-related variables. Server addresses, API tokens, language preferences, filters and switches are kept in device-local extension storage. Task status and transfer speeds are read from the configured service.

Download capture and media detection are on by default and can be disabled separately. Automatic media downloading, automatic deep search and requests from other extensions are off by default. Resources are submitted after user selection or according to explicitly enabled automatic features.

### Destinations and network requests

Download details and necessary request headers are sent to your configured service. The default extension-to-service connection uses loopback. The service then contacts download sources, redirects and resources referenced by media playlists. Those subsequent requests can leave your device. The current service may reuse submitted credentials for playlist dependencies or redirects, including resources on a different origin; this policy does not promise cross-origin credential isolation.

Media preview requests media from its hosting site. Temporary rules may attach the captured Referer and are removed when preview closes. Choosing Check for updates requests public release information from GitHub without attaching a Foxdown token, download URLs or browsing history. GitHub receives normal network metadata such as your IP address. Opening project, help or download links visits the linked websites normally.

Selecting “Resolve page videos” sends the current page URL to your configured Foxdown service. The service can use your installed yt-dlp to request media information from the site's servers. For an X post that the service cannot resolve, the extension may send its post ID to X's public embed endpoint to get media URLs. The lookup does not send browser website cookies or sign-in credentials. Automatic media discovery does not start yt-dlp.

Foxmori does not operate a server collecting extension browsing history, download history or authentication information. Configuring a remote service sends download information off-device; choose a trusted service and use HTTPS and an API token.

### Retention and control

Settings and API tokens use `chrome.storage.local`, without a dedicated encrypted credential vault. Legacy sync settings migrate locally and are removed from sync storage. Detected resources, required request headers and duplicate-suppression state use browser session storage to survive background-worker suspension. Navigation or tab closure clears that tab's detected media; ending the browser session clears session storage.

You can disable capture or detection, configure filters and import or export settings. Exports may contain tokens and should be protected. Uninstalling removes the extension's browser storage, but does not remove service-side task records, downloaded files or manually exported settings. Manage those separately in the service or on disk.

### Limited use

Data is used only for the download, resource discovery, preview, settings and status features described above. It is not sold or rented, used for advertising or analytics tracking, used for creditworthiness, or used for unrelated purposes. The extension does not intentionally gather payment information, health information or personal communication bodies, and does not ask for website usernames or passwords. Download URLs and authentication headers can nevertheless contain personal or sensitive information.

The use of information received from Chrome extension APIs adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements.

Contact: https://github.com/Foxmori-Official/Foxdown/issues
