import { describe, expect, it } from "vitest";
import { MergeFileModel } from "../../src/merge/index.js";

describe("MergeFileModel", () => {
  it("derives choices and tracks unresolved placeholders", () => {
    const model = new MergeFileModel({
      path: "file.txt",
      base: "a\nb\nc\n",
      ours: "a\nours\nc\n",
      theirs: "a\ntheirs\nc\n"
    });

    expect(model.conflicts).toHaveLength(1);
    expect(model.unresolvedCount()).toBe(1);
    expect(model.deriveResult()).toContain("⟪mergev:unresolved:1⟫");

    model.chooseCurrent("ours");
    expect(model.deriveResult()).toBe("a\nours\nc\n");
    expect(model.unresolvedCount()).toBe(0);
    expect(model.revision).toBe(1);

    expect(model.undo()).toBe(true);
    expect(model.unresolvedCount()).toBe(1);
  });

  it("combines ours before theirs for both", () => {
    const model = new MergeFileModel({
      path: "file.txt",
      base: "x\n",
      ours: "ours",
      theirs: "theirs"
    });

    model.chooseCurrent("both");
    expect(model.deriveResult()).toBe("ours\ntheirs");
  });

  it("normalizes internal eol and writes back the ours style", () => {
    const model = new MergeFileModel({
      path: "file.txt",
      base: "a\r\nb\r\n",
      ours: "a\r\nours\r\n",
      theirs: "a\r\ntheirs\r\n"
    });

    model.chooseCurrent("theirs");
    expect(model.deriveResult()).toBe("a\ntheirs\n");
    expect(model.deriveWritableResult()).toBe("a\r\ntheirs\r\n");
  });

  it("accepts one side for all conflicts", () => {
    const model = new MergeFileModel({
      path: "file.txt",
      base: "a\nx\nb\ny\nc\n",
      ours: "a\nours1\nb\nours2\nc\n",
      theirs: "a\ntheirs1\nb\ntheirs2\nc\n"
    });

    expect(model.conflicts.length).toBeGreaterThanOrEqual(2);
    model.chooseAll("ours");
    expect(model.unresolvedCount()).toBe(0);
    expect(model.deriveResult()).toBe("a\nours1\nb\nours2\nc\n");
  });
});
