use std::sync::Arc;
use std::sync::mpsc;
use std::time::Instant;

use ruffle_core::events::PlayerEvent;

use crate::doorbell::Doorbell;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Viewport {
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

impl Viewport {
    pub const AUTHORED: Viewport = Viewport {
        width: 958,
        height: 550,
        scale: 1.0,
    };
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Visibility {
    Visible,
    Hidden,
}

#[derive(Clone)]
pub struct InputSink {
    pub(crate) tx: mpsc::Sender<Command>,
    pub(crate) doorbell: Arc<Doorbell>,
}

impl InputSink {
    pub fn send(&self, event: PlayerEvent) {
        self.push(Command::Input(event));
    }

    pub fn paste(&self, text: String) {
        self.push(Command::Paste(text));
    }

    pub fn resize(&self, viewport: Viewport) {
        self.push(Command::Resize(viewport));
    }

    pub fn set_visibility(&self, visibility: Visibility) {
        self.push(Command::Visibility(visibility));
    }

    pub(crate) fn push(&self, command: Command) {
        if self.tx.send(command).is_ok() {
            self.doorbell.ring();
        }
    }
}

pub(crate) enum Command {
    Input(PlayerEvent),
    Paste(String),
    Resize(Viewport),
    Visibility(Visibility),
    Shutdown { deadline: Instant },
}
