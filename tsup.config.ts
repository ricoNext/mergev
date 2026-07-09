import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli/index.ts"
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  dts: true,
  sourcemap: true,
  splitting: false,
  banner: {
    js: "#!/usr/bin/env node"
  },
  outExtension: () => ({ js: ".js" })
});
