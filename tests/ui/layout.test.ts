import { describe, expect, it } from "vitest";
import {
  clampScrollX,
  clampScrollY,
  maxLineWidth,
  resolveLayoutMode,
  resolvePaneContentRows,
  resolvePaneContentWidth,
  resolvePanesHeight,
  resolveShellInnerWidth,
  windowPaneText
} from "../../src/ui/layout.js";
import { decodeWheel, isMouseInput, MERGE_WHEEL_X_STEP, MERGE_WHEEL_Y_STEP } from "../../src/ui/mouse.js";

describe("resolveLayoutMode", () => {
  it("picks three-pane for wide terminals", () => {
    expect(resolveLayoutMode(120)).toBe("three-pane");
    expect(resolveLayoutMode(80)).toBe("two-pane");
    expect(resolveLayoutMode(79)).toBe("result");
  });

  it("honors forced mode", () => {
    expect(resolveLayoutMode(40, "three-pane")).toBe("three-pane");
  });
});

describe("resolvePanesHeight", () => {
  it("fills remaining space between header and footer", () => {
    // 40 - (2 shell + 4 header + 5 footer) = 29
    expect(resolvePanesHeight(40)).toBe(29);
    expect(resolvePanesHeight(24)).toBe(13);
  });
});

describe("resolveShellInnerWidth", () => {
  it("subtracts outer border and padding", () => {
    expect(resolveShellInnerWidth(100)).toBe(96);
  });
});

describe("pane content metrics", () => {
  it("computes visible rows and cols", () => {
    expect(resolvePaneContentRows(20)).toBe(17);
    expect(resolvePaneContentWidth(96, 3)).toBe(28);
  });
});

describe("windowPaneText", () => {
  it("supports vertical and horizontal scrolling windows", () => {
    const text = "abcdef\nghijkl\nmnopqr\n";
    expect(windowPaneText(text, { scrollY: 1, scrollX: 2, visibleRows: 2, visibleCols: 3 })).toBe("ijk\nopq");
  });

  it("pads short lines to keep a stable viewport", () => {
    expect(windowPaneText("a\n", { scrollY: 0, scrollX: 0, visibleRows: 2, visibleCols: 3 })).toBe("a  \n   ");
  });
});

describe("scroll clamps", () => {
  it("clamps scroll offsets to content bounds", () => {
    expect(clampScrollY(99, 10, 4)).toBe(6);
    expect(clampScrollX(-1, 20, 8)).toBe(0);
    expect(maxLineWidth("ab\nabcd\n")).toBe(4);
  });
});

describe("decodeWheel", () => {
  it("maps vertical and horizontal wheel buttons", () => {
    expect(decodeWheel(64)).toEqual({ dy: -MERGE_WHEEL_Y_STEP, dx: 0 });
    expect(decodeWheel(65)).toEqual({ dy: MERGE_WHEEL_Y_STEP, dx: 0 });
    expect(decodeWheel(66)).toEqual({ dy: 0, dx: -MERGE_WHEEL_X_STEP });
    expect(decodeWheel(67)).toEqual({ dy: 0, dx: MERGE_WHEEL_X_STEP });
  });

  it("maps shift+wheel to horizontal pan", () => {
    expect(decodeWheel(64 + 4)).toEqual({ dy: 0, dx: -MERGE_WHEEL_X_STEP });
    expect(decodeWheel(65 + 4)).toEqual({ dy: 0, dx: MERGE_WHEEL_X_STEP });
  });

  it("ignores non-wheel buttons", () => {
    expect(decodeWheel(0)).toBeUndefined();
  });
});

describe("isMouseInput", () => {
  it("detects SGR mouse sequences", () => {
    expect(isMouseInput("\x1b[<64;10;10M")).toBe(true);
    expect(isMouseInput("<64;10;10M")).toBe(true);
    expect(isMouseInput("h")).toBe(false);
  });
});
