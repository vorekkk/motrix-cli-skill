import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { postinstallProblems } from "../src/lifecycle-guard.js";
import { PACKAGE_ROOT } from "../src/install.js";

test("the shipped postinstall command passes the guard", () => {
  const pkg = JSON.parse(
    fs.readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
  );
  assert.deepEqual(postinstallProblems(pkg.scripts.postinstall), []);
});

test("backticks are rejected (they broke every install once)", () => {
  const problems = postinstallProblems(
    "node -e \"console.log('run `motrix-cli-skill install`')\"",
  );
  assert.ok(
    problems.some((problem) => /shell would substitute/.test(problem)),
    problems.join("; "),
  );
});

test("shell command substitution is rejected", () => {
  for (const command of [
    "node $(npm root -g)/x.js",
    "node ${npm_package_json%/*}/bin/postinstall.js",
    "node $npm_package_json/../bin/postinstall.js",
  ]) {
    assert.ok(
      postinstallProblems(command).some((problem) => /substitute/.test(problem)),
      `should reject: ${command}`,
    );
  }
});

test("a cwd-relative entry point is rejected", () => {
  const problems = postinstallProblems("node ./bin/postinstall.js");
  assert.ok(problems.some((problem) => /deleted directory/.test(problem)));
});

test("a command that never mentions the hook is rejected", () => {
  const problems = postinstallProblems("node -e \"console.log(1)\"");
  assert.ok(problems.some((problem) => /should resolve/.test(problem)));
  assert.deepEqual(postinstallProblems(""), []);
});
