#!/usr/bin/env node
/**
 * Regenerate the per-skill reference/mdxp-catalog.json from the installed CLI.
 *
 * `motrix describe --json` is the authoritative, static catalog of
 * agent-callable MDXP methods. We snapshot it next to each skill so an agent
 * can read the shapes offline; the snapshot is explicitly marked as
 * non-authoritative and carries no timestamp, so re-running this script is
 * deterministic.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = [
  join(ROOT, "skills", "motrix-cli", "reference", "mdxp-catalog.json"),
  join(ROOT, "skills", "motrix-cli-en", "reference", "mdxp-catalog.json"),
];

function cliVersion() {
  const probe = spawnSync("motrix", ["--version"], { encoding: "utf8" });
  if (probe.error) {
    throw new Error(
      "`motrix` was not found on PATH. Install it first: npm i -g @motrix/cli",
    );
  }
  return (probe.stdout ?? "").trim();
}

function catalog() {
  const probe = spawnSync("motrix", ["describe", "--json"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (probe.status !== 0) {
    throw new Error(
      `motrix describe --json failed (exit ${probe.status}): ${probe.stderr?.trim()}`,
    );
  }
  return JSON.parse(probe.stdout);
}

const methods = catalog();
const snapshot = {
  _snapshot: {
    authoritative: false,
    authoritativeCommand: "motrix describe --json",
    generatedBy: "scripts/sync-catalog.mjs",
    cliVersion: cliVersion(),
    methodCount: methods.length,
    note: "Static catalog of agent-callable MDXP methods, captured from the installed @motrix/cli. It reflects the protocol version the CLI was built against. Always re-run `motrix describe --json` when exact, current shapes matter.",
  },
  methods,
};

for (const target of TARGETS) {
  fs.writeFileSync(target, `${JSON.stringify(snapshot, null, 2)}\n`);
  process.stdout.write(`wrote ${target} (${methods.length} methods)\n`);
}
