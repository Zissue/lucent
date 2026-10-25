use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_channel::{Receiver as AvmReceiver, Sender as AvmSender, TryRecvError};
use bridge::{CloseCause, ConnId, Direction, EventWriter, GameEvent, Packet, Seq, SocketEvent};
use ruffle_core::socket::{ConnectionState, SocketAction, SocketHandle};
use tokio::sync::mpsc;

use crate::doorbell::Doorbell;
use crate::framing::{Framed, Framer};
use crate::net::http::NetTasks;
use crate::net::socket::{NetEvent, NetEventKind, Reporter, SocketTask};

const MESSAGE_LIMIT: usize = 16 * 1024 * 1024;
const INBOUND_CAPACITY: usize = 256;

pub(crate) type SocketRule = fn(&str, u16) -> bool;

// The only publisher of a session's events. Net tasks move bytes; ordering happens here,
// on the player thread: an inbound packet is published before Ruffle receives its bytes,
// and every publish first drains the bytes AS3 has already written.
pub(crate) struct Sequencer {
    events: EventWriter,
    net: NetTasks,
    reporter: Reporter,
    from_net: mpsc::Receiver<NetEvent>,
    allow: SocketRule,
    bridges: HashMap<ConnId, SocketBridge>,
    next_conn: u64,
}

struct SocketBridge {
    handle: SocketHandle,
    to_avm: AvmSender<SocketAction>,
    from_avm: AvmReceiver<Vec<u8>>,
    to_net: Option<mpsc::UnboundedSender<Vec<u8>>>,
    inbound: Framer,
    outbound: Framer,
}

impl Sequencer {
    pub(crate) fn new(
        events: EventWriter,
        net: NetTasks,
        doorbell: Arc<Doorbell>,
        allow: SocketRule,
    ) -> Self {
        let (to_player, from_net) = mpsc::channel(INBOUND_CAPACITY);
        Self {
            events,
            net,
            reporter: Reporter {
                to_player,
                doorbell,
            },
            from_net,
            allow,
            bridges: HashMap::new(),
            next_conn: 1,
        }
    }

    pub(crate) fn publish(&mut self, event: GameEvent) -> Seq {
        self.drain_outbound();
        self.events.publish(event)
    }

    pub(crate) fn open_socket(
        &mut self,
        host: String,
        port: u16,
        timeout: Duration,
        handle: SocketHandle,
        from_avm: AvmReceiver<Vec<u8>>,
        to_avm: AvmSender<SocketAction>,
    ) {
        let conn = ConnId(self.next_conn);
        self.next_conn += 1;
        if !(self.allow)(&host, port) {
            tracing::warn!(
                host,
                port,
                "refused a game socket to a host that is not on the allowlist"
            );
            self.publish(GameEvent::Socket(SocketEvent::Refused { conn, host, port }));
            let _ = to_avm.try_send(SocketAction::Connect(handle, ConnectionState::Failed));
            return;
        }
        self.publish(GameEvent::Socket(SocketEvent::Connecting {
            conn,
            host: host.clone(),
            port,
        }));
        let (to_net, from_player) = mpsc::unbounded_channel();
        self.net.spawn(
            SocketTask {
                conn,
                host,
                port,
                timeout,
                from_player,
                reporter: self.reporter.clone(),
            }
            .run(),
        );
        self.bridges.insert(
            conn,
            SocketBridge {
                handle,
                to_avm,
                from_avm,
                to_net: Some(to_net),
                inbound: Framer::new(MESSAGE_LIMIT),
                outbound: Framer::new(MESSAGE_LIMIT),
            },
        );
    }

