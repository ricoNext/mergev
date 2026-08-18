import { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import "@mergev/merge-ui/styles.css";
import { buildSessionFromDocument } from "@mergev/merge-ui/core/mergeSession";
import { MergeScreen, type MergeScreenRuntime } from "@mergev/merge-ui/screens/MergeScreen";
import { applyThemeToDOM } from "@mergev/merge-ui/theme";
import { updateSyntaxTheme } from "@mergev/merge-ui/syntaxHighlight";
import type { AppView, MergeDocument, WorkspaceSnapshot } from "@mergev/merge-ui/types";

type VsCodeApi = { postMessage: (message: unknown) => void };
declare function acquireVsCodeApi(): VsCodeApi;

type HostDocument = {
	document: MergeDocument;
	repoRoot: string;
	repoName: string;
};

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
};

const vscode = acquireVsCodeApi();
let nextRequestId = 1;
const pending = new Map<number, PendingRequest>();

function request<T>(type: string, payload: Record<string, unknown>): Promise<T> {
	const requestId = nextRequestId++;
	const promise = new Promise<unknown>((resolve, reject) => {
		pending.set(requestId, { resolve, reject });
	});
	vscode.postMessage({ type, requestId, ...payload });
	return promise as Promise<T>;
}

function workspaceFor(input: HostDocument): WorkspaceSnapshot {
	return {
		cwd: input.repoRoot,
		root: input.repoRoot,
		repoName: input.repoName,
		branch: "",
		operation: "none",
		oursLabel: input.document.labels.ours,
		theirsLabel: input.document.labels.theirs,
		headline: "",
		files: [],
		totalBlocks: null,
	};
}

function mergeViewFor(input: HostDocument): Extract<AppView, { kind: "merge" }> {
	return {
		kind: "merge",
		workspace: workspaceFor(input),
		selectedPath: input.document.path,
		session: buildSessionFromDocument(input.document),
		detailError: null,
		saving: false,
		saveError: null,
	};
}

function syncTheme() {
	const dark = document.body.classList.contains("vscode-dark") || document.body.classList.contains("vscode-high-contrast");
	const theme = dark ? "dark" : "light";
	applyThemeToDOM(theme);
	updateSyntaxTheme(theme);
}

function App() {
	const [view, setView] = useState<Extract<AppView, { kind: "merge" }> | null>(null);
	const [resolvedPath, setResolvedPath] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		syncTheme();
		const observer = new MutationObserver(syncTheme);
		observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		function onMessage(event: MessageEvent) {
			const message = event.data;
			if (message.type === "document") {
				setView(mergeViewFor(message as HostDocument & { type: "document" }));
				setResolvedPath(null);
				setError(null);
				return;
			}
			if (message.type === "resolved") {
				setView(null);
				setResolvedPath(String(message.path || ""));
				setError(null);
				return;
			}
			if (message.type === "error") {
				setError(String(message.message || "加载失败"));
				return;
			}
			if (message.type === "response") {
				const item = pending.get(Number(message.requestId));
				if (!item) return;
				pending.delete(Number(message.requestId));
				message.ok ? item.resolve(message.result) : item.reject(new Error(String(message.error || "操作失败")));
			}
		}
		window.addEventListener("message", onMessage);
		vscode.postMessage({ type: "ready" });
		return () => window.removeEventListener("message", onMessage);
	}, []);

	const runtime = useMemo<MergeScreenRuntime>(() => ({
		enableKeyboardShortcuts: false,
		enableHistoryShortcuts: true,
		saveMergeResult: async ({ result }) => {
			await request("apply", { result });
		},
		confirm: async (message, options) => request<boolean>("confirm", { message, options }),
		onDirtyChange: (dirty) => vscode.postMessage({ type: "dirty", dirty }),
	}), []);

	if (error) return <div className="screen"><p className="error">{error}</p><button type="button" onClick={() => vscode.postMessage({ type: "reload" })}>重试</button></div>;
	if (resolvedPath !== null) return <div className="screen"><strong>文件已在外部解决</strong><p className="muted">{resolvedPath}</p><button type="button" onClick={() => vscode.postMessage({ type: "reload" })}>重新加载结果</button></div>;
	if (!view) return <div className="screen"><p className="muted">正在加载文件…</p></div>;
	if (!view.session?.conflicts.length) return <div className="screen"><strong>文件已在外部解决</strong><p className="muted">{view.selectedPath}</p><button type="button" onClick={() => vscode.postMessage({ type: "reload" })}>重新加载结果</button></div>;

	return <MergeScreen
		view={view}
		onBack={() => vscode.postMessage({ type: "reload" })}
		onChangeView={(next) => { if (next.kind === "merge") setView(next); }}
		onSaved={() => undefined}
		runtime={runtime}
	/>;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
