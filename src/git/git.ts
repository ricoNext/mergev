import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import type { ConflictFile, GitOperation, StageBlobs, UnmergedFile, UnmergedStage } from "./types.js";
import { decodeUtf8Text, isLockfile } from "../text/index.js";

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

export async function runGit(args: string[], cwd: string): Promise<string> {
  const result = await execa("git", args, { cwd });
  return result.stdout;
}

async function runGitBytes(args: string[], cwd: string): Promise<Uint8Array> {
  const result = await execa("git", args, {
    cwd,
    encoding: "latin1",
    stripFinalNewline: false
  });
  return Buffer.from(result.stdout, "latin1");
}

export async function findRepoRoot(cwd: string): Promise<string> {
  try {
    return (await runGit(["rev-parse", "--show-toplevel"], cwd)).trim();
  } catch {
    throw new GitError("Not inside a Git repository.");
  }
}

async function gitPath(repoRoot: string, name: string): Promise<string> {
  const output = (await runGit(["rev-parse", "--git-path", name], repoRoot)).trim();
  return path.isAbsolute(output) ? output : path.join(repoRoot, output);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function detectGitOperation(repoRoot: string): Promise<GitOperation> {
  const checks: Array<[GitOperation, string[]]> = [
    ["merge", ["MERGE_HEAD"]],
    ["rebase", ["rebase-merge", "rebase-apply", "REBASE_HEAD"]],
    ["cherry-pick", ["CHERRY_PICK_HEAD"]],
    ["revert", ["REVERT_HEAD"]]
  ];

  for (const [operation, names] of checks) {
    for (const name of names) {
      if (await pathExists(await gitPath(repoRoot, name))) {
        return operation;
      }
    }
  }

  return "none";
}

function parseUnmergedLine(line: string): { stage: UnmergedStage; mode: string; oid: string; path: string } | undefined {
  const match = /^(\d{6}) ([0-9a-fA-F]+) ([123])\t(.+)$/.exec(line);
  if (!match) {
    return undefined;
  }

  return {
    mode: match[1],
    oid: match[2],
    stage: Number(match[3]) as UnmergedStage,
    path: match[4]
  };
}

export async function listUnmergedFiles(repoRoot: string): Promise<UnmergedFile[]> {
  const output = await runGit(["ls-files", "-u"], repoRoot);
  const byPath = new Map<string, UnmergedFile>();

  for (const line of output.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }

    const parsed = parseUnmergedLine(line);
    if (!parsed) {
      continue;
    }

    const file = byPath.get(parsed.path) ?? { path: parsed.path, stages: {} };
    file.stages[parsed.stage] = parsed;
    byPath.set(parsed.path, file);
  }

  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function isModifyModify(file: UnmergedFile): boolean {
  return Boolean(file.stages[1] && file.stages[2] && file.stages[3]);
}

export async function readStageBlobs(repoRoot: string, file: UnmergedFile): Promise<StageBlobs> {
  const base = file.stages[1];
  const ours = file.stages[2];
  const theirs = file.stages[3];

  if (!base || !ours || !theirs) {
    throw new GitError(`Unsupported conflict shape for ${file.path}; expected stages 1, 2, and 3.`);
  }

  return {
    base: await runGitBytes(["cat-file", "-p", base.oid], repoRoot),
    ours: await runGitBytes(["cat-file", "-p", ours.oid], repoRoot),
    theirs: await runGitBytes(["cat-file", "-p", theirs.oid], repoRoot),
    oids: {
      base: base.oid,
      ours: ours.oid,
      theirs: theirs.oid
    }
  };
}

export async function checkBinaryAttr(repoRoot: string, filePath: string): Promise<boolean> {
  const output = await runGit(["check-attr", "binary", "--", filePath], repoRoot);
  return output.trim().endsWith(": binary: set");
}

export async function listConflictFiles(repoRoot: string): Promise<ConflictFile[]> {
  const operation = await detectGitOperation(repoRoot);
  const files = await listUnmergedFiles(repoRoot);

  return Promise.all(
    files.map(async (file) => {
      const lockfile = isLockfile(file.path);

      if (!isModifyModify(file)) {
        return {
          ...file,
          operation,
          supported: false,
          reason: "unsupported conflict shape",
          isLockfile: lockfile
        };
      }

      if (await checkBinaryAttr(repoRoot, file.path)) {
        return {
          ...file,
          operation,
          supported: false,
          reason: "marked binary by git attributes",
          isLockfile: lockfile
        };
      }

      try {
        const blobs = await readStageBlobs(repoRoot, file);
        for (const bytes of [blobs.base, blobs.ours, blobs.theirs]) {
          const decoded = decodeUtf8Text(bytes);
          if (!decoded.ok) {
            return {
              ...file,
              operation,
              supported: false,
              reason: decoded.reason === "binary" ? "binary content" : "invalid UTF-8",
              isLockfile: lockfile
            };
          }
        }
      } catch (error) {
        return {
          ...file,
          operation,
          supported: false,
          reason: error instanceof Error ? error.message : "unable to read staged blobs",
          isLockfile: lockfile
        };
      }

      return {
        ...file,
        operation,
        supported: true,
        isLockfile: lockfile
      };
    })
  );
}

export async function assertStagesUnchanged(repoRoot: string, file: UnmergedFile): Promise<void> {
  const current = (await listUnmergedFiles(repoRoot)).find((entry) => entry.path === file.path);
  if (!current) {
    throw new GitError(`${file.path} is no longer unmerged.`);
  }

  for (const stage of [1, 2, 3] as const) {
    if (current.stages[stage]?.oid !== file.stages[stage]?.oid) {
      throw new GitError(`${file.path} changed in Git stages after it was opened.`);
    }
  }
}

export async function gitAdd(repoRoot: string, filePath: string): Promise<void> {
  await runGit(["add", "--", filePath], repoRoot);
}

export function nextCommandForOperation(operation: GitOperation): string | undefined {
  switch (operation) {
    case "merge":
      return "git merge --continue";
    case "rebase":
      return "git rebase --continue";
    case "cherry-pick":
      return "git cherry-pick --continue";
    case "revert":
      return "git revert --continue";
    case "none":
      return undefined;
  }
}
