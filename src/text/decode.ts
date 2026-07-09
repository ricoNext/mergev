import { TextDecoder } from "node:util";

export type TextDecodeResult =
  | { ok: true; text: string }
  | { ok: false; reason: "binary" | "invalid-utf8" };

export function decodeUtf8Text(bytes: Uint8Array): TextDecodeResult {
  if (bytes.includes(0)) {
    return { ok: false, reason: "binary" };
  }

  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return { ok: true, text: decoder.decode(bytes) };
  } catch {
    return { ok: false, reason: "invalid-utf8" };
  }
}
