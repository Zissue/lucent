use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tokio::sync::broadcast;

use crate::packet::{ConnId, Direction, Packet};
use crate::value::AsValue;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Seq(u64);

impl Seq {
    pub const ZERO: Seq = Seq(0);

    pub fn get(self) -> u64 {
        self.0
    }
}

#[derive(Debug)]
pub struct Event {
    pub seq: Seq,
    pub at: Instant,
    pub kind: GameEvent,
}

#[derive(Clone, Debug, PartialEq)]
pub enum GameEvent {
    Packet(Packet),
    Socket(SocketEvent),
    Loader(LoaderEvent),
    Lifecycle(Lifecycle),
}

#[derive(Clone, Debug, PartialEq)]
pub enum SocketEvent {
    Connecting {
        conn: ConnId,
        host: String,
        port: u16,
    },
    Refused {
        conn: ConnId,
        host: String,
        port: u16,
    },
    Connected {
        conn: ConnId,
    },
    ConnectFailed {
        conn: ConnId,
        timed_out: bool,
    },
    Closed {
        conn: ConnId,
        cause: CloseCause,
        partial_inbound: usize,
        partial_outbound: usize,
    },
    Oversize {
        conn: ConnId,
        dir: Direction,
        len: usize,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CloseCause {
    Remote,
    Local,
    Error(String),
    Shutdown,
}

#[derive(Clone, Debug, PartialEq)]
pub enum LoaderEvent {
    Progress(u8),
    Loaded,
    Connection(SfsConnection),
    Debug(String),
    ExtensionResponse(String),
    PacketFromClient(String),
    PacketFromServer(String),
    Unrecognized { name: String, args: Vec<AsValue> },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SfsConnection {
    Connected,
    Failed,
    Lost,
}

impl LoaderEvent {
    pub fn parse(name: &str, args: Vec<AsValue>) -> LoaderEvent {
        match (name, args.as_slice()) {
            ("onProgress", [AsValue::Number(percent)]) => {
                LoaderEvent::Progress(percent.clamp(0.0, 100.0) as u8)
            }
            ("onLoaded", []) => LoaderEvent::Loaded,
            ("onConnection", [AsValue::String(status)]) => match status.as_str() {
                "OnConnection" => LoaderEvent::Connection(SfsConnection::Connected),
                "OnConnectionFailed" => LoaderEvent::Connection(SfsConnection::Failed),
                "OnConnectionLost" => LoaderEvent::Connection(SfsConnection::Lost),
                _ => LoaderEvent::unrecognized(name, args),
            },
            ("onDebug", [AsValue::String(text)]) => LoaderEvent::Debug(text.clone()),
            ("onExtensionResponse", [AsValue::String(json)]) => {
                LoaderEvent::ExtensionResponse(json.clone())
            }
            ("packetFromClient", [AsValue::String(packet)]) => {
                LoaderEvent::PacketFromClient(packet.clone())
            }
            ("packetFromServer", [AsValue::String(packet)]) => {
                LoaderEvent::PacketFromServer(packet.clone())
            }
            _ => LoaderEvent::unrecognized(name, args),
        }
    }

    fn unrecognized(name: &str, args: Vec<AsValue>) -> LoaderEvent {
        LoaderEvent::Unrecognized {
            name: name.to_owned(),
            args,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Lifecycle {
    MovieLoaded {
        width: u32,
        height: u32,
        frame_rate: f64,
    },
    Failed {
        error: String,
    },
    Stopping,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Status {
    pub boot: Boot,
    pub server: Server,
    pub last: Seq,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Boot {
    Starting,
    Downloading { percent: u8 },
    Ready,
    Failed { error: String },
    Stopping,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Server {
    Offline,
    Connected,
}

impl Status {
    pub fn initial() -> Self {
        Self {
            boot: Boot::Starting,
            server: Server::Offline,
            last: Seq::ZERO,
        }
    }

    pub fn apply(&mut self, event: &Event) {
        match &event.kind {
            GameEvent::Loader(LoaderEvent::Progress(percent))
                if matches!(self.boot, Boot::Starting | Boot::Downloading { .. }) =>
            {
                self.boot = Boot::Downloading { percent: *percent };
            }
            GameEvent::Loader(LoaderEvent::Loaded) => self.boot = Boot::Ready,
            GameEvent::Loader(LoaderEvent::Connection(SfsConnection::Connected)) => {
                self.server = Server::Connected;
            }
            GameEvent::Loader(LoaderEvent::Connection(_)) => self.server = Server::Offline,
            GameEvent::Lifecycle(Lifecycle::Failed { error }) => {
                self.boot = Boot::Failed {
                    error: error.clone(),
                };
            }
            GameEvent::Lifecycle(Lifecycle::Stopping) => self.boot = Boot::Stopping,
            _ => {}
        }
        self.last = event.seq;
    }
}

#[derive(Clone, Debug)]
pub enum Delivery {
    Event(Arc<Event>),
    Gap { missed: u64 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ended;

pub struct EventStream {
    rx: broadcast::Receiver<Arc<Event>>,
}

impl EventStream {
    pub fn recv_blocking(&mut self) -> Result<Delivery, Ended> {
        delivery(self.rx.blocking_recv())
    }

    pub async fn recv(&mut self) -> Result<Delivery, Ended> {
        delivery(self.rx.recv().await)
    }
}

fn delivery(result: Result<Arc<Event>, broadcast::error::RecvError>) -> Result<Delivery, Ended> {
    match result {
        Ok(event) => Ok(Delivery::Event(event)),
        Err(broadcast::error::RecvError::Lagged(missed)) => Ok(Delivery::Gap { missed }),
        Err(broadcast::error::RecvError::Closed) => Err(Ended),
    }
}

pub struct EventWriter {
    shared: Arc<Shared>,
    tx: broadcast::Sender<Arc<Event>>,
    last: Seq,
}

impl EventWriter {
    pub fn publish(&mut self, kind: GameEvent) -> Seq {
        self.last = Seq(self.last.0 + 1);
        let event = Arc::new(Event {
            seq: self.last,
            at: Instant::now(),
            kind,
        });
        self.shared.status.lock().unwrap().apply(&event);
        let _ = self.tx.send(event);
        self.last
    }

    pub fn last(&self) -> Seq {
        self.last
    }
}

pub(crate) struct Shared {
    // Weak so that every stream ends once the writer drops.
    weak: broadcast::WeakSender<Arc<Event>>,
    status: Mutex<Status>,
}

pub(crate) fn channel(capacity: NonZeroUsize) -> (Arc<Shared>, EventWriter) {
    let (tx, _) = broadcast::channel(capacity.get());
    let shared = Arc::new(Shared {
        weak: tx.downgrade(),
        status: Mutex::new(Status::initial()),
    });
    let writer = EventWriter {
        shared: shared.clone(),
        tx,
        last: Seq::ZERO,
    };
    (shared, writer)
}

pub(crate) fn subscribe(shared: &Shared) -> Result<EventStream, Ended> {
    let tx = shared.weak.upgrade().ok_or(Ended)?;
    Ok(EventStream { rx: tx.subscribe() })
}

pub(crate) fn status(shared: &Shared) -> Status {
    shared.status.lock().unwrap().clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opened(capacity: usize) -> (Arc<Shared>, EventWriter) {
        channel(NonZeroUsize::new(capacity).unwrap())
    }

    #[test]
    fn numbers_events_from_one_without_gaps() {
        let (shared, mut writer) = opened(8);
        let mut stream = subscribe(&shared).unwrap();
        writer.publish(GameEvent::Loader(LoaderEvent::Loaded));
        writer.publish(GameEvent::Lifecycle(Lifecycle::Stopping));
        let seqs: Vec<u64> = (0..2)
            .map(|_| match stream.recv_blocking().unwrap() {
                Delivery::Event(event) => event.seq.get(),
                Delivery::Gap { .. } => unreachable!(),
            })
            .collect();
        assert_eq!(seqs, [1, 2]);
    }

    #[test]
    fn tells_a_lagging_subscriber_how_many_events_it_missed() {
        let (shared, mut writer) = opened(4);
        let mut stream = subscribe(&shared).unwrap();
        for percent in 0..10 {
            writer.publish(GameEvent::Loader(LoaderEvent::Progress(percent)));
        }
        assert!(matches!(
            stream.recv_blocking(),
            Ok(Delivery::Gap { missed: 6 })
        ));
        let Ok(Delivery::Event(next)) = stream.recv_blocking() else {
            panic!("expected the oldest retained event");
        };
        assert_eq!(next.seq.get(), 7);
    }

    #[test]
    fn folds_status_before_subscribers_can_see_the_event() {
        let (shared, mut writer) = opened(8);
        let mut stream = subscribe(&shared).unwrap();
        writer.publish(GameEvent::Loader(LoaderEvent::Progress(40)));
        stream.recv_blocking().unwrap();
        assert_eq!(status(&shared).boot, Boot::Downloading { percent: 40 });
        writer.publish(GameEvent::Loader(LoaderEvent::Loaded));
        writer.publish(GameEvent::Loader(LoaderEvent::Progress(90)));
        assert_eq!(status(&shared).boot, Boot::Ready);
        assert_eq!(status(&shared).last.get(), 3);
    }

    #[test]
    fn ends_every_stream_when_the_writer_drops() {
        let (shared, writer) = opened(8);
        let mut stream = subscribe(&shared).unwrap();
        drop(writer);
        assert_eq!(stream.recv_blocking().unwrap_err(), Ended);
        assert!(subscribe(&shared).is_err());
    }

    #[test]
    fn parses_every_loader_host_call_and_keeps_unknown_shapes() {
        let s = |text: &str| AsValue::String(text.to_owned());
        assert_eq!(
            LoaderEvent::parse("onProgress", vec![AsValue::Number(57.0)]),
            LoaderEvent::Progress(57)
        );
        assert_eq!(
            LoaderEvent::parse("onProgress", vec![AsValue::Number(-3.0)]),
            LoaderEvent::Progress(0)
        );
        assert_eq!(LoaderEvent::parse("onLoaded", vec![]), LoaderEvent::Loaded);
        assert_eq!(
            LoaderEvent::parse("onConnection", vec![s("OnConnectionLost")]),
            LoaderEvent::Connection(SfsConnection::Lost)
        );
        assert_eq!(
            LoaderEvent::parse("onDebug", vec![s("hi")]),
            LoaderEvent::Debug("hi".into())
        );
        assert_eq!(
            LoaderEvent::parse("packetFromServer", vec![s("%xt%a%")]),
            LoaderEvent::PacketFromServer("%xt%a%".into())
        );
        assert_eq!(
            LoaderEvent::parse("onLoaded", vec![AsValue::Bool(true)]),
            LoaderEvent::Unrecognized {
                name: "onLoaded".into(),
                args: vec![AsValue::Bool(true)]
            }
        );
    }
}
