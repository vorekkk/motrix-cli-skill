---
name: motrix-cli-en
description: Drive the Motrix download manager through the `motrix` command-line client (English edition). Use when a task involves listing or filtering downloads, reading aggregate speeds and task counts, adding HTTP(S)/FTP/magnet/torrent downloads, pausing, resuming or removing tasks, streaming live progress, or connecting to a remote or headless Motrix server. The CLI is only a client — a running Motrix instance performs the actual transfer.
---

# Driving Motrix from the CLI

`motrix` (npm package `@motrix/cli`) is the command-line client for the Motrix download
manager. It is a **client, not a download engine**: every command is a request to an
already-running Motrix, and that instance performs the transfer. If Motrix is not
running, commands fail fast with exit code `3` — run `motrix open` first.

Transport: MDXP (JSON-RPC 2.0) over a unary `POST /mdxp`; notifications arrive on
`GET /mdxp/events` (SSE); pairing uses `/mdxp/pair/*`.

## When to use

- Enumerating or filtering download tasks; reading aggregate speeds and task counts
- Adding downloads: HTTP(S)/FTP URLs, magnet links (`--magnet`), `.torrent` files (`--torrent`)
- Task lifecycle control: pause, resume, remove (optionally deleting files)
- Streaming live progress until a download finishes
- Reaching a remote or headless Motrix (NAS, Docker deployment)

## Requirements

- Node.js ≥ 22 (`node -v`).
- The CLI installed globally: `npm i -g @motrix/cli`, then `motrix --version` should print a version.
- A reachable Motrix target: nothing to configure for the local desktop app; remote/headless needs one pairing.

> If a global install hits permission errors, use a Node version manager or a
> user-writable prefix (e.g. `npm config set prefix ~/.local`). Never fix it with
> `sudo` — that leaves root-owned files in your global `node_modules`.

## Connecting

| Scenario | How |
| --- | --- |
| Local desktop (recommended) | Zero configuration. The CLI reads `<userData>/bridge/endpoint.json` (port + machine-owner token). macOS: `~/Library/Application Support/Motrix/bridge/endpoint.json`; Windows: `%APPDATA%\Motrix\bridge\endpoint.json`; Linux: `$XDG_CONFIG_HOME/Motrix/bridge/endpoint.json` |
| Remote / headless server | `motrix pair --endpoint http://nas.local:16801 --name "laptop"`, then compare the printed verification code with the one shown in Motrix and approve it (toast, or Settings → Integration → Pending approvals) |
| One-off override | Global flags `--endpoint <url>` / `--token <token>`, or `MOTRIX_BRIDGE_TOKEN`. Prefer the environment variable in CI and scripts so the token never lands in a command line |

The issued token is stored in `~/.config/motrix/credentials.json` (mode `0600`, honoring
`XDG_CONFIG_HOME`), keyed by endpoint, and reused automatically by later commands.

## Output contract (read this first if you are an agent)

- **`--json`, or a piped / non-TTY stdout** → a single JSON value on stdout. This is the mode to parse. JSON mode is implied when piping, so `motrix list | jq` needs no flag.
- **Interactive TTY** → a human-readable table or summary.
- `motrix list --json` → `{"tasks":[…],"total":<n>}`; task fields are listed in `reference/commands.md`.
- `motrix stats --json` → `{"totalDownloadSpeed","totalUploadSpeed","activeTasks","waitingTasks","stoppedTasks"}` (bytes/s).
- `motrix watch` → **NDJSON**, one `{"event":<name>,"data":{…}}` per line, until interrupted.
- `motrix list --watch` is a **human TTY view**: piped (or with `--json`) it exits with code `2`. Agents should use `motrix watch` (NDJSON events) or `motrix list --json` (snapshots) instead.

### Exit codes — branch on these, never on parsed text

| Code | Meaning | What the agent should do |
| --- | --- | --- |
| `0` | Success | Continue |
| `2` | Usage error (bad flags or args) | Read `--help` and fix the call; do not re-run the same command |
| `3` | Network — the bridge is down or unreachable | Locally, run `motrix open` first, then retry once; remotely, check the address/network. Do not loop |
| `4` | Auth — token missing or rejected | Re-run `motrix pair` (remote) or fix `MOTRIX_BRIDGE_TOKEN`; do not retry blindly |
| `5` | Server — the bridge returned a JSON-RPC error | Read the message. `-32601` (unknown method) or HTTP 404 means **version drift**: tell the user to update Motrix or the CLI; retrying cannot help |
| `6` | Not installed — the desktop app could not be launched | Tell the user Motrix needs to be installed |
| `7` | Self-update failed | Do not retry; use the manual command the CLI prints |

In `--json` mode the original JSON-RPC `code` is preserved under `data` for programmatic branching.

## Command reference

