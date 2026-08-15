import { build as esbuild } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const dependency = (name) => join(root, "node_modules", name);
const mergeUiSource = join(root, "../../packages/merge-ui/src");

export const build = (async () => {
  await Promise.all([
    rm("dist", { recursive: true, force: true }),
    rm("media/assets", { recursive: true, force: true }),
    rm("media/chunks", { recursive: true, force: true }),
    rm("media/merge-webview.js", { force: true }),
    rm("media/merge-webview.js.map", { force: true }),
    rm("media/merge-webview.css", { force: true }),
    rm("media/merge-webview.css.map", { force: true }),
  ]);
  await mkdir("dist", { recursive: true });
  await mkdir("media", { recursive: true });
  const [, webviewResult] = await Promise.all([
    esbuild({ entryPoints: ["src/extension.ts"], bundle: true, platform: "node", format: "cjs", outfile: "dist/extension.js", external: ["vscode"], sourcemap: false }),
    esbuild({
      entryPoints: ["src/webview.tsx"],
      bundle: true,
      platform: "browser",
      format: "iife",
      outdir: "media",
      entryNames: "merge-webview",
      assetNames: "assets/[name]-[hash]",
      splitting: false,
      sourcemap: false,
      metafile: true,
      alias: {
		"@mergev/merge-ui": mergeUiSource,
        react: dependency("react"),
        "react-dom": dependency("react-dom"),
      },
    }),
  ]);
  const reactImplementations = Object.keys(webviewResult.metafile.inputs).filter(
    (input) => /node_modules\/react\/cjs\/react\.(development|production)\.js$/.test(input),
  );
  if (reactImplementations.length !== 1) {
    throw new Error(`Webview 必须只包含一份 React，当前为 ${reactImplementations.length} 份`);
  }
  return true;
})();
await build;
