#!/usr/bin/env node
/**
 * Native MDXP fallback client for Motrix.
 *
 * `motrix` (the official CLI) is the primary interface. A few MDXP methods have
 * no CLI verb at all — `engine/status` and `task/get` today. This script talks
 * JSON-RPC 2.0 directly to the bridge over a unary `POST /mdxp`, which is the
 * only way to reach them.
 *
 * This file is the single source of truth. Byte-identical copies live in
 * `skills/motrix-cli/scripts/mdxp.mjs` and
 * `skills/motrix-cli-en/scripts/mdxp.mjs` so the installed skills stay
 * self-contained; `test/mdxp-copies.test.mjs` fails if they ever drift.
 *
 * Usage:
 *   node mdxp.mjs engine/status
 *   node mdxp.mjs task/get --task <taskId>
 *   node mdxp.mjs call <method> [--params '<json>'] [--allow-write]
 *   node mdxp.mjs endpoints
 *
 * Exit codes match the official CLI: 0 ok, 2 usage, 3 network, 4 auth, 5 server.
 */

import { readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Methods this script will call without an explicit `--allow-write`. */
export const READ_ONLY_METHODS = [
  "engine/status",
  "task/get",
  "task/list",
  "stats/get",
];

export const EXIT = {
  OK: 0,
  USAGE: 2,
  NETWORK: 3,
  AUTH: 4,
  SERVER: 5,
};

const DEFAULT_TIMEOUT_MS = 10000;

export class MdxpError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = "MdxpError";
    this.code = code;
    this.details = details ?? {};
  }
}

/** Path to the desktop app's auto-discovery file (bridge port + owner token). */
export function localEndpointFile() {
  if (process.env.MOTRIX_ENDPOINT_FILE) return process.env.MOTRIX_ENDPOINT_FILE;
  if (process.platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Motrix",
      "bridge",
      "endpoint.json",
    );
  }
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "Motrix", "bridge", "endpoint.json");
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdg, "Motrix", "bridge", "endpoint.json");
}

/** Path to the paired-remote credentials file written by `motrix pair`. */
export function credentialsFile() {
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdg, "motrix", "credentials.json");
}

function normalizeEndpoint(value) {
  return String(value).trim().replace(/\/+$/, "");
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * Read the local desktop endpoint file. Returns null when Motrix has never run
 * on this machine (or the file is unreadable / incomplete).
 */
export function discoverLocalEndpoint() {
  const file = localEndpointFile();
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const port = Number(parsed?.port);
  if (!Number.isInteger(port) || port <= 0) return null;
  const host = typeof parsed?.host === "string" ? parsed.host : "127.0.0.1";
  return {
    endpoint: `http://${host}:${port}`,
    token: firstString(parsed?.localToken, parsed?.token),
    pid: Number.isInteger(parsed?.pid) ? parsed.pid : null,
    generation: typeof parsed?.generation === "string" ? parsed.generation : null,
    source: file,
  };
}

function collectPairings(node, out, depth = 0) {
  if (depth > 6 || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectPairings(item, out, depth + 1);
    return;
  }
  const directEndpoint = firstString(
    node.endpoint,
    node.url,
    node.baseUrl,
    node.base_url,
  );
  const directToken = firstString(
    node.token,
    node.bearerToken,
    node.accessToken,
    node.secret,
  );
  if (directEndpoint?.startsWith("http") && directToken) {
    out.push({ endpoint: normalizeEndpoint(directEndpoint), token: directToken });
  }
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("http")) {
      if (typeof value === "string" && value.length > 0) {
        out.push({ endpoint: normalizeEndpoint(key), token: value });
      } else if (value && typeof value === "object") {
        const token = firstString(
          value.token,
          value.bearerToken,
          value.accessToken,
          value.secret,
        );
        if (token) out.push({ endpoint: normalizeEndpoint(key), token });
      }
      continue;
    }
    collectPairings(value, out, depth + 1);
  }
}

/**
 * Best-effort read of `~/.config/motrix/credentials.json`. The file shape is
 * owned by the CLI, so this accepts several layouts and never throws; callers
 * should fall back to `--endpoint`/`--token` or `MOTRIX_BRIDGE_TOKEN`.
 */
export function listPairedEndpoints() {
  const file = credentialsFile();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { file, exists: false, entries: [] };
  }
  const found = [];
  collectPairings(parsed, found);
  const byEndpoint = new Map();
  for (const item of found) byEndpoint.set(item.endpoint, item.token);
  return {
    file,
    exists: true,
    entries: [...byEndpoint.entries()].map(([endpoint, token]) => ({
      endpoint,
      token: token ?? null,
    })),
  };
}

/**
 * Resolve `{ endpoint, token }` for a call.
 * Priority: explicit args -> MOTRIX_BRIDGE_TOKEN -> local discovery -> pairings.
 */