    pub(crate) fn deliver_inbound(&mut self) -> bool {
        let mut delivered = false;
        while let Ok(NetEvent { conn, kind }) = self.from_net.try_recv() {
            delivered = true;
            self.drain_outbound();
            let Some(bridge) = self.bridges.get_mut(&conn) else {
                continue;
            };
            match kind {
                NetEventKind::Connected => {
                    self.events
                        .publish(GameEvent::Socket(SocketEvent::Connected { conn }));
                    let _ = bridge.to_avm.try_send(SocketAction::Connect(
                        bridge.handle,
                        ConnectionState::Connected,
                    ));
                }
                NetEventKind::ConnectFailed { timed_out } => {
                    self.events
                        .publish(GameEvent::Socket(SocketEvent::ConnectFailed {
                            conn,
                            timed_out,
                        }));
                    let state = if timed_out {
                        ConnectionState::TimedOut
                    } else {
                        ConnectionState::Failed
                    };
                    let _ = bridge
                        .to_avm
                        .try_send(SocketAction::Connect(bridge.handle, state));
                    self.bridges.remove(&conn);
                }
                NetEventKind::Data(bytes) => {
                    let events = &mut self.events;
                    bridge.inbound.push(&bytes, |framed| {
                        publish_framed(events, conn, Direction::ToClient, framed)
                    });
                    let _ = bridge
                        .to_avm
                        .try_send(SocketAction::Data(bridge.handle, bytes));
                }
                NetEventKind::Closed(cause) => {
                    self.events.publish(GameEvent::Socket(SocketEvent::Closed {
                        conn,
                        cause,
                        partial_inbound: bridge.inbound.pending(),
                        partial_outbound: bridge.outbound.pending(),
                    }));
                    let _ = bridge.to_avm.try_send(SocketAction::Close(bridge.handle));
                    self.bridges.remove(&conn);
                }
            }
        }
        delivered
    }

    pub(crate) fn drain_outbound(&mut self) {
        let events = &mut self.events;
        for (&conn, bridge) in &mut self.bridges {
            loop {
                match bridge.from_avm.try_recv() {
                    Ok(bytes) => {
                        bridge.outbound.push(&bytes, |framed| {
                            publish_framed(events, conn, Direction::ToServer, framed)
                        });
                        if let Some(to_net) = &bridge.to_net {
                            let _ = to_net.send(bytes);
                        }
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Closed) => {
                        bridge.to_net = None;
                        break;
                    }
                }
            }
        }
    }

    pub(crate) fn has_inbound(&self) -> bool {
        !self.from_net.is_empty()
    }

    pub(crate) fn close_all(&mut self) {
        self.drain_outbound();
        let mut open: Vec<_> = self.bridges.drain().collect();
        open.sort_by_key(|(conn, _)| *conn);
        for (conn, bridge) in open {
            self.events.publish(GameEvent::Socket(SocketEvent::Closed {
                conn,
                cause: CloseCause::Shutdown,
                partial_inbound: bridge.inbound.pending(),
                partial_outbound: bridge.outbound.pending(),
            }));
        }
    }
}

