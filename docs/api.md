# Foxdown API 契约（v1）

Base: `http://127.0.0.1:16801`。REST 前缀 `/api/v1`。实时推送：WebSocket `ws://127.0.0.1:16801/ws`。
鉴权：若 settings.apiToken 非空，需 `Authorization: Bearer <token>` 或 `?token=`；默认空（仅监听 127.0.0.1）。
CORS 全开（供浏览器扩展使用）。

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
| POST | `/api/v1/resolve` | 请求 `{url, headers?: string[]}`；响应见下 |
| POST | `/api/v1/tasks` | 创建任务，见下 |
| GET | `/api/v1/tasks?status=all|active|waiting|stopped&search=关键词` | `{tasks: Task[]}` |
| GET | `/api/v1/tasks/:engine/:id` | 单个任务详情 |
| POST | `/api/v1/tasks/:engine/:id/action` | `{action: pause|resume|retry|delete, deleteFiles?: bool}` → `{ok}` |
| POST | `/api/v1/tasks/pause-all` / `resume-all` | 全局控制 |
| GET | `/api/v1/stats` | `{downloadSpeed, uploadSpeed, numActive, numWaiting, numStopped}` |
| GET | `/api/v1/settings` | 当前设置（隐藏 rpcSecret） |
| PUT | `/api/v1/settings` | 部分更新；改 aria2 关键项会自动重启引擎 → `{ok, restarted}` |
| POST | `/api/v1/trackers/update` | 拉取最新 BT tracker 并应用 → `{ok, count}` |
| POST | `/api/v1/reveal` | `{path}` 在系统文件管理器中定位 |
| GET | `/api/v1/doctor` | 环境自检：aria2c/ffmpeg/ffprobe/N_m3u8DL-RE 版本+路径+可用性、目录可写性（语义参考 N_m3u8DL-RE doctor） |
| POST | `/mcp` | MCP Server（Model Context Protocol，Streamable HTTP + JSON-RPC 2.0）：9 工具 resolve_task/create_task/list_tasks/get_task/get_task_status/get_task_stats/pause_task/continue_task/delete_task，语义对齐 Gopeed |
| GET | `/api/v1/dashboard` | 数据看板：速度历史采样（1Hz×300 点）+ 累计下载/上传量、完成数 |
| POST | `/api/v1/tasks/:engine/:id/priority` | 队列优先级 `{direction: top|bottom|up|down}`（aria2 changePosition） |
| POST | `/api/v1/speed-profiles/apply` | 应用限速预设 `{index}`（全速/办公/夜间三档） |

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
