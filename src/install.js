/**
 * Installer core: resolve agent skill directories, copy the bundled skills,
 * verify every write by hashing it back, and uninstall only what we manage.
 *
 * Safety rules encoded here:
 *  - never touch a directory that is not carrying our manifest (that is how the
 *    official `motrix` skill and user-authored skills stay untouched);
 *  - uninstall deletes manifest-listed files only, then removes the directory
 *    only if it is empty afterwards;
 *  - every copy is read back and re-hashed, so a silent partial write fails.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { PACKAGE_NAME, SKILLS, selectSkills } from "./skills.js";

export const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const MANIFEST_FILE = ".motrix-cli-skill.json";
export const SKILLS_SOURCE_ROOT = join(PACKAGE_ROOT, "skills");

export function packageVersion() {
  const pkg = JSON.parse(
    fs.readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
  );
  return pkg.version;
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function toPosix(value) {
  return value.split(sep).join("/");
}

function expandHome(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

export function codexSkillsDir() {
  const codexHome = process.env.CODEX_HOME;
  const root = codexHome ? expandHome(codexHome) : join(homedir(), ".codex");
  return join(root, "skills");
}

export function claudeSkillsDir() {
  return join(homedir(), ".claude", "skills");
}

function dirExists(path) {
  try {
    return fs.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isAgentPresent(skillsDir) {
  return dirExists(dirname(skillsDir));
}

/**
 * Resolve `--target` into concrete skill roots.
 *  - `all`    -> every agent found on this machine, falling back to Codex
 *  - `codex` / `claude` -> that agent, even if it is not installed yet
 *  - anything else -> treated as a directory (the skills root)
 */
export function resolveTargets(selector = "all") {
  const codex = {
    id: "codex",
    label: "Codex",
    dir: codexSkillsDir(),
  };
  const claude = {
    id: "claude",
    label: "Claude",
    dir: claudeSkillsDir(),
  };

  if (selector === "all") {
    const found = [codex, claude].filter((target) =>
      isAgentPresent(target.dir),
    );
    const chosen = found.length > 0 ? found : [codex];
    return chosen.map((target) => ({
      ...target,
      detected: isAgentPresent(target.dir),
      fallback: found.length === 0,
    }));
  }
  if (selector === "codex") {
    return [{ ...codex, detected: isAgentPresent(codex.dir), fallback: false }];
  }
  if (selector === "claude") {
    return [
      { ...claude, detected: isAgentPresent(claude.dir), fallback: false },
    ];
  }
  const dir = resolve(expandHome(selector));
  return [{ id: "custom", label: dir, dir, detected: dirExists(dir), fallback: false }];
}

/** Walk a bundled skill directory into `{ rel, abs, sha256, size }` records. */
export function sourceFiles(skillName) {
  const root = join(SKILLS_SOURCE_ROOT, skillName);
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        const buffer = fs.readFileSync(abs);
        out.push({
          rel: toPosix(relative(root, abs)),
          abs,
          sha256: sha256(buffer),
          size: buffer.byteLength,
        });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

function readManifest(destDir) {
  const file = join(destDir, MANIFEST_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.files) return null;
    return parsed;
  } catch {
    return null;
  }
}

function foreignEntries(destDir) {
  try {
    return fs
      .readdirSync(destDir)
      .filter((name) => name !== MANIFEST_FILE);
  } catch {
    return [];
  }
}

