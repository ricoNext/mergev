#!/usr/bin/env node
// mergev-mcp 端到端冒烟测试（无需安装 Zed，模拟 MCP 客户端）。
// 用法: node scripts/test-mcp.mjs [path/to/mergev-mcp]
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binary =
  process.argv[2] ??
  join(import.meta.dirname, "..", "..", "..", "target", "release", "mergev-mcp");

const repo = mkdtempSync(join(tmpdir(), "mergev-mcp-test-"));
const git = (cmd) => execSync(`git ${cmd}`, { cwd: repo, encoding: "utf8" }).trim();

// 1. 制造一个真实的 merge 冲突
git("init -b main");
git('config user.email t@t && git config user.name t');
writeFileSync(join(repo, "hello.txt"), "line1\nline2\nline3\n");
git("add . && git commit -m base");
git("checkout -b feature");
writeFileSync(join(repo, "hello.txt"), "line1\nFEATURE\nline3\n");
git("add . && git commit -m feature");
git("checkout main");
writeFileSync(join(repo, "hello.txt"), "line1\nMAIN\nline3\n");
git("add . && git commit -m main");
try {
  git("merge feature");
} catch {
  // 预期冲突
}

const proc = spawn(binary, [], { stdio: ["pipe", "pipe", "inherit"] });
let nextId = 1;
const pending = new Map();
let buffer = "";
proc.stdout.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});

const call = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => reject(new Error(`超时: ${method}`)), 10_000);
  });

const notify = (method, params) =>
  proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);

const expect = (label, condition, detail = "") => {
  console.log(`${condition ? "PASS" : "FAIL"}: ${label}${detail ? ` (${detail})` : ""}`);
  if (!condition) process.exitCode = 1;
};

// 2. MCP 握手 + 工具调用
const init = await call("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "mergev-test", version: "0.0.0" },
});
notify("notifications/initialized");
expect("initialize 返回 serverInfo", init?.result?.serverInfo?.name === "mergev-mcp");

const tools = await call("tools/list", {});
const toolNames = (tools?.result?.tools ?? []).map((tool) => tool.name);
expect(
  "tools/list 包含 4 个工具",
  ["mergev_workspace", "mergev_get_merge_document", "mergev_accept_file_side", "mergev_save_merge_result"].every((name) =>
    toolNames.includes(name),
  ),
  toolNames.join(", "),
);

const workspace = await call("tools/call", {
  name: "mergev_workspace",
  arguments: { root: repo },
});
const snapshot = JSON.parse(workspace?.result?.content?.[0]?.text ?? "{}");
expect(
  "mergev_workspace 识别 merge 操作 + 1 个冲突文件",
  snapshot.operation === "merge" && snapshot.files?.length === 1 && snapshot.files[0].path === "hello.txt",
  `operation=${snapshot.operation}, files=${snapshot.files?.length ?? 0}`,
);

const document = await call("tools/call", {
  name: "mergev_get_merge_document",
  arguments: { repoRoot: repo, path: "hello.txt" },
});
const mergeDocument = JSON.parse(document?.result?.content?.[0]?.text ?? "{}");
expect(
  "mergev_get_merge_document 返回三栏数据",
  mergeDocument.ours?.includes("MAIN") && mergeDocument.theirs?.includes("FEATURE"),
  `unresolved=${mergeDocument.unresolvedCount ?? "?"}`,
);

const accept = await call("tools/call", {
  name: "mergev_accept_file_side",
  arguments: { repoRoot: repo, path: "hello.txt", side: "ours" },
});
expect("mergev_accept_file_side 成功", accept?.result?.isError !== true, accept?.result?.content?.[0]?.text ?? "");

// 3. 验证 Git 状态：冲突已解决（无 unmerged 条目）、已暂存、且未越权提交
//    （accept ours 时暂存内容与 HEAD 相同，porcelain 为空是正确表现）
const unmerged = git("ls-files -u");
expect("冲突已解决并暂存（无 unmerged 条目）", unmerged === "", unmerged);
expect(
  "未越权提交（merge 仍进行中）",
  existsSync(join(repo, ".git", "MERGE_HEAD")),
);

const badPath = await call("tools/call", {
  name: "mergev_get_merge_document",
  arguments: { repoRoot: repo, path: "../escape.txt" },
});
expect("路径越界被拒绝", badPath?.result?.isError === true);

proc.kill();
rmSync(repo, { recursive: true, force: true });
console.log(process.exitCode ? "\n测试失败" : "\n全部通过");
