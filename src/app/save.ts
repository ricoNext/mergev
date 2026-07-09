import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CliOptions } from "../config/index.js";
import { assertStagesUnchanged, gitAdd, type UnmergedFile } from "../git/index.js";
import { MergeFileModel } from "../merge/index.js";
import { containsUnresolvedPlaceholder } from "../text/index.js";
import { runUserCheck, validateBuiltIn, type ValidationResult } from "../validation/index.js";

export type SaveOptions = Pick<CliOptions, "check" | "noAdd"> & {
  forceAdd?: boolean;
};

export type SaveResult =
  | { ok: true; added: boolean }
  | { ok: false; reason: string; validation?: ValidationResult };

export async function saveResolvedFile(
  repoRoot: string,
  file: UnmergedFile,
  model: MergeFileModel,
  options: SaveOptions = {}
): Promise<SaveResult> {
  if (model.unresolvedCount() > 0) {
    return { ok: false, reason: "Resolve all conflict blocks before saving." };
  }

  const result = model.deriveWritableResult();
  if (containsUnresolvedPlaceholder(result)) {
    return { ok: false, reason: "Internal unresolved placeholders remain in the result." };
  }

  try {
    await assertStagesUnchanged(repoRoot, file);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  const target = path.join(repoRoot, file.path);
  const tmp = path.join(path.dirname(target), `.mergev-${path.basename(file.path)}-${randomUUID()}.tmp`);

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(tmp, result);
  await rename(tmp, target);

  const builtIn = validateBuiltIn(file.path, result);
  if (!builtIn.ok) {
    return { ok: false, reason: "Built-in validation failed; file was written but not added.", validation: builtIn };
  }

  if (options.check) {
    const userCheck = await runUserCheck(repoRoot, options.check);
    if (!userCheck.ok) {
      return { ok: false, reason: "--check failed; file was written but not added.", validation: userCheck };
    }
  }

  const shouldAdd = options.forceAdd || !options.noAdd;
  if (shouldAdd) {
    await gitAdd(repoRoot, file.path);
  }

  return { ok: true, added: shouldAdd };
}
