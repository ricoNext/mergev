import { invoke } from "@tauri-apps/api/core";
import type { MergeDocument } from "@mergev/merge-ui/types";
import {
  buildSessionFromDocument,
  rebuildSession,
  serializeResult,
} from "@mergev/merge-ui/core/mergeSession";
import { applyAccept, emptyResolution } from "@mergev/merge-ui/utils/conflictUtils";

/**
 * 把指定冲突文件的所有冲突块整体采纳为一侧（ours/theirs），保存并 stage。
 * combined 与 conflicts 两个视图共用；失败时抛错，由调用方负责写入 actionError。
 */
export async function saveAcceptedResolution(
  side: "ours" | "theirs",
  path: string,
  repoRoot: string,
): Promise<void> {
  const document = await invoke<MergeDocument>("get_merge_document", {
    path,
    repoRoot,
  });
  const session = buildSessionFromDocument(document);

  const resolutions = session.conflicts.map(() =>
    applyAccept(emptyResolution(), side),
  );

  const updatedSession = rebuildSession(
    session.document,
    resolutions,
    session.activeConflict,
    true,
  );

  const endsWithNewline = updatedSession.document.working.endsWith("\n");
  const result = serializeResult(updatedSession.resultLines, endsWithNewline);
  await invoke("save_merge_result", {
    path: updatedSession.document.path,
    result,
    stage: true,
    repoRoot,
  });
}
