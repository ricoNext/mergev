import { useEffect } from "react";
import { useStdin } from "ink";

export type WheelDelta = {
  /** 纵向：负为上滚，正为下滚 */
  dy: number;
  /** 横向：负为左，正为右（Shift+滚轮或水平滚轮） */
  dx: number;
};

export const MERGE_WHEEL_Y_STEP = 3;
export const MERGE_WHEEL_X_STEP = 6;

const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;

/**
 * 启用终端 SGR 鼠标追踪，把滚轮事件转成滚动增量。
 * Ink / 终端没有 DOM 的 overflow:scroll；需自行开启 mouse reporting。
 */
export function useMouseWheel(onWheel: (delta: WheelDelta) => void, enabled = true): void {
  const { stdin, setRawMode, isRawModeSupported } = useStdin();

  useEffect(() => {
    if (!enabled || !stdin || !isRawModeSupported) {
      return;
    }

    setRawMode(true);
    // 1000: 基础鼠标；1006: SGR（大坐标 + 滚轮）
    process.stdout.write("\x1b[?1000h\x1b[?1006h");

    let buffer = "";

    const onData = (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");

      while (true) {
        const start = buffer.indexOf("\x1b[<");
        if (start < 0) {
          if (buffer.length > 64) {
            buffer = buffer.slice(-32);
          }
          break;
        }

        if (start > 0) {
          buffer = buffer.slice(start);
        }

        const match = SGR_MOUSE_RE.exec(buffer);
        if (!match) {
          if (buffer.length > 64) {
            buffer = "";
          }
          break;
        }

        buffer = buffer.slice(match[0].length);
        const button = Number(match[1]);
        const action = match[4];
        if (action !== "M") {
          continue;
        }

        const delta = decodeWheel(button);
        if (delta) {
          onWheel(delta);
        }
      }
    };

    stdin.on("data", onData);

    return () => {
      stdin.off("data", onData);
      process.stdout.write("\x1b[?1006l\x1b[?1000l");
    };
  }, [enabled, stdin, setRawMode, isRawModeSupported, onWheel]);
}

/**
 * SGR button：64/65 纵滚，66/67 横滚；+4 = Shift（常用于把纵滚映射为横移）。
 */
export function decodeWheel(button: number): WheelDelta | undefined {
  const mods = button & 0b11100;
  const base = button - mods;
  const shift = (mods & 4) !== 0;

  if (base === 64) {
    return shift ? { dy: 0, dx: -MERGE_WHEEL_X_STEP } : { dy: -MERGE_WHEEL_Y_STEP, dx: 0 };
  }
  if (base === 65) {
    return shift ? { dy: 0, dx: MERGE_WHEEL_X_STEP } : { dy: MERGE_WHEEL_Y_STEP, dx: 0 };
  }
  if (base === 66) {
    return { dy: 0, dx: -MERGE_WHEEL_X_STEP };
  }
  if (base === 67) {
    return { dy: 0, dx: MERGE_WHEEL_X_STEP };
  }

  return undefined;
}

/** useInput 收到的鼠标转义串应忽略，避免误触发快捷键。 */
export function isMouseInput(input: string): boolean {
  return input.includes("\x1b[<") || /^\x1b\[</.test(input) || /^<\d+;\d+;\d+[Mm]/.test(input);
}
