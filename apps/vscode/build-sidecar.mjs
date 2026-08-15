import { mkdir, cp } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL(".", import.meta.url));
const targets = [
  ["aarch64-apple-darwin", "darwin-arm64"],
  ["x86_64-apple-darwin", "darwin-x64"],
];

for (const [target, folder] of targets) {
  await exec("cargo", [
    "build",
    "--release",
    "--target",
    target,
    "--target-dir",
    "sidecar/target",
    "--manifest-path",
    "sidecar/Cargo.toml",
  ], { cwd: root });
  const destination = join(root, "bin", folder);
  await mkdir(destination, { recursive: true });
  await cp(
    join(root, "sidecar", "target", target, "release", "mergev-sidecar"),
    join(destination, "mergev-sidecar"),
  );
}

console.log("已构建 macOS Intel 与 Apple Silicon sidecar");
