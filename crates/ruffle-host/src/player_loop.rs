use std::cell::RefCell;
use std::rc::Rc;
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use bridge::{EventWriter, GameEvent, Lifecycle, PlayerSide};
use ruffle_core::config::Letterbox;
use ruffle_core::{FloatDuration, Player, PlayerBuilder, ViewportDimensions};
use ruffle_render_wgpu::backend::WgpuRenderBackend;
use ruffle_render_wgpu::target::TextureTarget;

use crate::doorbell::Doorbell;
use crate::engine::Engine;
use crate::executor::LocalExecutor;
use crate::external::LoaderInterface;
use crate::frame::{self, FrameSender};
use crate::host::{Movie, ShutdownOutcome, ShutdownReport};
use crate::input::{Command, Viewport, Visibility};
use crate::net::LucentNavigator;
use crate::net::http::{HttpClient, NetTasks};

pub(crate) struct PlayerInit {
    pub(crate) engine: Engine,
    pub(crate) movie: Movie,
    pub(crate) viewport: Viewport,
    pub(crate) side: PlayerSide,
    pub(crate) commands: mpsc::Receiver<Command>,
    pub(crate) frames: FrameSender,
    pub(crate) doorbell: Arc<Doorbell>,
}

const BUDGET: Duration = Duration::from_millis(4);
const AS3_EXECUTION_LIMIT: Duration = Duration::from_secs(15);

struct PlayerLoop {
    player: Arc<Mutex<Player>>,
    events: Rc<RefCell<EventWriter>>,
    commands: mpsc::Receiver<Command>,
    tasks: LocalExecutor,
    net: NetTasks,
    frames: Option<FrameSender>,
    doorbell: Arc<Doorbell>,
    visibility: Visibility,
    last_tick: Instant,
}

pub(crate) fn run(init: PlayerInit) -> ShutdownReport {
    let events = Rc::new(RefCell::new(init.side.events));
    let net = NetTasks::new(init.engine.inner.net.handle().clone());
    let tasks = LocalExecutor::new(init.doorbell.clone());
    let gpu = init.engine.inner.gpu.clone();
    let Viewport {
        width,
        height,
        scale,
    } = init.viewport;
    let renderer = TextureTarget::new(&gpu.device, (width, height))
        .and_then(|target| WgpuRenderBackend::new(gpu, target));
    let renderer = match renderer {
        Ok(renderer) => renderer,
        Err(error) => {
            events
                .borrow_mut()
                .publish(GameEvent::Lifecycle(Lifecycle::Failed {
                    error: error.to_string(),
                }));
            return ShutdownReport {
                elapsed: Duration::ZERO,
                outcome: ShutdownOutcome::Clean,
                leaked_tasks: tasks.drain(Instant::now()),
                net_tasks_left: 0,
            };
        }
    };
    let navigator = LucentNavigator::new(
        init.movie.clone(),
        HttpClient::new(net.clone()),
        tasks.spawner(),
    );
    let player = PlayerBuilder::new()
        .with_renderer(renderer)
        .with_navigator(navigator)
        .with_external_interface(Box::new(LoaderInterface {
            events: events.clone(),
        }))
        .with_viewport_dimensions(width, height, scale)
        .with_letterbox(Letterbox::On)
        .with_autoplay(true)
        .with_max_execution_duration(AS3_EXECUTION_LIMIT)
        .build();
    let metadata_events = events.clone();
    player.lock().expect("player lock").fetch_root_movie(
        init.movie.url.to_string(),
        Vec::new(),
        Box::new(move |header| {
            let stage = header.stage_size();
            metadata_events
                .borrow_mut()
                .publish(GameEvent::Lifecycle(Lifecycle::MovieLoaded {
                    width: (stage.x_max - stage.x_min).to_pixels() as u32,
                    height: (stage.y_max - stage.y_min).to_pixels() as u32,
                    frame_rate: header.frame_rate().to_f64(),
                }));
        }),
    );
    PlayerLoop {
        player,
        events,
        commands: init.commands,
        tasks,
        net,
        frames: Some(init.frames),
        doorbell: init.doorbell,
        visibility: Visibility::Visible,
        last_tick: Instant::now(),
    }
    .run()
}

impl PlayerLoop {
    fn run(mut self) -> ShutdownReport {
        loop {
            if let Some(deadline) = self.apply_commands() {
                return self.shut_down(deadline);
            }
            let more = self.tasks.run_ready(Instant::now() + BUDGET);
            self.tick();
            self.render();
            if !more {
                self.wait();
            }
        }
    }

    fn apply_commands(&mut self) -> Option<Instant> {
        let mut resize = None;
        let mut shutdown = None;
        let mut player = self.player.lock().expect("player lock");
        while let Ok(command) = self.commands.try_recv() {
            match command {
                Command::Input(event) => {
                    player.handle_event(event);
                }
                Command::Resize(viewport) => resize = Some(viewport),
                Command::Visibility(visibility) => self.visibility = visibility,
                Command::Shutdown { deadline } => {
                    shutdown = Some(deadline);
                    break;
                }
            }
        }
        if let Some(viewport) = resize {
            player.set_viewport_dimensions(ViewportDimensions {
                width: viewport.width,
                height: viewport.height,
                scale_factor: viewport.scale,
            });
        }
        shutdown
    }

    fn tick(&mut self) {
        let now = Instant::now();
        let elapsed = now - self.last_tick;
        if elapsed.is_zero() {
            return;
        }
        self.last_tick = now;
        self.player
            .lock()
            .expect("player lock")
            .tick(FloatDuration::from_std(elapsed));
    }

    fn render(&mut self) {
        let Some(frames) = self.frames.as_mut() else {
            return;
        };
        if self.visibility == Visibility::Hidden || !frames.wanted() {
            return;
        }
        let mut player = self.player.lock().expect("player lock");
        if !player.needs_render() {
            return;
        }
        player.render();
        let renderer: &dyn std::any::Any = player.renderer();
        let renderer = renderer
            .downcast_ref::<WgpuRenderBackend<TextureTarget>>()
            .expect("the player renders offscreen");
        if let Some((width, height, bgra)) = frame::read_back(renderer) {
            frames.post(width, height, bgra);
        }
    }

    fn wait(&mut self) {
        let next = self
            .player
            .lock()
            .expect("player lock")
            .time_til_next_frame();
        self.doorbell.wait_until(Instant::now() + next);
    }

    fn shut_down(self, deadline: Instant) -> ShutdownReport {
        let begun = Instant::now();
        self.events
            .borrow_mut()
            .publish(GameEvent::Lifecycle(Lifecycle::Stopping));
        drop(self.frames);
        self.net.cancel.cancel();
        self.net.tracker.close();
        let remaining = deadline.saturating_duration_since(Instant::now());
        let tracker = self.net.tracker.clone();
        let _ = self
            .net
            .runtime
            .block_on(async move { tokio::time::timeout(remaining, tracker.wait()).await });
        let net_tasks_left = self.net.tracker.len();
        let leaked_tasks = self.tasks.drain(deadline);
        drop(self.player);
        drop(self.events);
        ShutdownReport {
            elapsed: begun.elapsed(),
            outcome: ShutdownOutcome::Clean,
            leaked_tasks,
            net_tasks_left,
        }
    }
}
