mod support;

use std::thread;
use std::time::{Duration, Instant};

use bridge::{AsValue, Boot, CallbackName};
use ruffle_host::{Engine, FrameStream, PlayerConfig, PlayerHost, Profile, Viewport, Visibility};

const BOOT_TIMEOUT: Duration = Duration::from_secs(90);
const SHUTDOWN: Duration = Duration::from_secs(2);
#[cfg(any(target_os = "macos", target_os = "linux"))]
const OS_WORKER_DRIFT: usize = 4;

fn boot(engine: &Engine, viewport: Viewport) -> (PlayerHost, FrameStream) {
    let data = std::env::temp_dir().join(format!("lucent-live-{}", std::process::id()));
    let mut config = PlayerConfig::launcher(Profile::default_profile(data));
    config.viewport = viewport;
    let (host, presentation) = PlayerHost::spawn(engine, config).unwrap();
    assert_eq!(
        support::wait_for_boot(host.session(), BOOT_TIMEOUT),
        Boot::Ready
    );
    (host, presentation.frames)
}

fn summary(label: &str, samples: &mut [Duration]) -> (Duration, Duration) {
    samples.sort();
    let p50 = support::percentile(samples, 0.50);
    let p99 = support::percentile(samples, 0.99);
    println!(
        "{label}: n={} p50={:.3}ms p99={:.3}ms max={:.3}ms",
        samples.len(),
        p50.as_secs_f64() * 1e3,
        p99.as_secs_f64() * 1e3,
        samples.last().unwrap().as_secs_f64() * 1e3
    );
    (p50, p99)
}

#[test]
#[ignore = "needs a GPU and the AQW servers"]
fn a3_calls_from_another_thread_run_without_waiting_for_a_frame() {
    let engine = Engine::start().unwrap();
    let retina = Viewport {
        width: 1916,
        height: 1100,
        scale: 2.0,
    };
    let (host, frames) = boot(&engine, retina);
    let drain =
        thread::spawn(move || while futures::executor::block_on(frames.next()).is_some() {});
    let run = host.session().begin_run().unwrap();
    let caller = run.caller();
    let logged_in = CallbackName::from_static("auth.isLoggedIn");
    let level = CallbackName::from_static("player.getLevel");
    assert_eq!(
        caller.call(&logged_in, vec![], Instant::now() + Duration::from_secs(1)),
        Ok(AsValue::Bool(false))
    );
    let level_reply = caller.call(&level, vec![], Instant::now() + Duration::from_secs(1));
    println!("player.getLevel at the login screen: {level_reply:?}");
    assert!(level_reply.is_ok());

    let mut jitter = 0x2545_f491_u32;
    let mut measure = |label: &str, visibility: Visibility| {
        host.input().set_visibility(visibility);
        thread::sleep(Duration::from_secs(1));
        let mut samples = Vec::new();
        for index in 0..4000 {
            let name = if index % 2 == 0 { &logged_in } else { &level };
            let started = Instant::now();
            let reply = caller.call(name, vec![], started + Duration::from_secs(1));
            samples.push(started.elapsed());
            assert!(reply.is_ok(), "{label} call {index} failed: {reply:?}");
            jitter ^= jitter << 13;
            jitter ^= jitter >> 17;
            jitter ^= jitter << 5;
            thread::sleep(Duration::from_micros(u64::from(jitter % 3000)));
        }
        summary(label, &mut samples)
    };
    let (_, idle_p99) = measure("idle (hidden, no render)", Visibility::Hidden);
    let (_, drawing_p99) = measure(
        "drawing (visible, render and readback each frame)",
        Visibility::Visible,
    );
    drop(run);
    let report = host.shutdown(Instant::now() + SHUTDOWN);
    drain.join().unwrap();
    assert!(idle_p99 < Duration::from_millis(1), "idle p99 {idle_p99:?}");
    assert!(
        drawing_p99 < Duration::from_secs_f64(1.0 / 24.0),
        "drawing p99 {drawing_p99:?}"
    );
    println!("shutdown: {report:?}");
}

