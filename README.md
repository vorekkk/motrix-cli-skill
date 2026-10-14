# motrix-cli-skill

把 [Motrix](https://motrix.app) 的命令行客户端（npm 包 `@motrix/cli`）封装成**通用 agent skill**，
通过 npm 命令即可安装，安装后 agent 就能安全地驱动 Motrix 下载管理。

包含两个独立 skill：

| skill 名 | 语言 | 安装位置 |
| --- | --- | --- |
| `motrix-cli` | 中文 | `~/.codex/skills/motrix-cli/`、`~/.claude/skills/motrix-cli/` |
| `motrix-cli-en` | English | `~/.codex/skills/motrix-cli-en/`、`~/.claude/skills/motrix-cli-en/` |

## 它解决什么问题

`motrix` 只是**客户端**：每条命令都是发给一个正在运行的 Motrix 实例的请求（MDXP / JSON-RPC 2.0，
一元 `POST /mdxp`），真正的下载由那个实例完成。官方 CLI 自带一份 62 行的 skill，而本 skill 补齐了
agent 实际会踩的坑：

- **退出码处置**：`0/2/3/4/5/6/7` 逐码给出动作（`3` → 先 `motrix open`；`4` → 重跑 `motrix pair`；
  `5` 且 `-32601`/404 → 版本漂移，**重试无用**；`7` → 别重试，按提示手工升级）。
- **原生兜底**：`task/get`（按 id 取任务）与 `engine/status`（引擎状态 + aria2 能力报告）有协议定义
  却**没有任何 CLI 子命令**；本 skill 带一个零依赖脚本直连 bridge 调用它们。
- **安全红线**：`remove --delete-files` 会真的删文件，必须用户明确确认 + 精确 taskId；配对 token 等于
  该 Motrix 的完全控制权；token 绝不写进日志/回答/提交物。
- **数据结构与配方**：任务字段、状态枚举、NDJSON 事件目录、`jq` 配方库、故障排查表。
- **权威来源指引**：参数形状一律以 `motrix describe --json` 为准（静态、与 CLI 协议版本一致），
  包内附快照并标注其为非权威。

## 安装

```bash
# 全局安装（会自动把两个 skill 写入检测到的 agent 目录）
npm i -g motrix-cli-skill

# 若 npm 拦下了安装脚本（npm ≥ 11.19 的 allowScripts 提示），显式装一次即可
motrix-cli-skill install
```

在包发布到 npm 之前，或者想从仓库源码安装，用 tarball（等价于发布产物，且是真实拷贝而非软链接）：

```bash
git clone https://github.com/vorekkk/motrix-cli-skill.git
cd motrix-cli-skill
npm pack
npm i -g ./motrix-cli-skill-0.1.0.tgz
```

> 暂不建议 `npm i -g github:vorekkk/motrix-cli-skill`：npm 11.19 会把 git 依赖链接到
> `~/.npm/_cacache/tmp/git-clone*` 后删除该目录，装完是断链、命令也不在 PATH 上（这是 npm 的
> git 依赖行为，包内无法修复）。请用上面的 tarball 方式。

使用前还需要官方 CLI 与一个可达的 Motrix：

```bash
npm i -g @motrix/cli     # 提供 motrix 命令
motrix --version
motrix list              # 桌面版运行时零配置
```

### 安装器命令

```bash
motrix-cli-skill install [--target codex|claude|all|<dir>] [--skill all|motrix-cli|motrix-cli-en] [--dry-run] [--force]
motrix-cli-skill uninstall [--target ...] [--skill ...] [--dry-run]
motrix-cli-skill path                 # 已安装到哪里
motrix-cli-skill list-targets         # 检测到哪些 agent
motrix-cli-skill doctor [--json]      # Node / CLI / bridge / skill 完整性体检
motrix-cli-skill skills               # 包里有哪些 skill
```

默认行为：

- `--target all` 写入本机**检测到**的 agent（`~/.codex`、`~/.claude`）；一个都没检测到时退回 Codex。
  可用 `CODEX_HOME` 覆盖 Codex 位置，或直接把 `--target` 指到任意目录。
- `--skill all` 安装中英文两份；两个 skill 名字不同，可以共存，也**不会覆盖官方自带的 `motrix` skill**。
- 全局安装时 `postinstall` 自动执行同一套安装逻辑；`MOTRIX_CLI_SKILL_NO_AUTO_INSTALL=1` 可关闭，
  非全局安装只打印提示、不写文件。
- npm 11.19+ 会提示 postinstall「not yet covered by allowScripts」。此时脚本仍会执行；若你的 npm
  配置已禁止安装脚本，直接运行 `motrix-cli-skill install`（或
  `npm i -g --allow-scripts=motrix-cli-skill motrix-cli-skill`）。
- 每个已安装目录带 `.motrix-cli-skill.json` 清单：卸载只删自己写入的文件，改动过的文件会被体检标出。

退出码：`0` 正常；`1` 有需要处理的问题（`doctor` 检查未通过，或某个安装目标不可写）；
`2` 用法错误；`3` 非预期错误。目标目录属于别的用户（例如曾被 `sudo` 安装过的
`~/.claude/skills`）时，安装会明确报出属主与可选处理方式，并保持其他目标已装好的状态。

## agent 侧用法（skill 里的两条路径）

```bash
# 1) 常规操作全走官方 CLI
motrix list --status downloading --json | jq -r '.tasks[] | "\(.id)\t\(.name)"'
motrix add "https://example.com/f.zip" --save-dir ~/Downloads --connections 16
motrix watch --task <taskId>          # NDJSON，逐行解析

# 2) CLI 没有子命令的方法，用 skill 自带脚本直连 bridge
node ~/.codex/skills/motrix-cli/scripts/mdxp.mjs engine/status
node ~/.codex/skills/motrix-cli/scripts/mdxp.mjs task/get --task <taskId>
```

脚本退出码与 CLI 对齐（`0/2/3/4/5`）；默认只允许只读方法，其余需要显式 `--allow-write`。
写操作（添加/暂停/恢复/删除）请始终走 CLI 子命令。

## 仓库结构

```
bin/cli.js              安装器 CLI（install / uninstall / path / doctor / skills）
bin/postinstall.js      全局安装时的自动安装（可关闭）
src/install.js          目标目录解析、幂等写入 + 读回校验、清单与卸载
src/mdxp.mjs            MDXP 兜底客户端（库 + 命令行），skills 内为逐字节副本
src/skills.js           skill 注册表（与 SKILL.md frontmatter 双向校验）
skills/motrix-cli/      中文 skill：SKILL.md + reference/ + scripts/
skills/motrix-cli-en/   英文 skill：同上
scripts/sync-catalog.mjs  重新生成 reference/mdxp-catalog.json 快照
scripts/check-pack.mjs    校验 npm 发布产物内容
test/                   node:test 套件（50 个用例，不依赖真实 bridge）
docs/                   安装与使用 / 发布流程
```

## 开发

```bash
npm test           # 单元测试 + 隔离 HOME 的端到端用例
npm run pack:check # 校验发布产物（两个 skill 都必须在包内）
npm run sync:catalog # 升级 @motrix/cli 后刷新 schema 快照
```

## 安全说明

- 配对 token 拥有目标 Motrix 的完全控制权；只批准你自己刚生成的验证码，及时撤销不用的 token。
- token 不会出现在本工具的任何输出里（`doctor`、`mdxp.mjs endpoints` 只显示是否已配对）。
- 若全局安装遇到权限问题，请使用用户可写 prefix（例如 `npm config set prefix ~/.local`），**不要用 `sudo`**。

## 许可

[MIT](./LICENSE) · 官方手册：<https://motrix.app/manual/cli/>
