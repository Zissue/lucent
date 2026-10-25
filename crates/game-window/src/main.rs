mod keys;
mod present;
mod window;

use std::process::ExitCode;

use gpui::{
    App, Bounds, QuitMode, TitlebarOptions, WindowBounds, WindowOptions, prelude::*, px, size,
};
use ruffle_host::{Engine, PlayerConfig, PlayerHost};

use crate::window::GameWindow;

fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let engine = match Engine::start() {
        Ok(engine) => engine,
        Err(error) => {
            tracing::error!(%error, "Lucent could not start the game");
            return ExitCode::FAILURE;
        }
    };
    gpui_platform::application()
        .with_quit_mode(QuitMode::Explicit)
        .run(move |cx: &mut App| {
            let (host, presentation) = match PlayerHost::spawn(&engine, PlayerConfig::launcher()) {
                Ok(started) => started,
                Err(error) => {
                    tracing::error!(%error, "could not start the player thread");
                    cx.quit();
                    return;
                }
            };
            let options = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                    None,
                    size(px(1024.), px(768.)),
                    cx,
                ))),
                titlebar: Some(TitlebarOptions {
                    title: Some("Lucent".into()),
                    ..Default::default()
                }),
                ..Default::default()
            };
            let opened = cx.open_window(options, |window, cx| {
                let view = cx.new(|cx| GameWindow::new(host, presentation, window, cx));
                window::observe_focus(&view, window, cx);
                view
            });
            if let Err(error) = opened {
                tracing::error!(%error, "could not open the game window");
                cx.quit();
                return;
            }
            cx.activate(true);
        });
    ExitCode::SUCCESS
}
