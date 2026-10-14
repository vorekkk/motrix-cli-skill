# Motrix CLI reference (English)

`SKILL.md` covers how to operate; this file carries the details: data shapes, the event catalog, full
flags, the wire protocol, and triage. Every fact comes from `@motrix/cli` itself (`motrix describe
--json`, `motrix --help`) and from real command output — nothing here is guessed.

## 1. Task shape (`motrix list --json` / `task/get`)

Wrapper: `{"tasks":[…],"total":<n>}` — `total` is the filtered count (independent of `--limit`), which makes paging reliable.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Task id (UUID); used by `pause`/`resume`/`remove`/`task/get` |
| `type` | `http`\|`ftp`\|`bt`\|`magnet`\|`metalink` | Source kind |
| `name` | string | Display name (the torrent name for BT tasks) |
| `status` | see enum | Current state |
| `progress` | number | `0..1` |
| `bytesDone` / `bytesTotal` | number / number\|null | `null` when unknown |
| `speedBps` | number | Current speed in bytes/s |
| `etaSec` | number\|null | Estimated seconds remaining |
| `saveDir` | string | Destination directory |
| `error` / `errorCode` | string\|null / string\|null | Failure details |
| `createdAt` / `finishedAt` | number\|null | Millisecond timestamps |
| `finalPath` | string\|null | Final path once complete |
| `infoHash` | string\|null | BT info hash |
| `bt` | object\|null | `{peers,seeds,ratio,trackers}`, BT only |

Status enum: `queued`, `fetching_metadata`, `downloading`, `paused`, `seeding`, `finalizing`, `completed`, `error`.

`motrix stats --json` returns exactly `totalDownloadSpeed`, `totalUploadSpeed`, `activeTasks`, `waitingTasks`, `stoppedTasks` (speeds in bytes/s).

## 2. Event catalog (`motrix watch` NDJSON / SSE `/mdxp/events`)

Every event (a line in NDJSON, a message in SSE) has the shape `{"event":<name>,"data":{…}}`.

| Event | Fires when | `data` fields |
| --- | --- | --- |
| `motrix/initialized` | Bridge finished initializing | Initialization info |
| `$/task/progress` | Task progress changed | `taskId`, `phase` (`queued`\|`downloading`\|`muxing`\|`finalizing`), `bytesDone`, `bytesTotal`, `speedBps` |
| `$/task/completed` | Task finished | `taskId`, `filePath`, `durationMs` |
| `$/task/error` | Task failed | `taskId`, `message` |
| `$/pair/revoked` | A paired token was revoked | Pairing info |
| `$/stats` | Periodic aggregate push | Same 5 fields as `stats/get` |
| `$/cancelRequest` | Request cancelled | Request identifier |

`--stats` keeps only `$/stats`; `--task <id>` keeps only that task's non-`$/stats` events.

## 3. Commands and flags

### `motrix list`

`--status <s>` (status enum), `--limit <n>`, `--offset <n>` filter and paginate. `--watch` (TTY only,
`--interval <sec>` sets the cadence) is a human-facing live table and exits `2` when piped.

### `motrix add`

Three mutually exclusive sources: positional URLs (one or many, HTTP(S)/FTP), `--magnet <uri>`, or `--torrent <file.torrent>`.

- `--save-dir <dir>` is **required**.
- `--filename <name>` names the output file (meaningful for a single URL).
- `--header "K: V"` is repeatable — use it for direct links that need `Referer`, `Cookie`, etc.
- `--connections <n>` sets concurrent connections (the protocol allows 1..128).
- `--proxy <url>` routes this task through a proxy.
- `--select 0,2` applies to magnets only: download just the selected file indexes.
- The underlying `download/add` method also takes `idempotencyKey` (8..128 chars). **Reuse it when retrying the same logical download** so you do not create duplicate tasks. The CLI exposes no flag for it today; see `reference/mdxp-catalog.json` for the schema and de-duplicate yourself otherwise.

### `motrix pause` / `resume` / `remove`

Each takes one `taskId`. `pause` pauses every live instance of that task; `remove --delete-files` also deletes the downloaded files.

### `motrix open`

Launches the local desktop app and waits for its bridge; `--timeout <ms>` bounds the wait. Exit code `6` when the desktop app is not installed.

### `motrix pair`

`--endpoint <url>` picks the target, `--name <label>` is what Motrix shows. Flow: the terminal prints a code → compare it with the code in Motrix and approve → the token lands in `~/.config/motrix/credentials.json`.

### `motrix describe` / `motrix skill` / `motrix self-update`

