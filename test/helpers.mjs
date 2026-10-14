/** Shared test fixtures: a throwaway HOME/XDG sandbox and fetch stubs. */

import fs from "node:fs";
import { join } from "node:path";

export function sandbox(t, { endpointFile = null, credentials = null } = {}) {
  const root = fs.mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "motrix-test-"));
  const saved = {
    MOTRIX_ENDPOINT_FILE: process.env.MOTRIX_ENDPOINT_FILE,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    MOTRIX_BRIDGE_TOKEN: process.env.MOTRIX_BRIDGE_TOKEN,
  };
  delete process.env.MOTRIX_BRIDGE_TOKEN;

  let endpointPath = join(root, "missing-endpoint.json");
  if (endpointFile) {
    endpointPath = join(root, "endpoint.json");
    fs.writeFileSync(endpointPath, JSON.stringify(endpointFile));
  }
  process.env.MOTRIX_ENDPOINT_FILE = endpointPath;

  process.env.XDG_CONFIG_HOME = root;
  if (credentials) {
    fs.mkdirSync(join(root, "motrix"), { recursive: true });
    fs.writeFileSync(
      join(root, "motrix", "credentials.json"),
      JSON.stringify(credentials),
    );
  }

  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  return { root, endpointPath };
}

export function stubFetch(handler) {
  return async (url, init) => handler(url, init);
}

export function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

/** Capture everything a function writes to stdout. */
export async function captureStdout(run) {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    const value = await run();
    return { value, text: chunks.join("") };
  } finally {
    process.stdout.write = original;
  }
}
