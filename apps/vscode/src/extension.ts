import * as vscode from "vscode";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";

type WorkspaceSnapshot = { root: string; repoName: string; branch: string; operation: string; headline: string; files: Array<{ path: string; fileName: string; directory: string; conflictCount: number | null; oursStatus: string; theirsStatus: string; staged: boolean }> };
type ConflictFile = WorkspaceSnapshot["files"][number];
type RepoInfo = { root: string; name: string; snapshot?: WorkspaceSnapshot };
type RpcResponse = { id: number; ok: boolean; result?: unknown; error?: string };
type ScmResourceState = { resourceUri?: vscode.Uri };

class SidecarClient implements vscode.Disposable {
  private process: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private buffer = "";

  constructor(private readonly context: vscode.ExtensionContext) {}

  start() {
    if (this.process) return;
    if (vscode.env.remoteName) throw new Error("mergev 第一版仅支持本地工作区，暂不支持 Remote SSH、WSL 或 Dev Container。");
    if (process.platform !== "darwin") throw new Error("mergev VS Code 插件第一版仅支持 macOS。");
    const configured = vscode.workspace.getConfiguration("mergev").get<string>("sidecarPath", "");
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const bundled = path.join(this.context.extensionPath, "bin", `darwin-${arch}`, "mergev-sidecar");
    const executable = configured || bundled;
    const gitPath = vscode.workspace.getConfiguration("mergev").get<string>("gitPath", "");
    this.process = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...(gitPath ? { MERGEV_GIT_PATH: gitPath } : {}) } });
    this.process.stdout.on("data", (chunk: Buffer) => this.onData(chunk.toString("utf8")));
    this.process.stderr.on("data", (chunk: Buffer) => console.error(`[mergev] ${chunk.toString("utf8")}`));
    this.process.on("error", (error) => this.failAll(new Error(`无法启动 mergev sidecar: ${error.message}。请检查 Git 和 sidecar 路径。`)));
    this.process.on("exit", () => { this.process = undefined; this.failAll(new Error("mergev sidecar 已退出，请重试。")); });
  }

  async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    this.start();
    if (!this.process?.stdin.writable) throw new Error("mergev sidecar 未运行，请检查安装包中的 sidecar。");
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.process.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return promise as Promise<T>;
  }

  private onData(data: string) {
    this.buffer += data;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let response: RpcResponse;
      try { response = JSON.parse(line) as RpcResponse; } catch { continue; }
      const request = this.pending.get(response.id);
      if (!request) continue;
      this.pending.delete(response.id);
      response.ok ? request.resolve(response.result) : request.reject(new Error(response.error || "sidecar 请求失败"));
    }
  }

  private failAll(error: Error) { for (const request of this.pending.values()) request.reject(error); this.pending.clear(); }
  dispose() { this.failAll(new Error("mergev sidecar 已关闭")); this.process?.kill(); this.process = undefined; }
}

class MessageNode extends vscode.TreeItem {
  constructor(label: string, contextValue: string, command?: vscode.Command) { super(label); this.contextValue = contextValue; this.command = command; this.iconPath = new vscode.ThemeIcon("info"); }
}

class RepositoryNode extends vscode.TreeItem {
  readonly contextValue = "mergev.repository";
  constructor(readonly repo: RepoInfo) { super(repo.name, vscode.TreeItemCollapsibleState.Collapsed); this.description = "未加载"; this.tooltip = repo.root; this.iconPath = new vscode.ThemeIcon("repo"); }
}

class ConflictFileNode extends vscode.TreeItem {
  readonly contextValue = "mergev.conflictFile";
  constructor(readonly repository: RepoInfo, readonly file: ConflictFile) {
    super(file.fileName || path.basename(file.path), vscode.TreeItemCollapsibleState.None);
    this.description = file.directory || undefined;
    const count = file.conflictCount == null ? "冲突块数量未计算" : `${file.conflictCount} 个冲突块`;
    const status = (value: string) => value === "deleted" ? "已删除" : "已修改";
    this.tooltip = `${repository.name} / ${file.path}\n当前：${status(file.oursStatus)} · 对方：${status(file.theirsStatus)} · ${count}`;
    this.iconPath = new vscode.ThemeIcon("warning");
    this.command = { command: "mergev.openConflict", title: "使用 mergev 打开", arguments: [this] };
  }
}

class RepositoryErrorNode extends MessageNode { constructor(readonly repository: RepositoryNode, error: string) { super(`加载失败：${error}`, "mergev.repositoryError", { command: "mergev.retryRepository", title: "重试", arguments: [repository] }); this.iconPath = new vscode.ThemeIcon("error"); } }

class ConflictTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private roots: RepositoryNode[];
  constructor(private readonly sidecar: SidecarClient) { this.roots = this.readRoots(); }
  private readRoots() { return (vscode.workspace.workspaceFolders ?? []).map((folder) => new RepositoryNode({ root: folder.uri.fsPath, name: folder.name })); }
  getTreeItem(element: vscode.TreeItem) { return element; }
  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!element) {
      if (!vscode.workspace.workspaceFolders?.length) return [new MessageNode("请先打开项目", "mergev.noWorkspace", { command: "vscode.openFolder", title: "打开项目" })];
      return this.roots;
    }
    if (!(element instanceof RepositoryNode)) return [];
    const repo = element.repo;
    try {
      const snapshot = await this.sidecar.call<WorkspaceSnapshot>("getRepositoryWorkspace", { root: repo.root });
      repo.snapshot = snapshot;
      const operation = ({ none: "无进行中的操作", merge: "合并", rebase: "变基", cherryPick: "拣选提交", revert: "撤销提交" } as Record<string, string>)[snapshot.operation] ?? snapshot.operation;
      element.description = `${snapshot.branch} · ${operation}`;
      element.tooltip = `${repo.root}\n${snapshot.headline}`;
      const files = [...snapshot.files].sort((a, b) => a.fileName.localeCompare(b.fileName) || a.directory.localeCompare(b.directory));
      return files.length ? files.map((file) => new ConflictFileNode(repo, file)) : [new MessageNode("当前没有待解决的冲突", "mergev.noConflicts")];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/不是 Git 仓库|not a git repository/i.test(message)) return [new MessageNode("当前项目没有 Git 仓库", "mergev.noGit", { command: "vscode.openFolder", title: "打开项目" })];
      return [new RepositoryErrorNode(element, message)];
    }
  }
  refresh(repo?: RepoInfo) {
    if (!repo) { this.changed.fire(undefined); return; }
    repo.snapshot = undefined;
    const node = this.roots.find((item) => item.repo.root === repo.root);
    if (node) { node.description = "未加载"; node.tooltip = repo.root; this.changed.fire(node); }
  }
  reopen() { this.roots = this.readRoots(); this.changed.fire(undefined); }
  dispose() { this.changed.dispose(); }
  getRepositories() { return this.roots.map((node) => node.repo); }
}

function documentParts(uri: vscode.Uri) { const query = new URLSearchParams(uri.query); return { root: query.get("root") || "", path: query.get("path") || "" }; }
function documentUri(root: string, filePath: string) { return vscode.Uri.parse(`mergev:/document.mergev?root=${encodeURIComponent(root)}&path=${encodeURIComponent(filePath)}`); }

