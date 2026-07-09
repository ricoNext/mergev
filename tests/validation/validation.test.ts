import { describe, expect, it } from "vitest";
import { validateBuiltIn } from "../../src/validation/index.js";

describe("validateBuiltIn", () => {
  it("rejects conflict markers", () => {
    const result = validateBuiltIn("file.txt", "a\n<<<<<<< HEAD\n");
    expect(result.ok).toBe(false);
  });

  it("parses json", () => {
    expect(validateBuiltIn("package.json", "{\"ok\":true}").ok).toBe(true);
    expect(validateBuiltIn("package.json", "{").ok).toBe(false);
  });

  it("parses typescript syntax", () => {
    expect(validateBuiltIn("file.ts", "const value: number = 1;\n").ok).toBe(true);
    expect(validateBuiltIn("file.ts", "const = ;\n").ok).toBe(false);
  });
});
