import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  EXIT,
  MdxpError,
  callMdxp,
  discoverLocalEndpoint,
  listPairedEndpoints,
  resolveTarget,
} from "../src/mdxp.mjs";
import { jsonResponse, sandbox, stubFetch } from "./helpers.mjs";

test("local endpoint discovery reads port, host and owner token", (t) => {
  sandbox(t, { endpointFile: { port: 16802, pid: 42, localToken: "tok" } });
  const local = discoverLocalEndpoint();
  assert.equal(local.endpoint, "http://127.0.0.1:16802");
  assert.equal(local.token, "tok");
  assert.equal(local.pid, 42);
});

test("discovery returns null when the app never ran", (t) => {
  sandbox(t);
  assert.equal(discoverLocalEndpoint(), null);
});

test("an explicit endpoint plus token needs no discovery at all", (t) => {
  sandbox(t);
  const target = resolveTarget({
    endpoint: "http://nas.local:16801/",
    token: "abc",
  });
  assert.equal(target.endpoint, "http://nas.local:16801");
  assert.equal(target.token, "abc");
  assert.equal(target.source, "explicit");
});

test("MOTRIX_BRIDGE_TOKEN is honored", (t) => {
  sandbox(t);
  process.env.MOTRIX_BRIDGE_TOKEN = "from-env";
  const target = resolveTarget({ endpoint: "http://nas.local:16801" });
  assert.equal(target.token, "from-env");
});

test("remote pairings are read defensively from several shapes", (t) => {
  sandbox(t, {
    credentials: {
      "http://nas.local:16801": { token: "nested" },
      "http://other.local:16801": "flat",
    },
  });
  const pairings = listPairedEndpoints();
  assert.equal(pairings.exists, true);
  const map = Object.fromEntries(
    pairings.entries.map((entry) => [entry.endpoint, entry.token]),
  );
  assert.equal(map["http://nas.local:16801"], "nested");
  assert.equal(map["http://other.local:16801"], "flat");
});

test("a cached endpoint with no token fails as an auth problem", (t) => {
  sandbox(t, { endpointFile: { port: 16802 } });
  assert.throws(() => resolveTarget({}), (error) => {
    assert.ok(error instanceof MdxpError);
    assert.equal(error.code, EXIT.AUTH);
    return true;
  });
});

test("no bridge at all fails as a network problem", (t) => {
  sandbox(t);
  assert.throws(() => resolveTarget({}), (error) => {
    assert.equal(error.code, EXIT.NETWORK);
    assert.match(error.message, /motrix open/);
    return true;
  });
});

test("a successful call sends the expected envelope and returns the result", async (t) => {
  sandbox(t, { endpointFile: { port: 16802, localToken: "tok" } });
  let seen = null;
  const { result } = await callMdxp({
    method: "engine/status",
    fetchImpl: stubFetch((url, init) => {
      seen = { url, init };
      return jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: { state: "ready" },
      });
    }),
  });
  assert.equal(result.state, "ready");
  assert.equal(seen.url, "http://127.0.0.1:16802/mdxp");
  assert.equal(seen.init.headers.authorization, "Bearer tok");
  assert.deepEqual(JSON.parse(seen.init.body), {
    jsonrpc: "2.0",
    id: 1,
    method: "engine/status",
    params: {},
  });
});

test("a refused connection is reported as exit 3", async (t) => {
  sandbox(t, { endpointFile: { port: 16802, localToken: "tok" } });
  await assert.rejects(
    () =>
      callMdxp({
        method: "engine/status",
        fetchImpl: stubFetch(() => {
          throw new Error("ECONNREFUSED");
        }),
      }),
    (error) => {
      assert.equal(error.code, EXIT.NETWORK);
      assert.match(error.message, /unreachable/);
      return true;
    },
  );
});

test("a timeout is reported as a network problem", async (t) => {
  sandbox(t, { endpointFile: { port: 16802, localToken: "tok" } });
  await assert.rejects(
    () =>
      callMdxp({
        method: "engine/status",
        timeoutMs: 1,
        fetchImpl: stubFetch(() => {
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        }),
      }),
    (error) => {
      assert.equal(error.code, EXIT.NETWORK);
      assert.match(error.message, /timed out/);
      return true;
    },
  );
});

test("HTTP 401 becomes an auth error that tells the agent to pair", async (t) => {
  sandbox(t, { endpointFile: { port: 16802, localToken: "stale" } });
  await assert.rejects(
    () =>
      callMdxp({
        method: "engine/status",
        fetchImpl: stubFetch(() => jsonResponse({ error: "unauthorized" }, 401)),
      }),
    (error) => {
      assert.equal(error.code, EXIT.AUTH);
      assert.match(error.message, /motrix pair/);
      return true;
    },
  );
});

test("HTTP 404 is treated as version drift, not a transient failure", async (t) => {
  sandbox(t, { endpointFile: { port: 16802, localToken: "tok" } });
  await assert.rejects(
    () =>
      callMdxp({
        method: "task/get",
        fetchImpl: stubFetch(() => jsonResponse("nope", 404)),
      }),
    (error) => {
      assert.equal(error.code, EXIT.SERVER);
      assert.match(error.message, /404/);
      return true;
    },
  );
});

test("JSON-RPC -32601 is explained as drift and flagged as not worth retrying", async (t) => {
  sandbox(t, { endpointFile: { port: 16802, localToken: "tok" } });
  await assert.rejects(
    () =>
      callMdxp({
        method: "engine/status",
        fetchImpl: stubFetch(() =>
          jsonResponse({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32601, message: "Method not found" },
          }),
        ),
      }),
    (error) => {
      assert.equal(error.code, EXIT.SERVER);
      assert.equal(error.details.code, -32601);
      assert.match(error.message, /retrying will not help/);
      return true;
    },
  );
});

test("a non-JSON bridge body is a server error, not a crash", async (t) => {
  sandbox(t, { endpointFile: { port: 16802, localToken: "tok" } });
  await assert.rejects(
    () =>
      callMdxp({
        method: "engine/status",
        fetchImpl: stubFetch(() => jsonResponse("<html>proxy</html>")),
      }),
    (error) => {
      assert.equal(error.code, EXIT.SERVER);
      assert.match(error.message, /non-JSON-RPC/);
      return true;
    },
  );
});

test("the credentials path honors XDG_CONFIG_HOME", (t) => {
  const { root } = sandbox(t);
  assert.equal(listPairedEndpoints().file, join(root, "motrix", "credentials.json"));
  const file = join(root, "motrix", "credentials.json");
  assert.equal(fs.existsSync(file), false);
});