export function resolveTarget({ endpoint, token } = {}) {
  const requested = endpoint ? normalizeEndpoint(endpoint) : null;
  const envToken = firstString(process.env.MOTRIX_BRIDGE_TOKEN);
  const explicitToken = firstString(token, envToken);
  const local = discoverLocalEndpoint();

  if (!requested) {
    if (!local) {
      throw new MdxpError(
        `No local Motrix bridge found at ${localEndpointFile()}. Start the desktop app (motrix open) or pass --endpoint <url>.`,
        EXIT.NETWORK,
      );
    }
    const resolved = explicitToken ?? local.token;
    if (!resolved) {
      throw new MdxpError(
        `Endpoint ${local.source} has no token; the desktop bridge may not have finished starting.`,
        EXIT.AUTH,
      );
    }
    return { endpoint: local.endpoint, token: resolved, source: "local" };
  }

  if (explicitToken) {
    return { endpoint: requested, token: explicitToken, source: "explicit" };
  }
  if (local && normalizeEndpoint(local.endpoint) === requested && local.token) {
    return { endpoint: requested, token: local.token, source: "local" };
  }
  const pairings = listPairedEndpoints();
  const match = pairings.entries.find(
    (entry) => normalizeEndpoint(entry.endpoint) === requested,
  );
  if (match?.token) {
    return { endpoint: requested, token: match.token, source: "pairing" };
  }
  if (pairings.entries.length === 1 && pairings.entries[0].token) {
    return {
      endpoint: requested,
      token: pairings.entries[0].token,
      source: "pairing",
    };
  }
  throw new MdxpError(
    `No token for ${requested}. Run \`motrix pair --endpoint ${requested}\`, or pass --token / MOTRIX_BRIDGE_TOKEN.`,
    EXIT.AUTH,
  );
}

/**
 * Send one JSON-RPC 2.0 request to `<endpoint>/mdxp`.
 * Returns the JSON-RPC `result`; throws MdxpError with a CLI-compatible code.
 */
