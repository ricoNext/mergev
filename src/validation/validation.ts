import path from "node:path";
import { execa } from "execa";
import { parseSync } from "oxc-parser";
import { parse as parseYaml } from "yaml";

export type ValidationIssue = {
  message: string;
  line?: number;
  column?: number;
};

export type ValidationResult =
  | { ok: true }
  | { ok: false; issues: ValidationIssue[] };

const CONFLICT_MARKERS = ["<<<<<<<", "=======", ">>>>>>>"];

export function scanConflictMarkers(text: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const lines = text.split("\n");

  lines.forEach((line, index) => {
    for (const marker of CONFLICT_MARKERS) {
      const column = line.indexOf(marker);
      if (column >= 0) {
        issues.push({
          message: `Git conflict marker '${marker}' remains.`,
          line: index + 1,
          column: column + 1
        });
      }
    }
  });

  return issues;
}

export function validateBuiltIn(filePath: string, text: string): ValidationResult {
  const issues = scanConflictMarkers(text);
  const ext = path.extname(filePath).toLowerCase();

  try {
    if (ext === ".json") {
      JSON.parse(text);
    } else if (ext === ".yaml" || ext === ".yml") {
      parseYaml(text);
    } else if ([".js", ".jsx", ".ts", ".tsx"].includes(ext)) {
      const lang = ext.slice(1) as "js" | "jsx" | "ts" | "tsx";
      const parsed = parseSync(filePath, text, { lang, sourceType: "unambiguous" });
      issues.push(...parsed.errors.map((error) => ({ message: error.message })));
    }
  } catch (error) {
    issues.push({ message: error instanceof Error ? error.message : String(error) });
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true };
}

export async function runUserCheck(repoRoot: string, command: string): Promise<ValidationResult> {
  try {
    await execa(command, { cwd: repoRoot, shell: true });
    return { ok: true };
  } catch (error) {
    if (error instanceof Error && "shortMessage" in error) {
      return { ok: false, issues: [{ message: String(error.shortMessage) }] };
    }

    return { ok: false, issues: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
}
