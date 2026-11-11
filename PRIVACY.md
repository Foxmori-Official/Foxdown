# 隐私政策 / Privacy Policy

**Foxdown Connector** 浏览器扩展 · 更新日期：2026-10-19

---

## 中文

### 我们处理哪些数据

本扩展的功能是：把你发起的浏览器下载，连同必要的请求信息，发送给你本机运行的 Foxdown 下载管理器（默认 `http://127.0.0.1:16801`）以创建下载任务。为实现该功能，扩展会接触以下数据：

| 数据 | 来源 | 用途 | 去向 |
|---|---|---|---|
| 下载地址（URL） | Chrome 下载项 | 创建下载任务 | 仅发往你配置的服务器 |
| 建议文件名 | Chrome 下载项 | 指定保存文件名 | 仅发往你配置的服务器 |
| 下载请求的 HTTP 请求头（Cookie、User-Agent、Referer、Origin、Authorization） | webRequest 观测 + Cookies API | 让需要登录态/签名的下载可以正常进行 | 仅发往你配置的服务器 |
| 下载 URL 对应站点的 Cookie | Cookies API（含分区 Cookie） | 同上，作为请求头捕获的兜底 | 仅发往你配置的服务器 |
| 扩展设置（服务器地址、令牌、过滤规则、开关） | 你在选项页中的输入 | 保存于 `chrome.storage.sync` | 仅保存在你的浏览器账号存储中 |

### 明确不做的事

- **不**收集、传输任何数据给第三方；唯一的数据接收方是你自己配置的服务器（默认是你本机的 Foxdown）。
- **不**投放广告，**不**做个性化推荐，**不**进行任何用户行为追踪或分析。
- **不**读取与本扩展功能无关的网页内容；webRequest 仅观测请求头，不修改任何请求。
- **不**收集账号密码、支付信息、健康等敏感信息；Cookie 仅在你发起对应站点的下载时用于该次下载请求。
- **不**出售、出租、交易任何用户数据。

### 数据安全

- 数据仅传输到你配置的服务器地址。默认地址为 `http://127.0.0.1:16801`（本机回环，数据不出你的电脑）；若你自行改为远程服务器地址，数据将通过你所配置的通道传输，请自行确保该服务器可信（建议使用 HTTPS 并设置 API Token）。
- 远程代码：扩展不包含任何从服务器下载并执行的代码，所有逻辑都在扩展包内。

### 你的控制权

- 随时可在扩展选项页或 popup 中**关闭下载接管**；关闭后扩展不再读取或发送任何上述数据。
- 域名/后缀/大小过滤规则完全由你配置。
- 扩展设置可通过选项页的"导出/导入"管理；卸载扩展即删除全部数据。

### 本地组件说明

本扩展需要配套的开源本机程序 **Foxdown**（Node.js，源码见项目仓库）才能提供下载功能。下载任务在你的本机执行，下载的文件保存在你自己的磁盘上。该本机程序是独立的开源软件，由你自行运行和管理。

### 联系我们

如对本隐私政策有疑问，请通过项目仓库提交 issue。

---

## English

### What data this extension handles

The purpose of this extension is to send downloads you initiate — together with the request information needed to complete them — to the **Foxdown** download manager running on your own machine (default `http://127.0.0.1:16801`) to create download tasks. To do this, the extension handles:

| Data | Source | Purpose | Where it goes |
|---|---|---|---|
| Download URL | Chrome download item | Create the download task | Only to your configured server |
| Suggested filename | Chrome download item | Set the saved filename | Only to your configured server |
| HTTP request headers of the download (Cookie, User-Agent, Referer, Origin, Authorization) | webRequest observation + Cookies API | Allow authenticated/signed downloads to work | Only to your configured server |
| Cookies of the download URL's site | Cookies API (incl. partitioned cookies) | Fallback for the above | Only to your configured server |
| Extension settings (server address, token, filters, switches) | Your input in the options page | Stored in `chrome.storage.sync` | Only in your browser account storage |

### What we do NOT do

- We do **not** collect or transmit data to any third party; the only data receiver is the server you configured (your local Foxdown by default).
- No ads, no personalized recommendations, no user tracking or analytics of any kind.
- We do **not** read web content unrelated to this extension's function; webRequest is observe-only and never modifies requests.
- We do **not** collect passwords, payment, health or other highly sensitive data; cookies are only used for the download request you initiate on that site.
- We do **not** sell, rent or trade user data.

### Data security

- Data is transmitted only to the server address you configured. The default is `http://127.0.0.1:16801` (loopback — data never leaves your machine). If you change it to a remote server, data travels over the channel you configured; ensure that server is trusted (HTTPS + API Token recommended).
- No remote code: the extension downloads and executes no code from any server; all logic ships inside the extension package.

### Your controls

- Disable capture at any time from the options page or the popup; when disabled the extension reads/transmits none of the above.
- Domain/extension/size filter rules are fully user-configured.
- Settings can be managed via Export/Import in the options page; uninstalling the extension removes all data.

### Local component

This extension requires the companion open-source local application **Foxdown** (Node.js, source in the project repository). Downloads run on your machine and files are saved to your own disk. The local program is separate open-source software that you run and control yourself.

### Contact

Questions about this policy: please open an issue in the project repository.
