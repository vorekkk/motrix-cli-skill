import assert from "node:assert/strict";
import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MANIFEST_FILE,
  describeWriteFailure,
  install,
  inspectInstalled,
  planInstall,
  resolveTargets,
  uninstall,
} from "../src/install.js";
import { SKILLS } from "../src/skills.js";

/**
 * Every test runs against a throwaway HOME so the real ~/.codex and ~/.claude
 * are never touched.
 */
function sandbox(t, { withClaude = false, withCodex = true } = {}) {
  const root = fs.mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "motrix-skill-"));
  if (withCodex) fs.mkdirSync(join(root, ".codex"), { recursive: true });
  if (withClaude) fs.mkdirSync(join(root, ".claude"), { recursive: true });

  const savedHome = process.env.HOME;
  const savedCodexHome = process.env.CODEX_HOME;
  process.env.HOME = root;
  delete process.env.CODEX_HOME;

  t.after(() => {
    process.env.HOME = savedHome;
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedCodexHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  return { root, codexSkills: join(root, ".codex", "skills") };
}

test("HOME is honored when resolving skill roots", (t) => {
  const { root } = sandbox(t);
  assert.equal(homedir(), root);
  const [codex] = resolveTargets("codex");
  assert.equal(codex.dir, join(root, ".codex", "skills"));
});

test("all: installs into detected agents only, and falls back to Codex", (t) => {
  const { root, codexSkills } = sandbox(t, { withClaude: true });

  const both = resolveTargets("all");
  assert.deepEqual(
    both.map((target) => target.id).sort(),
    ["claude", "codex"],
  );

  const result = install({ target: "all", skill: "all" });
  assert.equal(result.failed.length, 0);
  for (const skill of SKILLS) {
    assert.ok(
      fs.existsSync(join(codexSkills, skill.name, "SKILL.md")),
      `${skill.name} should be installed for Codex`,
    );
    assert.ok(
      fs.existsSync(join(root, ".claude", "skills", skill.name, "SKILL.md")),
      `${skill.name} should be installed for Claude`,
    );
  }

  const bare = fs.mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "motrix-bare-"));
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  process.env.HOME = bare;
  const fallback = resolveTargets("all");
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].id, "codex");
  assert.equal(fallback[0].fallback, true);
  process.env.HOME = root;
});

test("install is idempotent, verified, and manifest-tracked", (t) => {
  const { codexSkills } = sandbox(t);
  const first = install({ target: "codex", skill: "motrix-cli" });
  assert.equal(first.installed.length, 1);
  assert.equal(first.installed[0].action, "create");

  const manifestPath = join(codexSkills, "motrix-cli", MANIFEST_FILE);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.package, "motrix-cli-skill");
  assert.equal(manifest.skill, "motrix-cli");
  assert.equal(manifest.language, "zh-CN");
  assert.ok(Object.keys(manifest.files).includes("SKILL.md"));

  const secondPlan = planInstall({ target: "codex", skill: "motrix-cli" });
  assert.equal(secondPlan[0].action, "sync");
  assert.deepEqual(secondPlan[0].stale, []);
  assert.ok(
    secondPlan[0].changes.every((change) => change.status === "unchanged"),
    "a second run must not report changes",
  );

  const report = inspectInstalled({ target: "codex", skill: "motrix-cli" });
  assert.equal(report[0].installed, true);
  assert.equal(report[0].healthy, true);
  assert.equal(report[0].outOfDate, false);
});

test("a stale file from an older version is removed on reinstall", (t) => {
  const { codexSkills } = sandbox(t);
  install({ target: "codex", skill: "motrix-cli" });
  const manifestPath = join(codexSkills, "motrix-cli", MANIFEST_FILE);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const ghost = join(codexSkills, "motrix-cli", "reference", "legacy.md");
  fs.writeFileSync(ghost, "old\n");
  manifest.files["reference/legacy.md"] = "deadbeef";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const plan = planInstall({ target: "codex", skill: "motrix-cli" });
  assert.deepEqual(plan[0].stale, ["reference/legacy.md"]);
  install({ target: "codex", skill: "motrix-cli" });
  assert.equal(fs.existsSync(ghost), false, "stale file should be gone");
});

test("a foreign skill directory is never overwritten or adopted by accident", (t) => {
  const { codexSkills } = sandbox(t);
  const foreign = join(codexSkills, "motrix-cli");
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(join(foreign, "SKILL.md"), "user-authored\n");

  const planned = planInstall({ target: "codex", skill: "motrix-cli" });
  assert.equal(planned[0].action, "blocked");

  const result = install({ target: "codex", skill: "motrix-cli" });
  assert.equal(result.installed.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].reason, /not managed by motrix-cli-skill/);
  assert.equal(
    fs.readFileSync(join(foreign, "SKILL.md"), "utf8"),
    "user-authored\n",
    "the foreign file must be untouched",
  );

  const forced = install({ target: "codex", skill: "motrix-cli", force: true });
  assert.equal(forced.installed.length, 1);
  const report = inspectInstalled({ target: "codex", skill: "motrix-cli" });
  assert.equal(report[0].healthy, true);
});

