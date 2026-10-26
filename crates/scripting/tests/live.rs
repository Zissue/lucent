use std::time::{Duration, Instant};

use bridge::Boot;
use futures::executor::block_on;
use ruffle_host::{Engine, PlayerConfig, PlayerHost, Profile};
use scripting::{AccountEvent, Scripting};
use serde_json::{Value, json};

const BOOT_TIMEOUT: Duration = Duration::from_secs(90);

fn wait_for_boot(host: &PlayerHost) -> Boot {
    let started = Instant::now();
    loop {
        let boot = host.session().status().boot;
        if matches!(boot, Boot::Ready | Boot::Failed { .. }) || started.elapsed() > BOOT_TIMEOUT {
            return boot;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn forward(
    events: async_channel::Receiver<AccountEvent>,
) -> std::sync::mpsc::Receiver<AccountEvent> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        while let Ok(event) = events.recv_blocking() {
            if tx.send(event).is_err() {
                return;
            }
        }
    });
    rx
}

fn next_event(
    events: &std::sync::mpsc::Receiver<AccountEvent>,
    want: impl Fn(&AccountEvent) -> bool,
) -> AccountEvent {
    let deadline = Instant::now() + BOOT_TIMEOUT;
    loop {
        let event = events
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("timed out waiting for an account event");
        println!("event: {event:?}");
        if want(&event) {
            return event;
        }
    }
}

#[test]
#[ignore = "needs a GPU and the AQW servers"]
fn runs_the_flash_api_against_the_real_client_at_the_login_screen() {
    let engine = Engine::start().unwrap();
    let data = std::env::temp_dir().join(format!("lucent-scripting-live-{}", std::process::id()));
    let (host, presentation) = PlayerHost::spawn(
        &engine,
        PlayerConfig::launcher(Profile::default_profile(data)),
    )
    .unwrap();
    let frames = presentation.frames;
    std::thread::spawn(move || while block_on(frames.next()).is_some() {});
    let assets = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../assets");
    let scratch = std::env::temp_dir().join(format!("lucent-scripting-hub-{}", std::process::id()));
    let paths = scripting::HubPaths {
        app_data: scratch.join("app-data"),
        workspace: scratch.join("workspace"),
        assets,
        home: scratch.clone(),
        temp: std::env::temp_dir(),
    };
    let scripting = Scripting::start(paths, false).unwrap();
    let (account, events) = scripting.open_account(host.session().clone()).unwrap();
    let events = forward(events);
    assert_eq!(
        next_event(&events, |e| matches!(
            e,
            AccountEvent::Ready | AccountEvent::Failed(_)
        )),
        AccountEvent::Ready
    );
    assert_eq!(wait_for_boot(&host), Boot::Ready);

    let command = |name: &str, input: Value| -> Result<Value, String> {
        block_on(account.command(name, input)).expect("the command was answered")
    };
    assert_eq!(
        command("call-api", json!({ "path": "auth.isLoggedIn" })),
        Ok(Value::Bool(false))
    );
    let refused = command("eval", json!({ "source": "return 1" })).unwrap_err();
    assert!(
        refused.starts_with("Scripts can only start after game readiness is complete."),
        "{refused}"
    );

    account.close(Instant::now() + Duration::from_secs(2));
    let report = host.shutdown(Instant::now() + Duration::from_secs(2));
    println!("{report:?}");
}
