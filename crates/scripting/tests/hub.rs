use std::path::PathBuf;
use std::sync::mpsc;
use std::task::Waker;
use std::time::{Duration, Instant};

use futures::executor::block_on;
use scripting::{AccountEvent, HubPaths, Scripting};
use serde_json::{Value, json};

const WAIT: Duration = Duration::from_secs(20);

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("lucent-hub-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn start(dir: &std::path::Path) -> Scripting {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("info")
        .with_test_writer()
        .try_init();
    Scripting::start(
        HubPaths {
            app_data: dir.join("app-data"),
            workspace: dir.join("workspace"),
            assets: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../assets"),
            home: dir.to_path_buf(),
            temp: std::env::temp_dir(),
        },
        false,
    )
    .unwrap()
}

fn forward(events: async_channel::Receiver<AccountEvent>) -> mpsc::Receiver<AccountEvent> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        while let Ok(event) = events.recv_blocking() {
            if tx.send(event).is_err() {
                return;
            }
        }
    });
    rx
}

fn wait_ready(events: &mpsc::Receiver<AccountEvent>) {
    let deadline = Instant::now() + WAIT;
    loop {
        match events.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(AccountEvent::Ready) => return,
            Ok(AccountEvent::Failed(error)) => panic!("account failed: {error}"),
            Ok(_) => {}
            Err(_) => panic!("timed out waiting for the account runtime"),
        }
    }
}

#[test]
fn loads_a_script_through_the_hub_script_library() {
    let dir = scratch("load");
    let scripts = dir.join("workspace/scripts");
    std::fs::create_dir_all(&scripts).unwrap();
    let script = scripts.join("hello.js");
    std::fs::write(
        &script,
        "const { script } = require(\"lucent/script\");\nexports.main = function* () { yield* script.log(\"hi\"); };\n",
    )
    .unwrap();

    let scripting = start(&dir);
    let opened = bridge::open(bridge::SessionConfig::default(), Waker::noop().clone());
    let booting = Instant::now();
    let (account, events) = scripting.open_account(opened.session.clone()).unwrap();
    let events = forward(events);
    wait_ready(&events);
    println!("account runtime ready in {:?}", booting.elapsed());

    let loaded =
        block_on(account.command("load-script", json!({ "path": script.to_string_lossy() })))
            .unwrap()
            .unwrap_or_else(|error| panic!("load-script failed: {error}"));
    assert_eq!(loaded["name"], Value::String("hello.js".into()));
    assert_eq!(loaded["hasInputs"], Value::Bool(false));

    let missing = block_on(account.command(
        "load-script",
        json!({ "path": dir.join("nope.js").to_string_lossy() }),
    ))
    .unwrap()
    .unwrap_err();
    assert!(!missing.is_empty());
}

#[test]
fn reads_and_saves_script_inputs_through_the_hub() {
    let dir = scratch("inputs");
    let scripts = dir.join("workspace/scripts");
    std::fs::create_dir_all(&scripts).unwrap();
    let script = scripts.join("farm.js");
    std::fs::write(
        &script,
        r#"module.exports = function* () {};
module.exports.inputs = {
  id: "farm",
  fields: [
    { key: "monster", type: "string", label: "Monster", required: true },
    { key: "count", type: "number", label: "Count", default: 3 },
  ],
};
"#,
    )
    .unwrap();

    let scripting = start(&dir);
    let opened = bridge::open(bridge::SessionConfig::default(), Waker::noop().clone());
    let (account, events) = scripting.open_account(opened.session.clone()).unwrap();
    let events = forward(events);
    wait_ready(&events);
    let command = |name: &str, input: Value| block_on(account.command(name, input)).unwrap();

    let loaded = command("load-script", json!({ "path": script.to_string_lossy() })).unwrap();
    assert_eq!(loaded["hasInputs"], Value::Bool(true));
    let started = command("start-script", json!({})).unwrap();
    assert_eq!(started["needsInputs"], Value::Bool(true));

    let inputs = command("get-inputs", json!({})).unwrap();
    assert_eq!(inputs["definition"]["id"], Value::String("farm".into()));
    assert_eq!(inputs["values"]["count"], json!(3));

    let saved = command(
        "save-inputs",
        json!({ "values": { "monster": "Frogzard", "count": 5 } }),
    )
    .unwrap();
    assert_eq!(saved, json!({ "monster": "Frogzard", "count": 5 }));
    let stored: Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("app-data/script-inputs.json")).unwrap(),
    )
    .unwrap();
    assert!(stored.to_string().contains("Frogzard"), "{stored}");
}

fn wait_for(path: &std::path::Path) {
    let deadline = Instant::now() + WAIT;
    while !path.exists() {
        assert!(
            Instant::now() < deadline,
            "{} never appeared",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn loads_a_script_that_imports_a_bundled_package() {
    let dir = scratch("package-import");
    let scripts = dir.join("workspace/scripts");
    std::fs::create_dir_all(&scripts).unwrap();
    let script = scripts.join("soak.js");
    std::fs::write(
        &script,
        "const consumables = require(\"@lucent/consumables\");\nmodule.exports = function* () { void consumables; };\n",
    )
    .unwrap();

    let scripting = start(&dir);
    wait_for(&dir.join("workspace/.script-package-setup.json"));
    let opened = bridge::open(bridge::SessionConfig::default(), Waker::noop().clone());
    let (account, events) = scripting.open_account(opened.session.clone()).unwrap();
    let events = forward(events);
    wait_ready(&events);

    let loaded =
        block_on(account.command("load-script", json!({ "path": script.to_string_lossy() })))
            .unwrap()
            .unwrap_or_else(|error| panic!("load-script failed: {error}"));
    assert_eq!(loaded["name"], Value::String("soak.js".into()));

    let described = block_on(scripting.hub_call(
        "scripts.describe",
        json!({ "path": dir.join("workspace/packages/lucent-dailies/scripts/spin-wheel-of-doom.js").to_string_lossy() }),
    ))
    .unwrap()
    .unwrap_or_else(|error| panic!("describe failed: {error}"));
    assert_eq!(
        described["reference"]["kind"],
        Value::String("package".into()),
        "{described}"
    );
}

#[test]
#[ignore = "needs the AQW servers"]
fn lists_login_servers_with_pings() {
    let dir = scratch("servers");
    let scripting = start(&dir);
    std::thread::sleep(Duration::from_millis(500));
    let servers = block_on(scripting.hub_call("servers.get", json!(null)))
        .unwrap()
        .unwrap();
    println!("{}", servers["servers"].as_array().map_or(0, Vec::len));
    assert!(!servers["servers"].as_array().unwrap().is_empty());
    let pings = block_on(scripting.hub_call("servers.pings", json!(null)))
        .unwrap()
        .unwrap();
    println!("{pings}");
    assert!(
        pings["pings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|ping| ping["status"] == "ok")
    );
}