```bash
motrix list [--status <s>] [--limit <n>] [--offset <n>]   # list tasks
motrix stats                                              # aggregate speeds + counts
motrix open [--timeout <ms>]                              # launch desktop app, wait for bridge
motrix add <url...> --save-dir <dir> [--filename <name>] [--header "K: V"] [--connections <n>] [--proxy <url>]
motrix add --magnet <uri> --save-dir <dir> [--select 0,2]
motrix add --torrent <file.torrent> --save-dir <dir>
motrix pause <taskId>                                     # pause (all live instances)
motrix resume <taskId>                                    # resume
motrix remove <taskId> [--delete-files]                   # remove (--delete-files deletes files)
motrix watch [--task <id>] [--stats]                      # NDJSON progress until Ctrl-C
motrix pair [--name <label>]                              # device-code pairing
motrix describe [--json]                                  # MDXP tool catalog (8 agent-callable methods)
motrix skill path | install [dir]                         # locate / install the shipped skill
motrix self-update [target] [--dry-run]                   # update the CLI itself (exit 7 = cannot here)
```

Every command accepts the global `--endpoint` / `--token` / `--json` flags. `motrix --version` prints the CLI version.

`--status` accepts the task-status enum: `queued`, `fetching_metadata`, `downloading`, `paused`, `seeding`, `finalizing`, `completed`, `error`.
Task types: `http`, `ftp`, `bt`, `magnet`, `metalink`.

## Recipes

```bash
# Only tasks that are actively downloading
motrix list --status downloading --json | jq -r '.tasks[] | "\(.id)\t\(.name)"'

# Find a taskId by name (for a later pause/resume/remove)
motrix list --json | jq -r '.tasks[] | select(.name|test("ubuntu";"i")) | .id'

# Add a download with an auth header and more connections
motrix add "https://example.com/f.zip" --save-dir ~/Downloads --header "Referer: https://example.com" --connections 16

# Follow one task until it finishes (NDJSON, parse line by line)
motrix watch --task <taskId>

# Current aggregate download speed, bytes/s
motrix stats --json | jq '"\(.totalDownloadSpeed/1048576|.*100|round/100) MB/s"'
```

More recipes (batch adds, idempotent retries, failure triage) live in `reference/commands.md`.

## Safety rules (must follow)

- `motrix remove <taskId> --delete-files` is **destructive**: it really deletes files from disk. Use it only when the user explicitly asked to delete files *and* the taskId came from your own `motrix list` result. **Never guess or construct a taskId**; if unsure, re-read `motrix list --json` and check `name` plus `saveDir` first.
- A paired token grants **full control** over that Motrix (adding downloads, deleting files). Only approve verification codes you just generated yourself, and revoke tokens you no longer use.
- **Never write a token into logs, chat replies, commits, or scripts.** Prefer the `MOTRIX_BRIDGE_TOKEN` environment variable over `--token`, which leaks into the process list and shell history.
- Do not use `sudo` to fix npm permission problems.
- Mutating operations (`add`/`pause`/`resume`/`remove`) go through the CLI subcommands so their exit-code semantics are preserved. Use the native fallback below only when no subcommand exists.

## Native fallback (methods the CLI does not expose)

`describe` lists 8 agent-callable methods, and two of them — **`task/get` and `engine/status`** — have no CLI subcommand at all. The script shipped with this skill talks to the bridge directly for those:

```bash
node scripts/mdxp.mjs engine/status            # engine state + aria2 version + feature list
node scripts/mdxp.mjs task/get --task <taskId> # one task (result is null when unknown)
node scripts/mdxp.mjs endpoints                # local + paired endpoints (never prints tokens)
```

It sends a unary `POST /mdxp` with `{"jsonrpc":"2.0","id":1,"method":…,"params":{…}}` and an
`Authorization: Bearer <token>` header. Token resolution matches the CLI: `--endpoint`/`--token` →
`MOTRIX_BRIDGE_TOKEN` → local `endpoint.json` → paired credentials. **Without a token the bridge
answers HTTP 401.** Exit codes mirror the CLI (`0/2/3/4/5`). Only read-only methods are allowed by
default; anything else needs an explicit `--allow-write`, which you normally should not use.

Live notifications (`$/task/progress`, `$/task/completed`, `$/task/error`, `$/stats`, …) arrive over
SSE at `GET /mdxp/events`. Keep consuming them through `motrix watch` — do not hand-roll an SSE client.

## Authoritative schemas

Parameter shapes come from **`motrix describe --json`**: it is static (no bridge call) and always
reflects the protocol version the CLI was built against, so it cannot drift from what the commands
actually send. It carries the JSON Schema (draft 2020-12) `inputSchema`/`outputSchema` for all 8 methods.

`reference/mdxp-catalog.json` in this skill is a **snapshot** of that command (not authoritative) so
the shapes are readable offline. Re-run `motrix describe --json` when exact, current shapes matter.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Exit `3`, no bridge found | Motrix is not running | `motrix open` locally, then retry once |
| Exit `4` | Token missing or revoked | Re-run `motrix pair`; or set `MOTRIX_BRIDGE_TOKEN` |
| Exit `5` with `-32601`/404 | Version drift between CLI and Motrix | Update one of them; retrying will not help |
| `motrix` not on PATH | Not installed globally, or PATH shadowing | `npm i -g @motrix/cli`, open a new terminal, check the prefix's `bin` |
| `list --watch` exits `2` in a pipe | That view requires a real TTY | Use `motrix watch` or `list --json` |
| Exit `7` | This install source cannot self-update (npx / checkout) | Upgrade the way the message tells you to |
