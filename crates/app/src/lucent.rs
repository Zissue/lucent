use std::path::PathBuf;

use gpui::{App, AsyncApp, Global, PathPromptOptions, Task, WindowHandle};
use ruffle_host::Engine;
use scripting::Scripting;

use crate::accounts::ManagedAccount;
use crate::host::HostWindow;

/// Process-wide state every window reads: the player engine, the script runtimes'
/// router, and where Lucent keeps its data.
pub struct Lucent {
    pub engine: Engine,
    pub scripting: Scripting,
    pub data_dir: PathBuf,
    pub hosts: Vec<(WindowHandle<HostWindow>, gpui::WeakEntity<HostWindow>)>,
    pub muted: bool,
}

impl Global for Lucent {}

#[derive(Clone, Debug)]
pub enum LaunchTarget {
    NewWindow,
    Window(WindowHandle<HostWindow>),
}

/// A script picked in the manager or a tab, as Electron's `ScriptFileReference`.
#[derive(Clone, Debug, PartialEq)]
pub struct ScriptChoice {
    pub name: String,
    pub path: PathBuf,
    /// The package reference when the script lives in an installed package.
    pub reference: Option<serde_json::Value>,
}

impl ScriptChoice {
    pub fn command_input(&self) -> serde_json::Value {
        let mut input = serde_json::json!({ "path": self.path.to_string_lossy() });
        if let Some(reference) = &self.reference {
            input["reference"] = reference.clone();
        }
        input
    }
}

#[derive(Clone, Debug)]
pub struct LaunchRequest {
    pub accounts: Vec<ManagedAccount>,
    /// Loaded and started once each account is in game.
    pub script: Option<ScriptChoice>,
    /// Joins this server after login instead of stopping at server select.
    pub server: Option<String>,
    pub target: LaunchTarget,
    pub grid: bool,
}

/// A tabbed window the manager can launch into.
#[derive(Clone, Debug)]
pub struct HostSummary {
    pub handle: WindowHandle<HostWindow>,
    pub title: String,
    pub tabs: usize,
}

impl Lucent {
    pub fn get(cx: &App) -> &Lucent {
        cx.global::<Lucent>()
    }

    /// Opens each account in a tab, filling the target window and then new windows
    /// up to the per-window tab limit.
    pub fn launch(request: LaunchRequest, cx: &mut App) {
        crate::host::launch(request, cx);
    }

    pub fn toggle_muted(cx: &mut App) {
        let lucent = cx.global_mut::<Lucent>();
        lucent.muted = !lucent.muted;
        let muted = lucent.muted;
        crate::preferences::write(
            &lucent.data_dir.clone(),
            "muted",
            serde_json::Value::Bool(muted),
        );
        crate::host::set_muted(muted, cx);
    }

    pub fn hosts(cx: &mut App) -> Vec<HostSummary> {
        crate::host::summaries(cx)
    }

    /// Asks for a script file and describes it the way Electron's `selectFile` does.
    /// Resolves to `Ok(None)` when the user cancels.
    pub fn choose_script(cx: &mut App) -> Task<Result<Option<ScriptChoice>, String>> {
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Load Script".into()),
        });
        cx.spawn(async move |cx: &mut AsyncApp| {
            let Ok(Ok(Some(paths))) = paths.await else {
                return Ok(None);
            };
            let Some(path) = paths.into_iter().next() else {
                return Ok(None);
            };
            let described = cx
                .update(|cx| {
                    Lucent::get(cx).scripting.hub_call(
                        "scripts.describe",
                        serde_json::json!({ "path": path.to_string_lossy() }),
                    )
                })
                .await
                .map_err(|_| "The script runtime stopped.".to_owned())??;
            Ok(Some(ScriptChoice {
                name: described["name"].as_str().unwrap_or("script").to_owned(),
                path,
                reference: described.get("reference").cloned(),
            }))
        })
    }
}
