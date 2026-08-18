//! mergev Zed 扩展（阶段 0 可行性 PoC）。
//!
//! 该扩展只做一件事：通过 `context_server_command` 告诉 Zed 如何启动
//! mergev 的 MCP 服务进程（mergev-mcp）。进程生命周期完全由 Zed 托管，
//! 扩展自身运行在 WASM 沙箱中，不直接 spawn 任何进程。
//!
//! 阶段 0 结论（详见 docs/ZED_FEASIBILITY.md）：
//! - Zed 扩展 API 不支持自定义面板 / 编辑器 Tab / WebView；
//! - WASM 沙箱内的 process API 只有一次性的 output()，无法维持
//!   JSON-Lines 长连接 sidecar；
//! - 唯一受支持的长驻二进制通道是 Context Server（MCP over stdio）。

use zed_extension_api as zed;
use zed::{ContextServerId, DownloadedFileType, Project};

/// 本地开发时使用的 mergev-mcp 二进制绝对路径。
/// 留空表示走 GitHub Release 下载流程。
const DEV_BINARY: &str = "/Users/ricolee/Desktop/rico/mergev/target/release/mergev-mcp";

/// mergev-mcp 的发布仓库（正式发布后替换为真实仓库）。
const GITHUB_REPO: &str = "mergev/mergev";

struct MergevExtension {
    cached_binary_path: Option<String>,
}

impl MergevExtension {
    /// 根据当前平台拼接 Release 资产名，并下载、解压、赋可执行权限。
    fn download_mcp_binary(&mut self) -> zed::Result<String> {
        let (os, arch) = zed::current_platform();
        let (os_name, arch_name) = match (os, arch) {
            (zed::Os::Mac, zed::Architecture::Aarch64) => ("apple-darwin", "aarch64"),
            (zed::Os::Mac, zed::Architecture::X8664) => ("apple-darwin", "x86_64"),
            (zed::Os::Linux, zed::Architecture::Aarch64) => ("unknown-linux-gnu", "aarch64"),
            (zed::Os::Linux, zed::Architecture::X8664) => ("unknown-linux-gnu", "x86_64"),
            (zed::Os::Windows, zed::Architecture::Aarch64) => ("pc-windows-msvc", "aarch64"),
            (zed::Os::Windows, zed::Architecture::X8664) => ("pc-windows-msvc", "x86_64"),
            _ => return Err("mergev: 当前平台暂不支持".into()),
        };
        let version = zed::latest_github_release(
            GITHUB_REPO,
            zed::GithubReleaseOptions {
                require_assets: true,
                pre_release: false,
            },
        )?
        .version;
        let asset = format!("mergev-mcp-{arch_name}-{os_name}.tar.gz");
        let url = format!(
            "https://github.com/{GITHUB_REPO}/releases/download/{version}/{asset}"
        );
        let dir = format!("mergev-mcp-{version}");
        let binary = format!("{dir}/mergev-mcp");
        if self.cached_binary_path.as_deref() != Some(binary.as_str()) {
            zed::download_file(&url, &dir, DownloadedFileType::GzipTar)?;
            zed::make_file_executable(&binary)?;
        }
        Ok(binary)
    }
}

impl zed::Extension for MergevExtension {
    fn new() -> Self {
        Self {
            cached_binary_path: None,
        }
    }

    /// Zed 在需要启动 mergev 上下文服务器时调用。
    /// 返回的命令由 Zed 负责 spawn / 重启 / 关闭。
    fn context_server_command(
        &mut self,
        _context_server_id: &ContextServerId,
        _project: &Project,
    ) -> zed::Result<zed::Command> {
        let command = if !DEV_BINARY.is_empty() {
            DEV_BINARY.to_string()
        } else {
            let binary = self.download_mcp_binary()?;
            self.cached_binary_path = Some(binary.clone());
            binary
        };
        Ok(zed::Command {
            command,
            args: vec![],
            env: vec![],
        })
    }
}

zed::register_extension!(MergevExtension);
