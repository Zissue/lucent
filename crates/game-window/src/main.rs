mod keys;
mod menus;
mod present;
mod window;

use std::process::ExitCode;
use std::{env, ffi::OsString, path::PathBuf};

use gpui::{
    App, Bounds, QuitMode, TitlebarOptions, WindowBounds, WindowOptions, prelude::*, px, size,
};
use ruffle_host::{Engine, PlayerConfig, PlayerHost, Profile};

use crate::window::GameWindow;

fn main() -> ExitCode {
    let profile = match profile_from_args(env::args_os().skip(1)) {
        Ok(profile) => profile,
        Err(()) => {
            eprintln!("Usage: game-window --data-dir <path> [--account <username>]");
            return ExitCode::from(2);
        }
    };
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
            let (host, presentation) =
                match PlayerHost::spawn(&engine, PlayerConfig::launcher(profile)) {
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
            match opened {
                Ok(window) => menus::install(window, cx),
                Err(error) => {
                    tracing::error!(%error, "could not open the game window");
                    cx.quit();
                    return;
                }
            }
            cx.activate(true);
        });
    ExitCode::SUCCESS
}

fn profile_from_args(mut args: impl Iterator<Item = OsString>) -> Result<Profile, ()> {
    let mut data_dir = None;
    let mut account = None;
    while let Some(arg) = args.next() {
        let value = args
            .next()
            .filter(|value| !value.is_empty() && !value.as_encoded_bytes().starts_with(b"--"))
            .ok_or(())?;
        match arg.to_str() {
            Some("--data-dir") if data_dir.is_none() => data_dir = Some(PathBuf::from(value)),
            Some("--account") if account.is_none() => {
                account = Some(value.into_string().map_err(|_| ())?)
            }
            _ => return Err(()),
        }
    }
    let data_dir = data_dir.ok_or(())?;
    match account {
        Some(account) => Profile::account(data_dir, &account).map_err(|_| ()),
        None => Ok(Profile::default_profile(data_dir)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Profile, ()> {
        profile_from_args(args.iter().map(OsString::from))
    }

    #[test]
    fn selects_the_default_or_normalized_account_profile() {
        assert_eq!(
            parse(&["--data-dir", "/tmp/lucent-cli-test"])
                .unwrap()
                .directory(),
            PathBuf::from("/tmp/lucent-cli-test/game-profiles/default")
        );
        assert_eq!(
            parse(&["--account", " Alice ", "--data-dir", "/tmp/lucent-cli-test"]).unwrap(),
            Profile::account("/tmp/lucent-cli-test", "alice").unwrap()
        );
    }

    #[test]
    fn rejects_missing_unknown_duplicate_and_empty_arguments() {
        for args in [
            vec![],
            vec!["--data-dir"],
            vec!["--account", "Alice"],
            vec!["--data-dir", ""],
            vec!["--data-dir", "/tmp/test", "--account"],
            vec!["--data-dir", "--account", "Alice"],
            vec!["--data-dir", "/tmp/test", "--account", "   "],
            vec!["--data-dir", "/tmp/test", "--unknown", "value"],
            vec!["--data-dir", "/tmp/test", "--data-dir", "/tmp/other"],
            vec![
                "--data-dir",
                "/tmp/test",
                "--account",
                "Alice",
                "--account",
                "Bob",
            ],
            vec!["--data-dir", "/tmp/test", "extra"],
        ] {
            assert_eq!(parse(&args), Err(()), "{args:?}");
        }
    }
}
