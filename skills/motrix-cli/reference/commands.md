# Motrix CLI 详细参考（中文）

`SKILL.md` 的主体是操作方法；本文件是配套的细节参考：数据结构、事件目录、完整参数、协议与排查。
所有事实来自 `@motrix/cli`（`motrix describe --json`、`motrix --help` 与真实运行输出），不是推测。

## 1. 任务对象（`motrix list --json` / `task/get`）

顶层：`{"tasks":[…],"total":<n>}`，`total` 是过滤后的总数（与 `--limit` 无关，可用于分页）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 任务 id（UUID），`pause`/`resume`/`remove`/`task/get` 都用它 |
| `type` | `http`\|`ftp`\|`bt`\|`magnet`\|`metalink` | 任务来源类型 |
| `name` | string | 显示名（BT 任务通常是种子名） |
| `status` | 见状态枚举 | 当前状态 |
| `progress` | number | `0..1` |
| `bytesDone` / `bytesTotal` | number / number\|null | 已下载/总量；未知时为 `null` |
| `speedBps` | number | 当前速度（byte/s） |
| `etaSec` | number\|null | 预计剩余秒数 |
| `saveDir` | string | 保存目录 |
| `error` / `errorCode` | string\|null / string\|null | 失败原因 |
| `createdAt` / `finishedAt` | number\|null | 毫秒时间戳 |
| `finalPath` | string\|null | 完成后的最终路径 |
| `infoHash` | string\|null | BT 任务的 info hash |
| `bt` | object\|null | `{peers,seeds,ratio,trackers}`，仅 BT 任务 |

状态枚举（2026）：`queued`、`fetching_metadata`、`downloading`、`paused`、`seeding`、`finalizing`、`completed`、`error`。

`motrix stats --json` 的 5 个字段：`totalDownloadSpeed`、`totalUploadSpeed`、`activeTasks`、`waitingTasks`、`stoppedTasks`（速度单位为 byte/s）。

## 2. 事件目录（`motrix watch` NDJSON / SSE `/mdxp/events`）

每行/每条事件的形状都是 `{"event":<名>,"data":{…}}`。

| 事件 | 触发时机 | `data` 字段 |
| --- | --- | --- |
| `motrix/initialized` | bridge 初始化完成 | 初始化信息 |
| `$/task/progress` | 任务进度变化 | `taskId`、`phase`(`queued`\|`downloading`\|`muxing`\|`finalizing`)、`bytesDone`、`bytesTotal`、`speedBps` |
| `$/task/completed` | 任务完成 | `taskId`、`filePath`、`durationMs` |
| `$/task/error` | 任务失败 | `taskId`、`message` |
| `$/pair/revoked` | 配对 token 被撤销 | 配对信息 |
| `$/stats` | 周期性聚合推送 | 与 `stats/get` 相同的 5 个字段 |
| `$/cancelRequest` | 请求取消 | 请求标识 |

`--stats` 只保留 `$/stats`；`--task <id>` 只保留该任务的非 `$/stats` 事件。

## 3. 命令与参数

### `motrix list`

`--status <s>`（状态枚举值）、`--limit <n>`、`--offset <n>` 用于过滤与分页；
`--watch`（仅 TTY，`--interval <sec>` 控制刷新节奏）是给人看的实时表格，管道下退出码 `2`。

### `motrix add`

三种互斥来源：位置参数 URL（可多个、HTTP(S)/FTP）、`--magnet <uri>`、`--torrent <file.torrent>`。

- `--save-dir <dir>` **必填**。
- `--filename <name>` 指定文件名（仅对单个 URL 有意义）。
- `--header "K: V"` 可重复，用于需要 Referer/Cookie 等头的直链。
- `--connections <n>` 并发连接数（协议层允许 1..128）。
- `--proxy <url>` 为本次任务指定代理。
- `--select 0,2` 仅磁力链：只下载选中的文件序号。
- 协议层 `download/add` 还接受 `idempotencyKey`（8..128 字符）：**重试同一逻辑下载时复用它**，可避免重复建任务。CLI 没有暴露该参数的标志，需要时用 `--json` 观察返回并自行去重，或参考 `reference/mdxp-catalog.json` 里的 schema。

### `motrix pause` / `resume` / `remove`

都只接受一个 `taskId`。`pause` 会暂停该任务的所有活动实例；`remove --delete-files` 同时删除已下载的文件。

### `motrix open`

在本地启动桌面版并等待 bridge 就绪；`--timeout <ms>` 控制等待上限。桌面版未安装时退出码 `6`。

### `motrix pair`

`--endpoint <url>` 指定目标，`--name <label>` 是显示在 Motrix 侧的名字。流程：终端打印验证码 → 在 Motrix 侧核对并批准 → token 落盘到 `~/.config/motrix/credentials.json`。

### `motrix describe` / `motrix skill` / `motrix self-update`

