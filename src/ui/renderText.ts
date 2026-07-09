import { sliceViewport } from "../merge/index.js";
import type { MergeFileModel } from "../merge/index.js";

export type PaneText = {
  ours: string;
  result: string;
  theirs: string;
};

export function renderPaneText(model: MergeFileModel): PaneText {
  const currentId = model.currentConflict?.id;
  const viewport = sliceViewport(model.regions, currentId);
  const panes: PaneText = { ours: "", result: "", theirs: "" };

  for (const item of viewport) {
    const region = item.region;
    if (region.type === "stable") {
      panes.ours += region.text;
      panes.result += region.text;
      panes.theirs += region.text;
      continue;
    }

    const prefix = item.isCurrent ? `#${region.id} ` : ` ${region.id} `;
    panes.ours += `${prefix}${region.ours || "(empty)"}\n`;
    panes.theirs += `${prefix}${region.theirs || "(empty)"}\n`;
    panes.result += `${prefix}${renderDecision(region)}\n`;
  }

  return panes;
}

function renderDecision(region: Extract<MergeFileModel["regions"][number], { type: "conflict" }>): string {
  switch (region.decision.kind) {
    case "ours":
      return region.ours || "(empty)";
    case "theirs":
      return region.theirs || "(empty)";
    case "both":
      return `${region.ours}${region.ours.endsWith("\n") ? "" : "\n"}${region.theirs}`;
    case "manual":
      return region.decision.text || "(empty)";
    case "unresolved":
      return "(unresolved)";
  }
}
