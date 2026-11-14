# Foxdown API 契约（v1）

服务默认地址为 `http://127.0.0.1:16801`，REST 路由以 `/api/v1` 开头。实时状态通过 `ws://127.0.0.1:16801/ws` 推送。
鉴权由 `settings.apiToken` 控制。配置令牌后，请求需携带 `Authorization: Bearer <token>` 或 `?token=`。令牌为空时，服务只接受来自回环地址、Host 为回环地址或 localhost 的请求。

REST、MCP 和 WebSocket 都校验浏览器 Origin，允许与服务 Host 相同的 Web UI 和 Chrome／Edge 扩展来源。扩展访问远程服务时仍需令牌。反向代理应保留客户端访问时的 Host，Vite 开发环境使用仓库内置代理。

修改 `postScript` 需要同源 Web UI，或携带有效 Bearer 令牌。仅查询参数中的令牌不能用于修改脚本。

免令牌浏览器扩展仅可检查健康状态、读取任务与统计、探测资源及创建下载。扩展指定的目录需要位于默认下载目录内，符号链接按实际目标检查。设置、令牌、MCP、Webhook 测试和打开目录等操作需要 Web UI 或显式 Bearer 令牌。

设置更新仅接受已定义字段及其正确类型，非法值会返回 400。`postScript` 等路径与 HTTP 头配置拒绝控制字符，速度预设会校验名称及上下行数值。

## 命令行

启动 Foxdown 后，可以查看任务或提交下载：

```sh
node cli/foxdown.mjs list
node cli/foxdown.mjs add "https://example.com/file.zip"
```

`FOXDOWN_SERVER` 指定服务地址，`FOXDOWN_TOKEN` 指定访问令牌。MCP JSON-RPC 接口位于 `POST /mcp`，使用相同的 Web API 令牌；工具和请求格式见下文。容器部署见 [Docker 文档](docker.md)。

## 统一任务模型（Task）

