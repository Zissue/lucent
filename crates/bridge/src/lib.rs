mod events;
mod value;

use std::num::NonZeroUsize;
use std::sync::Arc;

pub use events::{
    Boot, Delivery, Ended, Event, EventStream, EventWriter, GameEvent, Lifecycle, LoaderEvent, Seq,
    Server, SfsConnection, Status,
};
pub use value::AsValue;

#[derive(Clone, Copy, Debug)]
pub struct SessionConfig {
    pub event_capacity: NonZeroUsize,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            event_capacity: NonZeroUsize::new(4096).unwrap(),
        }
    }
}

#[derive(Clone)]
pub struct Session {
    events: Arc<events::Shared>,
}

impl Session {
    pub fn subscribe(&self) -> Result<EventStream, Ended> {
        events::subscribe(&self.events)
    }

    pub fn status(&self) -> Status {
        events::status(&self.events)
    }
}

pub struct PlayerSide {
    pub events: EventWriter,
}

pub fn open(config: SessionConfig) -> (Session, PlayerSide) {
    let (shared, writer) = events::channel(config.event_capacity);
    (Session { events: shared }, PlayerSide { events: writer })
}
