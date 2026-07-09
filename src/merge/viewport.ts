import type { ConflictRegion, Region } from "./types.js";

export type ViewportRegion = {
  region: Region;
  isCurrent: boolean;
};

export function sliceViewport(regions: Region[], currentConflictId: number | undefined, contextLines = 8): ViewportRegion[] {
  if (!currentConflictId) {
    return regions.map((region) => ({ region, isCurrent: false }));
  }

  const index = regions.findIndex((region) => region.type === "conflict" && region.id === currentConflictId);
  if (index < 0) {
    return regions.map((region) => ({ region, isCurrent: false }));
  }

  let beforeLines = 0;
  let start = index;
  while (start > 0 && beforeLines < contextLines) {
    start--;
    beforeLines += countLines(regions[start]);
  }

  let afterLines = 0;
  let end = index;
  while (end < regions.length - 1 && afterLines < contextLines) {
    end++;
    afterLines += countLines(regions[end]);
  }

  return regions.slice(start, end + 1).map((region) => ({
    region,
    isCurrent: region.type === "conflict" && region.id === currentConflictId
  }));
}

function countLines(region: Region): number {
  const text = region.type === "stable" ? region.text : conflictMaxText(region);
  if (text.length === 0) {
    return 0;
  }

  return text.split("\n").length;
}

function conflictMaxText(region: ConflictRegion): string {
  return [region.base, region.ours, region.theirs].sort((a, b) => b.length - a.length)[0] ?? "";
}