fn publish_framed(events: &mut EventWriter, conn: ConnId, dir: Direction, framed: Framed<'_>) {
    let event = match framed {
        Framed::Message(bytes) => {
            tracing::trace!(?dir, len = bytes.len(), "packet");
            GameEvent::Packet(Packet {
                conn,
                dir,
                bytes: bytes.to_vec(),
            })
        }
        Framed::Oversize(len) => GameEvent::Socket(SocketEvent::Oversize { conn, dir, len }),
    };
    events.publish(event);
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc as std_mpsc;
    use std::thread;
    use std::time::Instant;

    use bridge::{Delivery, SessionConfig};

    use super::*;
    use crate::net::policy;

    const MESSAGES: [&[u8]; 6] = [
        b"<msg t='sys'><body action='apiOK' r='0'></body></msg>",
        b"%xt%loginResponse%-1%true%1%Hero%%",
        b"{\"t\":\"xt\",\"b\":{\"r\":-1,\"o\":{\"cmd\":\"ct\",\"m\":\"H\xc3\xa9r\xc3\xb8\"}}}",
        b"%xt%uotls%-1%Hero%intHP:100%",
        b"",
        b"%xt%server%-1%Welcome%",
    ];

    struct Harness {
        _runtime: tokio::runtime::Runtime,
        sequencer: Sequencer,
        doorbell: Arc<Doorbell>,
        events: std_mpsc::Receiver<GameEvent>,
        to_avm: AvmSender<SocketAction>,
        actions: AvmReceiver<SocketAction>,
        seen: Vec<GameEvent>,
    }

    fn harness(allow: SocketRule) -> Harness {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        let (session, side) = bridge::open(SessionConfig::default());
        let mut stream = session.subscribe().unwrap();
        let (tx, events) = std_mpsc::channel();
        thread::spawn(move || {
            while let Ok(Delivery::Event(event)) = stream.recv_blocking() {
                if tx.send(event.kind.clone()).is_err() {
                    break;
                }
            }
        });
        let doorbell = Doorbell::new();
        let sequencer = Sequencer::new(
            side.events,
            NetTasks::new(runtime.handle().clone()),
            doorbell.clone(),
            allow,
        );
        let (to_avm, actions) = async_channel::unbounded();
        Harness {
            _runtime: runtime,
            sequencer,
            doorbell,
            events,
            to_avm,
            actions,
            seen: Vec::new(),
        }
    }

    fn any_host(_: &str, _: u16) -> bool {
        true
    }

    impl Harness {
        fn connect(&mut self, port: u16) -> AvmSender<Vec<u8>> {
            let (as3, from_avm) = async_channel::unbounded();
            self.sequencer.open_socket(
                "127.0.0.1".into(),
                port,
                Duration::from_secs(5),
                SocketHandle::default(),
                from_avm,
                self.to_avm.clone(),
            );
            as3
        }

        fn pump_until(&mut self, done: impl Fn(&[GameEvent]) -> bool) -> &[GameEvent] {
            let deadline = Instant::now() + Duration::from_secs(5);
            while !done(&self.seen) {
                assert!(Instant::now() < deadline, "timed out; saw {:#?}", self.seen);
                self.doorbell
                    .wait_until(Instant::now() + Duration::from_millis(20));
                self.sequencer.deliver_inbound();
                self.sequencer.drain_outbound();
                thread::sleep(Duration::from_millis(5));
                self.seen.extend(self.events.try_iter());
            }
            &self.seen
        }

        fn actions(&self) -> Vec<SocketAction> {
            std::iter::from_fn(|| self.actions.try_recv().ok()).collect()
        }
    }

    fn packets(events: &[GameEvent], dir: Direction) -> Vec<Vec<u8>> {
        events
            .iter()
            .filter_map(|event| match event {
                GameEvent::Packet(packet) if packet.dir == dir => Some(packet.bytes.clone()),
                _ => None,
            })
            .collect()
    }

    fn closed(events: &[GameEvent]) -> Option<&SocketEvent> {
        events.iter().find_map(|event| match event {
            GameEvent::Socket(closed @ SocketEvent::Closed { .. }) => Some(closed),
            _ => None,
        })
    }

    fn wire(messages: &[&[u8]]) -> Vec<u8> {
        messages
            .iter()
            .flat_map(|message| message.iter().copied().chain([0]))
            .collect()
    }

    fn server(script: impl FnOnce(TcpStream) + Send + 'static) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            script(stream);
        });
        port
    }

    #[test]
    fn delivers_fragmented_and_coalesced_reads_as_whole_packets_in_order() {
        let bytes = wire(&MESSAGES);
        let sent = bytes.clone();
        let (hold, release) = std_mpsc::channel::<()>();
        let port = server(move |mut stream| {
            for chunk in [&sent[..5], &sent[5..60], &sent[60..61], &sent[61..]] {
                stream.write_all(chunk).unwrap();
                stream.flush().unwrap();
                thread::sleep(Duration::from_millis(15));
            }
            let _ = release.recv();
        });
        let mut harness = harness(any_host);
        let _as3 = harness.connect(port);
        let events =
            harness.pump_until(|seen| packets(seen, Direction::ToClient).len() == MESSAGES.len());
        assert_eq!(
            packets(events, Direction::ToClient),
            MESSAGES.map(<[u8]>::to_vec)
        );
        assert!(
            matches!(events[0], GameEvent::Socket(SocketEvent::Connecting { port: p, .. }) if p == port)
        );
        assert_eq!(
            events[1],
            GameEvent::Socket(SocketEvent::Connected { conn: ConnId(1) })
        );
        let mut actions = harness.actions().into_iter();
        assert!(matches!(
            actions.next(),
            Some(SocketAction::Connect(_, ConnectionState::Connected))
        ));
        let forwarded: Vec<u8> = actions
            .flat_map(|action| match action {
                SocketAction::Data(_, data) => data,
                _ => panic!("expected only data after connect"),
            })
            .collect();
        assert_eq!(forwarded, bytes);
        drop(hold);
    }

    #[test]
    fn forwards_as3_writes_unchanged_and_publishes_each_message() {
        let (received_tx, received) = std_mpsc::channel();
        let port = server(move |mut stream| {
            let mut bytes = vec![0; 12];
            stream.read_exact(&mut bytes).unwrap();
            received_tx.send(bytes).unwrap();
        });
        let mut harness = harness(any_host);
        let as3 = harness.connect(port);
        harness.pump_until(|seen| {
            seen.contains(&GameEvent::Socket(SocketEvent::Connected {
                conn: ConnId(1),
            }))
        });
        for chunk in [&b"a\0b\0"[..], b"par", b"tial\0"] {
            as3.try_send(chunk.to_vec()).unwrap();
        }
        let events = harness.pump_until(|seen| packets(seen, Direction::ToServer).len() == 3);
        assert_eq!(
            packets(events, Direction::ToServer),
            [b"a".to_vec(), b"b".to_vec(), b"partial".to_vec()]
        );
        assert_eq!(
            received.recv_timeout(Duration::from_secs(5)).unwrap(),
            b"a\0b\0partial\0"
        );
    }

    #[test]
    fn reports_a_disconnect_mid_message_with_the_unfinished_length() {
        let port = server(|mut stream| {
            stream.write_all(b"abc\0de").unwrap();
        });
        let mut harness = harness(any_host);
        let _as3 = harness.connect(port);
        let events = harness.pump_until(|seen| closed(seen).is_some());
        assert_eq!(packets(events, Direction::ToClient), [b"abc".to_vec()]);
        assert_eq!(
            closed(events),
            Some(&SocketEvent::Closed {
                conn: ConnId(1),
                cause: CloseCause::Remote,
                partial_inbound: 2,
                partial_outbound: 0,
            })
        );
        assert!(matches!(
            harness.actions().last(),
            Some(SocketAction::Close(_))
        ));
    }

    #[test]
    fn closes_after_as3_closes_and_flushes_what_it_wrote() {
        let (received_tx, received) = std_mpsc::channel();
        let port = server(move |mut stream| {
            let mut bytes = Vec::new();
            stream.read_to_end(&mut bytes).unwrap();
            received_tx.send(bytes).unwrap();
        });
        let mut harness = harness(any_host);
        let as3 = harness.connect(port);
        harness.pump_until(|seen| {
            seen.contains(&GameEvent::Socket(SocketEvent::Connected {
                conn: ConnId(1),
            }))
        });
        as3.try_send(b"bye\0".to_vec()).unwrap();
        drop(as3);
        let events = harness.pump_until(|seen| closed(seen).is_some());
        assert_eq!(packets(events, Direction::ToServer), [b"bye".to_vec()]);
        assert!(matches!(
            closed(events),
            Some(SocketEvent::Closed {
                cause: CloseCause::Local,
                ..
            })
        ));
        assert_eq!(
            received.recv_timeout(Duration::from_secs(5)).unwrap(),
            b"bye\0"
        );
    }

    #[test]
    fn refuses_hosts_outside_artix_without_connecting() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut harness = harness(policy::allow_socket);
        let _as3 = harness.connect(port);
        harness.pump_until(|seen| !seen.is_empty());
        thread::sleep(Duration::from_millis(100));
        assert_eq!(
            harness.seen,
            [GameEvent::Socket(SocketEvent::Refused {
                conn: ConnId(1),
                host: "127.0.0.1".into(),
                port,
            })]
        );
        assert!(matches!(
            harness.actions().as_slice(),
            [SocketAction::Connect(_, ConnectionState::Failed)]
        ));
        assert!(listener.accept().is_err());
    }

    #[test]
    fn reports_a_refused_connection_as_failed() {
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let mut harness = harness(any_host);
        let _as3 = harness.connect(port);
        let events = harness.pump_until(|seen| seen.len() >= 2);
        assert_eq!(
            events[1],
            GameEvent::Socket(SocketEvent::ConnectFailed {
                conn: ConnId(1),
                timed_out: false,
            })
        );
        assert!(matches!(
            harness.actions().as_slice(),
            [SocketAction::Connect(_, ConnectionState::Failed)]
        ));
    }

    #[test]
    fn close_all_reports_open_connections_as_shutdown() {
        let (hold, release) = std_mpsc::channel::<()>();
        let port = server(move |mut stream| {
            stream.write_all(b"half").unwrap();
            let _ = release.recv();
        });
        let mut harness = harness(any_host);
        let _as3 = harness.connect(port);
        harness.pump_until(|seen| {
            seen.contains(&GameEvent::Socket(SocketEvent::Connected {
                conn: ConnId(1),
            }))
        });
        thread::sleep(Duration::from_millis(50));
        harness.sequencer.deliver_inbound();
        harness.sequencer.close_all();
        let events = harness.pump_until(|seen| closed(seen).is_some());
        assert_eq!(
            closed(events),
            Some(&SocketEvent::Closed {
                conn: ConnId(1),
                cause: CloseCause::Shutdown,
                partial_inbound: 4,
                partial_outbound: 0,
            })
        );
        drop(hold);
    }
}
