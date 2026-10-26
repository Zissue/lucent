mod runtime;

use std::sync::atomic::Ordering;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

pub use runtime::Exit;

pub fn init() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        // TurboFan can keep running a loop after TerminateExecution, which the watchdog relies on.
        v8::V8::set_flags_from_string("--no-turbofan");
        let platform = v8::new_default_platform(2, false).make_shared();
        v8::V8::initialize_platform(platform);
        v8::V8::initialize();
    });
}

#[derive(Clone, Debug, PartialEq)]
pub enum Arg {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    Str(String),
}

impl Arg {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Arg::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn into_string(self) -> Option<String> {
        match self {
            Arg::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_number(&self) -> Option<f64> {
        match self {
            Arg::Number(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Arg::Bool(b) => Some(*b),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Ret {
    Undefined,
    Bool(bool),
    Number(f64),
    Str(String),
}

#[derive(Debug)]
pub struct HostError {
    pub name: &'static str,
    pub message: String,
}

impl HostError {
    pub fn new(name: &'static str, message: impl Into<String>) -> Self {
        Self {
            name,
            message: message.into(),
        }
    }

    pub fn argument(message: impl Into<String>) -> Self {
        Self::new("HostArgumentError", message)
    }
}

/// Runs on the runtime's thread for every `__host.call(op, ...args)`.
pub trait Host: Send + 'static {
    fn call(&mut self, op: &str, args: Vec<Arg>) -> Result<Ret, HostError>;
}

pub struct Config {
    pub name: String,
    pub source: Arc<str>,
    pub heap_limit: usize,
    /// A turn that runs longer than this while JS has armed the watchdog is terminated.
    pub watchdog: Option<Duration>,
}

pub struct Runtime {
    inbox: Sender<runtime::Message>,
    shared: Arc<runtime::Shared>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl Runtime {
    pub fn spawn(
        config: Config,
        host: impl Host,
        on_exit: impl FnOnce(Exit) + Send + 'static,
    ) -> std::io::Result<Arc<Runtime>> {
        init();
        let (inbox, rx) = mpsc::channel();
        let shared = Arc::new(runtime::Shared::new());
        let watchdog = config.watchdog;
        let thread = thread::Builder::new()
            .name(format!("js-{}", config.name))
            .stack_size(8 << 20)
            .spawn({
                let shared = shared.clone();
                move || {
                    let exit = runtime::run(config, Box::new(host), rx, shared);
                    on_exit(exit);
                }
            })?;
        let runtime = Arc::new(Runtime {
            inbox,
            shared: shared.clone(),
            thread: Mutex::new(Some(thread)),
        });
        if let Some(limit) = watchdog {
            spawn_watchdog(Arc::downgrade(&shared), limit)?;
        }
        Ok(runtime)
    }

    /// Queues one JSON value for the bundle's next `turn`.
    pub fn post(&self, item: String) {
        let _ = self.inbox.send(runtime::Message::Item(item));
    }

    pub fn terminate(&self, reason: &str) {
        self.shared.terminate(reason);
        let _ = self.inbox.send(runtime::Message::Stop);
    }

    pub fn stop(&self) {
        let _ = self.inbox.send(runtime::Message::Stop);
        self.shared.terminate("stopped");
    }

    /// Stops the runtime and waits for its thread, giving up at the deadline.
    pub fn join(&self, deadline: Instant) -> bool {
        self.stop();
        let Some(thread) = self.thread.lock().unwrap().take() else {
            return true;
        };
        while !thread.is_finished() {
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(5));
        }
        let _ = thread.join();
        true
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        self.stop();
    }
}

fn spawn_watchdog(
    shared: std::sync::Weak<runtime::Shared>,
    limit: Duration,
) -> std::io::Result<()> {
    let tick = (limit / 4).max(Duration::from_millis(50));
    thread::Builder::new()
        .name("js-watchdog".into())
        .spawn(move || {
            loop {
                thread::sleep(tick);
                let Some(shared) = shared.upgrade() else {
                    return;
                };
                if shared.finished.load(Ordering::Acquire) {
                    return;
                }
                if shared.turn_overran(limit) {
                    tracing::warn!(?limit, "a script blocked its account; terminating it");
                    shared.terminate("watchdog");
                }
            }
        })?;
    Ok(())
}
