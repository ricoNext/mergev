//! TUI 入口：初始化终端、跑渲染/事件循环、退出时恢复终端。

mod app;
mod event;
mod session;
mod text;
mod ui;

use std::io;
use std::path::PathBuf;
use std::time::Duration;

use app::App;
use crossterm::event::{DisableMouseCapture, EnableMouseCapture, Event, KeyEventKind};
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
fn main() {
    // 可选参数：仓库根目录，默认当前目录
    let root = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));

    let mut app = match App::new(root) {
        Ok(app) => app,
        Err(err) => {
            eprintln!("mergev-tui: {err}");
            std::process::exit(1);
        }
    };

    if let Err(err) = run(&mut app) {
        eprintln!("mergev-tui: {err}");
        std::process::exit(1);
    }
}

fn run(app: &mut App) -> io::Result<()> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    crossterm::execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    let mut terminal = Terminal::new(CrosstermBackend::new(stdout))?;

    let result = event_loop(app, &mut terminal);

    // 无论正常退出还是出错，都恢复终端状态
    disable_raw_mode()?;
    crossterm::execute!(
        terminal.backend_mut(),
        DisableMouseCapture,
        LeaveAlternateScreen
    )?;
    terminal.show_cursor()?;

    result
}

fn event_loop(
    app: &mut App,
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
) -> io::Result<()> {
    while !app.should_quit {
        terminal.draw(|frame| ui::draw(frame, app))?;

        // header(1) + footer(1) + 决策栏(2) 之外才是内容视口
        let area = terminal.size()?;
        let viewport_height = area.height.saturating_sub(4) as usize;

        if !crossterm::event::poll(Duration::from_millis(100))? {
            continue;
        }
        match crossterm::event::read()? {
            // 过滤 Release/Repeat，避免按键被重复处理
            Event::Key(key) if key.kind == KeyEventKind::Press => {
                event::handle_key(app, key, viewport_height, area.width);
            }
            Event::Mouse(mouse) => event::handle_mouse(app, mouse, viewport_height),
            _ => {}
        }
    }
    Ok(())
}