test("the official motrix skill next door is left alone", (t) => {
  const { codexSkills } = sandbox(t);
  const official = join(codexSkills, "motrix");
  fs.mkdirSync(official, { recursive: true });
  fs.writeFileSync(join(official, "SKILL.md"), "official\n");
  install({ target: "codex", skill: "all" });
  uninstall({ target: "codex", skill: "all" });
  assert.equal(fs.readFileSync(join(official, "SKILL.md"), "utf8"), "official\n");
});

test("uninstall removes only manifest-listed files and prunes empty dirs", (t) => {
  const { codexSkills } = sandbox(t);
  install({ target: "codex", skill: "all" });
  const kept = join(codexSkills, "motrix-cli", "notes.md");
  fs.writeFileSync(kept, "mine\n");

  const result = uninstall({ target: "codex", skill: "all" });
  assert.equal(result.removed.length, SKILLS.length);
  assert.equal(fs.existsSync(join(codexSkills, "motrix-cli", "SKILL.md")), false);
  assert.equal(
    fs.existsSync(join(codexSkills, "motrix-cli-en")),
    false,
    "a fully managed skill directory should be pruned",
  );
  assert.equal(
    fs.existsSync(join(codexSkills, "motrix-cli")),
    true,
    "a directory holding unrelated files must survive",
  );
  assert.equal(fs.readFileSync(kept, "utf8"), "mine\n");
  assert.equal(fs.existsSync(join(codexSkills, "motrix-cli", MANIFEST_FILE)), false);
});

test("uninstall reports a foreign directory instead of deleting it", (t) => {
  const { codexSkills } = sandbox(t);
  const foreign = join(codexSkills, "motrix-cli");
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(join(foreign, "SKILL.md"), "user-authored\n");
  const result = uninstall({ target: "codex", skill: "motrix-cli" });
  assert.equal(result.removed.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(fs.existsSync(join(foreign, "SKILL.md")), true);
});

test("a modified installed file is reported as unhealthy", (t) => {
  const { codexSkills } = sandbox(t);
  install({ target: "codex", skill: "motrix-cli" });
  fs.appendFileSync(join(codexSkills, "motrix-cli", "SKILL.md"), "\nlocal edit\n");
  const report = inspectInstalled({ target: "codex", skill: "motrix-cli" });
  assert.equal(report[0].healthy, false);
  assert.deepEqual(report[0].changed, ["SKILL.md"]);
});

test("dry-run writes nothing at all", (t) => {
  const { codexSkills } = sandbox(t);
  const result = install({ target: "codex", skill: "all", dryRun: true });
  assert.equal(result.installed.length, 0);
  assert.equal(result.skipped.length, SKILLS.length);
  assert.equal(fs.existsSync(codexSkills), false);
});

test("a custom target directory can be used directly", (t) => {
  const { root } = sandbox(t);
  const custom = join(root, "agent", "skills");
  fs.mkdirSync(custom, { recursive: true });
  const result = install({ target: custom, skill: "motrix-cli-en" });
  assert.equal(result.installed.length, 1);
  assert.equal(result.installed[0].destDir, join(custom, "motrix-cli-en"));
  assert.ok(fs.existsSync(join(custom, "motrix-cli-en", "scripts", "mdxp.mjs")));
});

test("a permission failure is explained instead of dumping a raw EACCES", (t) => {
  const { root, codexSkills } = sandbox(t);
  const error = Object.assign(
    new Error(`EACCES: permission denied, mkdir '${join(codexSkills, "motrix-cli")}'`),
    { code: "EACCES" },
  );
  const message = describeWriteFailure(join(codexSkills, "motrix-cli"), error);
  assert.match(message, /EACCES/);
  assert.match(message, /not writable|not the current user/);
  assert.match(message, /sudo is not a fix/);
  assert.match(message, /--target codex/);
});

test("other filesystem failures keep a short explanation", (t) => {
  sandbox(t);
  assert.match(
    describeWriteFailure("/nope", Object.assign(new Error("read only"), { code: "EROFS" })),
    /read-only/,
  );
  assert.match(
    describeWriteFailure("/nope", Object.assign(new Error("full"), { code: "ENOSPC" })),
    /disk is full/,
  );
  assert.equal(
    describeWriteFailure("/nope", new Error("something else")),
    "something else",
  );
});
