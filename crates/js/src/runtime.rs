use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, TryRecvError};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::{Arg, Config, Host, HostError, Ret};

const BATCH_LIMIT: usize = 512;
const HEAP_HEADROOM: usize = 64 << 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Exit {
    Stopped,
    Terminated(String),
    Failed(String),
}

pub(crate) enum Message {
    Item(String),
    Stop,
}

#[derive(Clone)]
enum Reason {
    Stop,
    Kill(String),
}

pub(crate) struct Shared {
    isolate: OnceLock<v8::IsolateHandle>,
    reason: Mutex<Option<Reason>>,
    pub(crate) finished: AtomicBool,
    started: Instant,
    armed: AtomicBool,
    turn_started: AtomicU64,
}

impl Shared {
    pub(crate) fn new() -> Self {
        Self {
            isolate: OnceLock::new(),
            reason: Mutex::new(None),
            finished: AtomicBool::new(false),
            started: Instant::now(),
            armed: AtomicBool::new(false),
            turn_started: AtomicU64::new(0),
        }
    }

    pub(crate) fn terminate(&self, reason: &str) {
        {
            let mut current = self.reason.lock().unwrap();
            if current.is_none() {
                *current = Some(if reason == "stopped" {
                    Reason::Stop
                } else {
                    Reason::Kill(reason.to_owned())
                });
            }
        }
        if let Some(isolate) = self.isolate.get() {
            isolate.terminate_execution();
        }
    }

    pub(crate) fn turn_overran(&self, limit: Duration) -> bool {
        let started = self.turn_started.load(Ordering::Acquire);
        self.armed.load(Ordering::Acquire)
            && started != 0
            && self.nanos().saturating_sub(started) > limit.as_nanos() as u64
    }

    fn reason(&self) -> Option<Reason> {
        self.reason.lock().unwrap().clone()
    }

    fn ms(&self) -> f64 {
        self.started.elapsed().as_secs_f64() * 1000.0
    }

    fn nanos(&self) -> u64 {
        self.started.elapsed().as_nanos() as u64 + 1
    }
}

struct Slot {
    host: Box<dyn Host>,
    shared: std::sync::Arc<Shared>,
    name: String,
    rejections: Vec<(v8::Global<v8::Promise>, String)>,
}

struct Entry {
    context: v8::Global<v8::Context>,
    turn: v8::Global<v8::Function>,
    wake: v8::Global<v8::Function>,
}

pub(crate) fn run(
    config: Config,
    host: Box<dyn Host>,
    inbox: Receiver<Message>,
    shared: std::sync::Arc<Shared>,
) -> Exit {
    let exit = run_inner(config, host, inbox, &shared);
    shared.finished.store(true, Ordering::Release);
    exit
}

