import { mkdir, cp } from "node:fs/promises";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const host = platform();
const targets = [
  { rust: "aarch64-apple-darwin", folder: "darwin-arm64", binary: "mergev-sidecar" },
  { rust: "x86_64-apple-darwin", folder: "darwin-x64", binary: "mergev-sidecar" },
  { rust: "x86_64-pc-windows-msvc", folder: "win32-x64", binary: "mergev-sidecar.exe" },
  { rust: "aarch64-pc-windows-msvc", folder: "win32-arm64", binary: "mergev-sidecar.exe" },
  // Linux 使用 musl 静态链接：免疫远端服务器 glibc 版本差异（Remote SSH 场景）
  { rust: "x86_64-unknown-linux-musl", folder: "linux-x64", binary: "mergev-sidecar" },
  { rust: "aarch64-unknown-linux-musl", folder: "linux-arm64", binary: "mergev-sidecar" },
];

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} 退出码 ${code}`));
    });
  });
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      const output = Buffer.concat(chunks).toString("utf8");
      if (code === 0) resolve(output);
      else reject(new Error(output.trim() || `${command} 退出码 ${code}`));
    });
  });
}

function isWindowsTarget(rust) {
  return rust.includes("windows");
}

async function installedTargets() {
  const output = await capture("rustup", ["target", "list", "--installed"]);
  return new Set(output.split("\n").map((line) => line.trim()).filter(Boolean));
}

async function hasCargoXwin() {
  try {
    await capture("cargo", ["xwin", "--version"]);
    return true;
  } catch {
    return false;
  }
}

const installed = await installedTargets();
const needsXwin = host !== "win32" && targets.some((target) => isWindowsTarget(target.rust));
if (needsXwin && !(await hasCargoXwin())) {
  throw new Error("构建 Windows sidecar 需要 cargo-xwin。请先执行: cargo install cargo-xwin");
}

function isLinuxMuslTarget(rust) {
  return rust.endsWith("linux-musl");
}

for (const target of targets) {
  if (!installed.has(target.rust)) {
    await run("rustup", ["target", "add", target.rust]);
  }
  let args;
  if (isWindowsTarget(target.rust) && host !== "win32") {
    args = ["xwin", "build", "--release", "--target", target.rust, "--target-dir", "sidecar/target", "--manifest-path", "sidecar/Cargo.toml"];
  } else {
    args = ["build", "--release", "--target", target.rust, "--target-dir", "sidecar/target", "--manifest-path", "sidecar/Cargo.toml"];
    // musl 交叉编译用 Rust 自带的 rust-lld 链接；不能用 .cargo/config.toml，
    // 因为该脚本以 apps/vscode 为 cwd，cargo 不会发现 sidecar/.cargo/ 下的配置。
    if (isLinuxMuslTarget(target.rust)) {
      args.push("--config", `target.${target.rust}.linker="rust-lld"`);
    }
  }
  await run("cargo", args);
  const destination = join(root, "bin", target.folder);
  await mkdir(destination, { recursive: true });
  await cp(
    join(root, "sidecar", "target", target.rust, "release", target.binary),
    join(destination, target.binary),
  );
}

console.log("已构建 macOS、Windows 与 Linux sidecar");