`describe --json` 是权威的方法目录；`skill path|install` 管理官方自带 skill；`self-update [target] [--dry-run]` 用安装它的包管理器升级自身（npx/源码检出等场景退出码 `7`）。

## 4. 配方

```bash
# 1) 只列出正在下载、且速度非零的任务，按速度排序
motrix list --status downloading --json \
  | jq -r '.tasks | sort_by(-.speedBps)[] | "\(.speedBps)\t\(.name)"'

# 2) 分页遍历全部任务（total 是过滤后的总数）
motrix list --limit 50 --offset 0 --json | jq '.total, (.tasks|length)'

# 3) 用名字定位 taskId，再暂停（先确认再动手）
id=$(motrix list --json | jq -r '.tasks[] | select(.status=="downloading") | select(.name|test("ubuntu";"i")) | .id' | head -1)
[ -n "$id" ] && motrix pause "$id"

# 4) 批量添加（逐行 URL，失败不中断）
while read -r url; do
  [ -z "$url" ] && continue
  motrix add "$url" --save-dir ~/Downloads || echo "failed: $url" >&2
done < urls.txt

# 5) 跟踪单个任务到完成，只打印进度行（Ctrl-C 结束）
motrix watch --task "<taskId>" \
  | jq -r 'select(.event=="$/task/progress") | "\((.data.bytesDone/.data.bytesTotal*100)|floor)%  \(.data.speedBps)"'

# 6) 只消费聚合 stats 事件（适合做长跑监测）
motrix watch --stats | jq -r 'select(.event=="$/stats") | "\(.data.activeTasks) active, \(.data.totalDownloadSpeed) B/s"'

# 7) 失败任务排查
motrix list --status error --json | jq -r '.tasks[] | "\(.id)\t\(.errorCode)\t\(.error)"'

# 8) 引擎与单个任务的细粒度信息（CLI 无子命令，走原生兜底）
node scripts/mdxp.mjs engine/status | jq '.state, .featureReport.version'
node scripts/mdxp.mjs task/get --task "<taskId>" | jq '.task.status, .task.bt'
```

`jq` 不可用时：`motrix list --json` 本身就是一个 JSON 值，可交给任何 JSON 解析器；不要用 `grep`/`awk` 解析人类可读表格。

## 5. 协议细节（原生兜底为何可行）

- 传输：一元 `POST <endpoint>/mdxp`，body 为 `{"jsonrpc":"2.0","id":1,"method":"<名>","params":{…}}`，头 `Authorization: Bearer <token>`、`content-type: application/json`。
- 成功响应：`{"jsonrpc":"2.0","id":1,"result":{…}}`；失败：`{"jsonrpc":"2.0","id":…,"error":{"code":…,"message":…}}`。
- 未带 token：**HTTP 401**。带错 token：401/403。
- `-32601`（方法不存在）或 HTTP 404：CLI 与 Motrix 版本漂移，退出码 `5`。
- 通知流：`GET <endpoint>/mdxp/events`（SSE，`text/event-stream`）；配对：`/mdxp/pair/request`、`/mdxp/pair/poll`。
- `describe` 列出的 8 个 **agent 可用**方法：`download/add`、`task/list`、`task/get`、`task/pause`、`task/resume`、`task/remove`、`stats/get`、`engine/status`。
- 协议中另有未纳入该目录的方法（`motrix/initialize`、`download/submit`、`download/cancel`、`url/probe`、`url/resolve`、`system/ping`、`task/reveal`）。它们属于 CLI 内部使用面，**不要**在没有明确需求和理解后果时直接调用。

## 6. 排查

| 现象 | 诊断 | 处理 |
| --- | --- | --- |
| `No local Motrix bridge found` / 退出码 3 | 桌面版没运行，或 `endpoint.json` 不存在 | `motrix open`；远端则显式 `--endpoint` |
| 退出码 4 / `Bridge rejected the token` | token 被撤销或错配 | 重新 `motrix pair --endpoint <url>`；检查 `MOTRIX_BRIDGE_TOKEN` |
| 退出码 5 / `-32601`、404 | 版本漂移 | 升级 Motrix 或 `motrix self-update` |
| 退出码 6 | 找不到桌面版应用 | 安装 Motrix 桌面版，或改用远端/无头部署 |
| 退出码 7 | 当前安装方式不支持自更新 | 按命令输出的手工方式升级 |
| 加了任务但速度一直是 0 | 源站限速、需要 headers/proxy，或 BT 无 peer | 用 `--header`/`--proxy` 重试；BT 任务看 `bt.peers`、`bt.trackers` |
| 同名任务重复出现 | 重试时没有幂等键 | 复用时带 `idempotencyKey`（见 §3），或先 `list --json` 查重 |

## 7. 权威来源

- `motrix describe --json` —— 参数形状的**唯一权威**（静态、与 CLI 编译期协议版本一致）。
- `reference/mdxp-catalog.json` —— 上面命令的快照，供离线阅读，**非权威**。
- 官方文档：<https://motrix.app/manual/cli/>。
