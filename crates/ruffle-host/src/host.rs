use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use bridge::{Session, SessionConfig};
use url::Url;

use crate::doorbell::Doorbell;
use crate::engine::Engine;
use crate::frame::{self, FrameStream};
use crate::input::{Command, InputSink, Viewport};
use crate::player_loop::{self, PlayerInit};

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
    pub movie: Movie,
    pub viewport: Viewport,
    pub session: SessionConfig,
}

impl PlayerConfig {
    pub fn launcher() -> Self {
        Self {
            movie: Movie::lucent_loader(),
            viewport: Viewport::AUTHORED,
            session: SessionConfig::default(),
        }
    }
}

pub struct Presentation {
    pub frames: FrameStream,
}

#[derive(Debug)]
pub struct ShutdownReport {
    pub elapsed: Duration,
    pub outcome: ShutdownOutcome,
    pub leaked_tasks: usize,
    pub net_tasks_left: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ShutdownOutcome {
    Clean,
    Overran,
}

pub struct PlayerHost {
    session: Session,
    input: InputSink,
    report: mpsc::Receiver<ShutdownReport>,
    thread: thread::JoinHandle<()>,
}

impl PlayerHost {
    pub fn spawn(
        engine: &Engine,
        config: PlayerConfig,
    ) -> std::io::Result<(PlayerHost, Presentation)> {
        let doorbell = Doorbell::new();
        let (session, side) = bridge::open(config.session);
        let (commands_tx, commands) = mpsc::channel();
        let (frames_tx, frames) = frame::mailbox();
        let (report_tx, report) = mpsc::sync_channel(1);
        let init = PlayerInit {
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
                let _ = report_tx.send(player_loop::run(init));
            })?;
        let input = InputSink {
            tx: commands_tx,
            doorbell,
        };
        Ok((
            PlayerHost {
                session,
                input,
                report,
                thread,
            },
            Presentation { frames },
        ))
    }

    pub fn session(&self) -> &Session {
        &self.session
    }

    pub fn input(&self) -> &InputSink {
        &self.input
    }

    pub fn shutdown(self, deadline: Instant) -> ShutdownReport {
        let started = Instant::now();
        self.input.push(Command::Shutdown { deadline });
        match self
            .report
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        {
            Ok(report) => {
                let _ = self.thread.join();
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
}