`describe --json` is the authoritative method catalog; `skill path|install` manages the officially
shipped skill; `self-update [target] [--dry-run]` updates the CLI with the package manager that
installed it (exit `7` for npx / checkout installs that cannot self-update).

## 4. Recipes

```bash
# 1) Downloading tasks with non-zero speed, fastest first
motrix list --status downloading --json \
  | jq -r '.tasks | sort_by(-.speedBps)[] | "\(.speedBps)\t\(.name)"'

# 2) Page through everything (`total` is the filtered count)
motrix list --limit 50 --offset 0 --json | jq '.total, (.tasks|length)'

# 3) Locate a taskId by name, then pause it
id=$(motrix list --json | jq -r '.tasks[] | select(.status=="downloading") | select(.name|test("ubuntu";"i")) | .id' | head -1)
[ -n "$id" ] && motrix pause "$id"

# 4) Batch add (failures do not abort the loop)
while read -r url; do
  [ -z "$url" ] && continue
  motrix add "$url" --save-dir ~/Downloads || echo "failed: $url" >&2
done < urls.txt

# 5) Follow one task and print progress lines only
motrix watch --task "<taskId>" \
  | jq -r 'select(.event=="$/task/progress") | "\((.data.bytesDone/.data.bytesTotal*100)|floor)%  \(.data.speedBps)"'

# 6) Consume only aggregate stats events (good for long-running monitors)
motrix watch --stats | jq -r 'select(.event=="$/stats") | "\(.data.activeTasks) active, \(.data.totalDownloadSpeed) B/s"'

# 7) Triage failures
motrix list --status error --json | jq -r '.tasks[] | "\(.id)\t\(.errorCode)\t\(.error)"'

# 8) Engine and single-task detail (no CLI subcommand — native fallback)
node scripts/mdxp.mjs engine/status | jq '.state, .featureReport.version'
node scripts/mdxp.mjs task/get --task "<taskId>" | jq '.task.status, .task.bt'
```

Without `jq`: `motrix list --json` is already a single JSON value, so hand it to any JSON parser. Never
parse the human-readable table with `grep`/`awk`.

## 5. Wire protocol (why the native fallback works)

- Transport: unary `POST <endpoint>/mdxp` with body `{"jsonrpc":"2.0","id":1,"method":"<name>","params":{…}}` and headers `Authorization: Bearer <token>`, `content-type: application/json`.
- Success: `{"jsonrpc":"2.0","id":1,"result":{…}}`; failure: `{"jsonrpc":"2.0","id":…,"error":{"code":…,"message":…}}`.
- No token: **HTTP 401**. Wrong token: 401/403.
- `-32601` (unknown method) or HTTP 404: version drift between CLI and Motrix → exit code `5`.
- Notifications: `GET <endpoint>/mdxp/events` (SSE, `text/event-stream`). Pairing: `/mdxp/pair/request`, `/mdxp/pair/poll`.
- The 8 **agent-callable** methods from `describe`: `download/add`, `task/list`, `task/get`, `task/pause`, `task/resume`, `task/remove`, `stats/get`, `engine/status`.
- The protocol contains more methods that are deliberately outside that catalog (`motrix/initialize`, `download/submit`, `download/cancel`, `url/probe`, `url/resolve`, `system/ping`, `task/reveal`). They are CLI-internal surface: **do not** call them without a concrete need and a clear understanding of the consequences.

## 6. Triage

| Symptom | Diagnosis | Fix |
| --- | --- | --- |
| `No local Motrix bridge found` / exit `3` | Desktop app is not running, or `endpoint.json` is absent | `motrix open`; for remote, pass `--endpoint` explicitly |
| Exit `4` / `Bridge rejected the token` | Token revoked or mismatched | Re-run `motrix pair --endpoint <url>`; check `MOTRIX_BRIDGE_TOKEN` |
| Exit `5` / `-32601`, 404 | Version drift | Upgrade Motrix, or `motrix self-update` |
| Exit `6` | Desktop app not found | Install Motrix desktop, or use a remote/headless deployment |
| Exit `7` | Install source cannot self-update | Follow the manual upgrade command it prints |
| Task added but speed stays at 0 | Origin throttling, missing headers/proxy, or no BT peers | Retry with `--header`/`--proxy`; for BT inspect `bt.peers` and `bt.trackers` |
| Duplicate tasks with the same name | Retry without an idempotency key | Reuse `idempotencyKey` (§3) or de-duplicate with `list --json` first |

## 7. Sources of truth

- `motrix describe --json` — the **only** authority for parameter shapes (static, matching the CLI's build-time protocol version).
- `reference/mdxp-catalog.json` — a snapshot of the above for offline reading, **not authoritative**.
- Official manual: <https://motrix.app/manual/cli/>.