fn run_inner(
    config: Config,
    host: Box<dyn Host>,
    inbox: Receiver<Message>,
    shared: &std::sync::Arc<Shared>,
) -> Exit {
    let params = v8::CreateParams::default().heap_limits(0, config.heap_limit);
    let mut isolate = v8::Isolate::new(params);
    let _ = shared.isolate.set(isolate.thread_safe_handle());
    let near = Box::new(shared.clone());
    isolate.add_near_heap_limit_callback(near_heap_limit, &*near as *const _ as *mut c_void);
    isolate.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
    isolate.set_promise_reject_callback(promise_rejected);
    isolate.set_slot(Slot {
        host,
        shared: shared.clone(),
        name: config.name.clone(),
        rejections: Vec::new(),
    });
    if let Some(reason) = shared.reason() {
        return exit_for(reason);
    }
    let entry = match boot(&mut isolate, &config) {
        Ok(entry) => entry,
        Err(error) => {
            return match shared.reason() {
                Some(reason) => exit_for(reason),
                None => Exit::Failed(error),
            };
        }
    };
    let mut batch: Vec<String> = Vec::new();
    let exit = loop {
        if let Some(reason) = shared.reason() {
            break exit_for(reason);
        }
        if batch.is_empty() {
            let next = match wake(&mut isolate, &entry) {
                Ok(next) => next,
                Err(error) => {
                    break shared.reason().map(exit_for).unwrap_or(Exit::Failed(error));
                }
            };
            let wait = if next.is_finite() {
                Some(Duration::from_secs_f64(
                    ((next - shared.ms()) / 1000.0).max(0.0),
                ))
            } else {
                None
            };
            let received = match wait {
                Some(wait) if wait.is_zero() => None,
                Some(wait) => match inbox.recv_timeout(wait) {
                    Ok(message) => Some(message),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => break Exit::Stopped,
                },
                None => match inbox.recv() {
                    Ok(message) => Some(message),
                    Err(_) => break Exit::Stopped,
                },
            };
            match received {
                Some(Message::Item(item)) => batch.push(item),
                Some(Message::Stop) => break Exit::Stopped,
                None => {}
            }
        }
        let mut stop = false;
        while batch.len() < BATCH_LIMIT {
            match inbox.try_recv() {
                Ok(Message::Item(item)) => batch.push(item),
                Ok(Message::Stop) => {
                    stop = true;
                    break;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    stop = true;
                    break;
                }
            }
        }
        if stop {
            break Exit::Stopped;
        }
        let text = join_batch(&batch);
        batch.clear();
        shared.turn_started.store(shared.nanos(), Ordering::Release);
        let turned = turn(&mut isolate, &entry, &text);
        shared.turn_started.store(0, Ordering::Release);
        if let Err(error) = turned {
            break shared.reason().map(exit_for).unwrap_or(Exit::Failed(error));
        }
    };
    drop(entry);
    drop(near);
    exit
}

fn exit_for(reason: Reason) -> Exit {
    match reason {
        Reason::Stop => Exit::Stopped,
        Reason::Kill(why) => Exit::Terminated(why),
    }
}

fn join_batch(items: &[String]) -> String {
    let mut text = String::with_capacity(items.iter().map(|i| i.len() + 1).sum::<usize>() + 2);
    text.push('[');
    for (index, item) in items.iter().enumerate() {
        if index > 0 {
            text.push(',');
        }
        text.push_str(item);
    }
    text.push(']');
    text
}

fn boot(isolate: &mut v8::OwnedIsolate, config: &Config) -> Result<Entry, String> {
    v8::scope!(let scope, isolate);
    let context = v8::Context::new(scope, Default::default());
    let scope = &mut v8::ContextScope::new(scope, context);
    v8::tc_scope!(let tc, scope);
    let host = v8::Object::new(tc);
    let functions = [
        ("call", v8::Function::builder(host_call).build(tc)),
        ("now", v8::Function::builder(host_now).build(tc)),
        ("log", v8::Function::builder(host_log).build(tc)),
        ("watch", v8::Function::builder(host_watch).build(tc)),
    ];
    for (name, function) in functions {
        let function = function.ok_or("could not create a host function")?;
        let key = v8::String::new(tc, name).unwrap();
        host.set(tc, key.into(), function.into());
    }
    let global = context.global(tc);
    let key = v8::String::new(tc, "__host").unwrap();
    global.set(tc, key.into(), host.into());

    let code = v8::String::new(tc, &config.source).ok_or("the bundle is too large")?;
    let resource = v8::String::new(tc, &format!("lucent://{}.js", config.name)).unwrap();
    let origin = v8::ScriptOrigin::new(
        tc,
        resource.into(),
        0,
        0,
        false,
        0,
        None,
        false,
        false,
        false,
        None,
    );
    let script = v8::Script::compile(tc, code, Some(&origin)).ok_or_else(|| exception_text(tc))?;
    script.run(tc).ok_or_else(|| exception_text(tc))?;
    tc.perform_microtask_checkpoint();
    if tc.has_caught() {
        return Err(exception_text(tc));
    }
    let key = v8::String::new(tc, "__lucent").unwrap();
    let lucent = global
        .get(tc, key.into())
        .and_then(|value| v8::Local::<v8::Object>::try_from(value).ok())
        .ok_or("the bundle did not define __lucent")?;
    let function = |tc: &mut v8::PinnedRef<'_, v8::TryCatch<'_, '_, v8::HandleScope<'_>>>,
                    name: &str|
     -> Result<v8::Global<v8::Function>, String> {
        let key = v8::String::new(tc, name).unwrap();
        lucent
            .get(tc, key.into())
            .and_then(|value| v8::Local::<v8::Function>::try_from(value).ok())
            .map(|function| v8::Global::new(tc, function))
            .ok_or_else(|| format!("the bundle did not define __lucent.{name}"))
    };
    let turn = function(tc, "turn")?;
    let wake = function(tc, "wake")?;
    Ok(Entry {
        context: v8::Global::new(tc, context),
        turn,
        wake,
    })
}