export async function callMdxp({
  method,
  params = {},
  endpoint,
  token,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof method !== "string" || method.length === 0) {
    throw new MdxpError("A method name is required.", EXIT.USAGE);
  }
  const target = resolveTarget({ endpoint, token });
  const url = `${target.endpoint}/mdxp`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${target.token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
  } catch (error) {
    const reason = error?.name === "AbortError" ? "timed out" : "unreachable";
    throw new MdxpError(
      `Bridge ${reason} at ${target.endpoint} (${reason === "timed out" ? `${timeoutMs}ms` : "network error"}).`,
      EXIT.NETWORK,
      { cause: String(error?.message ?? error) },
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let envelope = null;
  try {
    envelope = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    envelope = null;
  }

  if (response.status === 401 || response.status === 403) {
    throw new MdxpError(
      `Bridge rejected the token (HTTP ${response.status}). Re-run \`motrix pair\`, or pass a valid --token / MOTRIX_BRIDGE_TOKEN.`,
      EXIT.AUTH,
      { status: response.status },
    );
  }
  if (response.status === 404) {
    throw new MdxpError(
      `Bridge has no /mdxp endpoint (HTTP 404) at ${target.endpoint} — the target is not a Motrix MDXP bridge, or it is too old.`,
      EXIT.SERVER,
      { status: response.status },
    );
  }
  if (!response.ok) {
    throw new MdxpError(
      `Bridge returned HTTP ${response.status} for ${method}.`,
      response.status >= 500 ? EXIT.SERVER : EXIT.NETWORK,
      { status: response.status, envelope },
    );
  }
  if (!envelope || typeof envelope !== "object") {
    throw new MdxpError(
      `Bridge returned a non-JSON-RPC body for ${method}.`,
      EXIT.SERVER,
      { body: text.slice(0, 500) },
    );
  }
  if (envelope.error) {
    const code = envelope.error.code;
    const drift = code === -32601;
    throw new MdxpError(
      drift
        ? `Method ${method} is unknown to this Motrix (JSON-RPC -32601). Update Motrix or the CLI; retrying will not help.`
        : `Bridge returned a JSON-RPC error for ${method}: ${envelope.error.message ?? "unspecified"}.`,
      EXIT.SERVER,
      { code, data: envelope.error.data ?? null },
    );
  }
  return { result: envelope.result ?? null, envelope, target };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `mdxp.mjs — native MDXP (JSON-RPC 2.0) fallback for methods the motrix CLI does not expose.

Usage:
  node mdxp.mjs engine/status [options]
  node mdxp.mjs task/get --task <taskId> [options]
  node mdxp.mjs call <method> [--params '<json>'] [--allow-write] [options]
  node mdxp.mjs endpoints

Options:
  --endpoint <url>   bridge base URL (default: auto-discovered local desktop)
  --token <token>    bearer token (default: endpoint.json or $MOTRIX_BRIDGE_TOKEN)
  --timeout <ms>     request timeout (default: ${DEFAULT_TIMEOUT_MS})
  --envelope         print the whole JSON-RPC envelope instead of result
  -h, --help         show this help

Read-only methods allowed without --allow-write: ${READ_ONLY_METHODS.join(", ")}
Prefer the CLI (motrix add|pause|resume|remove|list|stats|watch) for anything that changes state.`;

function parseArgs(argv) {
  const options = {
    endpoint: undefined,
    token: undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    envelope: false,
    allowWrite: false,
    params: undefined,
    task: undefined,
    help: false,
    positionals: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) {
        throw new MdxpError(`Missing value for ${arg}`, EXIT.USAGE);
      }
      return argv[i];
    };
    switch (arg) {
      case "--endpoint":
        options.endpoint = next();
        break;
      case "--token":
        options.token = next();
        break;
      case "--timeout": {
        const value = Number(next());
        if (!Number.isFinite(value) || value <= 0) {
          throw new MdxpError("--timeout must be a positive number of ms", EXIT.USAGE);
        }
        options.timeoutMs = value;
        break;
      }
      case "--params":
        options.params = next();
        break;
      case "--task":
        options.task = next();
        break;
      case "--envelope":
        options.envelope = true;
        break;
      case "--allow-write":
        options.allowWrite = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        if (arg.startsWith("-")) {
          throw new MdxpError(`Unknown option ${arg}`, EXIT.USAGE);
        }
        options.positionals.push(arg);
    }
  }
  return options;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help || options.positionals.length === 0) {
    process.stdout.write(`${USAGE}\n`);
    return options.help ? EXIT.OK : EXIT.USAGE;
  }

  const [verb, ...rest] = options.positionals;

  if (verb === "endpoints") {
    const local = discoverLocalEndpoint();
    const pairings = listPairedEndpoints();
    print({
      local: local
        ? {
            endpoint: local.endpoint,
            pid: local.pid,
            tokenSource: local.source,
            hasToken: Boolean(local.token),
          }
        : null,
      paired: {
        file: pairings.file,
        exists: pairings.exists,
        endpoints: pairings.entries.map((entry) => ({
          endpoint: entry.endpoint,
          hasToken: Boolean(entry.token),
        })),
      },
    });
    return EXIT.OK;
  }

  let method;
  let params = {};
  if (verb === "call") {
    method = rest[0];
    if (!method) throw new MdxpError("call requires a method name", EXIT.USAGE);
    if (!READ_ONLY_METHODS.includes(method) && !options.allowWrite) {
      throw new MdxpError(
        `${method} is not a read-only method. Use the CLI (motrix add|pause|resume|remove) instead, or pass --allow-write if you really mean to call it directly.`,
        EXIT.USAGE,
      );
    }
    if (options.params !== undefined) {
      try {
        params = JSON.parse(options.params);
      } catch (error) {
        throw new MdxpError(`--params is not valid JSON: ${error.message}`, EXIT.USAGE);
      }
    }
  } else if (verb === "engine/status") {
    method = "engine/status";
  } else if (verb === "task/get") {
    method = "task/get";
    if (!options.task) {
      throw new MdxpError("task/get requires --task <taskId>", EXIT.USAGE);
    }
    params = { taskId: options.task };
  } else if (READ_ONLY_METHODS.includes(verb)) {
    method = verb;
  } else {
    throw new MdxpError(
      `Unknown command ${verb}. Try: engine/status, task/get, call <method>, endpoints.`,
      EXIT.USAGE,
    );
  }

  const { result, envelope } = await callMdxp({
    method,
    params,
    endpoint: options.endpoint,
    token: options.token,
    timeoutMs: options.timeoutMs,
  });
  print(options.envelope ? envelope : result);
  return EXIT.OK;
}

/**
 * True when this file is the entry point. Uses realpath comparison so that a
 * global bin symlink or a path containing spaces (or any character that needs
 * URL encoding) still matches.
 */
function invokedDirectly() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(argv1).href === import.meta.url;
  }
}

if (invokedDirectly()) {
  try {
    process.exitCode = await main();
  } catch (error) {
    const code = error instanceof MdxpError ? error.code : EXIT.SERVER;
    process.stderr.write(`${error?.message ?? error}\n`);
    if (error instanceof MdxpError && error.details?.code !== undefined) {
      process.stderr.write(
        `jsonrpc code: ${error.details.code}${error.details.data !== undefined ? ` data: ${JSON.stringify(error.details.data)}` : ""}\n`,
      );
    }
    process.exitCode = code;
  }
}
