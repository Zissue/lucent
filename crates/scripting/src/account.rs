use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use bridge::{
    CallError, CallbackName, Caller, Delivery, GameEvent, LoaderEvent, Session, SfsConnection,
};
use futures::channel::oneshot;
use js::{Arg, Exit, Host, HostError, Ret};
use serde_json::{Value, json};

use crate::router::Router;
use crate::value::{from_as, to_as};

const ACCOUNT_BUNDLE: &str = include_str!("../../../assets/native/account.js");
const SWF_CALL_DEADLINE: Duration = Duration::from_secs(5);
const HEAP_LIMIT: usize = 512 << 20;
const WATCHDOG: Duration = Duration::from_secs(10);
const RESTART_DELAY: Duration = Duration::from_millis(250);

#[derive(Clone, Debug, PartialEq)]
pub enum ConsoleLevel {
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Clone, Debug, PartialEq)]
pub enum AccountEvent {
    Ready,
    Failed(String),
    /// The runtime was terminated (a runaway script or the heap limit) and restarted.
    Restarted(String),
    Player(Option<String>),
    ScriptStatus(Value),
    Dialog(Option<Value>),
    Console {
        level: ConsoleLevel,
        text: String,
    },
    /// `script.exit({ closeClient: true })` asked to close this game.
    CloseRequested,
}

#[derive(Clone, Debug)]
pub struct AccountOptions {
    pub debug: bool,
}

pub(crate) struct AccountInner {
    key: u64,
    session: Session,
    router: Arc<Router>,
    options: AccountOptions,
    events: async_channel::Sender<AccountEvent>,
    runtime: Mutex<Option<Arc<js::Runtime>>>,
    commands: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    next_command: AtomicU64,
    closed: AtomicBool,
}

impl AccountInner {
    pub(crate) fn post(&self, item: String) {
        if let Some(runtime) = &*self.runtime.lock().unwrap() {
            runtime.post(item);
        }
    }

    fn emit(&self, event: AccountEvent) {
        let _ = self.events.try_send(event);
    }
}

/// One account's game runtime: the flash api, automation, and the script runner in a
/// V8 isolate, fed by the account's player session.
pub struct AccountRuntime {
    inner: Arc<AccountInner>,
}

impl AccountRuntime {
    pub(crate) fn open(
        key: u64,
        session: Session,
        router: Arc<Router>,
        options: AccountOptions,
    ) -> std::io::Result<(AccountRuntime, async_channel::Receiver<AccountEvent>)> {
        let (events, receiver) = async_channel::unbounded();
        let inner = Arc::new(AccountInner {
            key,
            session,
            router: router.clone(),
            options,
            events,
            runtime: Mutex::new(None),
            commands: Mutex::new(HashMap::new()),
            next_command: AtomicU64::new(1),
            closed: AtomicBool::new(false),
        });
        router.register(key, Arc::downgrade(&inner));
        spawn_pump(&inner)?;
        spawn_runtime(&inner)?;
        Ok((AccountRuntime { inner }, receiver))
    }

    pub fn key(&self) -> u64 {
        self.inner.key
    }

    /// Runs a controller command in the account's runtime (`login`, `load-script`,
    /// `start-script`, `stop-script`, `respond-dialog`).
    pub fn command(&self, name: &str, input: Value) -> oneshot::Receiver<Result<Value, String>> {
        let (tx, rx) = oneshot::channel();
        let id = self.inner.next_command.fetch_add(1, Ordering::Relaxed);
        self.inner.commands.lock().unwrap().insert(id, tx);
        let item = json!({ "t": "cmd", "id": id, "name": name, "input": input });
        self.inner.post(item.to_string());
        rx
    }

    pub fn close(&self, deadline: Instant) {
        self.inner.closed.store(true, Ordering::Release);
        self.inner.router.unregister(self.inner.key);
        if let Some(runtime) = self.inner.runtime.lock().unwrap().take() {
            runtime.join(deadline);
        }
        self.inner.commands.lock().unwrap().clear();
    }
}

impl Drop for AccountRuntime {
    fn drop(&mut self) {
        if !self.inner.closed.load(Ordering::Acquire) {
            self.close(Instant::now() + Duration::from_secs(1));
        }
    }
}

