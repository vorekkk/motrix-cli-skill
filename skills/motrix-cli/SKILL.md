---
name: motrix-cli
description: 用 motrix 命令行客户端驱动 Motrix 下载管理器（中文版）。当任务涉及列出或筛选下载任务、查看聚合速度与任务计数、添加 HTTP(S)/FTP/磁力/种子下载、暂停或恢复或删除任务、流式跟踪下载进度、连接远端或无头 Motrix 服务器时使用。motrix 只是客户端，实际下载由运行中的 Motrix 实例完成。
---

# 用 CLI 驱动 Motrix

`motrix`（npm 包 `@motrix/cli`）是 Motrix 下载管理器的命令行客户端。它**只是客户端**：
每条命令都是发给一个**已经在运行**的 Motrix 实例的请求，真正的传输由那个实例完成。
如果 Motrix 没在跑，命令会快速失败（退出码 `3`），此时先 `motrix open`。

协议：MDXP（JSON-RPC 2.0），一元 `POST /mdxp`；通知走 `GET /mdxp/events`（SSE）；配对走 `/mdxp/pair/*`。

## 何时使用

- 枚举/筛选下载任务、读取聚合速度与任务计数
- 添加下载：HTTP(S)/FTP 链接、磁力链（`--magnet`）、种子文件（`--torrent`）
- 控制任务生命周期：暂停、恢复、删除（可选删文件）
- 流式跟踪进度直到完成
- 连接远端/无头 Motrix 服务器（NAS、Docker 部署）

## 前置条件

- Node.js ≥ 22（`node -v`）。
- 已安装 CLI：`npm i -g @motrix/cli`，然后 `motrix --version` 应能输出版本号。
- 目标 Motrix 可达：本地桌面版无需配置；远端/无头需要先配对。

> 全局安装若报权限错误，用 Node 版本管理器或用户可写 prefix（例如
> `npm config set prefix ~/.local`），**不要**用 `sudo`——那会在全局
> `node_modules` 里留下 root 权限的文件。

## 连接目标

| 场景 | 做法 |
| --- | --- |
| 本地桌面版（推荐） | 零配置。CLI 读取 `<userData>/bridge/endpoint.json`（含端口与机器属主 token）。macOS 路径：`~/Library/Application Support/Motrix/bridge/endpoint.json`；Windows：`%APPDATA%\Motrix\bridge\endpoint.json`；Linux：`$XDG_CONFIG_HOME/Motrix/bridge/endpoint.json` |
| 远端 / 无头服务器 | `motrix pair --endpoint http://nas.local:16801 --name "laptop"`，终端会打印验证码，必须在 Motrix 侧（弹窗或 设置 → 集成 → 待批准）核对同样的验证码并批准 |
| 一次性覆盖 | 全局参数 `--endpoint <url>`、`--token <token>`，或环境变量 `MOTRIX_BRIDGE_TOKEN`（CI/脚本里优先用环境变量，避免 token 出现在命令行参数中） |

配对成功后签发的 token 存于 `~/.config/motrix/credentials.json`（权限 `0600`，遵循 `XDG_CONFIG_HOME`），按 endpoint 存放并被后续命令自动复用。

## 输出契约（agent 先读这一段）

- **加了 `--json`，或 stdout 是管道 / 非 TTY** → stdout 上是**单个 JSON 值**，这是给机器解析的模式。JSON 模式在管道时自动启用，所以 `motrix list | jq` 无需加参数。
- **交互式 TTY** → 人类可读的表格/摘要。
- `motrix list --json` → `{"tasks":[…],"total":<n>}`。任务对象字段见 `reference/commands.md`。
- `motrix stats --json` → `{"totalDownloadSpeed","totalUploadSpeed","activeTasks","waitingTasks","stoppedTasks"}`（单位 byte/s）。
- `motrix watch` → **NDJSON**，每行一个 `{"event":<名>,"data":{…}}`，直到被中断。
- `motrix list --watch` 是**面向人的 TTY 视图**：管道下会以退出码 `2` 退出。agent 用 `motrix watch`（NDJSON 事件）或 `motrix list --json`（快照）代替。

