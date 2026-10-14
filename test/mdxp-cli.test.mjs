import assert from "node:assert/strict";
import test from "node:test";

import { EXIT, main } from "../src/mdxp.mjs";
import { captureStdout, sandbox } from "./helpers.mjs";

test("the fallback refuses a mutating method without --allow-write", async (t) => {
  sandbox(t, { endpointFile: { port: 16802, localToken: "tok" } });
  await assert.rejects(
    () => main(["call", "task/remove", "--params", '{"taskId":"x"}']),
    (error) => {
      assert.equal(error.code, EXIT.USAGE);
      assert.match(error.message, /motrix add\|pause\|resume\|remove/);
      return true;
    },
  );
});

test("task/get requires an explicit task id", async (t) => {
  sandbox(t, { endpointFile: { port: 16802, localToken: "tok" } });
  await assert.rejects(
    () => main(["task/get"]),
    (error) => {
      assert.equal(error.code, EXIT.USAGE);
      assert.match(error.message, /--task/);
      return true;
    },
  );
});

test("an unknown command fails with a usage error", async () => {
  await assert.rejects(
    () => main(["frobnicate"]),
    (error) => {
      assert.equal(error.code, EXIT.USAGE);
      return true;
    },
  );
});

test("--help succeeds and a bare invocation is a usage error", async () => {
  const help = await captureStdout(() => main(["--help"]));
  assert.equal(help.value, EXIT.OK);
  assert.match(help.text, /Read-only methods allowed/);
  const bare = await captureStdout(() => main([]));
  assert.equal(bare.value, EXIT.USAGE);
});

test("bad JSON in --params is a usage error, not a network call", async (t) => {
  sandbox(t, { endpointFile: { port: 16802, localToken: "tok" } });
  await assert.rejects(
    () => main(["call", "task/get", "--params", "{not json"]),
    (error) => {
      assert.equal(error.code, EXIT.USAGE);
      assert.match(error.message, /valid JSON/);
      return true;
    },
  );
});

test("endpoints output never contains the token itself", async (t) => {
  sandbox(t, {
    endpointFile: { port: 16802, localToken: "super-secret-token" },
    credentials: { "http://nas.local:16801": { token: "paired-secret" } },
  });
  const { value, text } = await captureStdout(() => main(["endpoints"]));
  assert.equal(value, EXIT.OK);
  assert.ok(!text.includes("super-secret-token"), "local token leaked");
  assert.ok(!text.includes("paired-secret"), "paired token leaked");
  const parsed = JSON.parse(text);
  assert.equal(parsed.local.hasToken, true);
  assert.equal(parsed.paired.endpoints.length, 1);
  assert.equal(parsed.paired.endpoints[0].token, undefined);
});
