import { Command, InvalidArgumentError } from "commander";
import React from "react";
import { render } from "ink";
import { findRepoRoot, listConflictFiles, nextCommandForOperation, type ConflictFile } from "../git/index.js";
import { normalizeMode, type CliOptions, type LayoutMode } from "../config/index.js";
import { MergevApp } from "../ui/index.js";

const VERSION = "0.1.0";
const DESCRIPTION = "Terminal merge conflict resolver with a three-pane visual workflow.";

function parseMode(value: string): LayoutMode {
  const mode = normalizeMode(value);
  if (!mode) {
    throw new InvalidArgumentError("Expected one of: three-pane, two-pane, result.");
  }

  return mode;
}

function formatConflict(file: ConflictFile): string {
  const status = "unmerged";
  const count = file.conflictCount ?? "-";
  const supported = file.supported ? "supported" : `unsupported: ${file.reason ?? "unknown"}`;
  const lockfile = file.isLockfile ? " lockfile" : "";
  return `${file.path}  ${status}  ${count}  ${supported}${lockfile}`;
}

function formatPorcelain(file: ConflictFile): string {
  return [file.path, "unmerged", file.conflictCount ?? "-", String(file.supported), String(file.isLockfile)].join("\t");
}

async function listFiles(repoRoot: string, porcelain: boolean): Promise<void> {
  const operation = await import("../git/index.js").then((module) => module.detectGitOperation(repoRoot));
  const files = await listConflictFiles(repoRoot);

  if (porcelain) {
    for (const file of files) {
      console.log(formatPorcelain(file));
    }
    return;
  }

  console.log(`Git operation: ${operation}`);
  if (files.length === 0) {
    console.log("No unmerged files.");
    return;
  }

  for (const file of files) {
    console.log(formatConflict(file));
  }
}

async function run(): Promise<void> {
  const program = new Command();

  program
    .name("mergev")
    .description(DESCRIPTION)
    .version(VERSION)
    .argument("[path]", "Open a specific conflicted file")
    .option("--list", "List conflicted files without starting the TUI")
    .option("--porcelain", "Use script-friendly output with --list")
    .option("--check <command>", "Run a shell command after writing and before git add")
    .option("--no-add", "Do not run git add on normal save")
    .option("--all", "Open the next supported file after each successful save")
    .option("--mode <mode>", "Force layout mode: three-pane, two-pane, result", parseMode)
    .option("--editor <command>", "Editor command for manual conflict editing")
    .option("--debug", "Print debug details on errors")
    .action(async (filePath: string | undefined, options: CliOptions) => {
      const repoRoot = await findRepoRoot(process.cwd());

      if (options.list || options.porcelain) {
        await listFiles(repoRoot, Boolean(options.porcelain));
        return;
      }

      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error("Mergev TUI requires a TTY. Use --list or --porcelain in non-interactive contexts.");
      }

      const files = await listConflictFiles(repoRoot);
      if (files.length === 0) {
        console.log("No unmerged files.");
        return;
      }

      if (filePath && !files.some((file) => file.path === filePath)) {
        throw new Error(`${filePath} is not an unmerged file.`);
      }

      render(React.createElement(MergevApp, { repoRoot, files, initialPath: filePath, options }));
    });

  await program.parseAsync(process.argv);
}

run().catch((error) => {
  const debug = process.argv.includes("--debug");
  console.error(error instanceof Error ? error.message : String(error));
  if (debug && error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exitCode = 1;
});
