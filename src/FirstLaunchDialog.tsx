import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./FirstLaunchDialog.css";

interface FirstLaunchDialogProps {
  onClose: () => void;
}

export function FirstLaunchDialog({ onClose }: FirstLaunchDialogProps) {
  const [installing, setInstalling] = useState(false);
  const [installResult, setInstallResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  async function handleInstallCLI() {
    setInstalling(true);
    setInstallResult(null);

    try {
      const message = await invoke<string>("install_cli_command");
      setInstallResult({ success: true, message });
    } catch (error) {
      setInstallResult({
        success: false,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setInstalling(false);
    }
  }

  async function handleSkip() {
    try {
      await invoke("mark_first_launch_done");
      onClose();
    } catch (error) {
      console.error("Failed to mark first launch done:", error);
      onClose();
    }
  }

  async function handleFinish() {
    try {
      await invoke("mark_first_launch_done");
      onClose();
    } catch (error) {
      console.error("Failed to mark first launch done:", error);
      onClose();
    }
  }

  return (
    <div className="first-launch-overlay">
      <div className="first-launch-dialog">
        <div className="first-launch-header">
          <h1>欢迎使用 mergev</h1>
          <p className="first-launch-subtitle">
            一个优雅的 Git 冲突解决工具
          </p>
        </div>

        <div className="first-launch-body">
          <div className="first-launch-section">
            <h2>🚀 安装全局命令（推荐）</h2>
            <p className="first-launch-description">
              安装 <code>mergev</code> 命令到全局环境，之后可在任意 Git 仓库目录执行：
            </p>
            <pre className="first-launch-code">cd /path/to/your/repo{"\n"}mergev</pre>

            {installResult && (
              <div
                className={
                  installResult.success
                    ? "first-launch-result success"
                    : "first-launch-result error"
                }
              >
                <pre>{installResult.message}</pre>
              </div>
            )}

            <div className="first-launch-actions">
              {!installResult ? (
                <>
                  <button
                    type="button"
                    className="primary"
                    onClick={handleInstallCLI}
                    disabled={installing}
                  >
                    {installing ? "安装中…" : "安装 mergev 命令"}
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={handleSkip}
                    disabled={installing}
                  >
                    跳过
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="primary"
                  onClick={handleFinish}
                >
                  完成
                </button>
              )}
            </div>
          </div>

          {!installResult && (
            <div className="first-launch-note">
              <p className="muted">
                💡 提示：你也可以稍后通过菜单「工具 → 安装 mergev 命令到 PATH」来安装
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
