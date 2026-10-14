/**
 * The `postinstall` command is executed by a shell (sh / zsh on POSIX, cmd on
 * Windows) and, for git installs, npm runs it from a working directory that has
 * already been deleted. Both facts have bitten this package before, so the
 * command is validated at publish time and in the test suite.
 */

const SHELL_SUBSTITUTIONS = ["`", "$(", "${", "$npm_"];

export function postinstallProblems(command) {
  const problems = [];
  if (!command) return problems;
  for (const risky of SHELL_SUBSTITUTIONS) {
    if (command.includes(risky)) {
      problems.push(
        `postinstall must not contain ${JSON.stringify(risky)} — a shell would substitute it`,
      );
    }
  }
  if (command.includes("./bin/postinstall.js")) {
    problems.push(
      "postinstall must not use a cwd-relative path — npm runs it from a deleted directory for git installs",
    );
  }
  if (!command.includes("postinstall.js")) {
    problems.push("postinstall should resolve bin/postinstall.js");
  }
  if (!command.includes("npm_package_json")) {
    problems.push(
      "postinstall should locate its script through npm_package_json, not the working directory",
    );
  }
  return problems;
}
