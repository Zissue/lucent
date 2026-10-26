mod accounts;
mod game_view;
mod host;
mod inputs_form;
mod keys;
mod login_servers;
mod lucent;
mod manager;
mod menus;
mod preferences;
mod present;
mod soak;
mod ui;

use std::path::PathBuf;
use std::process::ExitCode;
use std::{env, ffi::OsString};

use gpui::{App, QuitMode};
use ruffle_host::Engine;
use scripting::{HubPaths, Scripting};

use crate::lucent::Lucent;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LaunchMode {
    Game,
    AccountManager,
}

#[derive(Debug, Default, PartialEq)]
struct Options {
    data_dir: Option<PathBuf>,
    workspace_dir: Option<PathBuf>,
    launch_mode: Option<LaunchMode>,
    soak: Option<soak::SoakOptions>,
    debug: bool,
}

fn main() -> ExitCode {
    let options = match parse(env::args_os().skip(1)) {
        Ok(options) => options,
        Err(()) => {
            eprintln!(
                "Usage: lucent [--launch-mode game|manager] [--data-dir <path>] [--workspace-dir <path>] [--debug]"
            );
            return ExitCode::from(2);
        }
    };
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| {
                    tracing_subscriber::EnvFilter::new(
                        "info,avm_trace=off,ruffle_core=error,ruffle_frontend_utils=error,gpui_macos=error,symphonia_bundle_mp3=off,symphonia_core=off",
                    )
                }),
        )
        .init();
    let mut paths = HubPaths::electron_defaults(assets_dir());
    if let Some(data_dir) = options.data_dir {
        paths.app_data = data_dir;
    }
    if let Some(workspace_dir) = options.workspace_dir {
        paths.workspace = workspace_dir;
    }
    let engine = match Engine::start() {
        Ok(engine) => engine,
        Err(error) => {
            tracing::error!(%error, "Lucent could not start the game engine");
            return ExitCode::FAILURE;
        }
    };
    let data_dir = paths.app_data.clone();
    let soak = options.soak;
    let launch_mode = options
        .launch_mode
        .unwrap_or_else(|| preferred_launch_mode(&data_dir));
    let scripting = match Scripting::start(paths, options.debug) {
        Ok(scripting) => scripting,
        Err(error) => {
            tracing::error!(%error, "Lucent could not start the script runtime");
            return ExitCode::FAILURE;
        }
    };
    gpui_platform::application()
        .with_quit_mode(if soak.is_some() {
            QuitMode::Explicit
        } else {
            QuitMode::LastWindowClosed
        })
        .run(move |cx: &mut App| {
            cx.set_global(Lucent {
                engine,
                scripting,
                muted: preferences::muted(&data_dir),
                data_dir,
                hosts: Vec::new(),
            });
            menus::install(cx);
            host::bind_keys(cx);
            cx.on_app_quit(host::shutdown_all).detach();
            match (soak, launch_mode) {
                (Some(soak), _) => soak::start(soak, cx),
                (None, LaunchMode::Game) => host::open_empty(cx),
                (None, LaunchMode::AccountManager) => manager::open(cx),
            }
            cx.activate(true);
        });
    ExitCode::SUCCESS
}

/// Bundled script packages and the script declarations ship next to the binary in a
/// release; in development they come from the repository.
fn assets_dir() -> PathBuf {
    let bundled = env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("../Resources/assets")))
        .filter(|dir| dir.is_dir());
    bundled.unwrap_or_else(|| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../assets")))
}

/// `preferences.launchMode` from Electron's settings.json, which defaults to the game.
fn preferred_launch_mode(data_dir: &std::path::Path) -> LaunchMode {
    let mode = std::fs::read_to_string(data_dir.join("settings.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|settings| {
            settings["preferences"]["launchMode"]
                .as_str()
                .map(str::to_owned)
        });
    match mode.as_deref() {
        Some("account-manager") => LaunchMode::AccountManager,
        _ => LaunchMode::Game,
    }
}

fn parse_launch_mode(value: &str) -> Option<LaunchMode> {
    match value.trim().to_lowercase().as_str() {
        "game" => Some(LaunchMode::Game),
        "manager" | "account-manager" => Some(LaunchMode::AccountManager),
        _ => None,
    }
}

fn parse(mut args: impl Iterator<Item = OsString>) -> Result<Options, ()> {
    let mut options = Options::default();
    let (mut script, mut group, mut cycles, mut report) = (None, None, None, None);
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some(flag @ ("--soak-script" | "--soak-group" | "--soak-cycles" | "--soak-report")) => {
                let value = args
                    .next()
                    .and_then(|value| value.into_string().ok())
                    .ok_or(())?;
                match flag {
                    "--soak-script" => script = Some(PathBuf::from(value)),
                    "--soak-group" => group = Some(value),
                    "--soak-cycles" => cycles = Some(value.parse::<u32>().map_err(|_| ())?),
                    _ => report = Some(PathBuf::from(value)),
                }
            }
            Some("--debug") => options.debug = true,
            Some("--launch-mode" | "--launchMode") => {
                let value = args.next().ok_or(())?;
                options.launch_mode = Some(parse_launch_mode(value.to_str().ok_or(())?).ok_or(())?);
            }
            Some(flag @ ("--data-dir" | "--workspace-dir")) => {
                let value = args
                    .next()
                    .filter(|value| {
                        !value.is_empty() && !value.as_encoded_bytes().starts_with(b"--")
                    })
                    .ok_or(())?;
                let slot = if flag == "--data-dir" {
                    &mut options.data_dir
                } else {
                    &mut options.workspace_dir
                };
                if slot.replace(PathBuf::from(value)).is_some() {
                    return Err(());
                }
            }
            _ => return Err(()),
        }
    }
    options.soak = match (script, group, cycles, report) {
        (Some(script), Some(group), Some(cycles), Some(report)) => Some(soak::SoakOptions {
            script,
            group,
            cycles,
            report,
        }),
        (None, None, None, None) => None,
        _ => return Err(()),
    };
    Ok(options)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(args: &[&str]) -> Result<Options, ()> {
        parse(args.iter().map(OsString::from))
    }

    #[test]
    fn reads_optional_directories_and_debug() {
        assert_eq!(parsed(&[]), Ok(Options::default()));
        assert_eq!(
            parsed(&[
                "--data-dir",
                "/tmp/a",
                "--debug",
                "--workspace-dir",
                "/tmp/b"
            ]),
            Ok(Options {
                data_dir: Some("/tmp/a".into()),
                workspace_dir: Some("/tmp/b".into()),
                launch_mode: None,
                soak: None,
                debug: true,
            })
        );
        assert_eq!(
            parsed(&["--launch-mode", " Manager "]).map(|options| options.launch_mode),
            Ok(Some(LaunchMode::AccountManager))
        );
        assert_eq!(
            parsed(&["--launchMode", "game"]).map(|options| options.launch_mode),
            Ok(Some(LaunchMode::Game))
        );
    }

    #[test]
    fn rejects_missing_duplicate_and_unknown_arguments() {
        for args in [
            vec!["--data-dir"],
            vec!["--data-dir", ""],
            vec!["--data-dir", "--debug"],
            vec!["--data-dir", "/a", "--data-dir", "/b"],
            vec!["--account", "Alice"],
            vec!["--launch-mode", "settings"],
            vec!["extra"],
        ] {
            assert_eq!(parsed(&args), Err(()), "{args:?}");
        }
    }
}
