import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { PACKAGE_ROOT } from "../src/install.js";

const CLI = join(PACKAGE_ROOT, "bin", "cli.js");

/**
 * Run the real entry point. By default it gets a throwaway HOME so nothing real
 * is touched; `real: true` inherits the machine's environment instead (used for
 * the one live check against a running Motrix).
 */
function runCli(t, args, { home, real = false } = {}) {
  if (real) {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      env: process.env,
    });
    return { ...result, root: process.env.HOME };
  }
  const root = home ?? fs.mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "motrix-cli-"));
  if (!home) {
    fs.mkdirSync(join(root, ".codex"), { recursive: true });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  }
  const env = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: root,
    MOTRIX_ENDPOINT_FILE: join(root, "no-such-endpoint.json"),
  };
  delete env.CODEX_HOME;
  delete env.MOTRIX_BRIDGE_TOKEN;
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env,
  });
  return { ...result, root };
}

test("--version prints the package version", (t) => {
  const pkg = JSON.parse(fs.readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
  const result = runCli(t, ["--version"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), pkg.version);
});

test("--help documents every subcommand", (t) => {
  const result = runCli(t, ["--help"]);
  assert.equal(result.status, 0);
  for (const command of [
    "install",
    "uninstall",
    "path",
    "list-targets",
    "doctor",
    "skills",
  ]) {
    assert.match(result.stdout, new RegExp(`motrix-cli-skill ${command}`));
  }
});

test("install -> path -> uninstall works end to end in an isolated HOME", (t) => {
  const install = runCli(t, ["install"]);
  assert.equal(install.status, 0, install.stderr);
  const skillsDir = join(install.root, ".codex", "skills");
  assert.ok(fs.existsSync(join(skillsDir, "motrix-cli", "SKILL.md")));
  assert.ok(fs.existsSync(join(skillsDir, "motrix-cli-en", "SKILL.md")));

  const path = runCli(t, ["path"], { home: install.root });
  assert.equal(path.status, 0);
  assert.match(path.stdout, /motrix-cli \[codex\]/);
  assert.match(path.stdout, /v0\.1\.0/);

  const uninstall = runCli(t, ["uninstall"], { home: install.root });
  assert.equal(uninstall.status, 0);
  assert.equal(fs.existsSync(join(skillsDir, "motrix-cli")), false);
  assert.equal(fs.existsSync(join(skillsDir, "motrix-cli-en")), false);
});

test("--skill selects one skill, --dry-run writes nothing", (t) => {
  const plan = runCli(t, ["install", "--skill", "motrix-cli-en", "--dry-run"]);
  assert.equal(plan.status, 0);
  assert.match(plan.stdout, /\[plan\] motrix-cli-en/);
  assert.ok(!plan.stdout.includes("motrix-cli ->"), "the zh skill must not be planned");
  assert.equal(fs.existsSync(join(plan.root, ".codex", "skills")), false);
  assert.match(plan.stdout, /nothing was written/);
});

test("an unknown flag is a usage error", (t) => {
  const result = runCli(t, ["install", "--nope"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown option/);
});

test("doctor --json reports structured state without leaking a token", (t) => {
  const result = runCli(t, ["doctor", "--json"]);
  assert.equal(result.status, 1, "no bridge in the sandbox, so doctor must fail");
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.node.ok, true);
  assert.equal(report.bridge.reachable, false);
  assert.equal(
    report.skills.length,
    2,
    "only the detected agent (codex) is inspected in this sandbox",
  );
  assert.ok(report.skills.every((entry) => entry.target === "codex"));
  assert.ok(report.skills.every((entry) => entry.installed === false));
  assert.ok(!result.stdout.includes("localToken"));
});

test("doctor resolves the live local bridge when the CLI is installed", (t) => {
  const probe = spawnSync(
    process.platform === "win32" ? "where" : "which",
    ["motrix"],
    { encoding: "utf8" },
  );
  if (probe.status !== 0) {
    t.skip("motrix CLI is not installed on this runner");
    return;
  }
  const result = runCli(t, ["doctor", "--json"], { real: true });
  const report = JSON.parse(result.stdout);
  assert.equal(report.cli.present, true);
  assert.ok(!result.stdout.includes("localToken"), "doctor must not leak a token");
  if (report.bridge.reachable) {
    assert.equal(report.bridge.engine.state, "ready");
    assert.ok(report.bridge.engine.featureReport.version.length > 0);
  } else if (process.env.MOTRIX_LIVE === "1") {
    assert.fail(
      `MOTRIX_LIVE=1 requires a reachable bridge, but doctor reported: ${report.bridge.error.message}`,
    );
  } else {
    t.diagnostic(`no live bridge: ${report.bridge.error.message}`);
  }
});

test("an unwritable agent directory fails honestly with actionable advice", (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("running as root: permission bits do not apply");
  }
  const root = fs.mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "motrix-cli-ro-"));
  const codex = join(root, ".codex");
  fs.mkdirSync(codex, { recursive: true });
  fs.chmodSync(codex, 0o500);
  t.after(() => {
    fs.chmodSync(codex, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = runCli(t, ["install"], { home: root });
  assert.equal(result.status, 1, "an install failure must not look like success");
  assert.match(result.stderr, /EACCES/);
  assert.match(result.stderr, /sudo is not a fix/);
  assert.match(result.stdout, /could not be written/);
});

test("the postinstall hook installs when explicitly allowed", (t) => {
  const root = fs.mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "motrix-pi-"));
  fs.mkdirSync(join(root, ".codex"), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = spawnSync(
    process.execPath,
    [join(PACKAGE_ROOT, "bin", "postinstall.js")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: root,
        npm_config_global: "true",
        MOTRIX_ENDPOINT_FILE: join(root, "none.json"),
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /installed motrix-cli ->/);
  assert.ok(fs.existsSync(join(root, ".codex", "skills", "motrix-cli", "SKILL.md")));
});

test("the postinstall hook stays out of the way when disabled or not global", (t) => {
  const root = fs.mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "motrix-pi2-"));
  fs.mkdirSync(join(root, ".codex"), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const baseEnv = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: root,
    MOTRIX_ENDPOINT_FILE: join(root, "none.json"),
  };

  const disabled = spawnSync(
    process.execPath,
    [join(PACKAGE_ROOT, "bin", "postinstall.js")],
    {
      encoding: "utf8",
      env: {
        ...baseEnv,
        npm_config_global: "true",
        MOTRIX_CLI_SKILL_NO_AUTO_INSTALL: "1",
      },
    },
  );
  assert.equal(disabled.status, 0);
  assert.match(disabled.stdout, /disabled/);

  const local = spawnSync(
    process.execPath,
    [join(PACKAGE_ROOT, "bin", "postinstall.js")],
    { encoding: "utf8", env: { ...baseEnv, npm_config_global: "false" } },
  );
  assert.equal(local.status, 0);
  assert.match(local.stdout, /skipped auto-install/);
  assert.equal(fs.existsSync(join(root, ".codex", "skills")), false);
});
