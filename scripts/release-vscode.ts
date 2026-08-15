#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const packagePath = "apps/vscode/package.json";
const changelogPath = "apps/vscode/CHANGELOG.md";
const tagPrefix = "vscode-v";
const versionPattern = /^\d+\.\d+\.\d+$/;

type ReleaseArgs = {
	version: string;
	push: boolean;
	dryRun: boolean;
};

function fail(message: string): never {
	console.error(`错误: ${message}`);
	process.exit(1);
}

function run(command: string, args: string[], allowFailure = false): string {
	const result = spawnSync(command, args, {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0 && !allowFailure) {
		fail(`${command} ${args.join(" ")} 失败: ${(result.stderr || result.stdout).trim()}`);
	}
	return (result.stdout || "").trim();
}

function read(path: string): string {
	return readFileSync(join(root, path), "utf8");
}

function write(path: string, content: string): void {
	writeFileSync(join(root, path), content, "utf8");
}

function parseArgs(argv: string[]): ReleaseArgs {
	const flags = new Set(argv.filter((item) => item.startsWith("--")));
	const version = argv.find((item) => !item.startsWith("--"))?.replace(/^v/, "");
	if (!version || !versionPattern.test(version)) {
		fail("请传入 x.y.z 版本号，例如: bun run release:vscode 0.0.3");
	}
	return { version, push: flags.has("--push"), dryRun: flags.has("--dry-run") };
}

function releaseNotes(): string {
	const previousTag = run(
		"git",
		["describe", "--tags", "--abbrev=0", "--match", `${tagPrefix}*`],
		true,
	);
	const range = previousTag ? `${previousTag}..HEAD` : "HEAD";
	const subjects = run(
		"git",
		["log", range, "--pretty=format:%s", "--no-merges"],
		true,
	)
		.split("\n")
		.map((item) => item.trim())
		.filter(Boolean)
		.filter((item) => !/^chore\(vscode\): release/i.test(item));

	return subjects.length
		? subjects.map((item) => `- ${item}`).join("\n")
		: "- （请补充本版本变更）";
}

function updateFiles(version: string): void {
	const manifest = JSON.parse(read(packagePath)) as Record<string, unknown>;
	manifest.version = version;
	write(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);

	const changelog = read(changelogPath);
	if (changelog.includes(`## ${version} `)) {
		fail(`${changelogPath} 中已存在版本 ${version}`);
	}
	const date = new Date().toISOString().slice(0, 10);
	const entry = `## ${version} - ${date}\n\n### 变更\n\n${releaseNotes()}\n\n`;
	write(
		changelogPath,
		changelog.startsWith("# Changelog\n")
			? changelog.replace("# Changelog\n", `# Changelog\n\n${entry}`)
			: `${entry}${changelog}`,
	);
}

function main(): void {
	const args = parseArgs(process.argv.slice(2));
	const tag = `${tagPrefix}${args.version}`;
	if (!args.dryRun && run("git", ["status", "--porcelain"])) {
		fail("工作区不干净，请先提交或暂存其他改动");
	}
	if (run("git", ["tag", "-l", tag])) {
		fail(`本地已存在标签 ${tag}`);
	}

	const backups = new Map([
		[packagePath, read(packagePath)],
		[changelogPath, read(changelogPath)],
	]);
	updateFiles(args.version);

	if (args.dryRun) {
		for (const [path, content] of backups) write(path, content);
		console.log(`已验证 VS Code 插件发布 ${tag}`);
		return;
	}

	run("git", ["add", packagePath, changelogPath]);
	run("git", ["commit", "-m", `chore(vscode): release ${tag}`]);
	run("git", ["tag", tag]);
	if (args.push) {
		run("git", ["push", "origin", "HEAD"]);
		run("git", ["push", "origin", tag]);
	}
	console.log(`已创建 VS Code 插件发布 ${tag}`);
}

main();
