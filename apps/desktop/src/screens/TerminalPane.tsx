import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Channel, invoke } from "@tauri-apps/api/core";
import { resolveTheme, type Theme } from "@mergev/merge-ui/theme";
import "@xterm/xterm/css/xterm.css";

// 终端配色与中间面板背景一致（--bg-middle），亮暗主题各一份
const LIGHT_TERM_THEME = {
  background: "#ffffff",
  foreground: "#33322e",
  cursor: "#5f5e5a",
  cursorAccent: "#ffffff",
  selectionBackground: "#d3d1c7",
};

const DARK_TERM_THEME = {
  background: "#3a3632",
  foreground: "#e6e1d9",
  cursor: "#b4b2a9",
  cursorAccent: "#3a3632",
  selectionBackground: "#5f5e5a",
};

function buildTheme(resolved: "light" | "dark") {
  return resolved === "dark" ? DARK_TERM_THEME : LIGHT_TERM_THEME;
}

// 桌面端当前仅面向 macOS；shell 取用户默认登录 shell 的常见值
const SHELL = "/bin/zsh";

type PtyMessage = ArrayBuffer | Uint8Array | { event?: string };

interface TerminalPaneProps {
  /** 工作目录：分支组路径（主仓库或 worktree） */
  cwd: string;
  /** 是否处于展示状态（切 tab 时仅切换显隐，PTY 会话保持常驻） */
  visible: boolean;
  theme: Theme;
}

/**
 * 单个终端 tab 的内容：xterm.js 渲染 + 后端 pty_* 命令管理会话。
 * 生命周期与 React 节点绑定——卸载（关 tab / 分支组被清理）即 kill 会话；
 * 隐藏（切 tab / 切分支）只改 display，后台 shell 继续运行。
 */
