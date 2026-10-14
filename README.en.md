# motrix-cli-skill

Packages the [Motrix](https://motrix.app) command-line client (npm package `@motrix/cli`) as a
**general-purpose agent skill** that installs with a single npm command, so an agent can drive the
Motrix download manager safely.

Two independent skills ship in this package:

| Skill | Language | Installed to |
| --- | --- | --- |
| `motrix-cli` | 中文 | `~/.codex/skills/motrix-cli/`, `~/.claude/skills/motrix-cli/` |
| `motrix-cli-en` | English | `~/.codex/skills/motrix-cli-en/`, `~/.claude/skills/motrix-cli-en/` |

## Why this exists

`motrix` is only a **client**: every command is a request to an already-running Motrix instance
(MDXP / JSON-RPC 2.0 over a unary `POST /mdxp`), and that instance does the downloading. The official
CLI ships a 62-line skill; this one closes the gaps an agent actually hits:

- **Exit-code playbook** for `0/2/3/4/5/6/7` (`3` → `motrix open` first; `4` → re-run `motrix pair`;
  `5` with `-32601`/404 → version drift, **retrying cannot help**; `7` → do not retry, follow the
  printed manual upgrade).
- **Native fallback**: `task/get` and `engine/status` are defined in the protocol but have **no CLI
  subcommand at all**. A zero-dependency script in the skill calls them over `/mdxp`.
- **Safety rules**: `remove --delete-files` really deletes files and needs explicit user consent plus
  an exact taskId; a paired token grants full control of that Motrix; tokens never go into logs,
  replies, or commits.
- **Data shapes and recipes**: task fields, status enum, the NDJSON event catalog, `jq` recipes, and a
  triage table.
- **Authoritative schemas**: parameter shapes always come from `motrix describe --json` (static,
  matching the CLI's protocol version); the bundled snapshot is explicitly marked non-authoritative.

## Install

```bash
# Global install (auto-installs both skills into the agents it detects)
npm i -g motrix-cli-skill

# Or straight from the Git repository
npm i -g github:vorekkk/motrix-cli-skill

# If npm gated the install script (npm >= 11.19 allowScripts notice), install once explicitly
motrix-cli-skill install
```

You also need the official CLI and a reachable Motrix:

```bash
npm i -g @motrix/cli     # provides the `motrix` command
motrix --version
motrix list              # zero configuration while the desktop app runs
```

### Installer commands

```bash
motrix-cli-skill install [--target codex|claude|all|<dir>] [--skill all|motrix-cli|motrix-cli-en] [--dry-run] [--force]
motrix-cli-skill uninstall [--target ...] [--skill ...] [--dry-run]
motrix-cli-skill path                 # where are the skills installed
motrix-cli-skill list-targets         # which agents were detected
motrix-cli-skill doctor [--json]      # node / CLI / bridge / skill integrity
motrix-cli-skill skills               # what the package ships
```

Defaults:

- `--target all` writes to every agent **detected** on the machine (`~/.codex`, `~/.claude`), falling
  back to Codex when none is found. `CODEX_HOME` overrides the Codex location, and `--target` also
  accepts any directory.
- `--skill all` installs both language editions. Their names differ, so they coexist — and the
  official `motrix` skill is **never** overwritten.
- For global installs, `postinstall` runs the same install logic automatically;
  `MOTRIX_CLI_SKILL_NO_AUTO_INSTALL=1` disables it, and non-global installs only print a hint.
- npm 11.19+ prints a "not yet covered by allowScripts" notice for that postinstall. The script
  still runs; if your npm configuration blocks install scripts entirely, run
  `motrix-cli-skill install` (or `npm i -g --allow-scripts=motrix-cli-skill motrix-cli-skill`).
- Each installed directory carries a `.motrix-cli-skill.json` manifest, so uninstall removes only our
  own files and `doctor` flags anything a user edited.

Exit codes: `0` ok; `1` something needs attention (`doctor` found problems, or a target could not be
written); `2` usage error; `3` unexpected failure. When a target directory belongs to another user —
for example a `~/.claude/skills` created by an earlier `sudo` install — the installer names the owner
and the real options, and leaves every other target that succeeded in place.

## Agent-side usage (the two paths in the skill)

```bash
# 1) Everyday operations go through the official CLI
motrix list --status downloading --json | jq -r '.tasks[] | "\(.id)\t\(.name)"'
motrix add "https://example.com/f.zip" --save-dir ~/Downloads --connections 16
motrix watch --task <taskId>          # NDJSON, parse line by line

# 2) Methods with no CLI subcommand use the skill's bundled script
node ~/.codex/skills/motrix-cli-en/scripts/mdxp.mjs engine/status
node ~/.codex/skills/motrix-cli-en/scripts/mdxp.mjs task/get --task <taskId>
```

The script mirrors the CLI's exit codes (`0/2/3/4/5`), allows read-only methods by default, and
requires an explicit `--allow-write` for anything else. Mutating work should always go through the CLI
subcommands.

## Repository layout

```
bin/cli.js              installer CLI (install / uninstall / path / doctor / skills)
bin/postinstall.js      auto-install on global installs (opt-out supported)
src/install.js          target resolution, verified idempotent writes, manifest, uninstall
src/mdxp.mjs            MDXP fallback client (library + CLI); byte-identical copies live in skills
src/skills.js           skill registry, cross-checked against each SKILL.md frontmatter
skills/motrix-cli/      Chinese skill: SKILL.md + reference/ + scripts/
skills/motrix-cli-en/   English skill: same layout
scripts/sync-catalog.mjs  regenerate the reference/mdxp-catalog.json snapshot
scripts/check-pack.mjs    verify what npm publish would ship
test/                   node:test suite (50 cases, no live bridge required)
docs/                   installation & usage, release runbook (Chinese)
```

## Development

```bash
npm test             # unit tests plus isolated-HOME end-to-end cases
npm run pack:check   # verify the publish payload (both skills must be inside)
npm run sync:catalog # refresh the schema snapshot after upgrading @motrix/cli
```

## Safety notes

- A paired token has full control over the target Motrix. Only approve verification codes you just
  generated yourself, and revoke tokens you no longer use.
- Tokens never appear in this tool's output (`doctor` and `mdxp.mjs endpoints` only report whether a
  token exists).
- If a global install hits permission errors, use a user-writable prefix
  (`npm config set prefix ~/.local`). Do not use `sudo`.

## License

[MIT](./LICENSE) · Official manual: <https://motrix.app/manual/cli/>
