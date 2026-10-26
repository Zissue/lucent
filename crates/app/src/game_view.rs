use std::cell::Cell;
use std::collections::VecDeque;
use std::ops::Range;
use std::rc::Rc;
use std::time::{Duration, Instant};

use bridge::Boot;
use futures::FutureExt;
use futures::future::BoxFuture;
use gpui::{
    App, Bounds, ClipboardItem, Context, Corners, CursorStyle, DispatchPhase, ElementInputHandler,
    Entity, EntityInputHandler, FocusHandle, HitboxBehavior, KeyDownEvent, KeyUpEvent,
    ModifiersChangedEvent, MouseButton, MouseDownEvent, MouseExitEvent, MouseMoveEvent,
    MouseUpEvent, Pixels, Point, Render, ScrollDelta, ScrollWheelEvent, Task, UTF16Selection,
    Window, canvas, div, prelude::*, px, rgb,
};
use ruffle_host::ruffle::{
    ImeEvent, MouseButton as GameButton, MouseCursor, MouseWheelDelta, PlayerEvent, TextControlCode,
};
use ruffle_host::{
    InputSink, PlayerConfig, PlayerHost, Presentation, Profile, UiRequest, Viewport, Visibility,
};
use scripting::{AccountEvent, AccountRuntime, ConsoleLevel};
use serde_json::{Value, json};

use crate::accounts::ManagedAccount;
use crate::keys;
use crate::lucent::{Lucent, ScriptChoice};
use crate::present::Presented;

const SHUTDOWN_DEADLINE: Duration = Duration::from_secs(2);
const LOAD_DELAY: Duration = Duration::from_secs(10);
const CONSOLE_LINES: usize = 500;

#[derive(Clone, Debug, PartialEq)]
pub struct ConsoleLine {
    pub level: ConsoleLevel,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LoadedScript {
    pub choice: ScriptChoice,
    pub has_inputs: bool,
}

/// The script runner's status, as `ScriptRunner.onStatus` reports it.
#[derive(Clone, Debug, PartialEq)]
pub struct ScriptStatus {
    pub state: String,
    pub name: Option<String>,
    pub detail: Option<String>,
}

impl ScriptStatus {
    fn idle() -> Self {
        Self {
            state: "idle".into(),
            name: None,
            detail: None,
        }
    }

    fn from_value(value: &Value) -> Self {
        let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
        Self {
            state: text("state").unwrap_or_else(|| "idle".into()),
            name: text("name"),
            detail: text("message").or_else(|| text("reason")),
        }
    }

    pub fn is_active(&self) -> bool {
        matches!(
            self.state.as_str(),
            "starting" | "running" | "stopping" | "waiting-to-restart"
        )
    }

