import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { detectGitOperation, findRepoRoot, gitAdd, listConflictFiles, readStageBlobs } from "../../src/git/index.js";
import { openMergeFile, saveResolvedFile } from "../../src/app/index.js";

async function git(cwd: string, args: string[]) {
  return execa("git", args, { cwd });
}

type ConflictContent = {
  base: string | Uint8Array;
  ours: string | Uint8Array;
  theirs: string | Uint8Array;
  filePath?: string;
};

async function makeConflictRepo(content: ConflictContent = {
  base: "a\nbase\nc\n",
  ours: "a\nours\nc\n",
  theirs: "a\ntheirs\nc\n",
  filePath: "file.txt"
}): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "mergev-test-"));
  const filePath = content.filePath ?? "file.txt";
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Mergev Test"]);
  await writeFile(path.join(repo, filePath), content.base);
  await git(repo, ["add", filePath]);
  await git(repo, ["commit", "-m", "base"]);
  await git(repo, ["checkout", "-b", "feature"]);
  await writeFile(path.join(repo, filePath), content.theirs);
  await git(repo, ["add", filePath]);
  await git(repo, ["commit", "-m", "feature"]);
  await git(repo, ["checkout", "main"]).catch(async () => {
    await git(repo, ["checkout", "master"]);
  });
  await writeFile(path.join(repo, filePath), content.ours);
  await git(repo, ["add", filePath]);
  await git(repo, ["commit", "-m", "main"]);
  await git(repo, ["merge", "feature"]).catch(() => undefined);
  return repo;
}

describe("git integration", () => {
  it("finds modify/modify conflicts and reads stage blobs", async () => {
    const repo = await makeConflictRepo();
    await expect(findRepoRoot(repo)).resolves.toBe(realpathSync(repo));
    await expect(detectGitOperation(repo)).resolves.toBe("merge");

    const files = await listConflictFiles(repo);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("file.txt");
    expect(files[0].supported).toBe(true);

    const blobs = await readStageBlobs(repo, files[0]);
    expect(Buffer.from(blobs.ours).toString("utf8")).toContain("ours");
    expect(Buffer.from(blobs.theirs).toString("utf8")).toContain("theirs");
  });

  it("saves resolved content and stages the file", async () => {
    const repo = await makeConflictRepo();
    const files = await listConflictFiles(repo);
    const opened = await openMergeFile(repo, files[0]);
    opened.model.chooseCurrent("ours");

    const result = await saveResolvedFile(repo, opened.file, opened.model);
    expect(result.ok).toBe(true);

    const remaining = await listConflictFiles(repo);
    expect(remaining).toHaveLength(0);
  });

  it("marks binary and invalid utf8 staged blobs as unsupported", async () => {
    const binaryRepo = await makeConflictRepo({
      filePath: "binary.dat",
      base: Buffer.from([0x61, 0x00, 0x62]),
      ours: Buffer.from([0x61, 0x00, 0x6f]),
      theirs: Buffer.from([0x61, 0x00, 0x74])
    });
    const binaryFiles = await listConflictFiles(binaryRepo);
    expect(binaryFiles[0].supported).toBe(false);
    expect(binaryFiles[0].reason).toMatch(/binary/);

    const invalidRepo = await makeConflictRepo({
      filePath: "invalid.txt",
      base: Buffer.from([0x61, 0x0a]),
      ours: Buffer.from([0xff, 0x0a]),
      theirs: Buffer.from([0xfe, 0x0a])
    });
    const invalidFiles = await listConflictFiles(invalidRepo);
    expect(invalidFiles[0].supported).toBe(false);
    expect(invalidFiles[0].reason).toBe("invalid UTF-8");
  });

  it("writes but does not stage when built-in validation fails", async () => {
    const repo = await makeConflictRepo({
      filePath: "package.json",
      base: "{\"name\":\"base\"}\n",
      ours: "{\"name\":\"ours\"}\n",
      theirs: "{\"name\":\"theirs\"}\n"
    });
    const files = await listConflictFiles(repo);
    const opened = await openMergeFile(repo, files[0]);
    opened.model.setManual(opened.model.currentConflict?.id ?? 1, "{");

    const result = await saveResolvedFile(repo, opened.file, opened.model);
    expect(result.ok).toBe(false);
    expect(await readFile(path.join(repo, "package.json"), "utf8")).toBe("{");
    expect(await listConflictFiles(repo)).toHaveLength(1);
  });

  it("honors noAdd unless forceAdd is requested", async () => {
    const repo = await makeConflictRepo();
    const files = await listConflictFiles(repo);
    const opened = await openMergeFile(repo, files[0]);
    opened.model.chooseCurrent("ours");

    const noAdd = await saveResolvedFile(repo, opened.file, opened.model, { noAdd: true });
    expect(noAdd.ok).toBe(true);
    expect(await listConflictFiles(repo)).toHaveLength(1);

    const forceAdd = await saveResolvedFile(repo, opened.file, opened.model, { noAdd: true, forceAdd: true });
    expect(forceAdd.ok).toBe(true);
    expect(await listConflictFiles(repo)).toHaveLength(0);
  });

  it("refuses to save after conflict stages change externally", async () => {
    const repo = await makeConflictRepo();
    const files = await listConflictFiles(repo);
    const opened = await openMergeFile(repo, files[0]);
    opened.model.chooseCurrent("ours");
    await git(repo, ["add", "file.txt"]);

    const result = await saveResolvedFile(repo, opened.file, opened.model);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toMatch(/no longer unmerged/);
  });
});