### 退出码处置（据此分支，不要解析文本）

| 码 | 含义 | agent 应该做什么 |
| --- | --- | --- |
| `0` | 成功 | 继续 |
| `2` | 用法错误（参数/标志不对） | 读 `--help` 修正参数；不要重试同一命令 |
| `3` | 网络：bridge 未运行或不可达 | 本地先 `motrix open`（并等待其就绪）再重试一次；远端检查地址/网络，不要盲目循环重试 |
| `4` | 鉴权：token 缺失或被拒 | 重新 `motrix pair`（远端）或确认 `MOTRIX_BRIDGE_TOKEN`；不要重复重试 |
| `5` | 服务端：bridge 返回 JSON-RPC 错误 | 看错误消息。若是 `-32601`（方法不存在）或 HTTP 404，属**版本漂移**：提示升级 Motrix 或 CLI，重试无用 |
| `6` | 未安装：无法启动桌面版 | 告知用户需要安装 Motrix 桌面版 |
| `7` | 自更新失败 | 不要再重试，改用命令打印的手工升级方式 |

`--json` 模式下原始 JSON-RPC `code` 保留在 `data` 里，可编程分支。

## 命令参考

```bash
motrix list [--status <s>] [--limit <n>] [--offset <n>]   # 列出任务
motrix stats                                              # 聚合速度 + 任务计数
motrix open [--timeout <ms>]                              # 启动本地桌面版并等待 bridge 就绪
motrix add <url...> --save-dir <dir> [--filename <name>] [--header "K: V"] [--connections <n>] [--proxy <url>]
motrix add --magnet <uri> --save-dir <dir> [--select 0,2]
motrix add --torrent <file.torrent> --save-dir <dir>
motrix pause <taskId>                                     # 暂停（暂停所有活动实例）
motrix resume <taskId>                                    # 恢复
motrix remove <taskId> [--delete-files]                   # 删除任务（--delete-files 会删文件）
motrix watch [--task <id>] [--stats]                      # 流式进度（NDJSON）直到 Ctrl-C
motrix pair [--name <label>]                              # 设备码配对
motrix describe [--json]                                  # 打印 MDXP 工具目录（8 个 agent 可用方法）
motrix skill path | install [dir]                         # 定位 / 安装官方自带 skill
motrix self-update [target] [--dry-run]                   # 更新 CLI 自身（退出码 7 = 此环境无法自更新）
```

所有命令都接受全局参数 `--endpoint` / `--token` / `--json`。`motrix --version` 打印 CLI 版本。

`--status` 的取值即任务状态枚举：`queued`、`fetching_metadata`、`downloading`、`paused`、`seeding`、`finalizing`、`completed`、`error`。
任务类型枚举：`http`、`ftp`、`bt`、`magnet`、`metalink`。

## 常用配方

```bash
# 只看正在下载的任务
motrix list --status downloading --json | jq -r '.tasks[] | "\(.id)\t\(.name)"'

# 按名称找到 taskId（用于后续 pause/resume/remove）
motrix list --json | jq -r '.tasks[] | select(.name|test("ubuntu";"i")) | .id'

# 添加带鉴权头与并发数的下载
motrix add "https://example.com/f.zip" --save-dir ~/Downloads --header "Referer: https://example.com" --connections 16

# 跟踪单个任务直到结束（NDJSON，逐行解析）
motrix watch --task <taskId>

# 当前总体速度（byte/s → 人类可读）
motrix stats --json | jq '"\(.totalDownloadSpeed/1048576|.*100|round/100) MB/s"'
```

更多配方（批量添加、幂等重试、错误排查）见 `reference/commands.md`。

