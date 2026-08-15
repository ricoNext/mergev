import { describe, expect, it } from "vitest";
import type { MergeDocument } from "../types";
import {
  buildSessionFromDocument,
  rebuildSession,
  serializeResult,
} from "./mergeSession";

function conflictDocument(): MergeDocument {
  return {
    path: "src/file.ts",
    labels: { ours: "Yours", theirs: "Theirs" },
    base: "before\nbase\nafter\n",
    ours: "before\nours\nafter\n",
    theirs: "before\ntheirs\nafter\n",
    working:
      "before\n<<<<<<< Yours\nours\n=======\ntheirs\n>>>>>>> Theirs\nafter\n",
    rows: [
      {
        id: "r0",
        kind: "context",
        conflictIndex: null,
        oursLine: { number: 1, text: "before" },
        resultLine: { number: 1, text: "before" },
        theirsLine: { number: 1, text: "before" },
      },
      {
        id: "r1",
        kind: "conflict",
        conflictIndex: 0,
        oursLine: { number: 2, text: "ours" },
        resultLine: { number: 2, text: "" },
        theirsLine: { number: 2, text: "theirs" },
      },
      {
        id: "r2",
        kind: "context",
        conflictIndex: null,
        oursLine: { number: 3, text: "after" },
        resultLine: { number: 3, text: "after" },
        theirsLine: { number: 3, text: "after" },
      },
    ],
    conflicts: [
      {
        index: 0,
        rowStart: 1,
        rowEnd: 1,
        decision: "unresolved",
        resolution: {
          ours: "pending",
          theirs: "pending",
          acceptOrder: [],
        },
        blockKind: "conflict",
        ours: "ours",
        theirs: "theirs",
      },
    ],
    result: [
      { source: "context", conflictIndex: null, text: "before" },
      { source: "unresolved", conflictIndex: 0, text: "" },
      { source: "context", conflictIndex: null, text: "after" },
    ],
    unresolvedCount: 1,
  };
}

describe("mergeSession", () => {
  it("为未处理冲突建立稳定的初始会话", () => {
    const session = buildSessionFromDocument(conflictDocument());

    expect(session.activeConflict).toBe(0);
    expect(session.document.unresolvedCount).toBe(1);
    expect(session.decisions).toEqual(["unresolved"]);
    expect(session.resultLines.map((line) => line.text)).toEqual([
      "before",
      "",
      "after",
    ]);
  });

  it("按照双方接受顺序重建并序列化结果", () => {
    const session = rebuildSession(
      conflictDocument(),
      [
        {
          ours: "accepted",
          theirs: "accepted",
          acceptOrder: ["ours", "theirs"],
        },
      ],
      0,
      true,
    );

    expect(session.document.unresolvedCount).toBe(0);
    expect(session.decisions).toEqual(["oursThenTheirs"]);
    expect(serializeResult(session.resultLines, true)).toBe(
      "before\nours\ntheirs\nafter\n",
    );
  });

  it("只在原文件需要时保留末尾换行", () => {
    const lines = [
      { source: "context" as const, conflictIndex: null, text: "one" },
      { source: "context" as const, conflictIndex: null, text: "two" },
    ];

    expect(serializeResult(lines, true)).toBe("one\ntwo\n");
    expect(serializeResult(lines, false)).toBe("one\ntwo");
    expect(serializeResult([], true)).toBe("");
  });
});
