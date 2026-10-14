#!/usr/bin/env node
/**
 * Best-effort auto-install of the bundled skills after a global `npm i -g`.
 *
 * Runs only for global installs, never fails the install, and can be disabled
 * with MOTRIX_CLI_SKILL_NO_AUTO_INSTALL=1.
 */

import { install } from "../src/install.js";

const disabled = process.env.MOTRIX_CLI_SKILL_NO_AUTO_INSTALL === "1";
const isGlobal = process.env.npm_config_global === "true";
const forced = process.env.MOTRIX_CLI_SKILL_FORCE_AUTO_INSTALL === "1";

if (disabled) {
  process.stdout.write(
    "motrix-cli-skill: auto-install disabled (MOTRIX_CLI_SKILL_NO_AUTO_INSTALL=1).\n",
  );
} else if (!isGlobal && !forced) {
  process.stdout.write(
    "motrix-cli-skill: skipped auto-install (not a global install). Run `motrix-cli-skill install` when you want it.\n",
  );
} else {
  try {
    const result = install({ target: "all", skill: "all", force: false });
    for (const item of result.installed) {
      process.stdout.write(
        `motrix-cli-skill: installed ${item.skill} -> ${item.destDir}\n`,
      );
    }
    for (const item of result.failed) {
      const adoptable = item.reason.includes("not managed by");
      process.stdout.write(
        adoptable
          ? `motrix-cli-skill: skipped ${item.skill} (${item.reason}); run \`motrix-cli-skill install --force\` to adopt it.\n`
          : `motrix-cli-skill: skipped ${item.skill} in ${item.destDir} — ${item.reason}\n`,
      );
    }
    if (result.installed.length === 0 && result.failed.length === 0) {
      process.stdout.write("motrix-cli-skill: nothing to do.\n");
    }
  } catch (error) {
    process.stdout.write(
      `motrix-cli-skill: auto-install skipped (${error?.message ?? error}); run \`motrix-cli-skill install\` manually.\n`,
    );
  }
}