    pub fn label(&self) -> String {
        let state = match self.state.as_str() {
            "idle" => "Idle",
            "starting" => "Starting",
            "running" => "Running",
            "stopping" => "Stopping",
            "completed" => "Completed",
            "failed" => "Failed",
            "stopped" => "Stopped",
            "waiting-to-restart" => "Waiting to restart",
            other => other,
        };
        match &self.detail {
            Some(detail) if self.state == "failed" || self.state == "stopped" => {
                format!("{state}: {detail}")
            }
            _ => state.to_owned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum DialogKind {
    Alert,
    Confirm,
    Prompt { placeholder: String },
}

/// A `lucent/script` dialog waiting for the user.
#[derive(Clone, Debug, PartialEq)]
pub struct ScriptDialog {
    pub id: u64,
    pub kind: DialogKind,
    pub message: String,
    pub source: String,
}

impl ScriptDialog {
    fn from_value(value: &Value) -> Option<Self> {
        let kind = match value.get("kind")?.as_str()? {
            "alert" => DialogKind::Alert,
            "confirm" => DialogKind::Confirm,
            "prompt" => DialogKind::Prompt {
                placeholder: value
                    .get("placeholder")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            },
            _ => return None,
        };
        Some(Self {
            id: value.get("id")?.as_u64()?,
            kind,
            message: value.get("message")?.as_str()?.to_owned(),
            source: value
                .get("sourceName")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum DialogAnswer {
    Dismissed,
    Confirmed(bool),
    Prompted(Option<String>),
}

#[derive(Clone, Debug, PartialEq)]
pub enum FieldKind {
    Text,
    Number,
    Boolean,
    Select(Vec<String>),
    MultiSelect(Vec<String>),
}

#[derive(Clone, Debug, PartialEq)]
pub struct InputField {
    pub key: String,
    pub label: String,
    pub description: Option<String>,
    pub required: bool,
    pub kind: FieldKind,
}

/// A loaded script's `module.exports.inputs` and the values saved for it.
#[derive(Clone, Debug, PartialEq)]
pub struct ScriptInputs {
    pub fields: Vec<InputField>,
    pub values: serde_json::Map<String, Value>,
}

impl ScriptInputs {
    fn from_value(value: &Value) -> Option<Self> {
        let definition = value.get("definition")?;
        let fields = definition
            .get("fields")?
            .as_array()?
            .iter()
            .filter_map(|field| {
                let options = || {
                    field
                        .get("options")
                        .and_then(Value::as_array)
                        .map(|options| {
                            options
                                .iter()
                                .filter_map(|option| option.as_str().map(str::to_owned))
                                .collect()
                        })
                        .unwrap_or_default()
                };
                let kind = match field.get("type")?.as_str()? {
                    "string" => FieldKind::Text,
                    "number" => FieldKind::Number,
                    "boolean" => FieldKind::Boolean,
                    "select" => FieldKind::Select(options()),
                    "multi-select" => FieldKind::MultiSelect(options()),
                    _ => return None,
                };
                Some(InputField {
                    key: field.get("key")?.as_str()?.to_owned(),
                    label: field.get("label")?.as_str()?.to_owned(),
                    description: field
                        .get("description")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    required: field
                        .get("required")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    kind,
                })
            })
            .collect();
        let values = value
            .get("values")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        Some(Self { fields, values })
    }
}

#[derive(Clone, Debug, PartialEq)]
enum Login {
    None,
    Pending,
    Sent,
}

/// What the tab strip and script bar show for one account.
pub struct Session {
    pub runtime_ready: bool,
    pub runtime_error: Option<String>,
    pub player: Option<String>,
    pub script: Option<LoadedScript>,
    pub status: ScriptStatus,
    pub busy: bool,
    pub console: VecDeque<ConsoleLine>,
    pub dialog: Option<ScriptDialog>,
    /// Set while the inputs form is open.
    pub inputs: Option<ScriptInputs>,
    pub inputs_error: Option<String>,
}

/// Electron's `GameViewPresentation`: what the game's frame-rate limit follows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ViewPresentation {
    pub active: bool,
    pub grid: bool,
    pub window_active: bool,
}

/// The script asked for its game to close.
pub struct CloseRequested;

impl gpui::EventEmitter<CloseRequested> for GameView {}

pub struct GameView {
    account: Option<ManagedAccount>,
    server: Option<String>,
    profile: Profile,
    host: Option<PlayerHost>,
    runtime: Option<AccountRuntime>,
    input: Option<InputSink>,
    presented: Presented,
    boot: Boot,
    load_delayed: bool,
    focus: FocusHandle,
    viewport: Rc<Cell<Viewport>>,
    modifiers: gpui::Modifiers,
    composing: Option<Range<usize>>,
    cursor: CursorStyle,
    login: Login,
    pending_script: Option<ScriptChoice>,
    presentation: Option<ViewPresentation>,
    visible: bool,
    pub session: Session,
    _tasks: Vec<Task<()>>,
}

impl GameView {
    pub fn new(
        account: Option<ManagedAccount>,
        server: Option<String>,
        script: Option<ScriptChoice>,
        cx: &mut Context<Self>,
    ) -> Self {
        let data_dir = Lucent::get(cx).data_dir.clone();
        let profile = match &account {
            Some(account) => Profile::account(&data_dir, &account.username)
                .unwrap_or_else(|_| Profile::default_profile(&data_dir)),
            None => Profile::default_profile(&data_dir),
        };
        let mut view = Self {
            login: if account.is_some() {
                Login::Pending
            } else {
                Login::None
            },
            account,
            server,
            pending_script: script,
            presentation: None,
            profile,
            input: None,
            boot: Boot::Starting,
            load_delayed: false,
            host: None,
            runtime: None,
            presented: Presented::default(),
            focus: cx.focus_handle(),
            viewport: Rc::new(Cell::new(Viewport::AUTHORED)),
            modifiers: gpui::Modifiers::default(),
            composing: None,
            cursor: CursorStyle::Arrow,
            visible: true,
            session: Session {
                runtime_ready: false,
                runtime_error: None,
                player: None,
                script: None,
                status: ScriptStatus::idle(),
                busy: false,
                console: VecDeque::new(),
                dialog: None,
                inputs: None,
                inputs_error: None,
            },
            _tasks: Vec::new(),
        };
        view.spawn_player(cx);
        view
    }

    fn spawn_player(&mut self, cx: &mut Context<Self>) {
        let engine = Lucent::get(cx).engine.clone();
        match PlayerHost::spawn(&engine, PlayerConfig::launcher(self.profile.clone())) {
            Ok((host, presentation)) => self.attach(host, presentation, cx),
            Err(error) => {
                tracing::error!(%error, "could not start the player thread");
                self.boot = Boot::Failed {
                    error: error.to_string(),
                };
                cx.notify();
            }
        }
    }

    fn send(&self, event: PlayerEvent) {
        if let Some(input) = &self.input {
            input.send(event);
        }
    }

    pub fn focus_handle(&self) -> &FocusHandle {
        &self.focus
    }

    pub fn title(&self) -> String {
        if let Some(account) = &self.account {
            let label = account.label.trim();
            return if label.is_empty() {
                account.username.clone()
            } else {
                label.to_owned()
            };
        }
        self.session
            .player
            .clone()
            .unwrap_or_else(|| "New game".into())
    }

    pub fn boot(&self) -> &Boot {
        &self.boot
    }

    pub fn set_presentation(&mut self, presentation: ViewPresentation, cx: &mut Context<Self>) {
        if self.presentation != Some(presentation) {
            self.presentation = Some(presentation);
            self.send_presentation(cx);
        }
    }

    /// The loader resets the stage frame rate when the game or the runtime restarts,
    /// so the limit is sent again then.
    fn send_presentation(&mut self, cx: &mut Context<Self>) {
        let Some(presentation) = self.presentation else {
            return;
        };
        if !self.session.runtime_ready || self.boot != Boot::Ready {
            return;
        }
        let input = json!({
            "active": presentation.active,
            "layout": if presentation.grid { "grid" } else { "focused" },
            "tiled": presentation.grid,
            "windowActive": presentation.window_active,
        });
        self.run("set-presentation", input, cx, |_, result, _| {
            if let Err(error) = result {
                tracing::debug!(%error, "could not apply the frame rate limit");
            }
        });
    }

    pub fn set_muted(&mut self, muted: bool) {
        if let Some(input) = &self.input {
            input.set_volume(if muted { 0.0 } else { 1.0 });
        }
    }

    pub fn set_visible(&mut self, visible: bool) {
        if self.visible != visible {
            self.visible = visible;
            if let Some(input) = &self.input {
                input.set_visibility(if visible {
                    Visibility::Visible
                } else {
                    Visibility::Hidden
                });
            }
        }
    }

    fn attach(&mut self, host: PlayerHost, presentation: Presentation, cx: &mut Context<Self>) {
        let Presentation { frames, ui } = presentation;
        let frame_task = cx.spawn(async move |this, cx| {
            while let Some(frame) = frames.next().await {
                let presented = this.update(cx, |view, cx| {
                    view.presented.replace(frame);
                    cx.notify();
                });
                if presented.is_err() {
                    return;
                }
            }
            let _ = this.update(cx, |view, cx| {
                if !matches!(view.boot, Boot::Stopping) {
                    tracing::error!(tab = %view.title(), "the player thread stopped unexpectedly");
                    view.boot = Boot::Failed {
                        error: "the game stopped unexpectedly".into(),
                    };
                    cx.notify();
                }
            });
        });
        let ui_task = cx.spawn(async move |this, cx| {
            while let Some(request) = ui.next().await {
                if this.update(cx, |view, cx| view.apply(request, cx)).is_err() {
                    break;
                }
            }
        });
        let mut changes = host.session().status_changes();
        let status_task = cx.spawn(async move |this, cx| {
            while let Ok(status) = changes.changed().await {
                if this
                    .update(cx, |view, cx| {
                        view.boot = status.boot;
                        view.try_login(cx);
                        view.send_presentation(cx);
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        });
        let delay_task = cx.spawn(async move |this, cx| {
            cx.background_executor().timer(LOAD_DELAY).await;
            let _ = this.update(cx, |view, cx| {
                view.load_delayed = true;
                cx.notify();
            });
        });
        let mut tasks = vec![frame_task, ui_task, status_task, delay_task];
        match Lucent::get(cx)
            .scripting
            .open_account(host.session().clone())
        {
            Ok((runtime, events)) => {
                tasks.push(cx.spawn(async move |this, cx| {
                    while let Ok(event) = events.recv().await {
                        if this
                            .update(cx, |view, cx| view.on_account(event, cx))
                            .is_err()
                        {
                            break;
                        }
                    }
                }));
                self.runtime = Some(runtime);
            }
            Err(error) => {
                tracing::error!(%error, "could not start the account runtime");
                self.session.runtime_error = Some(error.to_string());
            }
        }
        self.input = Some(host.input().clone());
        host.input()
            .set_volume(if Lucent::get(cx).muted { 0.0 } else { 1.0 });
        if !self.visible {
            host.input().set_visibility(Visibility::Hidden);
        }
        self.boot = host.session().status().boot;
        self.load_delayed = false;
        self.host = Some(host);
        self._tasks = tasks;
        self.viewport.set(Viewport::AUTHORED);
        self.session.runtime_ready = false;
        self.session.player = None;
        if self.account.is_some() {
            self.login = Login::Pending;
        }
        cx.notify();
    }

    fn on_account(&mut self, event: AccountEvent, cx: &mut Context<Self>) {
        match event {
            AccountEvent::Ready => {
                self.session.runtime_ready = true;
                self.session.runtime_error = None;
                self.try_login(cx);
                self.send_presentation(cx);
            }
            AccountEvent::Failed(error) => {
                self.log(
                    ConsoleLevel::Error,
                    format!("The script runtime failed: {error}"),
                );
                self.session.runtime_error = Some(error);
            }
            AccountEvent::Restarted(reason) => {
                self.session.runtime_ready = false;
                self.session.status = ScriptStatus::idle();
                self.session.dialog = None;
                self.log(
                    ConsoleLevel::Warn,
                    format!("The script runtime was restarted ({reason}). Load the script again to run it."),
                );
                self.session.script = None;
            }
            AccountEvent::Player(player) => {
                let ready = player.is_some();
                self.session.player = player;
                if ready {
                    self.send_presentation(cx);
                }
                if ready && let Some(choice) = self.pending_script.take() {
                    self.launch_script(choice, cx);
                }
            }
            AccountEvent::ScriptStatus(status) => {
                self.session.status = ScriptStatus::from_value(&status);
            }
            AccountEvent::Dialog(dialog) => {
                self.session.dialog = dialog.as_ref().and_then(ScriptDialog::from_value);
            }
            AccountEvent::Console { level, text } => self.log(level, text),
            AccountEvent::CloseRequested => cx.emit(CloseRequested),
        }
        cx.notify();
    }

    fn log(&mut self, level: ConsoleLevel, text: String) {
        if self.session.console.len() == CONSOLE_LINES {
            self.session.console.pop_front();
        }
        self.session.console.push_back(ConsoleLine { level, text });
    }

    pub fn clear_console(&mut self, cx: &mut Context<Self>) {
        self.session.console.clear();
        cx.notify();
    }

    fn try_login(&mut self, cx: &mut Context<Self>) {
        if self.login != Login::Pending || !self.session.runtime_ready || self.boot != Boot::Ready {
            return;
        }
        let Some(account) = &self.account else {
            return;
        };
        self.login = Login::Sent;
        let mut input = json!({ "username": account.username, "password": account.password });
        if let Some(server) = &self.server {
            input["server"] = Value::String(server.clone());
        }
        self.log(
            ConsoleLevel::Info,
            format!("Logging in as {}", account.username),
        );
        self.run("login", input, cx, |view, result, _| match result {
            Ok(outcome) => {
                let status = outcome
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("done")
                    .to_owned();
                view.log(ConsoleLevel::Info, format!("Login finished: {status}"));
            }
            Err(error) => view.log(ConsoleLevel::Error, format!("Login failed: {error}")),
        });
    }

    fn run(
        &mut self,
        name: &str,
        input: Value,
        cx: &mut Context<Self>,
        done: impl FnOnce(&mut Self, Result<Value, String>, &mut Context<Self>) + 'static,
    ) {
        let Some(runtime) = &self.runtime else {
            done(self, Err("The script runtime is not running.".into()), cx);
            return;
        };
        let reply = runtime.command(name, input);
        cx.spawn(async move |this, cx| {
            let result = reply
                .await
                .unwrap_or_else(|_| Err("The script runtime stopped before answering.".into()));
            let _ = this.update(cx, |view, cx| {
                done(view, result, cx);
                cx.notify();
            });
        })
        .detach();
    }

    pub fn load_script(&mut self, choice: ScriptChoice, cx: &mut Context<Self>) {
        self.load(choice, false, cx);
    }

    /// Loads the script and starts it, as Electron does after a launch logs in.
    fn launch_script(&mut self, choice: ScriptChoice, cx: &mut Context<Self>) {
        self.log(ConsoleLevel::Info, format!("Loading {}", choice.name));
        self.load(choice, true, cx);
    }

    fn load(&mut self, choice: ScriptChoice, start: bool, cx: &mut Context<Self>) {
        self.session.busy = true;
        let input = choice.command_input();
        self.run("load-script", input, cx, move |view, result, cx| {
            view.session.busy = false;
            match result {
                Ok(loaded) => {
                    view.log(ConsoleLevel::Info, format!("Loaded {}", choice.name));
                    let has_inputs = loaded["hasInputs"] == Value::Bool(true);
                    view.session.script = Some(LoadedScript { choice, has_inputs });
                    if start {
                        view.start_script(cx);
                    }
                }
                Err(error) => view.log(
                    ConsoleLevel::Error,
                    format!("Could not load the script: {error}"),
                ),
            }
        });
        cx.notify();
    }

    pub fn start_script(&mut self, cx: &mut Context<Self>) {
        if self.session.script.is_none() {
            return;
        }
        self.session.busy = true;
        self.run("start-script", json!({}), cx, |view, result, cx| {
            view.session.busy = false;
            match result {
                Ok(started) if started["needsInputs"] == Value::Bool(true) => {
                    view.log(
                        ConsoleLevel::Warn,
                        "This script needs inputs before it can start.".into(),
                    );
                    view.edit_inputs(cx);
                }
                Ok(_) => {}
                Err(error) => view.log(ConsoleLevel::Error, error),
            }
        });
        cx.notify();
    }

    pub fn has_inputs(&self) -> bool {
        self.session
            .script
            .as_ref()
            .is_some_and(|script| script.has_inputs)
    }

    pub fn edit_inputs(&mut self, cx: &mut Context<Self>) {
        self.run(
            "get-inputs",
            json!({}),
            cx,
            |view, result, _| match result {
                Ok(inputs) => {
                    view.session.inputs_error = None;
                    view.session.inputs = ScriptInputs::from_value(&inputs);
                }
                Err(error) => view.log(
                    ConsoleLevel::Error,
                    format!("Could not read the script inputs: {error}"),
                ),
            },
        );
    }

    pub fn close_inputs(&mut self, cx: &mut Context<Self>) {
        self.session.inputs = None;
        self.session.inputs_error = None;
        cx.notify();
    }

    /// Saves the values, then starts the script when `start` is set.
    pub fn save_inputs(
        &mut self,
        values: serde_json::Map<String, Value>,
        start: bool,
        cx: &mut Context<Self>,
    ) {
        self.run(
            "save-inputs",
            json!({ "values": values }),
            cx,
            move |view, result, cx| match result {
                Ok(_) => {
                    view.session.inputs = None;
                    view.session.inputs_error = None;
                    if start {
                        view.start_script(cx);
                    }
                }
                Err(error) => view.session.inputs_error = Some(error),
            },
        );
    }

    pub fn stop_script(&mut self, cx: &mut Context<Self>) {
        self.run("stop-script", json!({}), cx, |view, result, _| {
            if let Err(error) = result {
                view.log(
                    ConsoleLevel::Error,
                    format!("Could not stop the script: {error}"),
                );
            }
        });
    }

    pub fn answer_dialog(&mut self, answer: DialogAnswer, cx: &mut Context<Self>) {
        let Some(dialog) = self.session.dialog.take() else {
            return;
        };
        let response = match answer {
            DialogAnswer::Dismissed => json!({ "id": dialog.id, "kind": "alert" }),
            DialogAnswer::Confirmed(confirmed) => {
                json!({ "id": dialog.id, "kind": "confirm", "confirmed": confirmed })
            }
            DialogAnswer::Prompted(value) => {
                json!({ "id": dialog.id, "kind": "prompt", "value": value })
            }
        };
        self.run(
            "respond-dialog",
            json!({ "response": response }),
            cx,
            |view, result, _| {
                if let Err(error) = result {
                    view.log(
                        ConsoleLevel::Error,
                        format!("Could not answer the dialog: {error}"),
                    );
                }
            },
        );
        cx.notify();
    }

    fn reload(&mut self, cx: &mut Context<Self>) {
        let shutdown = self.take_shutdown();
        cx.background_executor().spawn(shutdown).detach();
        self.spawn_player(cx);
    }

    fn take_shutdown(&mut self) -> BoxFuture<'static, ()> {
        let runtime = self.runtime.take();
        let host = self.host.take();
        self.input = None;
        self._tasks.clear();
        async move {
            let deadline = Instant::now() + SHUTDOWN_DEADLINE;
            if let Some(runtime) = runtime {
                runtime.close(deadline);
            }
            if let Some(host) = host {
                let report = host.shutdown(deadline);
                tracing::info!(?report, "player stopped");
            }
        }
        .boxed()
    }

    /// Stops the script runtime and the player. The future blocks, so run it on the
    /// background executor.
    pub fn shutdown(&mut self) -> BoxFuture<'static, ()> {
        self.take_shutdown()
    }

    fn apply(&mut self, request: UiRequest, cx: &mut Context<Self>) {
        match request {
            UiRequest::Cursor(cursor) => {
                self.cursor = match cursor {
                    MouseCursor::Arrow => CursorStyle::Arrow,
                    MouseCursor::Hand => CursorStyle::PointingHand,
                    MouseCursor::IBeam => CursorStyle::IBeam,
                    MouseCursor::Grab => CursorStyle::ClosedHand,
                };
                cx.notify();
            }
            UiRequest::CursorVisible(visible) => {
                tracing::debug!(
                    visible,
                    "the game changed cursor visibility, which the window does not support"
                );
            }
            UiRequest::SetClipboard(text) => cx.write_to_clipboard(ClipboardItem::new_string(text)),
            UiRequest::OpenUrl(url) => cx.open_url(url.as_str()),
        }
    }

    fn key_down(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) {
        self.send(PlayerEvent::KeyDown {
            key: keys::descriptor(&event.keystroke),
        });
        match keys::text_control(&event.keystroke) {
            Some(TextControlCode::Paste) => {
                let text = cx
                    .read_from_clipboard()
                    .and_then(|item| item.text())
                    .unwrap_or_default();
                if let Some(input) = &self.input {
                    input.paste(text);
                }
            }
            Some(code) => self.send(PlayerEvent::TextControl { code }),
            None => {}
        }
    }

    fn key_up(&mut self, event: &KeyUpEvent) {
        self.send(PlayerEvent::KeyUp {
            key: keys::descriptor(&event.keystroke),
        });
    }

    fn modifiers_changed(&mut self, event: &ModifiersChangedEvent) {
        let before = keys::modifier_keys(&self.modifiers);
        let after = keys::modifier_keys(&event.modifiers);
        for ((was, _), (is, key)) in before.into_iter().zip(after) {
            match (was, is) {
                (false, true) => self.send(PlayerEvent::KeyDown { key }),
                (true, false) => self.send(PlayerEvent::KeyUp { key }),
                _ => {}
            }
        }
        self.modifiers = event.modifiers;
    }

    fn release_input(&mut self) {
        for (held, key) in keys::modifier_keys(&self.modifiers) {
            if held {
                self.send(PlayerEvent::KeyUp { key });
            }
        }
        self.modifiers = gpui::Modifiers::default();
        self.send(PlayerEvent::FocusLost);
    }
}

fn game_button(button: MouseButton) -> GameButton {
    match button {
        MouseButton::Left => GameButton::Left,
        MouseButton::Right => GameButton::Right,
        MouseButton::Middle => GameButton::Middle,
        _ => GameButton::Unknown,
    }
}

fn physical(position: Point<Pixels>, bounds: Bounds<Pixels>, scale: f32) -> (f64, f64) {
    let x = f32::from(position.x - bounds.origin.x) * scale;
    let y = f32::from(position.y - bounds.origin.y) * scale;
    (f64::from(x), f64::from(y))
}

impl Render for GameView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.presented.retire(window);
        let image = self.presented.image();
        let input = self.input.clone();
        let viewport = self.viewport.clone();
        let focus = self.focus.clone();
        let cursor = self.cursor;
        let entity = cx.entity();
        let game = canvas(
            move |bounds, window, _| {
                let scale = window.scale_factor();
                let size = Viewport {
                    width: (f32::from(bounds.size.width) * scale).round().max(1.0) as u32,
                    height: (f32::from(bounds.size.height) * scale).round().max(1.0) as u32,
                    scale: f64::from(scale),
                };
                if viewport.get() != size {
                    viewport.set(size);
                    if let Some(input) = &input {
                        input.resize(size);
                    }
                }
                (window.insert_hitbox(bounds, HitboxBehavior::Normal), input)
            },
            move |bounds, (hitbox, input), window, cx| {
                if let Some(image) = image {
                    let _ = window.paint_image(bounds, Corners::default(), image, 0, false);
                }
                window.set_cursor_style(cursor, &hitbox);
                window.handle_input(&focus, ElementInputHandler::new(bounds, entity), cx);
                let Some(input) = input else {
                    return;
                };
                let scale = window.scale_factor();
                window.on_mouse_event({
                    let (input, hitbox) = (input.clone(), hitbox.clone());
                    move |event: &MouseDownEvent, phase, window, _| {
                        if phase == DispatchPhase::Bubble && hitbox.is_hovered(window) {
                            let (x, y) = physical(event.position, bounds, scale);
                            input.send(PlayerEvent::MouseDown {
                                x,
                                y,
                                button: game_button(event.button),
                                index: None,
                            });
                        }
                    }
                });
                window.on_mouse_event({
                    let input = input.clone();
                    move |event: &MouseUpEvent, phase, _, _| {
                        if phase == DispatchPhase::Bubble {
                            let (x, y) = physical(event.position, bounds, scale);
                            input.send(PlayerEvent::MouseUp {
                                x,
                                y,
                                button: game_button(event.button),
                            });
                        }
                    }
                });
                window.on_mouse_event({
                    let (input, hitbox) = (input.clone(), hitbox.clone());
                    move |event: &MouseMoveEvent, phase, window, _| {
                        if phase == DispatchPhase::Bubble
                            && (hitbox.is_hovered(window) || event.pressed_button.is_some())
                        {
                            let (x, y) = physical(event.position, bounds, scale);
                            input.send(PlayerEvent::MouseMove { x, y });
                        }
                    }
                });
                window.on_mouse_event({
                    let (input, hitbox) = (input.clone(), hitbox.clone());
                    move |event: &ScrollWheelEvent, phase, window, _| {
                        if phase == DispatchPhase::Bubble && hitbox.is_hovered(window) {
                            let delta = match event.delta {
                                ScrollDelta::Lines(lines) => {
                                    MouseWheelDelta::Lines(f64::from(lines.y))
                                }
                                ScrollDelta::Pixels(pixels) => {
                                    MouseWheelDelta::Pixels(f64::from(f32::from(pixels.y) * scale))
                                }
                            };
                            input.send(PlayerEvent::MouseWheel { delta });
                        }
                    }
                });
                window.on_mouse_event(move |_: &MouseExitEvent, phase, _, _: &mut App| {
                    if phase == DispatchPhase::Bubble {
                        input.send(PlayerEvent::MouseLeave);
                    }
                });
            },
        )
        .size_full();
        div()
            .relative()
            .size_full()
            .bg(rgb(0x000000))
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|view, event, _, cx| view.key_down(event, cx)))
            .on_key_up(cx.listener(|view, event, _, _| view.key_up(event)))
            .on_modifiers_changed(cx.listener(|view, event, _, _| view.modifiers_changed(event)))
            .child(game)
            .when_some(overlay(&self.boot, self.load_delayed), |root, overlay| {
                let reload = overlay.offers_reload.then(|| {
                    div()
                        .id("reload-game")
                        .mt_3()
                        .px_3()
                        .py_1()
                        .rounded_md()
                        .border_1()
                        .border_color(rgb(0x52525b))
                        .cursor_pointer()
                        .hover(|style| style.bg(rgb(0x27272a)))
                        .child("Reload game")
                        .on_click(cx.listener(|view, _, _, cx| view.reload(cx)))
                });
                root.child(
                    div()
                        .absolute()
                        .inset_0()
                        .occlude()
                        .flex()
                        .flex_col()
                        .items_center()
                        .justify_center()
                        .gap_1()
                        .bg(rgb(0x000000))
                        .text_color(rgb(0xd4d4d8))
                        .text_size(px(14.))
                        .child(overlay.title)
                        .children(overlay.detail)
                        .children(reload),
                )
            })
    }
}

struct Overlay {
    title: String,
    detail: Option<&'static str>,
    offers_reload: bool,
}

fn overlay(boot: &Boot, delayed: bool) -> Option<Overlay> {
    let loading = |title: String| {
        if delayed {
            Overlay {
                title: "Still loading...".into(),
                detail: Some(
                    "The game is taking longer than expected. You can keep waiting or reload it.",
                ),
                offers_reload: true,
            }
        } else {
            Overlay {
                title,
                detail: None,
                offers_reload: false,
            }
        }
    };
    Some(match boot {
        Boot::Ready => return None,
        Boot::Starting => loading("Loading".into()),
        Boot::Downloading { percent } => loading(format!("Loading {percent}%")),
        Boot::Failed { error } => Overlay {
            title: format!("The game could not start: {error}"),
            detail: None,
            offers_reload: true,
        },
        Boot::Stopping => Overlay {
            title: "Closing".into(),
            detail: None,
            offers_reload: false,
        },
    })
}

impl EntityInputHandler for GameView {
    fn text_for_range(
        &mut self,
        _: Range<usize>,
        _: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        None
    }

    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: 0..0,
            reversed: false,
        })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.composing.clone()
    }

