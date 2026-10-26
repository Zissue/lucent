use std::sync::Arc;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use js::{Arg, Config, Exit, Host, HostError, Ret, Runtime};

const LOOP: &str = r#"
const timers = new Map()
let nextId = 1
globalThis.setTimeout = (fn, ms) => { const id = nextId++; timers.set(id, { at: __host.now() + ms, fn }); return id }
const handlers = []
globalThis.__lucent = {
  turn(text) {
    for (const item of JSON.parse(text)) for (const handler of handlers) handler(item)
    for (const [id, timer] of [...timers]) if (timer.at <= __host.now()) { timers.delete(id); timer.fn() }
  },
  wake() {
    let next = Infinity
    for (const timer of timers.values()) next = Math.min(next, timer.at)
    return next
  },
}
"#;

struct Recorder(mpsc::Sender<String>);

impl Host for Recorder {
    fn call(&mut self, op: &str, args: Vec<Arg>) -> Result<Ret, HostError> {
        match op {
            "record" => {
                let text = args
                    .into_iter()
                    .next()
                    .and_then(Arg::into_string)
                    .unwrap_or_default();
                self.0.send(text).unwrap();
                Ok(Ret::Undefined)
            }
            "double" => Ok(Ret::Number(args[0].as_number().unwrap() * 2.0)),
            "fail" => Err(HostError::new("NotAllowed", "refused")),
            _ => Err(HostError::argument(format!("unknown op {op}"))),
        }
    }
}

fn spawn(
    body: &str,
    watchdog: Option<Duration>,
) -> (Arc<Runtime>, mpsc::Receiver<String>, mpsc::Receiver<Exit>) {
    let (records, recorded) = mpsc::channel();
    let (exits, exited) = mpsc::channel();
    let runtime = Runtime::spawn(
        Config {
            name: "test".into(),
            source: format!("{LOOP}\n{body}").into(),
            heap_limit: 128 << 20,
            watchdog,
        },
        Recorder(records),
        move |exit| exits.send(exit).unwrap(),
    )
    .unwrap();
    (runtime, recorded, exited)
}

const WAIT: Duration = Duration::from_secs(5);

#[test]
fn delivers_posted_items_and_answers_host_ops() {
    let (runtime, recorded, _) = spawn(
        r#"handlers.push((item) => {
            __host.call("record", `${item.n}:${__host.call("double", item.n)}`)
            try { __host.call("fail") } catch (error) { __host.call("record", `${error.name}:${error.message}`) }
        })"#,
        None,
    );
    runtime.post(r#"{"n":21}"#.into());
    assert_eq!(recorded.recv_timeout(WAIT).unwrap(), "21:42");
    assert_eq!(recorded.recv_timeout(WAIT).unwrap(), "NotAllowed:refused");
    assert!(runtime.join(Instant::now() + WAIT));
}

#[test]
fn fires_timers_and_microtasks_without_posted_items() {
    let (runtime, recorded, _) = spawn(
        r#"setTimeout(() => Promise.resolve().then(() => __host.call("record", "timer")), 30)"#,
        None,
    );
    let started = Instant::now();
    assert_eq!(recorded.recv_timeout(WAIT).unwrap(), "timer");
    assert!(started.elapsed() >= Duration::from_millis(25));
    assert!(runtime.join(Instant::now() + WAIT));
}

#[test]
fn keeps_running_after_a_handler_throws() {
    let (runtime, recorded, _) = spawn(
        r#"handlers.push((item) => {
            if (item.boom) { __host.call("record", "boom"); throw new Error("boom") }
            __host.call("record", "ok")
        })"#,
        None,
    );
    runtime.post(r#"{"boom":true}"#.into());
    assert_eq!(recorded.recv_timeout(WAIT).unwrap(), "boom");
    runtime.post(r#"{"boom":false}"#.into());
    assert_eq!(recorded.recv_timeout(WAIT).unwrap(), "ok");
    assert!(runtime.join(Instant::now() + WAIT));
}

#[test]
fn watchdog_terminates_an_armed_runaway_turn_only() {
    let (_runtime, recorded, exited) = spawn(
        r#"handlers.push((item) => {
            __host.watch(item.armed)
            const until = __host.now() + item.ms
            while (__host.now() < until) {}
            __host.call("record", "done")
            if (item.forever) for (;;) {}
        })"#,
        Some(Duration::from_millis(200)),
    );
    _runtime.post(r#"{"armed":false,"ms":400}"#.into());
    assert_eq!(recorded.recv_timeout(WAIT).unwrap(), "done");
    _runtime.post(r#"{"armed":true,"ms":0,"forever":true}"#.into());
    assert_eq!(recorded.recv_timeout(WAIT).unwrap(), "done");
    assert_eq!(
        exited.recv_timeout(WAIT).unwrap(),
        Exit::Terminated("watchdog".into())
    );
}

#[test]
fn stop_ends_a_busy_runtime() {
    let (runtime, recorded, exited) = spawn(
        r#"handlers.push(() => { __host.call("record", "spinning"); for (;;) {} })"#,
        None,
    );
    runtime.post("{}".into());
    assert_eq!(recorded.recv_timeout(WAIT).unwrap(), "spinning");
    assert!(runtime.join(Instant::now() + WAIT));
    assert_eq!(exited.recv_timeout(WAIT).unwrap(), Exit::Stopped);
}

#[test]
fn reports_a_bundle_that_fails_to_boot() {
    let (_runtime, _, exited) = spawn("throw new Error('bad bundle')", None);
    match exited.recv_timeout(WAIT).unwrap() {
        Exit::Failed(error) => assert!(error.contains("bad bundle"), "{error}"),
        other => panic!("unexpected exit {other:?}"),
    }
}
