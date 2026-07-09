import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";

export function resolveEditor(explicit?: string): string {
  return explicit ?? process.env.VISUAL ?? process.env.EDITOR ?? (process.platform === "win32" ? "notepad" : "vi");
}

export async function editText(initialText: string, editorCommand?: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mergev-"));
  const filePath = path.join(dir, "conflict.txt");

  try {
    await writeFile(filePath, initialText, "utf8");
    await execa(`${resolveEditor(editorCommand)} ${JSON.stringify(filePath)}`, {
      shell: true,
      stdio: "inherit"
    });
    return await readFile(filePath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
