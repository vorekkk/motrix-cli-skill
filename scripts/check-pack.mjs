#!/usr/bin/env node
/**
 * Verify what `npm publish` would actually ship: both skills complete, the
 * installer and fallback script present, and no test/CI files leaking in.
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const required = [
  "package.json",
  "bin/cli.js",
  "bin/postinstall.js",
  "src/install.js",
  "src/skills.js",
  "src/mdxp.mjs",
  "scripts/sync-catalog.mjs",
  "skills/motrix-cli/SKILL.md",
  "skills/motrix-cli/reference/commands.md",
  "skills/motrix-cli/reference/mdxp-catalog.json",
  "skills/motrix-cli/scripts/mdxp.mjs",
  "skills/motrix-cli-en/SKILL.md",
  "skills/motrix-cli-en/reference/commands.md",
  "skills/motrix-cli-en/reference/mdxp-catalog.json",
  "skills/motrix-cli-en/scripts/mdxp.mjs",
];

const forbidden = [/^test\//, /^\.github\//, /^docs\//, /^\.tmp\//];

const probe = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});

if (probe.status !== 0) {
  process.stderr.write(`npm pack --dry-run failed: ${probe.stderr}\n`);
  process.exit(1);
}

const [entry] = JSON.parse(probe.stdout);
const files = entry.files.map((file) => file.path).sort();
const problems = [];

for (const path of required) {
  if (!files.includes(path)) problems.push(`missing from package: ${path}`);
}
for (const file of files) {
  if (forbidden.some((pattern) => pattern.test(file))) {
    problems.push(`should not be published: ${file}`);
  }
}

process.stdout.write(
  `package ${entry.name}@${entry.version}: ${files.length} files, ${entry.unpackedSize} bytes unpacked\n`,
);
for (const file of files) process.stdout.write(`  ${file}\n`);

if (problems.length > 0) {
  process.stderr.write(`\n${problems.map((p) => `✗ ${p}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("\n✓ package contents look right\n");