## 安全红线（必须遵守）

- `motrix remove <taskId> --delete-files` 是**破坏性操作**：会真的删除磁盘文件。只有用户明确要求删除文件、且 taskId 来自你自己的 `motrix list` 查询结果时才可用。**绝不猜测或构造 taskId**；不确定就先 `motrix list --json` 核对 `name` 与 `saveDir`。
- 配对 token 等于该 Motrix 的**完全控制权**（含添加下载、删除文件）。只批准你自己刚生成的验证码；不再使用的 token 请在 Motrix 侧撤销。
- **不要把 token 写进日志、聊天回复、提交物或脚本**。需要显式传参时优先用 `MOTRIX_BRIDGE_TOKEN` 环境变量；把 token 放进命令行参数会泄漏到进程列表与 shell 历史。
- 不要用 `sudo` 修复 npm 权限问题。
- 写操作（`add`/`pause`/`resume`/`remove`）一律走 CLI 子命令，以保留其退出码语义；只有在 CLI 完全没有对应子命令时才用下面的原生兜底。

## 原生兜底（CLI 未暴露的方法）

CLI 的 `describe` 只列出 8 个 agent 可用方法，其中 **`task/get`（按 id 取单个任务）与 `engine/status`（引擎状态 + 能力报告）没有任何 CLI 子命令**。需要它们时用本 skill 自带的脚本直连 bridge：

```bash
node scripts/mdxp.mjs engine/status            # 引擎状态 + aria2 版本 + 能力列表
node scripts/mdxp.mjs task/get --task <taskId> # 单个任务（不存在时 result 为 null）
node scripts/mdxp.mjs endpoints                # 显示本地/已配对的 endpoint（绝不打印 token）
```

该脚本只发送一元 `POST /mdxp`：`{"jsonrpc":"2.0","id":1,"method":…,"params":{…}}`，并带
`Authorization: Bearer <token>`。token 来源与 CLI 一致：`--endpoint`/`--token` →
`MOTRIX_BRIDGE_TOKEN` → 本地 `endpoint.json` → 已配对凭据。**没有 token 时 bridge 返回 HTTP 401**。
退出码与 CLI 对齐（`0/2/3/4/5`）。默认只允许只读方法；其余方法需要显式 `--allow-write`，且通常不应该用。

实时通知（`$/task/progress`、`$/task/completed`、`$/task/error`、`$/stats` 等）走 SSE `GET /mdxp/events`，属于流式长连接；**继续用 `motrix watch` 消费，不要自己实现 SSE**。

## 权威 schema

参数形状以 **`motrix describe --json`** 为准：它是静态的（不发起 bridge 调用），始终反映 CLI 编译时对应的协议版本，因此不会与实际发送的内容脱节。8 个方法的 JSON Schema（draft 2020-12）`inputSchema`/`outputSchema` 都在里面。

本 skill 的 `reference/mdxp-catalog.json` 是同一命令的**快照**（非权威），便于离线阅读。需要精确/最新形状时请重新运行 `motrix describe --json`。

## 故障排查速查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 退出码 3，提示找不到 bridge | Motrix 没运行 | 本地 `motrix open`，等就绪后重试一次 |
| 退出码 4 | token 缺失/被撤销 | 远端重新 `motrix pair`；或用 `MOTRIX_BRIDGE_TOKEN` |
| 退出码 5 且 `-32601`/404 | 版本漂移（CLI 与 Motrix 不匹配） | 升级其中一方，重试无用 |
| `motrix` 命令不在 PATH | 未全局安装或 PATH 被覆盖 | `npm i -g @motrix/cli`，开新终端；必要时检查 prefix 下的 `bin` |
| 管道里 `list --watch` 退出码 2 | 该视图仅限 TTY | 改用 `motrix watch` 或 `list --json` |
| 退出码 7 | 当前安装方式不支持自更新（npx / 源码检出） | 按提示手工升级 |
