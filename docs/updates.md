# Foxdown 更新与维护

## 查看参考项目的更新

[Upstream changes](https://github.com/Foxmori-Official/Foxdown/actions/workflows/upstream.yml) 每周一北京时间 10:23 提交运行请求，也可从 Actions 手动运行。打开该次运行的 Summary，或下载 `upstream-report`。报告为每个项目列出近期发布、变更摘要、默认分支提交和完整比较链接。发布不频繁的项目也会通过提交比较显示变化。

本地运行同一检查。

```sh
npm run upstream:report
node tools/upstream-report.mjs upstream-report.md
```

`docs/upstreams.json` 记录项目、关注模块和上次审阅的提交。若 GitHub API 限流，可用自己的 GitHub CLI 会话向命令提供 `GH_TOKEN`。首次报告的基线是建立工作流时读取的各仓库 HEAD，仅作为审阅起点。引擎实际使用的版本和 SHA-256 记录在 `tools/download-engines.mjs`。

## 选择要补充的改动

1. 从报告打开对应的发布说明、提交或差异。记录上游 URL、提交或标签、受影响的 Foxdown 模块和用户能观察到的变化。
2. 核对接口、许可证和运行平台。安装包始终内置所需引擎。涉及引擎时，对比 RPC 选项、分段和续传行为，核对每种系统架构的文件和 SHA-256。涉及扩展时，重点看 Chrome／Edge 的权限、MV3 事件和请求头。
3. 把选中的改动实现为独立提交。PR 说明记录来源、选择理由、验证结果及回退方式。下载引擎升级还需验证从旧版会话恢复的路径。
4. 运行 `npm test`、`npm run test:web-build`、`npm run test:desktop-engine` 和 `npm run pack:extension`。涉及安装引导、浏览器接管或 Electron 的改动，需要在相应入口实际操作。
5. 审阅完成后再更新对应项目的 `baseline`。决定暂缓的改动可在 PR 或 issue 记录原因和原始链接。

## 发布 Foxdown

主 README 使用简体中文，英文文档位于 `docs/README.en.md`。每个版本的发布说明保存在 `docs/releases/v<version>.md`，只提供简体中文说明，不添加「English」章节，也不使用自动生成的英文提交列表替代发布说明。

1. 同步更新根包、服务端、Web 包、浏览器扩展 manifest 的版本和 npm lockfiles。
2. 检查 [Desktop and extension builds](https://github.com/Foxmori-Official/Foxdown/actions/workflows/desktop.yml) 的四个平台构建和扩展产物。使用旧版本用户目录验证升级，并用临时用户目录验证首次安装。
3. 准备对应版本的简体中文发布说明。可以在 main 分支提交标题为 `release: v<version>` 的发布提交，也可在 Actions 手动运行构建并填写 `release_tag`。工作流会先核对所有包与锁文件的版本，完成四个平台的构建和测试后，为该提交创建标签并生成 Release 草稿。直接推送 `v<version>` 标签也支持同一流程。普通提交仅构建，不创建版本。
4. 在草稿中补充此次变更、已知限制、上游来源与升级说明，核对签名与安装结果后发布。用户通过「查看更新」访问已发布的版本。

macOS ARM64 默认由 GitHub Intel Mac 交叉构建，流程验证 ARM64 组件与签名，原生启动和扩展联动需在 Apple 芯片机器验证并记录。标准 ARM 执行器可用时，可勾选手动运行中的 `native_mac_arm64`，直接执行原生 ARM 安装包测试。只做验证时将 `release_tag` 留空。

main 分支的构建按提交隔离并发队列，过期构建会自动取消。长期排队且未响应普通取消的旧任务会被清理，避免阻塞新提交。

若需要回退，从 Releases 获取前一版本并备份用户数据后安装。若版本改变了数据格式，使用升级前的备份验证兼容性。
