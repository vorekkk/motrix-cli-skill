/**
 * Registry of the skills shipped in this package.
 *
 * `description` must match the `description:` value in the corresponding
 * `skills/<name>/SKILL.md` frontmatter exactly — `test/skills.test.mjs`
 * enforces that, so the registry cannot silently drift from what agents load.
 */

export const PACKAGE_NAME = "motrix-cli-skill";

export const SKILLS = [
  {
    name: "motrix-cli",
    language: "zh-CN",
    title: "Motrix CLI（中文版）",
    description:
      "用 motrix 命令行客户端驱动 Motrix 下载管理器（中文版）。当任务涉及列出或筛选下载任务、查看聚合速度与任务计数、添加 HTTP(S)/FTP/磁力/种子下载、暂停或恢复或删除任务、流式跟踪下载进度、连接远端或无头 Motrix 服务器时使用。motrix 只是客户端，实际下载由运行中的 Motrix 实例完成。",
  },
  {
    name: "motrix-cli-en",
    language: "en",
    title: "Motrix CLI (English)",
    description:
      "Drive the Motrix download manager through the `motrix` command-line client (English edition). Use when a task involves listing or filtering downloads, reading aggregate speeds and task counts, adding HTTP(S)/FTP/magnet/torrent downloads, pausing, resuming or removing tasks, streaming live progress, or connecting to a remote or headless Motrix server. The CLI is only a client — a running Motrix instance performs the actual transfer.",
  },
];

export function skillNames() {
  return SKILLS.map((skill) => skill.name);
}

export function selectSkills(selector) {
  if (!selector || selector === "all") return [...SKILLS];
  const wanted = String(selector)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const picked = SKILLS.filter((skill) => wanted.includes(skill.name));
  if (picked.length === 0) {
    throw new Error(
      `Unknown skill ${selector}. Available: ${skillNames().join(", ")}, all`,
    );
  }
  return picked;
}