/** Nearest existing ancestor, used to explain permission failures accurately. */
function nearestExisting(path) {
  let current = path;
  for (let depth = 0; depth < 40; depth += 1) {
    try {
      fs.statSync(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
  return null;
}

/**
 * Turn a raw filesystem error into something an agent can act on. The common
 * real-world case is an agent directory owned by another user (for example a
 * ~/.claude/skills created by an earlier `sudo` install) — `--force` cannot fix
 * that, so the message must say what actually will.
 */
export function describeWriteFailure(destDir, error) {
  const base = String(error?.message ?? error);
  const code = error?.code;
  if (code === "EACCES" || code === "EPERM") {
    const existing = nearestExisting(destDir) ?? destDir;
    let owner = "unknown";
    try {
      const stat = fs.statSync(existing);
      const mine = typeof process.getuid === "function" ? process.getuid() : null;
      owner =
        mine !== null && stat.uid === mine
          ? "you, but the directory is not writable"
          : `uid ${stat.uid} (not the current user, uid ${mine ?? "?"})`;
    } catch {
      /* keep the placeholder */
    }
    return `${base} — ${existing} is owned by ${owner}. Install into a writable agent only (--target codex), fix that directory's ownership yourself, or pick a directory you own; sudo is not a fix.`;
  }
  if (code === "EROFS") {
    return `${base} — the target filesystem is read-only; choose a different --target.`;
  }
  if (code === "ENOSPC") {
    return `${base} — the disk is full.`;
  }
  return base;
}

/** Dry-run the install so callers can print an exact plan before writing. */
export function planInstall({ target = "all", skill = "all", force = false } = {}) {
  const targets = resolveTargets(target);
  const skills = selectSkills(skill);
  const rows = [];
  for (const skillEntry of skills) {
    const files = sourceFiles(skillEntry.name);
    for (const targetEntry of targets) {
      const destDir = join(targetEntry.dir, skillEntry.name);
      const manifest = readManifest(destDir);
      const exists = dirExists(destDir);
      const blocked =
        exists && !manifest && foreignEntries(destDir).length > 0 && !force;
      const previous = manifest?.files ?? {};
      const next = new Map(files.map((file) => [file.rel, file.sha256]));
      const stale = Object.keys(previous).filter((rel) => !next.has(rel));
      const changes = files.map((file) => {
        const before = previous[file.rel];
        if (before === undefined) return { rel: file.rel, status: "new" };
        if (before === file.sha256) return { rel: file.rel, status: "unchanged" };
        return { rel: file.rel, status: "update" };
      });
      rows.push({
        skill: skillEntry.name,
        target: targetEntry.id,
        targetLabel: targetEntry.label,
        destDir,
        action: blocked
          ? "blocked"
          : !exists
            ? "create"
            : manifest
              ? "sync"
              : "adopt",
        blockedReason: blocked
          ? `${destDir} exists and is not managed by ${PACKAGE_NAME}; re-run with --force to adopt it`
          : null,
        fileCount: files.length,
        changes,
        stale,
      });
    }
  }
  return rows;
}

/**
 * Copy the bundled skills into the resolved targets.
 * Returns `{ installed: [...], skipped: [...], failed: [...] }`.
 */
export function install({ target = "all", skill = "all", dryRun = false, force = false } = {}) {
  const rows = planInstall({ target, skill, force });
  const result = { installed: [], skipped: [], failed: [], dryRun };

  for (const row of rows) {
    if (row.action === "blocked") {
      result.failed.push({
        skill: row.skill,
        target: row.target,
        destDir: row.destDir,
        reason: row.blockedReason,
      });
      continue;
    }
    if (dryRun) {
      result.skipped.push({ ...row, reason: "dry-run" });
      continue;
    }

    const files = sourceFiles(row.skill);
    const manifest = readManifest(row.destDir);
    const written = [];
    try {
      fs.mkdirSync(row.destDir, { recursive: true });
      for (const file of files) {
        const dest = join(row.destDir, ...file.rel.split("/"));
        fs.mkdirSync(dirname(dest), { recursive: true });
        fs.writeFileSync(dest, fs.readFileSync(file.abs));
        const digest = sha256(fs.readFileSync(dest));
        if (digest !== file.sha256) {
          throw new Error(
            `write verification failed for ${file.rel} (expected ${file.sha256}, got ${digest})`,
          );
        }
        written.push(file.rel);
      }
      const stale = row.stale;
      for (const rel of stale) {
        fs.rmSync(join(row.destDir, ...rel.split("/")), { force: true });
      }
      const manifestBody = {
        package: PACKAGE_NAME,
        version: packageVersion(),
        skill: row.skill,
        language: SKILLS.find((entry) => entry.name === row.skill)?.language ?? null,
        installedAt: new Date().toISOString(),
        files: Object.fromEntries(
          files.map((file) => [file.rel, file.sha256]),
        ),
      };
      fs.writeFileSync(
        join(row.destDir, MANIFEST_FILE),
        `${JSON.stringify(manifestBody, null, 2)}\n`,
      );
      result.installed.push({
        skill: row.skill,
        target: row.target,
        destDir: row.destDir,
        action: row.action,
        files: written.length,
        removed: stale,
        adopted: row.action === "adopt" && Boolean(manifest) === false && force,
      });
    } catch (error) {
      result.failed.push({
        skill: row.skill,
        target: row.target,
        destDir: row.destDir,
        reason: describeWriteFailure(row.destDir, error),
      });
    }
  }
  return result;
}

function pruneEmptyDirs(root, from) {
  let dir = dirname(from);
  const stop = resolve(root);
  while (resolve(dir).startsWith(stop) && resolve(dir) !== stop) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    if (entries.length > 0) return;
    fs.rmdirSync(dir);
    dir = dirname(dir);
  }
}

/**
 * Remove only files this package installed. Directories are dropped when they
 * are empty afterwards, so unrelated skills next to ours are never touched.
 */
export function uninstall({ target = "all", skill = "all", dryRun = false, force = false } = {}) {
  const targets = resolveTargets(target);
  const skills = selectSkills(skill);
  const result = { removed: [], skipped: [], dryRun };
  for (const skillEntry of skills) {
    for (const targetEntry of targets) {
      const destDir = join(targetEntry.dir, skillEntry.name);
      const manifest = readManifest(destDir);
      if (!manifest) {
        if (dirExists(destDir)) {
          result.skipped.push({
            skill: skillEntry.name,
            target: targetEntry.id,
            destDir,
            reason: `not managed by ${PACKAGE_NAME}${force ? " (use a plain rm to remove it)" : ""}`,
          });
        }
        continue;
      }
      const rels = Object.keys(manifest.files ?? {});
      if (dryRun) {
        result.skipped.push({
          skill: skillEntry.name,
          target: targetEntry.id,
          destDir,
          reason: "dry-run",
          files: rels.length,
        });
        continue;
      }
      const removed = [];
      for (const rel of rels) {
        const abs = join(destDir, ...rel.split("/"));
        if (fs.existsSync(abs)) {
          fs.rmSync(abs, { force: true });
          removed.push(rel);
          pruneEmptyDirs(destDir, abs);
        }
      }
      fs.rmSync(join(destDir, MANIFEST_FILE), { force: true });
      try {
        if (fs.readdirSync(destDir).length === 0) fs.rmdirSync(destDir);
      } catch {
        /* leave any non-empty directory in place */
      }
      result.removed.push({
        skill: skillEntry.name,
        target: targetEntry.id,
        destDir,
        files: removed.length,
        version: manifest.version ?? null,
      });
    }
  }
  return result;
}

/** Integrity report used by `doctor` and by tests. */
export function inspectInstalled({ target = "all", skill = "all" } = {}) {
  const targets = resolveTargets(target);
  const skills = selectSkills(skill);
  const report = [];
  for (const skillEntry of skills) {
    const source = sourceFiles(skillEntry.name);
    for (const targetEntry of targets) {
      const destDir = join(targetEntry.dir, skillEntry.name);
      const manifest = readManifest(destDir);
      const entry = {
        skill: skillEntry.name,
        target: targetEntry.id,
        destDir,
        installed: false,
        managed: Boolean(manifest),
        version: manifest?.version ?? null,
        outOfDate: null,
        missing: [],
        changed: [],
        foreign: [],
      };
      if (dirExists(destDir)) {
        if (manifest) {
          entry.installed = true;
          entry.outOfDate = manifest.version !== packageVersion();
          for (const file of source) {
            const abs = join(destDir, ...file.rel.split("/"));
            if (!fs.existsSync(abs)) {
              entry.missing.push(file.rel);
              continue;
            }
            if (sha256(fs.readFileSync(abs)) !== file.sha256) {
              entry.changed.push(file.rel);
            }
          }
          const managed = new Set([
            ...Object.keys(manifest.files ?? {}),
            MANIFEST_FILE,
          ]);
          entry.foreign = foreignEntries(destDir).filter(
            (name) => !managed.has(name),
          );
        } else {
          entry.foreign = fs.readdirSync(destDir);
        }
      }
      entry.healthy =
        entry.installed &&
        !entry.outOfDate &&
        entry.missing.length === 0 &&
        entry.changed.length === 0;
      report.push(entry);
    }
  }
  return report;
}
