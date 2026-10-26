use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use gpui::{App, AsyncApp, Global};
use serde_json::{Value, json};

use crate::accounts::AccountStore;
use crate::login_servers;
use crate::lucent::{LaunchRequest, LaunchTarget, Lucent, ScriptChoice};

const POLL: Duration = Duration::from_secs(2);
const CYCLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const SETTLE: Duration = Duration::from_secs(20);

/// Launches a group with a script, waits for the script to close every tab, and
/// repeats, writing one JSON line per cycle.
#[derive(Clone, Debug, PartialEq)]
pub struct SoakOptions {
    pub script: PathBuf,
    pub group: String,
    pub cycles: u32,
    pub report: PathBuf,
}

/// Tabs closed by `script.exit({ closeClient: true })` during the current cycle.
#[derive(Default)]
pub struct SoakCloses(pub usize);

impl Global for SoakCloses {}

fn unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis())
}

fn append(report: &PathBuf, line: Value) {
    let written = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(report)
        .and_then(|mut file| writeln!(file, "{line}"));
    if let Err(error) = written {
        tracing::error!(%error, "could not write the soak report");
    }
    tracing::info!(target: "soak", "{line}");
}

pub fn start(options: SoakOptions, cx: &mut App) {
    cx.set_global(SoakCloses::default());
    cx.spawn(async move |cx: &mut AsyncApp| {
        if let Err(error) = run(&options, cx).await {
            append(
                &options.report,
                json!({ "event": "error", "message": error }),
            );
        }
        cx.update(|cx| cx.quit());
    })
    .detach();
}

async fn hub(cx: &mut AsyncApp, method: &str, payload: Value) -> Result<Value, String> {
    cx.update(|cx| Lucent::get(cx).scripting.hub_call(method, payload))
        .await
        .map_err(|_| "the hub stopped".to_owned())?
}

async fn sleep(cx: &mut AsyncApp, duration: Duration) {
    cx.background_executor().timer(duration).await;
}

async fn run(options: &SoakOptions, cx: &mut AsyncApp) -> Result<(), String> {
    let data_dir = cx.update(|cx| Lucent::get(cx).data_dir.clone());
    let store = AccountStore::load(&data_dir).map_err(|error| error.to_string())?;
    let storage = store.storage();
    let group = storage
        .groups
        .iter()
        .find(|group| group.name == options.group)
        .ok_or_else(|| format!("no group named {}", options.group))?;
    let accounts: Vec<_> = group
        .usernames
        .iter()
        .filter_map(|username| storage.account(username).cloned())
        .collect();

    sleep(cx, Duration::from_secs(2)).await;
    let described = hub(
        cx,
        "scripts.describe",
        json!({ "path": options.script.to_string_lossy() }),
    )
    .await?;
    let script = ScriptChoice {
        name: described["name"].as_str().unwrap_or("script").to_owned(),
        path: options.script.clone(),
        reference: described.get("reference").cloned(),
    };
    let servers = login_servers::parse_servers(&hub(cx, "servers.get", Value::Null).await?);
    let server =
        login_servers::resolve(&servers, login_servers::load_preference(&data_dir).as_ref())
            .flatten();
    append(
        &options.report,
        json!({
            "event": "start",
            "at": unix_ms(),
            "pid": std::process::id(),
            "accounts": accounts.iter().map(|account| &account.username).collect::<Vec<_>>(),
            "server": server,
            "script": script.name,
        }),
    );

    for cycle in 1..=options.cycles {
        cx.update(|cx| cx.global_mut::<SoakCloses>().0 = 0);
        let started = Instant::now();
        let started_at = unix_ms();
        let request = LaunchRequest {
            accounts: accounts.clone(),
            script: Some(script.clone()),
            server: server.clone(),
            target: LaunchTarget::NewWindow,
            grid: true,
        };
        cx.update(|cx| Lucent::launch(request, cx));
        let outcome = loop {
            sleep(cx, POLL).await;
            if cx.update(|cx| Lucent::hosts(cx).is_empty()) {
                let closes = cx.update(|cx| cx.global::<SoakCloses>().0);
                break if closes == accounts.len() {
                    "completed"
                } else {
                    "closed-early"
                };
            }
            if started.elapsed() > CYCLE_TIMEOUT {
                let shutdown = cx.update(|cx| {
                    let shutdown = crate::host::shutdown_all(cx);
                    for host in Lucent::hosts(cx) {
                        let _ = host
                            .handle
                            .update(cx, |_, window, _| window.remove_window());
                    }
                    shutdown
                });
                shutdown.await;
                break "timeout";
            }
        };
        let closes = cx.update(|cx| cx.global::<SoakCloses>().0);
        append(
            &options.report,
            json!({
                "event": "cycle",
                "cycle": cycle,
                "startedAt": started_at,
                "endedAt": unix_ms(),
                "durationMs": started.elapsed().as_millis(),
                "outcome": outcome,
                "closedByScript": closes,
                "accounts": accounts.len(),
            }),
        );
        sleep(cx, SETTLE).await;
        append(
            &options.report,
            json!({ "event": "idle", "cycle": cycle, "at": unix_ms() }),
        );
    }
    append(&options.report, json!({ "event": "done", "at": unix_ms() }));
    Ok(())
}