class MergeEditorProvider implements vscode.CustomReadonlyEditorProvider<vscode.CustomDocument>, vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly dirty = new Set<string>();
  constructor(private readonly context: vscode.ExtensionContext, private readonly sidecar: SidecarClient, private readonly tree: ConflictTreeProvider) {}
  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument { return { uri, dispose() {} }; }
  async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel) {
    const key = document.uri.toString(); this.panels.set(key, panel);
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")] };
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage(async (message) => {
      const parts = documentParts(document.uri);
      try {
        if (message.type === "ready" || message.type === "reload") await this.load(document.uri, panel);
        if (message.type === "dirty") {
          if (message.dirty === false) this.dirty.delete(key); else this.dirty.add(key);
        }
        if (message.type === "confirm") {
          const options = message.options || {};
          const answer = await vscode.window.showWarningMessage(String(message.message || "确认执行此操作？"), { modal: true }, String(options.okLabel || "确认"));
          panel.webview.postMessage({ type: "response", requestId: message.requestId, ok: true, result: answer === String(options.okLabel || "确认") });
        }
        if (message.type === "apply") {
          await this.sidecar.call("saveMergeResult", { repoRoot: parts.root, path: parts.path, result: message.result, stage: true });
          this.dirty.delete(key); await this.load(document.uri, panel); this.tree.refresh();
          panel.webview.postMessage({ type: "response", requestId: message.requestId, ok: true, result: true });
        }
      } catch (error) {
        if (message.requestId !== undefined) panel.webview.postMessage({ type: "response", requestId: message.requestId, ok: false, error: error instanceof Error ? error.message : String(error) });
        else panel.webview.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    });
    panel.onDidDispose(() => { this.panels.delete(key); this.dirty.delete(key); });
    await this.load(document.uri, panel);
  }
  async open(root: string, filePath: string) { await vscode.commands.executeCommand("vscode.openWith", documentUri(root, filePath), "mergev.mergeEditor"); }
  async accept(node: ConflictFileNode, side: "ours" | "theirs") {
    const uri = documentUri(node.repository.root, node.file.path); const key = uri.toString();
    if (this.dirty.has(key)) { const answer = await vscode.window.showWarningMessage("当前 Tab 有未保存的操作，是否丢弃并执行整文件 Accept？", { modal: true }, "确认"); if (answer !== "确认") return; }
    await this.sidecar.call("acceptFileSide", { repoRoot: node.repository.root, path: node.file.path, side });
    this.dirty.delete(key); const panel = this.panels.get(key); if (panel) await this.load(uri, panel); this.tree.refresh(node.repository);
  }
  async reloadRepository(root: string) { for (const [key, panel] of this.panels) { const uri = vscode.Uri.parse(key); const parts = documentParts(uri); if (parts.root === root) await this.load(uri, panel); } }
  private async load(uri: vscode.Uri, panel: vscode.WebviewPanel) {
    const parts = documentParts(uri);
    this.dirty.delete(uri.toString());
    try {
      const document = await this.sidecar.call("getMergeDocument", { repoRoot: parts.root, path: parts.path });
      panel.title = `mergev: ${vscode.workspace.getWorkspaceFolder(vscode.Uri.file(parts.root))?.name || path.basename(parts.root)} / ${parts.path}`;
      panel.webview.postMessage({ type: "document", document, repoRoot: parts.root, repoName: vscode.workspace.getWorkspaceFolder(vscode.Uri.file(parts.root))?.name || path.basename(parts.root) });
    } catch (error) {
      const snapshot = await this.sidecar.call<WorkspaceSnapshot>("getRepositoryWorkspace", { root: parts.root }).catch(() => undefined);
      if (snapshot && !snapshot.files.some((file) => file.path === parts.path)) {
        panel.title = `mergev: ${snapshot.repoName} / ${parts.path}`;
        panel.webview.postMessage({ type: "resolved", path: parts.path });
        return;
      }
      throw error;
    }
  }
  private html(webview: vscode.Webview) {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "merge-webview.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "merge-webview.css"));
    const nonce = String(Date.now());
    return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}">
  <link rel="stylesheet" href="${style}">
</head>
<body>
  <div id="root"><div class="screen"><p>正在加载文件…</p></div></div>
  <script nonce="${nonce}">
    const showMergevError = (error) => {
      const root = document.getElementById("root");
      root.innerHTML = '<div class="screen"><strong>Webview 加载失败</strong><pre class="error" id="mergev-error"></pre></div>';
      document.getElementById("mergev-error").textContent =
        error instanceof Error ? error.stack || error.message : String(error);
    };
    window.addEventListener("error", (event) => showMergevError(event.error || event.message));
    window.addEventListener("unhandledrejection", (event) => showMergevError(event.reason));
    const entry = document.createElement("script");
    entry.src = ${JSON.stringify(script.toString())};
    entry.nonce = ${JSON.stringify(nonce)};
    entry.addEventListener("error", () => showMergevError("无法加载 merge-webview.js"));
    document.body.appendChild(entry);
  </script>
</body>
</html>`;
  }
  dispose() { this.panels.clear(); this.dirty.clear(); }
}

export function activate(context: vscode.ExtensionContext) {
  const sidecar = new SidecarClient(context); const tree = new ConflictTreeProvider(sidecar); const editor = new MergeEditorProvider(context, sidecar, tree);
  const treeView = vscode.window.createTreeView("mergev.conflicts", { treeDataProvider: tree, showCollapseAll: false });
  context.subscriptions.push(sidecar, tree, editor, treeView, vscode.window.registerCustomEditorProvider("mergev.mergeEditor", editor, { supportsMultipleEditorsPerDocument: false }));
  context.subscriptions.push(treeView.onDidChangeVisibility(({ visible }) => { if (visible) tree.reopen(); }));
  context.subscriptions.push(vscode.commands.registerCommand("mergev.openConflict", async (argument?: ConflictFileNode | ScmResourceState | vscode.Uri) => {
    if (argument instanceof ConflictFileNode) return editor.open(argument.repository.root, argument.file.path);
    const uri = argument instanceof vscode.Uri ? argument : argument?.resourceUri;
    if (!uri) return;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder) return editor.open(folder.uri.fsPath, path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join("/"));
  }));
  context.subscriptions.push(vscode.commands.registerCommand("mergev.refreshRepository", async (node?: RepositoryNode) => { if (node instanceof RepositoryNode) { tree.refresh(node.repo); await editor.reloadRepository(node.repo.root); } }));
  context.subscriptions.push(vscode.commands.registerCommand("mergev.retryRepository", (node: RepositoryNode) => node && tree.refresh(node.repo)));
  context.subscriptions.push(vscode.commands.registerCommand("mergev.copyPath", async (node: RepositoryNode) => { if (node?.repo) await vscode.env.clipboard.writeText(node.repo.root); }));
  context.subscriptions.push(vscode.commands.registerCommand("mergev.copyBranch", async (node: RepositoryNode) => { if (node?.repo.snapshot) await vscode.env.clipboard.writeText(node.repo.snapshot.branch); }));
  context.subscriptions.push(vscode.commands.registerCommand("mergev.openTerminal", (node: RepositoryNode) => { if (node?.repo) vscode.window.createTerminal({ cwd: node.repo.root }).show(); }));
  context.subscriptions.push(vscode.commands.registerCommand("mergev.acceptYours", (node: ConflictFileNode) => node && editor.accept(node, "ours")));
  context.subscriptions.push(vscode.commands.registerCommand("mergev.acceptTheirs", (node: ConflictFileNode) => node && editor.accept(node, "theirs")));
}

export function deactivate() {}