export function TerminalPane({ cwd, visible, theme }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const pidRef = useRef<number | null>(null);

  // 挂载：创建 xterm 实例并在 cwd 拉起 shell；卸载时 kill 进程
  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const term = new Terminal({
      fontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      theme: buildTheme(resolveTheme(theme)),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    if (host.clientWidth > 0) {
      try {
        fit.fit();
      } catch {
        // 容器尺寸异常时跳过，等 ResizeObserver / visible 再补
      }
    }

    let disposed = false;

    // spawn 尚未返回时先缓存按键，就绪后统一冲刷，避免启动瞬间丢字
    const pendingInput: string[] = [];
    let spawnSettled = false;

    const flushInput = () => {
      const pid = pidRef.current;
      if (pid === null) {
        return;
      }
      while (pendingInput.length > 0) {
        const chunk = pendingInput.shift();
        if (chunk !== undefined) {
          void invoke("pty_write", { pid, data: chunk }).catch(() => {});
        }
      }
    };

    // 输出通道：二进制 = shell 输出，JSON {event:"exit"} = 会话结束
    // disposed 守卫：StrictMode 双挂载时，第一个被杀会话的退出事件
    // 仍会通过其 channel 回调到达，绝不能清掉第二个（活着）会话的 pid
    const channel = new Channel<PtyMessage>();
    channel.onmessage = (message) => {
      if (disposed) {
        return;
      }
      if (message instanceof ArrayBuffer) {
        term.write(new Uint8Array(message));
      } else if (message instanceof Uint8Array) {
        term.write(message);
      } else if (message && typeof message === "object" && message.event === "exit") {
        pidRef.current = null;
        term.writeln("\r\n\x1b[90m[会话已结束]\x1b[0m");
      }
    };

    // 统一输入出口：会话就绪直接写；spawn 进行中先缓冲，就绪后冲刷；
    // 会话已退出且 spawn 已结束则提示一次后忽略
    let hintedNoSession = false;
    const sendInput = (data: string) => {
      const pid = pidRef.current;
      if (pid !== null) {
        invoke("pty_write", { pid, data }).catch((error) => {
          term.writeln(
            `\x1b[31m[输入写入失败：${error instanceof Error ? error.message : String(error)}]\x1b[0m`,
          );
        });
        return;
      }
      if (!spawnSettled) {
        pendingInput.push(data);
        return;
      }
      if (!hintedNoSession) {
        hintedNoSession = true;
        term.writeln("\x1b[33m[终端尚未就绪或已退出，输入被忽略]\x1b[0m");
      }
    };
    const inputDisposer = term.onData(sendInput);

    // Ctrl+Delete：从光标位置向前清除到行首，保留光标之后的内容。
    // 发送 M-- C-k（负数字参数 + kill-line）让 ZLE 自己执行 backward-kill-line；
    // 已用 pty 回环实验验证 zsh：光标在 "echo hello|world" 的 | 处按此序列，
    // 回车后执行的是 "echo hello"（^U / Ctrl+A+Ctrl+K 会把整行清掉，均不可用）。
    term.attachCustomKeyEventHandler((event) => {
      if (
        event.type === "keydown" &&
        event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        event.key === "Delete"
      ) {
        sendInput("\x1b-1\x0b");
        return false; // 拦截掉，xterm 不再生成默认的 \x1b[3;5~ 序列
      }
      return true;
    });

    void (async () => {
      try {
        const pid = await invoke<number>("pty_spawn", {
          file: SHELL,
          args: [],
          cwd,
          cols: term.cols,
          rows: term.rows,
          env: {
            TERM: "xterm-256color",
            COLORTERM: "truecolor",
          },
          channel,
        });
        spawnSettled = true;
        if (disposed) {
          void invoke("pty_kill", { pid }).catch(() => {});
          return;
        }
        pidRef.current = pid;
        flushInput();
      } catch (error) {
        spawnSettled = true;
        term.writeln(
          `\x1b[31m无法启动终端：${error instanceof Error ? error.message : String(error)}\x1b[0m`,
        );
      }
    })();

    // 容器尺寸变化 → 重算列行数并同步给 PTY，否则换行会错乱
    const syncSize = () => {
      const pid = pidRef.current;
      if (host.clientWidth <= 0 || host.clientHeight <= 0) {
        return;
      }
      try {
        fit.fit();
        if (pid !== null) {
          void invoke("pty_resize", { pid, cols: term.cols, rows: term.rows }).catch(
            () => {},
          );
        }
      } catch {
        // fit 在极端尺寸下可能抛错，忽略即可
      }
    };
    const observer = new ResizeObserver(syncSize);
    observer.observe(host);

    // 鼠标点击定位光标：把点击列与光标列的差值换算成方向键序列发给 shell，
    // 由 ZLE 移动光标（同 iTerm2 / VS Code 的 click-to-reposition 原理）。
    // 仅支持点击当前光标所在行（即正在输入的行）；双击留给选词，拖拽留给选区。
    let downPos: { x: number; y: number } | null = null;
    const onMouseDown = (e: MouseEvent) => {
      downPos = { x: e.clientX, y: e.clientY };
    };
    const onClick = (e: MouseEvent) => {
      if (e.detail !== 1 || e.button !== 0) {
        return;
      }
      const pid = pidRef.current;
      if (pid === null) {
        return;
      }
      // 按下后移动过（拖拽选择）不算点击
      if (
        downPos &&
        Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 4
      ) {
        return;
      }
      const screen = host.querySelector<HTMLElement>(".xterm-screen");
      if (!screen) {
        return;
      }
      const rect = screen.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        return;
      }
      const cellW = rect.width / term.cols;
      const cellH = rect.height / term.rows;
      const clickRow = Math.floor((e.clientY - rect.top) / cellH);
      const buf = term.buffer.active;
      if (clickRow !== buf.cursorY) {
        return; // 不在光标所在行（提示行上方的历史区），忽略
      }
      const clickCol = Math.floor((e.clientX - rect.left) / cellW);
      const delta = clickCol - buf.cursorX;
      if (delta === 0) {
        return;
      }
      // 右移 \x1b[C / 左移 \x1b[D，重复 |delta| 次；超出行尾时 shell 会自动停在末尾
      const seq = delta > 0 ? "\x1b[C" : "\x1b[D";
      void invoke("pty_write", {
        pid,
        data: seq.repeat(Math.abs(delta)),
      }).catch(() => {});
    };
    host.addEventListener("mousedown", onMouseDown);
    host.addEventListener("click", onClick);

    return () => {
      disposed = true;
      observer.disconnect();
      inputDisposer.dispose();
      host.removeEventListener("mousedown", onMouseDown);
      host.removeEventListener("click", onClick);
      const pid = pidRef.current;
      if (pid !== null) {
        pidRef.current = null;
        void invoke("pty_kill", { pid }).catch(() => {});
      }
      termRef.current = null;
      fitRef.current = null;
      term.dispose();
    };
    // cwd 是 tab 身份的一部分，tab 存续期间不变，仅挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  // 主题切换跟随（system 模式监听系统配色变化）
  useEffect(() => {
    const apply = () => {
      const term = termRef.current;
      if (term) {
        term.options.theme = buildTheme(resolveTheme(theme));
      }
    };
    apply();
    if (theme !== "system") {
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  // 从隐藏切回显示时重新 fit（display:none 期间 ResizeObserver 不触发）
  useEffect(() => {
    if (!visible) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      const host = hostRef.current;
      const fit = fitRef.current;
      const pid = pidRef.current;
      const term = termRef.current;
      if (!host || !fit || !term || host.clientWidth <= 0) {
        return;
      }
      try {
        fit.fit();
        if (pid !== null) {
          void invoke("pty_resize", { pid, cols: term.cols, rows: term.rows }).catch(
            () => {},
          );
        }
        term.focus();
      } catch {
        // 忽略极端尺寸
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  return (
    <div
      className="terminal-pane"
      data-visible={visible ? "true" : "false"}
      ref={hostRef}
    />
  );
}
