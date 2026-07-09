# AGENTS

## Cursor Cloud specific instructions

### Overview

`mergev` is a terminal Git merge-conflict resolver (Node.js + TypeScript CLI with
an Ink three-pane TUI). The implemented application currently lives on the
`test/ink-cli` branch; the `main` branch holds only `docs/` and a skeleton
`package.json` with no source or dependencies.

### Toolchain

- Package manager / dev runner: **bun** (installed at `~/.bun/bin`, already on
  `PATH` via `~/.bashrc`).
- User runtime: **Node.js >= 20** (the VM has Node 22).
- Stack: TypeScript (ESM), Ink + React (TUI), commander (CLI), execa (git),
  node-diff3 (merge model), tsup (build), tsx (dev), vitest (tests).

### Commands (run where the app code exists, e.g. `test/ink-cli`)

Standard scripts are defined in `package.json`:

- Install dependencies: `bun install`
- Dev run: `bun run dev` (runs `tsx src/cli/index.ts`)
- Lint / typecheck: `bun run typecheck` (runs `tsc --noEmit`; there is no
  separate ESLint config, so typecheck is the lint gate)
- Tests: `bun run test` (runs `vitest run`)
- Build: `bun run build` (runs `tsup`, emits `dist/cli.js`)

### Non-obvious caveats

- The git integration tests in `tests/git/git.test.ts` spawn many real `git`
  subprocesses in temporary repos and are slow in this sandbox (individual tests
  can take 8-21s). The default per-test timeout can produce a spurious timeout
  on the `honors noAdd unless forceAdd is requested` case. Re-run those tests
  with a higher timeout when needed: `bunx vitest run tests/git/git.test.ts
  --testTimeout=60000`. The non-git test files are fast.
- The interactive TUI requires a real TTY. In non-interactive contexts use
  `mergev --list` or `mergev --porcelain`. To drive the TUI headlessly, run it
  inside `tmux` (which provides a pty); the three-pane layout needs a terminal
  width of >= 120 columns (80-119 renders two-pane, < 80 renders single-pane).
- To run the CLI against a repository, invoke it from inside that repository
  (it resolves the repo root from the current working directory).
