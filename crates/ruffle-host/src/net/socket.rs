use std::sync::Arc;
use std::time::Duration;

use bridge::{CloseCause, ConnId};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

use crate::doorbell::Doorbell;

const READ_BUFFER: usize = 64 * 1024;

pub(crate) struct NetEvent {
    pub(crate) conn: ConnId,
    pub(crate) kind: NetEventKind,
}

pub(crate) enum NetEventKind {
    Connected,
    ConnectFailed { timed_out: bool },
    Data(Vec<u8>),
    Closed(CloseCause),
}

#[derive(Clone)]
pub(crate) struct Reporter {
    pub(crate) to_player: mpsc::Sender<NetEvent>,
    pub(crate) doorbell: Arc<Doorbell>,
}

impl Reporter {
    async fn report(&self, conn: ConnId, kind: NetEventKind) -> bool {
        let sent = self.to_player.send(NetEvent { conn, kind }).await.is_ok();
        if sent {
            self.doorbell.ring();
        }
        sent
    }
}

pub(crate) struct SocketTask {
    pub(crate) conn: ConnId,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) timeout: Duration,
    pub(crate) from_player: mpsc::UnboundedReceiver<Vec<u8>>,
    pub(crate) reporter: Reporter,
}

impl SocketTask {
    pub(crate) async fn run(self) {
        let SocketTask {
            conn,
            host,
            port,
            timeout,
            mut from_player,
            reporter,
        } = self;
        let stream =
            match tokio::time::timeout(timeout, TcpStream::connect((host.as_str(), port))).await {
                Ok(Ok(stream)) => stream,
                Ok(Err(error)) => {
                    tracing::warn!(host, port, %error, "game socket could not connect");
                    reporter
                        .report(conn, NetEventKind::ConnectFailed { timed_out: false })
                        .await;
                    return;
                }
                Err(_) => {
                    tracing::warn!(host, port, "game socket timed out connecting");
                    reporter
                        .report(conn, NetEventKind::ConnectFailed { timed_out: true })
                        .await;
                    return;
                }
            };
        let _ = stream.set_nodelay(true);
        if !reporter.report(conn, NetEventKind::Connected).await {
            return;
        }
        let (mut reader, mut writer) = stream.into_split();
        let read = async {
            let mut buffer = vec![0; READ_BUFFER];
            loop {
                match reader.read(&mut buffer).await {
                    Ok(0) => break CloseCause::Remote,
                    Ok(read) => {
                        let data = NetEventKind::Data(buffer[..read].to_vec());
                        if !reporter.report(conn, data).await {
                            break CloseCause::Shutdown;
                        }
                    }
                    Err(error) => break CloseCause::Error(error.to_string()),
                }
            }
        };
        let write = async {
            while let Some(bytes) = from_player.recv().await {
                if let Err(error) = writer.write_all(&bytes).await {
                    return CloseCause::Error(error.to_string());
                }
            }
            let _ = writer.shutdown().await;
            CloseCause::Local
        };
        let cause = tokio::select! {
            cause = read => cause,
            cause = write => cause,
        };
        reporter.report(conn, NetEventKind::Closed(cause)).await;
    }
}
