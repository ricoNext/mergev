#!/usr/bin/env bun
/**
 * 发版脚本：同步版本号、更新 CHANGELOG、commit、打 tag。
 *
 * 用法：
 *   bun run release 0.3.0
 *   bun run release 0.3.0 --push
 *   bun run release 0.3.0 --dry-run
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const VERSION_RE = /^\d+\.\d+\.\d+$/;

const SECTION_BY_TYPE: Record<string, string> = {
  feat: "新功能",
  fix: "修复",
  perf: "性能优化",
  refactor: "重构",
  docs: "文档",
  build: "构建",
  ci: "持续集成",
  chore: "杂项",
  style: "样式",
  test: "测试",
};

type Args = {
  version: string;
  push: boolean;
  dryRun: boolean;
};

function fail(message: string): never {
  console.error(`错误: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positional = argv.filter((a) => !a.startsWith("--"));
  const version = positional[0]?.replace(/^v/, "");

  if (!version) {
    fail("请传入版本号，例如: bun run release 0.3.0");
  }
  if (!VERSION_RE.test(version)) {
    fail(`版本号格式无效: ${version}（期望 x.y.z）`);
  }

  return {
    version,
    push: flags.has("--push"),
    dryRun: flags.has("--dry-run"),
  };
}

function run(
  command: string,
  args: string[],
  options: { allowFail?: boolean } = {},
): string {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0 && !options.allowFail) {
    const stderr = (result.stderr || result.stdout || "").trim();
    fail(`${command} ${args.join(" ")} 失败${stderr ? `\n${stderr}` : ""}`);
  }

  return (result.stdout || "").trim();
}

function read(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf8");
}

function write(relPath: string, content: string): void {
  writeFileSync(join(ROOT, relPath), content, "utf8");
}

function today(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function bumpPackageJson(version: string): void {
  const path = "package.json";
  const pkg = JSON.parse(read(path)) as { version: string };
  pkg.version = version;
  write(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

function bumpCargoToml(version: string): void {
  const path = "src-tauri/Cargo.toml";
  const content = read(path);
  const next = content.replace(
    /^version\s*=\s*"[^"]+"/m,
    `version = "${version}"`,
  );
  if (next === content) {
    fail("未能更新 src-tauri/Cargo.toml 中的 version");
  }
  write(path, next);
}

function bumpCargoLock(version: string): void {
  const path = "src-tauri/Cargo.lock";
  const content = read(path);
  const next = content.replace(
    /(name = "mergev"\n)version = "[^"]+"/,
    `$1version = "${version}"`,
  );
  if (next === content) {
    fail("未能更新 src-tauri/Cargo.lock 中的 mergev version");
  }
  write(path, next);
}

function bumpTauriConf(version: string): void {
  const path = "src-tauri/tauri.conf.json";
  const conf = JSON.parse(read(path)) as { version: string };
  conf.version = version;
  write(path, `${JSON.stringify(conf, null, 2)}\n`);
}

function previousTagOrEmpty(): string {
  const tag = run("git", ["describe", "--tags", "--abbrev=0"], {
    allowFail: true,
  });
  return tag;
}

function collectChangelogBody(): string {
  const lastTag = previousTagOrEmpty();
  const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
  const log = run(
    "git",
    ["log", range, "--pretty=format:%s", "--no-merges"],
    { allowFail: true },
  );

  const subjects = log
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^chore:\s*release\b/i.test(line));

  if (subjects.length === 0) {
    return ["### 变更", "", "- （请补充本版本变更）", ""].join("\n");
  }

  const grouped = new Map<string, string[]>();

  for (const subject of subjects) {
    const match = subject.match(
      /^(feat|fix|perf|refactor|docs|build|ci|chore|style|test)(?:\([^)]*\))?!?:\s*(.+)$/i,
    );

    if (match) {
      const type = match[1].toLowerCase();
      const section = SECTION_BY_TYPE[type] ?? "变更";
      const text = match[2].trim();
      const list = grouped.get(section) ?? [];
      list.push(`- ${text}`);
      grouped.set(section, list);
      continue;
    }

    const list = grouped.get("变更") ?? [];
    list.push(`- ${subject}`);
    grouped.set("变更", list);
  }

  const order = [
    "新功能",
    "修复",
    "性能优化",
    "重构",
    "文档",
    "构建",
    "持续集成",
    "样式",
    "测试",
    "杂项",
    "变更",
  ];

  const parts: string[] = [];
  for (const section of order) {
    const items = grouped.get(section);
    if (!items?.length) continue;
    parts.push(`### ${section}`, "", ...items, "");
  }

  return parts.join("\n");
}

function updateChangelog(version: string): void {
  const path = "CHANGELOG.md";
  const content = read(path);
  const heading = `## ${version} - ${today()}`;

  if (content.includes(`## ${version} `) || content.includes(`## ${version}\n`)) {
    fail(`CHANGELOG.md 中已存在版本 ${version}`);
  }

  const body = collectChangelogBody();
  const insertion = `${heading}\n\n${body}`;

  if (content.startsWith("# Changelog\n")) {
    write(path, content.replace("# Changelog\n", `# Changelog\n\n${insertion}`));
    return;
  }

  write(path, `${insertion}\n${content}`);
}

function ensureCleanOrOnlyExpected(): void {
  const status = run("git", ["status", "--porcelain"]);
  if (status) {
    fail(`工作区不干净，请先提交或暂存其他改动：\n${status}`);
  }
}

function ensureTagAbsent(version: string): void {
  const tag = `v${version}`;
  const exists = run("git", ["tag", "-l", tag]);
  if (exists) {
    fail(`本地已存在 tag ${tag}`);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const tag = `v${args.version}`;

  console.log(`准备发版 ${tag}${args.dryRun ? "（dry-run）" : ""}`);

  if (!args.dryRun) {
    ensureCleanOrOnlyExpected();
  }
  ensureTagAbsent(args.version);

  const current = JSON.parse(read("package.json")).version as string;
  console.log(`当前 package.json 版本: ${current} → ${args.version}`);

  const files = [
    "package.json",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
    "src-tauri/tauri.conf.json",
    "CHANGELOG.md",
  ];
  const backups = new Map(files.map((file) => [file, read(file)]));

  bumpPackageJson(args.version);
  bumpCargoToml(args.version);
  bumpCargoLock(args.version);
  bumpTauriConf(args.version);
  updateChangelog(args.version);

  console.log("已更新:");
  for (const file of files) {
    console.log(`  - ${file}`);
  }

  if (args.dryRun) {
    console.log("dry-run：还原改动，不 commit / tag");
    for (const file of files) {
      write(file, backups.get(file)!);
    }
    return;
  }

  run("git", ["add", ...files]);
  run("git", ["commit", "-m", `chore: release ${tag}`]);
  run("git", ["tag", tag]);

  console.log(`已创建 commit 与 tag ${tag}`);

  if (args.push) {
    run("git", ["push", "origin", "HEAD"]);
    run("git", ["push", "origin", tag]);
    console.log("已推送分支与 tag，publish-desktop 将自动构建安装包。");
    return;
  }

  console.log("下一步推送以触发桌面端构建：");
  console.log(`  git push origin HEAD && git push origin ${tag}`);
  console.log("或直接：");
  console.log(`  bun run release ${args.version} --push`);
}

main();
