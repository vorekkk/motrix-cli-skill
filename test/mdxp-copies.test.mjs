import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { PACKAGE_ROOT, sha256, sourceFiles } from "../src/install.js";
import { SKILLS } from "../src/skills.js";

const CANONICAL = join(PACKAGE_ROOT, "src", "mdxp.mjs");

test("mdxp.mjs copies in the skills are byte-identical to the source of truth", () => {
  const canonical = sha256(fs.readFileSync(CANONICAL));
  for (const skill of SKILLS) {
    const copy = join(PACKAGE_ROOT, "skills", skill.name, "scripts", "mdxp.mjs");
    assert.equal(
      sha256(fs.readFileSync(copy)),
      canonical,
      `${skill.name}/scripts/mdxp.mjs drifted from src/mdxp.mjs — copy it again`,
    );
  }
});

test("catalog snapshots agree, cover every method, and declare themselves non-authoritative", () => {
  const payloads = SKILLS.map((skill) => {
    const path = join(
      PACKAGE_ROOT,
      "skills",
      skill.name,
      "reference",
      "mdxp-catalog.json",
    );
    return fs.readFileSync(path, "utf8");
  });
  for (const payload of payloads.slice(1)) {
    assert.equal(payload, payloads[0], "snapshots must stay identical");
  }

  const snapshot = JSON.parse(payloads[0]);
  assert.equal(snapshot._snapshot.authoritative, false);
  assert.equal(
    snapshot._snapshot.authoritativeCommand,
    "motrix describe --json",
  );
  assert.equal(snapshot._snapshot.methodCount, snapshot.methods.length);
  assert.deepEqual(
    snapshot.methods.map((method) => method.name).sort(),
    [
      "download/add",
      "engine/status",
      "stats/get",
      "task/get",
      "task/list",
      "task/pause",
      "task/remove",
      "task/resume",
    ],
  );
  for (const method of snapshot.methods) {
    assert.ok(method.inputSchema, `${method.name} needs an inputSchema`);
    assert.ok(method.outputSchema, `${method.name} needs an outputSchema`);
  }
});

test("catalog snapshots are shipped with both skills", () => {
  for (const skill of SKILLS) {
    const rels = sourceFiles(skill.name).map((file) => file.rel);
    assert.ok(rels.includes("reference/mdxp-catalog.json"));
  }
});