fn turn(isolate: &mut v8::OwnedIsolate, entry: &Entry, batch: &str) -> Result<(), String> {
    v8::scope!(let scope, isolate);
    let context = v8::Local::new(scope, &entry.context);
    let scope = &mut v8::ContextScope::new(scope, context);
    v8::tc_scope!(let tc, scope);
    let turn = v8::Local::new(tc, &entry.turn);
    let argument = v8::String::new(tc, batch).ok_or("a message batch is too large")?;
    let undefined = v8::undefined(tc);
    let called = turn.call(tc, undefined.into(), &[argument.into()]);
    if tc.has_terminated() || tc.is_execution_terminating() {
        return Err("execution terminated".into());
    }
    if called.is_none() {
        tracing::error!(error = %exception_text(tc), "a turn threw");
        tc.reset();
    }
    tc.perform_microtask_checkpoint();
    if tc.has_terminated() || tc.is_execution_terminating() {
        return Err("execution terminated".into());
    }
    if tc.has_caught() {
        tracing::error!(error = %exception_text(tc), "a microtask threw");
    }
    let slot = tc.get_slot_mut::<Slot>().expect("a runtime slot");
    for (_, reason) in slot.rejections.drain(..) {
        tracing::warn!(runtime = %slot.name, %reason, "unhandled promise rejection");
    }
    Ok(())
}

fn wake(isolate: &mut v8::OwnedIsolate, entry: &Entry) -> Result<f64, String> {
    v8::scope!(let scope, isolate);
    let context = v8::Local::new(scope, &entry.context);
    let scope = &mut v8::ContextScope::new(scope, context);
    v8::tc_scope!(let tc, scope);
    let wake = v8::Local::new(tc, &entry.wake);
    let undefined = v8::undefined(tc);
    let value = wake
        .call(tc, undefined.into(), &[])
        .ok_or_else(|| exception_text(tc))?;
    value.number_value(tc).ok_or_else(|| exception_text(tc))
}

fn exception_text(
    scope: &mut v8::PinnedRef<'_, v8::TryCatch<'_, '_, v8::HandleScope<'_>>>,
) -> String {
    if scope.has_terminated() || scope.is_execution_terminating() {
        return "execution terminated".into();
    }
    let stack = scope
        .stack_trace()
        .map(|value| value.to_rust_string_lossy(scope));
    let message = scope
        .exception()
        .map(|value| value.to_rust_string_lossy(scope))
        .unwrap_or_else(|| "V8 operation failed".into());
    stack.unwrap_or(message)
}

fn throw(scope: &mut v8::PinScope, error: HostError) {
    let Some(message) = v8::String::new(scope, &error.message) else {
        scope.terminate_execution();
        return;
    };
    let exception = v8::Exception::error(scope, message);
    if let Ok(object) = v8::Local::<v8::Object>::try_from(exception) {
        let key = v8::String::new(scope, "name").unwrap();
        let name = v8::String::new(scope, error.name).unwrap();
        object.set(scope, key.into(), name.into());
    }
    scope.throw_exception(exception);
}

