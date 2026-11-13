# Docker 无头部署

foxdown 支持以非 root 容器方式运行在 NAS / 服务器上。镜像基于 `node:20-alpine`，
内置 Linux 版 aria2 与 ffmpeg（Alpine 官方源），容器内以非 root 用户 `foxdown`（uid 1000）运行，
根文件系统只读，仅 `/data` 与 `/downloads` 两个卷可写。

## 快速开始

```bash
docker compose build
docker compose up -d
# Web UI: http://<host>:16801
```

目录结构（compose 与数据放在一起）：

```
foxdown/
  docker-compose.yml
  data/        # 设置、任务库、aria2 session、rpc secret（持久化，务必备份）
  downloads/   # 下载文件
```

首次启动前确保宿主机目录可被容器内 uid 1000 写入：

```bash
mkdir -p data downloads
chown -R 1000:1000 data downloads
```

否则 entrypoint 会做可写性预校验并以明确报错退出（容器日志可见修复提示）。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `FOXDOWN_PORT` | `16801` | Web UI / API 端口 |
| `FOXDOWN_HOST` | `0.0.0.0`（镜像内） | 监听地址 |
| `API_TOKEN` | 空 | 访问令牌，远程访问需要设置；空值只允许回环地址和 Host |
| `DOWNLOAD_DIR` | `/downloads` | 下载目录（容器内路径） |
| `DATA_DIR` | `/data` | 数据目录（容器内路径） |

环境变量优先级高于 `data/settings.json`，适合 NAS 图形界面直接配置。

通过反向代理访问 Web UI 时，保留浏览器访问地址对应的 Host。Origin 校验会拒绝其他网站向下载服务发起的请求。

## 群晖 DSM

1. Container Manager（或旧版 Docker 套件）→ 项目 → 新增，选择存放 `docker-compose.yml` 的目录。
2. 或用 SSH：`cd /volume1/docker/foxdown && docker compose up -d`。
3. 宿主机目录建议放在共享文件夹下（如 `/volume1/docker/foxdown/data`），
   在「文件服务」里把目录所有者改为 uid 1000，或 SSH 执行 `chown -R 1000:1000`。
4. 端口冲突时在 compose 中改左侧宿主端口，如 `"18001:16801"`。

## 飞牛 fnOS

1. 「Docker」应用 → Compose → 新建项目，粘贴 `docker-compose.yml` 内容或指向项目目录。
2. 卷路径建议使用 fnOS 存储空间下的绝对路径（如 `/vol1/1000/docker/foxdown/data`）。
3. 同样在启动前确认目录对 uid 1000 可写；fnOS 的 Docker 图形界面可直接编辑环境变量
   （设置 `API_TOKEN`）。

## 威联通 QNAP

1. Container Station → 应用程序 → 建立，粘贴 compose YAML。
2. 宿主机目录如 `/share/Container/foxdown/data`，用 SSH `chown -R 1000:1000`。
3. QNAP 默认 Web 端口较多，若 16801 被占用，映射为其他宿主端口即可。

## 更新流程（数据保留）

数据全部在 `./data` 与 `./downloads` 卷中，更新镜像不影响：

```bash
docker compose build --pull   # 或 docker compose pull（使用远程镜像时）
docker compose up -d          # 重建容器，data/downloads 原样挂载
```

## 备注

- BT 用户请在 compose 中取消 `51413` tcp/udp 端口映射的注释。
- 容器根文件系统为只读（`read_only: true`），应用运行期只写 `/data`、`/downloads` 与 tmpfs `/tmp`。
- 容器内二进制位于 `/usr/bin`（`FOXDOWN_BIN_DIR=/usr/bin`），无需挂载 `bin/`。