    fn unmark_text(&mut self, _: &mut Window, _: &mut Context<Self>) {
        if self.composing.take().is_some() {
            self.send(PlayerEvent::Ime(ImeEvent::Preedit(String::new(), None)));
        }
    }

    fn replace_text_in_range(
        &mut self,
        _: Option<Range<usize>>,
        text: &str,
        _: &mut Window,
        _: &mut Context<Self>,
    ) {
        if self.composing.take().is_some() {
            self.send(PlayerEvent::Ime(ImeEvent::Commit(text.to_owned())));
            return;
        }
        // Control characters arrive as key downs and text controls, so inserting them too would repeat them.
        for codepoint in text.chars().filter(|character| !character.is_control()) {
            self.send(PlayerEvent::TextInput { codepoint });
        }
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        _: Option<Range<usize>>,
        text: &str,
        selected: Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) {
        let length = text.encode_utf16().count();
        self.composing = (length > 0).then_some(0..length);
        let cursor = selected.map(|range| (range.start, range.end));
        self.send(PlayerEvent::Ime(ImeEvent::Preedit(text.to_owned(), cursor)));
    }

    fn bounds_for_range(
        &mut self,
        _: Range<usize>,
        element_bounds: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        Some(element_bounds)
    }

    fn character_index_for_point(
        &mut self,
        _: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        None
    }
}

pub fn observe_focus(view: &Entity<GameView>, window: &mut Window, cx: &mut App) {
    let focus = view.read(cx).focus.clone();
    let view = view.downgrade();
    window
        .on_focus_out(&focus, cx, move |_, _, cx| {
            let _ = view.update(cx, |view, _| view.release_input());
        })
        .detach();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_script_runner_statuses() {
        let failed = ScriptStatus::from_value(&json!({
            "state": "failed",
            "name": "farm.js",
            "message": "Boom",
            "failedAt": "now",
        }));
        assert_eq!(failed.label(), "Failed: Boom");
        assert!(!failed.is_active());
        let stopped =
            ScriptStatus::from_value(&json!({ "state": "stopped", "reason": "Connection lost" }));
        assert_eq!(stopped.label(), "Stopped: Connection lost");
        assert!(ScriptStatus::from_value(&json!({ "state": "waiting-to-restart" })).is_active());
        assert_eq!(ScriptStatus::from_value(&json!({})).label(), "Idle");
    }

    #[test]
    fn reads_script_dialog_requests() {
        assert_eq!(
            ScriptDialog::from_value(&json!({
                "id": 3,
                "kind": "prompt",
                "message": "Name?",
                "placeholder": "Artix",
                "sourceName": "farm.js",
            })),
            Some(ScriptDialog {
                id: 3,
                kind: DialogKind::Prompt {
                    placeholder: "Artix".into()
                },
                message: "Name?".into(),
                source: "farm.js".into(),
            })
        );
        assert_eq!(
            ScriptDialog::from_value(&json!({ "id": 1, "kind": "toast", "message": "x" })),
            None
        );
    }

    fn shown(boot: Boot, delayed: bool) -> Option<(String, bool)> {
        overlay(&boot, delayed).map(|overlay| (overlay.title, overlay.offers_reload))
    }

    #[test]
    fn offers_a_reload_once_loading_is_slow_or_has_failed() {
        assert_eq!(
            shown(Boot::Downloading { percent: 40 }, false),
            Some(("Loading 40%".into(), false))
        );
        assert_eq!(
            shown(Boot::Downloading { percent: 40 }, true),
            Some(("Still loading...".into(), true))
        );
        assert_eq!(
            shown(Boot::Starting, true),
            Some(("Still loading...".into(), true))
        );
        assert_eq!(
            shown(
                Boot::Failed {
                    error: "offline".into()
                },
                false
            ),
            Some(("The game could not start: offline".into(), true))
        );
        assert_eq!(shown(Boot::Stopping, true), Some(("Closing".into(), false)));
        assert_eq!(shown(Boot::Ready, true), None);
    }
}
