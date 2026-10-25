mod calls;
mod events;
mod packet;
mod value;

use std::num::NonZeroUsize;
use std::sync::Arc;
use std::task::Waker;

pub use calls::{CallError, Caller, Execution, Inbox, NotRun, Run, RunId, Unknown};
pub use events::{
    Boot, CloseCause, Delivery, Ended, Event, EventStream, EventWriter, GameEvent, Lifecycle,
    LoaderEvent, Seq, Server, SfsConnection, SocketEvent, Status, StatusChanges,
};
pub use packet::{ConnId, Direction, Packet};
pub use value::{AsValue, CallbackName, InvalidCallbackName};

#[derive(Clone, Copy, Debug)]
pub struct SessionConfig {
    pub call_capacity: NonZeroUsize,
    pub event_capacity: NonZeroUsize,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            call_capacity: NonZeroUsize::new(64).unwrap(),
            event_capacity: NonZeroUsize::new(4096).unwrap(),
        }
    }
}

#[derive(Clone)]
pub struct Session {
    calls: Arc<calls::Shared>,
    events: Arc<events::Shared>,
}

impl Session {
    pub fn begin_run(&self) -> Result<Run, Ended> {
        calls::begin_run(&self.calls)
    }

    pub fn subscribe(&self) -> Result<EventStream, Ended> {
        events::subscribe(&self.events)
    }

    pub fn status(&self) -> Status {
        events::status(&self.events)
    }

    pub fn status_changes(&self) -> StatusChanges {
        events::status_changes(&self.events)
    }
}

pub struct PlayerSide {
    pub events: EventWriter,
    pub inbox: Inbox,
}

pub struct Closer {
    calls: Arc<calls::Shared>,
}

impl Closer {
    pub fn close(&self) {
        calls::close(&self.calls);
    }
}

pub struct Opened {
    pub session: Session,
    pub player: PlayerSide,
    pub closer: Closer,
}

pub fn open(config: SessionConfig, wake_player: Waker) -> Opened {
    let calls = calls::Shared::new(config.call_capacity, wake_player);
    let (shared, writer) = events::channel(config.event_capacity);
    Opened {
        session: Session {
            calls: calls.clone(),
            events: shared,
        },
        player: PlayerSide {
            events: writer,
            inbox: Inbox::new(calls.clone()),
        },
        closer: Closer { calls },
    }
}