#[test]
#[ignore = "needs a GPU and the AQW servers"]
fn frame_copy_cost_at_one_and_two_times_scale_with_one_and_seven_games() {
    let engine = Engine::start().unwrap();
    for (scale, games) in [(1.0, 1), (2.0, 1), (1.0, 7), (2.0, 7)] {
        let viewport = Viewport {
            width: (958.0 * scale) as u32,
            height: (550.0 * scale) as u32,
            scale,
        };
        let hosts: Vec<_> = (0..games).map(|_| boot(&engine, viewport)).collect();
        let mut render = Vec::new();
        let mut readback = Vec::new();
        let mut frames = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        thread::scope(|scope| {
            let workers: Vec<_> = hosts
                .iter()
                .map(|(_, stream)| {
                    scope.spawn(move || {
                        let mut timings = Vec::new();
                        while Instant::now() < deadline {
                            let next = futures::executor::block_on(futures::future::select(
                                Box::pin(stream.next()),
                                Box::pin(async_sleep(Duration::from_millis(200))),
                            ));
                            if let futures::future::Either::Left((Some(frame), _)) = next {
                                timings.push((frame.render, frame.readback));
                            }
                        }
                        timings
                    })
                })
                .collect();
            for worker in workers {
                let timings = worker.join().unwrap();
                frames.push(timings.len());
                render.extend(timings.iter().map(|(render, _)| *render));
                readback.extend(timings.iter().map(|(_, readback)| *readback));
            }
        });
        let label = format!(
            "{games} game(s) at {scale}x ({}x{})",
            viewport.width, viewport.height
        );
        summary(&format!("{label} render"), &mut render);
        summary(&format!("{label} readback"), &mut readback);
        println!("{label} frames per game in 10 s: {frames:?}");
        for (host, _) in hosts {
            let report = host.shutdown(Instant::now() + SHUTDOWN);
            assert_eq!(report.outcome, ruffle_host::ShutdownOutcome::Clean);
        }
    }
}

async fn async_sleep(duration: Duration) {
    let (tx, rx) = futures::channel::oneshot::channel::<()>();
    thread::spawn(move || {
        thread::sleep(duration);
        let _ = tx.send(());
    });
    let _ = rx.await;
}

fn boot_account(engine: &Engine, data: &std::path::Path, account: &str) -> PlayerHost {
    let profile = Profile::account(data, account).unwrap();
    let (host, _) = PlayerHost::spawn(engine, PlayerConfig::launcher(profile)).unwrap();
    assert_eq!(
        support::wait_for_boot(host.session(), BOOT_TIMEOUT),
        Boot::Ready
    );
    host
}

fn call(host: &PlayerHost, name: &'static str, args: Vec<AsValue>) -> AsValue {
    let run = host.session().begin_run().unwrap();
    run.caller()
        .call(
            &CallbackName::from_static(name),
            args,
            Instant::now() + Duration::from_secs(2),
        )
        .unwrap()
}

fn text(value: &str) -> AsValue {
    AsValue::String(value.into())
}

#[test]
#[ignore = "needs a GPU and the AQW servers"]
fn a4_shared_objects_persist_per_account_across_restarts() {
    let engine = Engine::start().unwrap();
    let data = std::env::temp_dir().join(format!("lucent-a4-{}", std::process::id()));
    let token = format!("probe-{}", std::process::id());
    let probe = "userPreference.data.lucentProbe";

    let first = boot_account(&engine, &data, "probe-a");
    call(
        &first,
        "flash.setGameObject",
        vec![text(probe), text(&token)],
    );
    assert_eq!(
        call(
            &first,
            "flash.callGameFunction",
            vec![text("userPreference.flush")]
        ),
        text("\"flushed\"")
    );
    assert_eq!(
        first.shutdown(Instant::now() + SHUTDOWN).outcome,
        ruffle_host::ShutdownOutcome::Clean
    );

    let saved = Profile::account(&data, "probe-a")
        .unwrap()
        .directory()
        .join("SharedObjects");
    let files: Vec<_> = walk(&saved);
    println!("saved SharedObjects: {files:?}");
    assert!(files.iter().any(|path| path.ends_with("AQWUserPref.sol")));

    let again = boot_account(&engine, &data, "  Probe-A ");
    assert_eq!(
        call(&again, "flash.getGameObject", vec![text(probe)]),
        text(&format!("\"{token}\""))
    );
    again.shutdown(Instant::now() + SHUTDOWN);

    let other = boot_account(&engine, &data, "probe-b");
    let seen = call(&other, "flash.getGameObject", vec![text(probe)]);
    println!("another account reads: {seen:?}");
    assert_ne!(seen, text(&format!("\"{token}\"")));
    other.shutdown(Instant::now() + SHUTDOWN);
    let _ = std::fs::remove_dir_all(&data);
}

fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(walk(&path));
        } else {
            out.push(path);
        }
    }
    out
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
#[ignore = "needs a GPU and the AQW servers; run with TMPDIR set to an empty directory"]
fn a5_twenty_start_stop_cycles_leave_threads_sockets_and_temp_files_unchanged() {
    let settle = || thread::sleep(Duration::from_secs(12));
    let engine = Engine::start().unwrap();
    let data = std::env::temp_dir().join(format!("lucent-a5-{}", std::process::id()));
    let cycle = || {
        let profile = Profile::account(&data, "cycle").unwrap();
        let (host, presentation) =
            PlayerHost::spawn(&engine, PlayerConfig::launcher(profile)).unwrap();
        assert_eq!(
            support::wait_for_boot(host.session(), BOOT_TIMEOUT),
            Boot::Ready
        );
        let run = host.session().begin_run().unwrap();
        let caller = run.caller();
        let in_flight = thread::spawn(move || {
            let name = CallbackName::from_static("auth.isLoggedIn");
            while caller
                .call(&name, vec![], Instant::now() + Duration::from_secs(1))
                .is_ok()
            {}
        });
        thread::sleep(Duration::from_millis(500));
        let report = host.shutdown(Instant::now() + SHUTDOWN);
        in_flight.join().unwrap();
        drop(presentation);
        report
    };
    cycle();
    settle();
    let before = support::resources();
    let names_before = support::thread_names();
    let temp_before = support::files_in(&std::env::temp_dir());
    let mut elapsed = Vec::new();
    for index in 0..20 {
        let report = cycle();
        println!("cycle {index}: {report:?}");
        assert_eq!(report.outcome, ruffle_host::ShutdownOutcome::Clean);
        assert_eq!((report.leaked_tasks, report.net_tasks_left), (0, 0));
        assert!(
            report.elapsed < SHUTDOWN,
            "cycle {index} took {:?}",
            report.elapsed
        );
        elapsed.push(report.elapsed);
    }
    settle();
    let after = support::resources();
    let names_after = support::thread_names();
    let temp_after = support::files_in(&std::env::temp_dir());
    summary("shutdown", &mut elapsed);
    println!("before {before:?} temp files {temp_before}");
    println!("after  {after:?} temp files {temp_after}");
    println!("threads before {names_before:?}");
    println!("threads after  {names_after:?}");
    let named = |names: &[String]| {
        names
            .iter()
            .filter(|name| !name.is_empty())
            .cloned()
            .collect::<Vec<_>>()
    };
    let unnamed = |names: &[String]| names.iter().filter(|name| name.is_empty()).count();
    assert_eq!(named(&names_after), named(&names_before));
    assert!(!names_after.iter().any(|name| name == "lucent-player"));
    assert!(unnamed(&names_after) <= unnamed(&names_before) + OS_WORKER_DRIFT);
    assert_eq!(
        (after.sockets, after.open_files),
        (before.sockets, before.open_files)
    );
    assert_eq!(temp_after, temp_before);
    let _ = std::fs::remove_dir_all(&data);
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
#[ignore = "needs a GPU and the AQW servers"]
fn a_dropped_host_stops_its_player_thread() {
    let engine = Engine::start().unwrap();
    let (host, frames) = boot(&engine, Viewport::AUTHORED);
    assert!(
        support::thread_names()
            .iter()
            .any(|name| name == "lucent-player")
    );
    drop(host);
    drop(frames);
    let deadline = Instant::now() + SHUTDOWN;
    while support::thread_names()
        .iter()
        .any(|name| name == "lucent-player")
    {
        assert!(
            Instant::now() < deadline,
            "the player thread outlived its host"
        );
        thread::sleep(Duration::from_millis(20));
    }
}
