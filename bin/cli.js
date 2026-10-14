#!/usr/bin/env node
/**
 * motrix-cli-skill — installer / doctor CLI for the bundled agent skills.
 *
 * Exit codes: 0 ok, 1 problems found (doctor), 2 usage error, 3 unexpected failure.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  PACKAGE_ROOT,
  inspectInstalled,
  install,
  packageVersion,
  planInstall,
  resolveTargets,
  uninstall,
} from "../src/install.js";
import { SKILLS, skillNames } from "../src/skills.js";
import {
  EXIT,
  callMdxp,
  discoverLocalEndpoint,
  listPairedEndpoints,
} from "../src/mdxp.mjs";

const MANIFEST_NAME = ".motrix-cli-skill.json";

const HELP = [
  "motrix-cli-skill — install the Motrix CLI agent skills (motrix-cli / motrix-cli-en).",
  "",
  "Usage:",
  "  motrix-cli-skill install [--target codex|claude|all|<dir>] [--skill all|<name>] [--dry-run] [--force]",
  "  motrix-cli-skill uninstall [--target ...] [--skill ...] [--dry-run]",
  "  motrix-cli-skill path [--target ...] [--skill ...]",
  "  motrix-cli-skill list-targets",
  "  motrix-cli-skill doctor [--json]",
  "  motrix-cli-skill skills",
  "  motrix-cli-skill --version",
  "",
  "Options:",
  "  --target <value>  codex (~/.codex/skills), claude (~/.claude/skills), all (default), or a directory",
  `  --skill <value>   all (default), ${skillNames().join(", ")}`,
  "  --dry-run         print the plan without writing anything",
  "  --force           adopt a directory that this package did not install",
  "  --json            machine-readable output (doctor)",
  "",
  "Each skill is installed as <skills-dir>/<skill-name>/ and tracked with a",
  `${MANIFEST_NAME} manifest, so uninstall removes only our own files.`,
].join("\n");

function parseArgs(argv) {
  const parsed = {
    command: null,
    target: "all",
    skill: "all",
    dryRun: false,
    force: false,
    json: false,
    help: false,
    version: false,
    unknown: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const readValue = () => {
      i += 1;
      return argv[i];
    };
    if (arg === "-h" || arg === "--help") parsed.help = true;
    else if (arg === "-v" || arg === "--version") parsed.version = true;
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--force") parsed.force = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--target") parsed.target = readValue() ?? parsed.target;
    else if (arg === "--skill") parsed.skill = readValue() ?? parsed.skill;
    else if (arg.startsWith("-")) parsed.unknown.push(arg);
    else if (!parsed.command) parsed.command = arg;
    else parsed.unknown.push(arg);
  }
  return parsed;
}

function mark(ok) {
  return ok ? "✓" : "✗";
}

function findOnPath(binary) {
  const pathValue = process.env.PATH ?? "";
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, `${binary}${ext}`);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

function motrixCliStatus() {
  const path = findOnPath("motrix");
  if (!path) return { present: false, path: null, version: null };
  const probe = spawnSync(path, ["--version"], {
    encoding: "utf8",
    timeout: 15000,
  });
  const version = (probe.stdout ?? "").trim() || null;
  return { present: true, path, version };
}

async function probeBridge() {
  try {
    const { result } = await callMdxp({ method: "engine/status", timeoutMs: 8000 });
    return { reachable: true, engine: result ?? null, error: null };
  } catch (error) {
    return {
      reachable: false,
      engine: null,
      error: {
        message: String(error?.message ?? error),
        exitCode: error?.code ?? EXIT.SERVER,
      },
    };
  }
}

function commandInstall(args) {
  const rows = planInstall({
    target: args.target,
    skill: args.skill,
    force: args.force,
  });
  for (const row of rows) {
    const changed = row.changes.filter((c) => c.status !== "unchanged").length;
    process.stdout.write(
      `${args.dryRun ? "[plan] " : ""}${row.skill} -> ${row.destDir} (${row.action}, ${changed}/${row.fileCount} files changed)\n`,
    );
  }
  const result = install({
    target: args.target,
    skill: args.skill,
    dryRun: args.dryRun,
    force: args.force,
  });
  for (const item of result.installed) {
    process.stdout.write(
      `${mark(true)} ${item.skill} -> ${item.destDir} (${item.files} files, ${item.action})\n`,
    );
  }
  for (const item of result.failed) {
    process.stderr.write(
      `${mark(false)} ${item.skill} -> ${item.destDir}\n    ${item.reason}\n`,
    );
  }
  if (args.dryRun) {
    process.stdout.write("--dry-run: nothing was written.\n");
  }
  if (result.failed.length > 0) {
    process.stdout.write(
      "One or more targets could not be written. Run `motrix-cli-skill list-targets` to see what was detected, or pass --target to choose another agent.\n",
    );
    return 1;
  }
  return EXIT.OK;
}

function commandUninstall(args) {
  const result = uninstall({
    target: args.target,
    skill: args.skill,
    dryRun: args.dryRun,
  });
  for (const item of result.removed) {
    process.stdout.write(
      `${mark(true)} removed ${item.skill} from ${item.destDir} (${item.files} files${item.version ? `, was v${item.version}` : ""})\n`,
    );
  }
  for (const item of result.skipped) {
    process.stdout.write(
      `- skipped ${item.skill} in ${item.destDir}: ${item.reason}${item.files ? ` (${item.files} files would go)` : ""}\n`,
    );
  }
  if (result.removed.length === 0 && result.skipped.length === 0) {
    process.stdout.write("Nothing installed in the selected targets.\n");
  }
  return EXIT.OK;
}

function commandPath(args) {
  for (const entry of inspectInstalled({ target: args.target, skill: args.skill })) {
    const suffix = entry.installed
      ? ` (v${entry.version}${entry.healthy ? "" : ", needs attention"})`
      : "";
    process.stdout.write(
      `${mark(entry.installed)} ${entry.skill} [${entry.target}] ${entry.destDir}${suffix}\n`,
    );
  }
  return EXIT.OK;
}

function commandListTargets() {
  for (const target of resolveTargets("all")) {
    const note = target.fallback ? " (fallback: no agent detected)" : "";
    process.stdout.write(`${mark(target.detected)} ${target.id}: ${target.dir}${note}\n`);
  }
  process.stdout.write("\nOverride with --target codex|claude|<dir>.\n");
  return EXIT.OK;
}

function commandSkills() {
  for (const skill of SKILLS) {
    process.stdout.write(`${skill.name} [${skill.language}] — ${skill.title}\n`);
  }
  return EXIT.OK;
}

async function commandDoctor(args) {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const nodeOk = nodeMajor >= 22;
  const cli = motrixCliStatus();
  const bridge = await probeBridge();
  const skills = inspectInstalled({ target: "all", skill: "all" });
  const local = discoverLocalEndpoint();
  const pairings = listPairedEndpoints();
  // A target we did not install into is informational, not a failure: users may
  // deliberately target a single agent (or that agent's directory may be owned
  // by another user). What must hold is that at least one skill is installed and
  // every installed copy is intact.
  const installed = skills.filter((entry) => entry.installed);
  const healthy = installed.filter((entry) => entry.healthy);
  const skillsSummary = {
    installed: installed.length,
    healthy: healthy.length,
    unhealthy: installed.length - healthy.length,
    notInstalled: skills.length - installed.length,
  };
  const report = {
    ok:
      nodeOk &&
      cli.present &&
      bridge.reachable &&
      installed.length > 0 &&
      healthy.length === installed.length,
    package: {
      name: "motrix-cli-skill",
      version: packageVersion(),
      root: PACKAGE_ROOT,
    },
    node: { version: process.versions.node, ok: nodeOk, minimum: "22" },
    cli,
    bridge: {
      reachable: bridge.reachable,
      localEndpoint: local?.endpoint ?? null,
      endpointSource: local?.source ?? null,
      engine: bridge.engine,
      error: bridge.error,
    },
    pairings: {
      file: pairings.file,
      exists: pairings.exists,
      endpoints: pairings.entries.map((entry) => ({
        endpoint: entry.endpoint,
        hasToken: Boolean(entry.token),
      })),
    },
    skillsSummary,
    skills,
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? EXIT.OK : 1;
  }

  process.stdout.write(`${mark(nodeOk)} node ${process.versions.node} (>= 22 required)\n`);
  process.stdout.write(
    cli.present
      ? `${mark(true)} motrix CLI ${cli.version ?? "?"} at ${cli.path}\n`
      : `${mark(false)} motrix CLI not found on PATH — npm i -g @motrix/cli\n`,
  );
  if (bridge.reachable) {
    const engine = bridge.engine ?? {};
    const features = engine.featureReport?.features?.length ?? 0;
    process.stdout.write(
      `${mark(true)} bridge reachable at ${local?.endpoint} (state: ${engine.state ?? "unknown"}, aria2 ${engine.featureReport?.version ?? "?"}, ${features} features)\n`,
    );
  } else {
    process.stdout.write(`${mark(false)} bridge unreachable: ${bridge.error.message}\n`);
    if (bridge.error.exitCode === EXIT.NETWORK) {
      process.stdout.write(
        "    -> start the desktop app (motrix open) or pass --endpoint for a remote bridge\n",
      );
    } else if (bridge.error.exitCode === EXIT.AUTH) {
      process.stdout.write("    -> re-run `motrix pair` for that endpoint\n");
    }
  }
  process.stdout.write(
    pairings.exists
      ? `${mark(true)} paired endpoints file (${pairings.entries.length} paired)\n`
      : `- no paired endpoints file (${pairings.file}); the local desktop needs no pairing\n`,
  );
  for (const entry of skills) {
    if (entry.installed) {
      const problems = entry.healthy
        ? ""
        : ` — missing ${entry.missing.length}, changed ${entry.changed.length}${
            entry.outOfDate ? ", version differs from package" : ""
          }`;
      process.stdout.write(
        `${mark(entry.healthy)} skill ${entry.skill} [${entry.target}] v${entry.version}${problems}\n`,
      );
    } else {
      process.stdout.write(
        `- skill ${entry.skill} [${entry.target}] not installed (run \`motrix-cli-skill install --target ${entry.target}\` to add it)\n`,
      );
    }
  }
  if (skillsSummary.installed === 0) {
    process.stdout.write(
      "\nNo skills are installed anywhere — run `motrix-cli-skill install`.\n",
    );
  }
  process.stdout.write(
    report.ok
      ? "\nEverything checks out.\n"
      : "\nSome checks need attention (see above).\n",
  );
  return report.ok ? EXIT.OK : 1;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.version) {
    process.stdout.write(`${packageVersion()}\n`);
    return EXIT.OK;
  }
  if (args.unknown.length > 0) {
    process.stderr.write(`Unknown option: ${args.unknown.join(" ")}\n\n${HELP}\n`);
    return EXIT.USAGE;
  }
  if (args.help || !args.command) {
    process.stdout.write(`${HELP}\n`);
    if (!args.help) {
      const installed = inspectInstalled({ target: "all", skill: "all" });
      if (installed.every((entry) => !entry.installed)) {
        process.stdout.write(
          "\nNo skills are installed yet — run `motrix-cli-skill install`.\n",
        );
      }
    }
    return args.help ? EXIT.OK : EXIT.USAGE;
  }
  switch (args.command) {
    case "install":
      return commandInstall(args);
    case "uninstall":
      return commandUninstall(args);
    case "path":
      return commandPath(args);
    case "list-targets":
      return commandListTargets();
    case "skills":
      return commandSkills();
    case "doctor":
      return commandDoctor(args);
    default:
      process.stderr.write(`Unknown command: ${args.command}\n\n${HELP}\n`);
      return EXIT.USAGE;
  }
}

/** True when this file is the entry point (symlink- and space-safe). */
function isMainModule() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return (
      fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return pathToFileURL(argv1).href === import.meta.url;
  }
}

if (isMainModule()) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 3;
  }
}
