import { build } from "./build.mjs";
import { readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
await build;
const root = fileURLToPath(new URL(".", import.meta.url));
const extensionManifest = JSON.parse(
	await readFile(`${root}package.json`, "utf8"),
);
const output = `${root}${extensionManifest.name}-${extensionManifest.version}.vsix`;
await rm(output, { force: true });
await exec(
	`${root}node_modules/.bin/vsce`,
	["package", "--no-dependencies", "--out", output],
	{ cwd: root },
);
console.log(`已生成 ${output}`);