fn spawn_runtime(inner: &Arc<AccountInner>) -> std::io::Result<()> {
    let run = inner
        .session
        .begin_run()
        .map_err(|_| std::io::Error::other("the player session has ended"))?;
    let host = AccountHost {
        inner: inner.clone(),
        caller: run.caller(),
        _run: run,
        next_invoke: 1,
    };
    let weak = Arc::downgrade(inner);
    let runtime = js::Runtime::spawn(
        js::Config {
            name: format!("account-{}", inner.key),
            source: Arc::from(ACCOUNT_BUNDLE),
            heap_limit: HEAP_LIMIT,
            watchdog: Some(WATCHDOG),
        },
        host,
        move |exit| {
            let Some(inner) = weak.upgrade() else {
                return;
            };
            match exit {
                Exit::Stopped => {}
                Exit::Failed(error) => {
                    tracing::error!(%error, "an account runtime failed");
                    inner.emit(AccountEvent::Failed(error));
                }
                Exit::Terminated(reason) => {
                    if inner.closed.load(Ordering::Acquire) {
                        return;
                    }
                    tracing::warn!(%reason, "restarting an account runtime");
                    for (_, pending) in inner.commands.lock().unwrap().drain() {
                        let _ =
                            pending.send(Err(format!("The script runtime restarted ({reason}).")));
                    }
                    inner
                        .router
                        .post_hub(format!(r#"{{"t":"restarted","account":{}}}"#, inner.key));
                    thread::sleep(RESTART_DELAY);
                    match spawn_runtime(&inner) {
                        Ok(()) => inner.emit(AccountEvent::Restarted(reason)),
                        Err(error) => inner.emit(AccountEvent::Failed(error.to_string())),
                    }
                }
            }
        },
    )?;
    *inner.runtime.lock().unwrap() = Some(runtime);
    Ok(())
}

fn spawn_pump(inner: &Arc<AccountInner>) -> std::io::Result<()> {
    let mut stream = inner
        .session
        .subscribe()
        .map_err(|_| std::io::Error::other("the player session has ended"))?;
    let weak = Arc::downgrade(inner);
    thread::Builder::new()
        .name(format!("account-{}-events", inner.key))
        .spawn(move || {
            while let Ok(delivery) = stream.recv_blocking() {
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                if inner.closed.load(Ordering::Acquire) {
                    return;
                }
                match delivery {
                    Delivery::Event(event) => {
                        if let GameEvent::Loader(loader) = &event.kind
                            && let Some(item) = loader_item(loader)
                        {
                            inner.post(item);
                        }
                    }
                    Delivery::Gap { missed } => {
                        tracing::warn!(missed, "the account runtime fell behind the game's events");
                    }
                }
            }
        })?;
    Ok(())
}

fn loader_item(event: &LoaderEvent) -> Option<String> {
    let (name, args): (&str, Value) = match event {
        LoaderEvent::Progress(percent) => ("onProgress", json!([percent])),
        LoaderEvent::Loaded => ("onLoaded", json!([])),
        LoaderEvent::Connection(status) => (
            "onConnection",
            json!([match status {
                SfsConnection::Connected => "OnConnection",
                SfsConnection::Failed => "OnConnectionFailed",
                SfsConnection::Lost => "OnConnectionLost",
            }]),
        ),
        LoaderEvent::Debug(text) => ("onDebug", json!([text])),
        LoaderEvent::ExtensionResponse(raw) => ("onExtensionResponse", json!([raw])),
        LoaderEvent::PacketFromClient(raw) => ("packetFromClient", json!([raw])),
        LoaderEvent::PacketFromServer(raw) => ("packetFromServer", json!([raw])),
        LoaderEvent::Unrecognized { name, args } => {
            let args = args
                .iter()
                .cloned()
                .map(|arg| from_as(arg).unwrap_or(Value::Null))
                .collect();
            return Some(
                json!({ "t": "loader", "name": name, "args": Value::Array(args) }).to_string(),
            );
        }
    };
    Some(json!({ "t": "loader", "name": name, "args": args }).to_string())
}

struct AccountHost {
    inner: Arc<AccountInner>,
    caller: Caller,
    _run: bridge::Run,
    next_invoke: u64,
}

fn string_arg(args: &mut std::vec::IntoIter<Arg>, what: &str) -> Result<String, HostError> {
    args.next()
        .and_then(Arg::into_string)
        .ok_or_else(|| HostError::argument(format!("expected {what}")))
}

fn optional_string(args: &mut std::vec::IntoIter<Arg>) -> Option<String> {
    args.next().and_then(Arg::into_string)
}

fn number_arg(args: &mut std::vec::IntoIter<Arg>, what: &str) -> Result<f64, HostError> {
    args.next()
        .and_then(|arg| arg.as_number())
        .ok_or_else(|| HostError::argument(format!("expected {what}")))
}

impl Host for AccountHost {
    fn call(&mut self, op: &str, args: Vec<Arg>) -> Result<Ret, HostError> {
        let mut args = args.into_iter();
        match op {
            "config" => Ok(Ret::Str(
                json!({ "debug": self.inner.options.debug, "os": os() }).to_string(),
            )),
            "swf" => {
                let method = string_arg(&mut args, "a method name")?;
                let argv = string_arg(&mut args, "JSON arguments")?;
                self.swf(&method, &argv)
            }
            "invoke" => {
                let channel = string_arg(&mut args, "a channel")?;
                let payload = optional_string(&mut args);
                let id = self.next_invoke;
                self.next_invoke += 1;
                self.inner
                    .router
                    .invoke(self.inner.key, id, &channel, payload.as_deref());
                Ok(Ret::Number(id as f64))
            }
            "emit" => {
                let kind = string_arg(&mut args, "an event kind")?;
                let payload = string_arg(&mut args, "a JSON payload")?;
                let payload: Value = serde_json::from_str(&payload)
                    .map_err(|error| HostError::argument(error.to_string()))?;
                self.emit(&kind, payload);
                Ok(Ret::Undefined)
            }
            "done" => {
                let id = number_arg(&mut args, "a command id")? as u64;
                let result = string_arg(&mut args, "a JSON result")?;
                let result: Value = serde_json::from_str(&result)
                    .map_err(|error| HostError::argument(error.to_string()))?;
                if let Some(pending) = self.inner.commands.lock().unwrap().remove(&id) {
                    let outcome = if result["ok"] == Value::Bool(true) {
                        Ok(result["value"].clone())
                    } else {
                        Err(result["message"]
                            .as_str()
                            .unwrap_or("The command failed.")
                            .to_owned())
                    };
                    let _ = pending.send(outcome);
                }
                Ok(Ret::Undefined)
            }
            "console" => {
                let level = string_arg(&mut args, "a level")?;
                let text = string_arg(&mut args, "text")?;
                let level = match level.as_str() {
                    "debug" => ConsoleLevel::Debug,
                    "warn" => ConsoleLevel::Warn,
                    "error" => ConsoleLevel::Error,
                    _ => ConsoleLevel::Info,
                };
                match level {
                    ConsoleLevel::Debug => tracing::debug!(account = self.inner.key, "{text}"),
                    ConsoleLevel::Info => tracing::info!(account = self.inner.key, "{text}"),
                    ConsoleLevel::Warn => tracing::warn!(account = self.inner.key, "{text}"),
                    ConsoleLevel::Error => tracing::error!(account = self.inner.key, "{text}"),
                }
                self.inner.emit(AccountEvent::Console { level, text });
                Ok(Ret::Undefined)
            }
            "random" => {
                let length = (number_arg(&mut args, "a length")? as usize).min(65_536);
                let mut bytes = vec![0u8; length];
                getrandom::fill(&mut bytes)
                    .map_err(|error| HostError::new("Error", error.to_string()))?;
                Ok(Ret::Str(
                    bytes.iter().map(|byte| format!("{byte:02x}")).collect(),
                ))
            }
            _ => Err(HostError::argument(format!("unknown op {op}"))),
        }
    }
}

impl AccountHost {
    fn swf(&mut self, method: &str, argv: &str) -> Result<Ret, HostError> {
        let name = CallbackName::new(method).map_err(|_| {
            HostError::new("SwfCallError", format!("invalid Flash method {method}"))
        })?;
        let args = match serde_json::from_str(argv) {
            Ok(Value::Array(items)) => items.into_iter().map(to_as).collect(),
            _ => return Err(HostError::argument("Flash arguments must be a JSON array")),
        };
        match self
            .caller
            .call(&name, args, Instant::now() + SWF_CALL_DEADLINE)
        {
            Ok(value) => Ok(match from_as(value) {
                None => Ret::Undefined,
                Some(value) => Ret::Str(value.to_string()),
            }),
            Err(error) => Err(HostError::new("SwfCallError", describe(error, method))),
        }
    }

    fn emit(&self, kind: &str, payload: Value) {
        let event = match kind {
            "ready" => AccountEvent::Ready,
            "failed" => AccountEvent::Failed(payload.as_str().unwrap_or_default().to_owned()),
            "player" => AccountEvent::Player(payload["username"].as_str().map(str::to_owned)),
            "script-status" => AccountEvent::ScriptStatus(payload),
            "dialog" => AccountEvent::Dialog((!payload.is_null()).then_some(payload)),
            "close-client" => AccountEvent::CloseRequested,
            "loaded" | "progress" => return,
            other => {
                tracing::debug!(kind = other, "ignored an account event");
                return;
            }
        };
        self.inner.emit(event);
    }
}

fn describe(error: CallError, method: &str) -> String {
    match error {
        CallError::NotRun(bridge::NotRun::NotRegistered) => {
            format!("Missing Flash method: {method}")
        }
        other => format!("{method} failed: {other:?}"),
    }
}

fn os() -> &'static str {
    if cfg!(target_os = "macos") {
        "mac"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}
