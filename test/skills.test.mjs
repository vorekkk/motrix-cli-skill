import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { PACKAGE_ROOT, SKILLS_SOURCE_ROOT, sourceFiles } from "../src/install.js";
import { PACKAGE_NAME, SKILLS } from "../src/skills.js";

const NAME_PATTERN = /^[a-z0-9-]+$/;

function frontmatter(skillName) {
  const raw = fs.readFileSync(
    join(SKILLS_SOURCE_ROOT, skillName, "SKILL.md"),
    "utf8",
  );
  const match = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  assert.ok(match, `${skillName}/SKILL.md has no YAML frontmatter`);
  const fields = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return { raw, fields };
}

test("package metadata targets the published repo", () => {
  const pkg = JSON.parse(
    fs.readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
  );
  assert.equal(pkg.name, PACKAGE_NAME);
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.type, "module");
  assert.match(pkg.repository.url, /github\.com\/vorekkk\/motrix-cli-skill/);
  assert.equal(pkg.engines.node, ">=22");
  assert.ok(pkg.bin["motrix-cli-skill"], "bin entry is required");
  for (const dir of ["bin", "src", "scripts", "skills"]) {
    assert.ok(pkg.files.includes(dir), `${dir} must be published`);
  }
});

test("registry matches the bundled skill directories", () => {
  const onDisk = fs
    .readdirSync(SKILLS_SOURCE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(
    onDisk,
    SKILLS.map((skill) => skill.name).sort(),
    "registry and skills/ must agree",
  );
});

for (const skill of SKILLS) {
  test(`${skill.name}: frontmatter matches the registry and is loader-safe`, () => {
    const { raw, fields } = frontmatter(skill.name);
    assert.equal(fields.name, skill.name, "name must equal the directory name");
    assert.match(fields.name, NAME_PATTERN);
    assert.equal(
      fields.description,
      skill.description,
      "description must equal the registry entry so agents see what we advertise",
    );
    assert.ok(fields.description.length > 80, "description should be specific");
    assert.ok(raw.includes("## "), "SKILL.md should be organized in sections");
  });

  test(`${skill.name}: ships the fallback script and the catalog snapshot`, () => {
    const rels = sourceFiles(skill.name).map((file) => file.rel);
    assert.ok(rels.includes("SKILL.md"));
    assert.ok(rels.includes("scripts/mdxp.mjs"));
    assert.ok(rels.includes("reference/commands.md"));
    assert.ok(rels.includes("reference/mdxp-catalog.json"));
  });

  test(`${skill.name}: documents the safety rules and the exit-code contract`, () => {
    const { raw } = frontmatter(skill.name);
    const shared = [
      "--delete-files",
      "MOTRIX_BRIDGE_TOKEN",
      "motrix pair",
      "describe --json",
      "-32601",
      "mdxp.mjs",
    ];
    const needles =
      skill.language === "zh-CN"
        ? [...shared, "退出码", "安全红线"]
        : [...shared, "Exit code", "Safety rules"];
    for (const needle of needles) {
      assert.ok(raw.includes(needle), `SKILL.md should mention ${needle}`);
    }
  });
}