fn to_arg(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Result<Arg, HostError> {
    if value.is_undefined() {
        Ok(Arg::Undefined)
    } else if value.is_null() {
        Ok(Arg::Null)
    } else if value.is_boolean() {
        Ok(Arg::Bool(value.boolean_value(scope)))
    } else if value.is_number() {
        Ok(Arg::Number(value.number_value(scope).unwrap_or(f64::NAN)))
    } else if value.is_string() {
        Ok(Arg::Str(value.to_rust_string_lossy(scope)))
    } else {
        Err(HostError::argument(
            "host arguments must be undefined, null, boolean, number, or string",
        ))
    }
}

fn host_call(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let op = args.get(0);
    if !op.is_string() {
        throw(
            scope,
            HostError::argument("the first argument names the op"),
        );
        return;
    }
    let op = op.to_rust_string_lossy(scope);
    let mut argv = Vec::with_capacity(args.length().saturating_sub(1) as usize);
    for index in 1..args.length() {
        match to_arg(scope, args.get(index)) {
            Ok(arg) => argv.push(arg),
            Err(error) => {
                throw(scope, error);
                return;
            }
        }
    }
    let result = scope
        .get_slot_mut::<Slot>()
        .expect("a runtime slot")
        .host
        .call(&op, argv);
    match result {
        Ok(Ret::Undefined) => {}
        Ok(Ret::Bool(value)) => rv.set(v8::Boolean::new(scope, value).into()),
        Ok(Ret::Number(value)) => rv.set(v8::Number::new(scope, value).into()),
        Ok(Ret::Str(value)) => match v8::String::new(scope, &value) {
            Some(value) => rv.set(value.into()),
            None => throw(
                scope,
                HostError::new("RangeError", "a host result is too large"),
            ),
        },
        Err(error) => throw(scope, error),
    }
}

fn host_now(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let now = scope
        .get_slot::<Slot>()
        .expect("a runtime slot")
        .shared
        .ms();
    rv.set(v8::Number::new(scope, now).into());
}

fn host_watch(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let armed = args.get(0).boolean_value(scope);
    scope
        .get_slot::<Slot>()
        .expect("a runtime slot")
        .shared
        .armed
        .store(armed, Ordering::Release);
}

fn host_log(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let level = args.get(0).int32_value(scope).unwrap_or(1);
    let text = args.get(1).to_rust_string_lossy(scope);
    let name = &scope.get_slot::<Slot>().expect("a runtime slot").name;
    match level {
        0 => tracing::debug!(runtime = %name, "{text}"),
        1 => tracing::info!(runtime = %name, "{text}"),
        2 => tracing::warn!(runtime = %name, "{text}"),
        _ => tracing::error!(runtime = %name, "{text}"),
    }
}

extern "C" fn promise_rejected(message: v8::PromiseRejectMessage) {
    v8::callback_scope!(unsafe scope, &message);
    v8::scope!(let scope, scope);
    let promise = message.get_promise();
    match message.get_event() {
        v8::PromiseRejectEvent::PromiseRejectWithNoHandler => {
            let reason = message
                .get_value()
                .map(|value| {
                    v8::Local::<v8::Object>::try_from(value)
                        .ok()
                        .and_then(|object| {
                            let key = v8::String::new(scope, "stack")?;
                            object.get(scope, key.into())
                        })
                        .filter(|stack| stack.is_string())
                        .unwrap_or(value)
                        .to_rust_string_lossy(scope)
                })
                .unwrap_or_default();
            let promise = v8::Global::new(scope, promise);
            if let Some(slot) = scope.get_slot_mut::<Slot>() {
                slot.rejections.push((promise, reason));
            }
        }
        v8::PromiseRejectEvent::PromiseHandlerAddedAfterReject => {
            let promise = v8::Global::new(scope, promise);
            if let Some(slot) = scope.get_slot_mut::<Slot>() {
                slot.rejections.retain(|(pending, _)| *pending != promise);
            }
        }
        _ => {}
    }
}

unsafe extern "C" fn near_heap_limit(data: *mut c_void, current: usize, _initial: usize) -> usize {
    let shared = unsafe { &*(data as *const std::sync::Arc<Shared>) };
    tracing::error!(current, "a runtime reached its heap limit; terminating it");
    shared.terminate("heap limit");
    current.saturating_add(HEAP_HEADROOM)
}
