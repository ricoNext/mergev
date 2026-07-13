use std::fs;
use std::path::PathBuf;

/// 首次启动配置文件路径
fn config_path() -> Result<PathBuf, String> {
    let config_dir = dirs::config_dir()
        .ok_or_else(|| "无法获取配置目录".to_string())?;
    let app_config = config_dir.join("mergev");
    Ok(app_config.join("first_launch.json"))
}

/// 检查是否是首次启动
pub fn is_first_launch() -> Result<bool, String> {
    let path = config_path()?;
    Ok(!path.exists())
}

/// 标记首次启动已完成
pub fn mark_first_launch_done() -> Result<(), String> {
    let path = config_path()?;

    // 确保目录存在
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("创建配置目录失败: {}", e))?;
    }

    // 写入标记文件
    let config = serde_json::json!({
        "first_launch_completed": true,
        "completed_at": chrono::Local::now().to_rfc3339()
    });

    fs::write(&path, serde_json::to_string_pretty(&config).unwrap())
        .map_err(|e| format!("写入配置文件失败: {}", e))?;

    Ok(())
}