```json
{
  "id": "string",                  // aria2 任务为 gid；stream 任务为内部 id
  "engine": "aria2" | "stream",
  "kind": "file" | "torrent" | "stream",
  "name": "string",
  "status": "active" | "waiting" | "paused" | "error" | "complete" | "removed"   // aria2
            | "downloading" | "muxing" | "cancelled",                            // stream 附加
  "totalLength": 0, "completedLength": 0, "uploadLength": 0,
  "downloadSpeed": 0, "uploadSpeed": 0,
  "connections": 0, "numSeeders": 0,
  "dir": "下载目录", "infoHash": "", "errorCode": 0, "errorMessage": "",
  "files": [{ "index": 1, "path": "", "length": 0, "completedLength": 0, "selected": true }],
  "createdAt": 0,
  // 仅 stream：
  "progress": { "totalSegments": 0, "doneSegments": 0, "bytesDownloaded": 0, "speed": 0, "eta": 0, "live": false },
  "outputFiles": ["..."],
  "streamMeta": { "format": "hls|dash", "live": false }
}
```

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/health` | `{ok, aria2, aria2Version, stream, ffmpeg, externalStreamEngine}` |
| GET | `/api/v1/updates` | 查询 GitHub 的最新正式版本，返回 `{version, available, releaseUrl}`。查询失败时返回 502。 |
| POST | `/api/v1/resolve` | 请求 `{url, headers?: string[]}`；响应见下 |
| POST | `/api/v1/tasks` | 创建任务，见下 |
| GET | `/api/v1/tasks` | 可通过 `status`（`all`、`active`、`waiting`、`stopped`）和 `search`（关键词）筛选，返回 `{tasks: Task[]}`。 |
| GET | `/api/v1/tasks/:engine/:id` | 单个任务详情 |
| POST | `/api/v1/tasks/:engine/:id/action` | `action` 可取 `pause`、`resume`、`retry` 或 `delete`。删除时可传布尔值 `deleteFiles`，成功时返回 `{ok}`。 |
| POST | `/api/v1/tasks/pause-all` / `resume-all` | 全局控制 |
| POST | `/api/v1/tasks/clear-completed` | 清空已完成任务记录，保留磁盘文件。返回 `{removed, failed}` |
| GET | `/api/v1/stats` | `{downloadSpeed, uploadSpeed, numActive, numWaiting, numStopped}` |
| GET | `/api/v1/settings` | 当前设置，包含 Web API 令牌和 aria2 RPC 密钥 |
| PUT | `/api/v1/settings` | 提交部分设置。请求包含需要重启的 aria2 配置项时，服务会自动重启引擎。成功时返回 `{ok, restarted}`。 |
| POST | `/api/v1/trackers/update` | 拉取最新 BT tracker 并应用 → `{ok, count}` |
| POST | `/api/v1/reveal` | `{path}` 在系统文件管理器中定位 |
| GET | `/api/v1/doctor` | 检查 `aria2c`、`ffmpeg`、`ffprobe` 和可选的 `N_m3u8DL-RE`。返回工具的路径、版本和可用状态，以及默认下载目录和数据目录是否可写。 |
| POST | `/mcp` | MCP 服务使用 Streamable HTTP 和 JSON-RPC 2.0，提供 9 个资源解析和任务管理工具。 |
| GET | `/api/v1/dashboard` | 数据看板：速度历史采样（1Hz×300 点）+ 累计下载/上传量、完成数 |
| POST | `/api/v1/tasks/:engine/:id/priority` | 调整 aria2 等待队列中前 100 个任务的顺序。`direction` 可取 `top`、`bottom`、`up` 或 `down`。流媒体任务返回 400。 |
| POST | `/api/v1/speed-profiles/apply` | 应用限速预设 `{index}`（全速/办公/夜间三档） |

### MCP 工具

调用 `tools/list` 可获取工具及其参数定义。通过 `tools/call` 调用以下工具。

- `resolve_task` 解析资源，`create_task` 创建下载任务。
- `list_tasks`、`get_task`、`get_task_status` 和 `get_task_stats` 查询任务或统计数据。
- `pause_task`、`continue_task` 和 `delete_task` 暂停、继续或删除任务。

### resolve 响应

- 普通文件：`{type:"file", url, name, totalLength, resumable, contentType}`
- 种子/磁力：`{type:"torrent", url, name, totalLength?, files?[{path,length}], trackers?, magnet?, torrentBase64?}`
- 流媒体：`{type:"stream", url, format:"hls|dash", live, name, variants:[{id,bandwidth,resolution,frameRate,codecs,audio}], duration?}`

### 创建任务请求

```json
{
  "url": "...",            // 或 "urls": ["..."] 多源/批量镜像
  "torrentBase64": "...",  // 或直接提交种子文件内容
  "metalinkBase64": "...", // 或直接提交 Metalink 文件内容
  "options": {
    "dir": "...", "out": "文件名", "referer": "...", "userAgent": "...",
    "cookie": "...", "headers": ["X: y"], "split": 16,
    "maxConnectionPerServer": 16, "selectFile": "1,3-5", "seedTime": 60,
    "checksum": "sha-1=BASE32...",   // aria2 --checksum 透传
    "startAt": 1792481997991         // 定时开始（时间戳 ms，创建即暂停到点自启）
  },
  "stream": {              // url 是 m3u8/mpd 时提供（省略则按默认）
    "select": "best",      // best|worst|带宽|1080|N_m3u8DL DSL（如 "res=^1280:for=best"）
    "drop": "res=^640:for=all",  // DSL 反向剔除（-dv 语义）
    "key": "hex 密钥",      // 可选，AES-128 覆盖
    "iv": "hex IV",         // 可选，自定义 IV
    "adKeywords": ["ad"],  // 广告分片 URL 正则剔除（--ad-keyword）
    "customRange": "0-10", // 分片区间或时间轴 "05:00-20:00"（--custom-range）
    "liveRecordLimitMin": 0,
    "mux": true            // 完成后 ffmpeg 转封装 MP4
  }
}
```
响应 `{id, engine}`。

原生流媒体遇到同名输出时添加序号；完成后的任务名称及 `outputFiles` 返回实际结果。恢复／重试接口在启动任务后返回，完成状态通过任务查询或 WebSocket 获取。

资源探测与播放列表的响应体上限为 16 MiB。原生 DASH 每份 MPD 最多展开 100,000 个分片，超出工作量或结构预算会报错。容量设置接受整数、K、M 格式，`minSplitSize` 范围为 1 KiB 至 1 GiB。

### WebSocket 推送

- 每 1s（有变化时更快）：`{type:"state", tasks: Task[], stats: {...}}`
- 事件：`{type:"event", name:"onDownloadStart|onDownloadComplete|onDownloadError|onDownloadStop|onDownloadPause|onBtComplete", gid}`

## 设置项（GET/PUT /api/v1/settings）

downloadDir, maxConcurrentDownloads(5), maxConnectionPerServer(16, 最大64), split(16), minSplitSize("1M"),
maxOverallDownloadLimit(0), maxOverallUploadLimit(0), continueDownloads(true), fileAllocation("none"),
diskCache("64M"), userAgent, checkCertificate(true),
proxyEnabled(false), proxyServer(""), proxyUser(""), proxyPasswd(""), noProxy(""),
enableDht(true), btEnableLpd(true), btMaxPeers(128), btTracker, btTrackerSource, btTrackerAutoUpdate(true),
seedRatio(1.0), seedTime(0), followTorrent(true), listenPort(51413),
streamThreadCount(8), streamRetryCount(5), streamTimeoutMs(20000), streamMuxAfterDownload(true),
streamLiveRecordLimitMin(0), preferExternalStreamEngine(true),
savePattern("<SaveName>"), webhookUrl(""), postScript(""), autoExtract(false),
speedProfiles([全速/办公/夜间]), activeSpeedProfile(-1),
apiToken(""), theme("auto"), locale("zh-CN")

`seedTime=0` 表示下载完成后立即停止做种。设为正数时，做种时间和分享率中的任一条件满足后停止。`seedRatio=0` 取消分享率限制，仍受做种时间限制。

流媒体命名支持 `{SaveName}`、`<SaveName>`、`${fileName}` 三种变量语法。两端共用 SaveName／fileName、Host／host 和 Date／date。扩展的 title、ext 与桌面引擎的 Resolution、Codecs 等变量来自各自可获得的数据。

后处理脚本接收 `FOXDOWN_EVENT`、`FOXDOWN_TASK_ID`、`FOXDOWN_TASK_NAME`、`FOXDOWN_FILE` 和 `FOXDOWN_FILE_COUNT`。
