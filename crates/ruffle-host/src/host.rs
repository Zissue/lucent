use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use std::task::Waker;

use bridge::{Closer, Opened, Session, SessionConfig};
use url::Url;

use crate::doorbell::Doorbell;
use crate::engine::Engine;
use crate::frame::{self, FrameStream};
use crate::input::{Command, InputSink, Viewport};
use crate::player_loop::PlayerInit;
use crate::profile::Profile;
use crate::ui::{self, UiRequests};

#[derive(Clone)]
pub struct Movie {
    pub url: Url,
    pub bytes: Arc<[u8]>,
}

impl Movie {
    pub fn lucent_loader() -> Self {
        Self {
            url: Url::parse("lucent-asset://assets/loader.swf").expect("a valid literal URL"),
            bytes: Arc::from(&include_bytes!("../../../assets/loader.swf")[..]),
        }
    }
}

pub struct PlayerConfig {
    pub profile: Profile,
    pub movie: Movie,
    pub viewport: Viewport,
    pub session: SessionConfig,
}

impl PlayerConfig {
    pub fn launcher(profile: Profile) -> Self {
        Self {
            profile,
            movie: Movie::lucent_loader(),
            viewport: Viewport::AUTHORED,
            session: SessionConfig::default(),
        }
    }
}

pub struct Presentation {
    pub frames: FrameStream,
    pub ui: UiRequests,
}

#[derive(Debug)]
pub struct ShutdownReport {
    pub elapsed: Duration,
    pub outcome: ShutdownOutcome,
    pub leaked_tasks: usize,
    pub net_tasks_left: usize,
}

impl ShutdownReport {
    pub(crate) fn clean(elapsed: Duration, leaked_tasks: usize, net_tasks_left: usize) -> Self {
        Self {
            elapsed,
            outcome: ShutdownOutcome::Clean,
            leaked_tasks,
            net_tasks_left,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum ShutdownOutcome {
    Clean,
    Overran,
}

pub struct PlayerHost {
    session: Session,
    closer: Closer,
    input: InputSink,
    report: mpsc::Receiver<ShutdownReport>,
    thread: Option<thread::JoinHandle<()>>,
}

const DROPPED_HOST_DEADLINE: Duration = Duration::from_secs(2);

impl PlayerHost {
    pub fn spawn(
        engine: &Engine,
        config: PlayerConfig,
    ) -> std::io::Result<(PlayerHost, Presentation)> {
        let doorbell = Doorbell::new();
        let Opened {
            session,
            player: side,
            closer,
        } = bridge::open(config.session, Waker::from(doorbell.clone()));
        let (commands_tx, commands) = mpsc::channel();
        let (frames_tx, frames) = frame::mailbox();
        let (report_tx, report) = mpsc::sync_channel(1);
        let (ui_tx, ui) = ui::channel();
        let init = PlayerInit {
            platform: crate::platform::PlatformConfig {
                profile: config.profile,
                ui: ui_tx,
            },
            engine: engine.clone(),
            movie: config.movie,
            viewport: config.viewport,
            side,
            commands,
            frames: frames_tx,
            doorbell: doorbell.clone(),
        };
        let thread = thread::Builder::new()
            .name("lucent-player".into())
            .spawn(move || {
                let _ = report_tx.send(crate::platform::run(init));
            })?;
        let input = InputSink {
            tx: commands_tx,
            doorbell,
        };
        Ok((
            PlayerHost {
                session,
                closer,
                input,
                report,
                thread: Some(thread),
            },
            Presentation { frames, ui },
        ))
    }

    pub fn session(&self) -> &Session {
        &self.session
    }

    pub fn input(&self) -> &InputSink {
        &self.input
    }

    pub fn shutdown(mut self, deadline: Instant) -> ShutdownReport {
        let started = Instant::now();
        self.request_stop(deadline);
        let thread = self.thread.take();
        match self
            .report
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        {
            Ok(report) => {
                if let Some(thread) = thread {
                    let _ = thread.join();
                }
                report
            }
            Err(_) => ShutdownReport {
                elapsed: started.elapsed(),
                outcome: ShutdownOutcome::Overran,
                leaked_tasks: 0,
                net_tasks_left: 0,
            },
        }
    }

    fn request_stop(&self, deadline: Instant) {
        self.closer.close();
        self.input.push(Command::Shutdown { deadline });
    }
}

impl Drop for PlayerHost {
    fn drop(&mut self) {
        if self.thread.is_some() {
            self.request_stop(Instant::now() + DROPPED_HOST_DEADLINE);
        }
    }
}
