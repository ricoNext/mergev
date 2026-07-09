import type { ConflictFile, StageBlobs } from "../git/index.js";
import { readStageBlobs } from "../git/index.js";
import { MergeFileModel } from "../merge/index.js";
import { decodeUtf8Text } from "../text/index.js";

export type OpenedMergeFile = {
  file: ConflictFile;
  blobs: StageBlobs;
  model: MergeFileModel;
};

export async function openMergeFile(repoRoot: string, file: ConflictFile): Promise<OpenedMergeFile> {
  if (!file.supported) {
    throw new Error(file.reason ?? "Unsupported conflict file.");
  }

  const blobs = await readStageBlobs(repoRoot, file);
  const base = decodeUtf8Text(blobs.base);
  const ours = decodeUtf8Text(blobs.ours);
  const theirs = decodeUtf8Text(blobs.theirs);

  if (!base.ok || !ours.ok || !theirs.ok) {
    throw new Error("Staged blobs must be UTF-8 text.");
  }

  return {
    file,
    blobs,
    model: new MergeFileModel({
      path: file.path,
      base: base.text,
      ours: ours.text,
      theirs: theirs.text
    })
  };
}
