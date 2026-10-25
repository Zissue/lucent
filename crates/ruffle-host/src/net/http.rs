use std::borrow::Cow;

use std::sync::Arc;

use reqwest::Method;
use reqwest::header::{
    AUTHORIZATION, CONTENT_TYPE, COOKIE, HeaderMap, HeaderName, HeaderValue, LOCATION,
    PROXY_AUTHORIZATION,
};
use ruffle_core::backend::navigator::{
    ErrorResponse, NavigationMethod, OwnedFuture, Request, SuccessResponse, get_encoding,
};
use ruffle_core::loader::Error as LoaderError;
use ruffle_core::swf::Encoding;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
use url::Url;

use super::policy;

#[derive(Clone)]
pub(crate) struct NetTasks {
    pub(crate) runtime: tokio::runtime::Handle,
    pub(crate) tracker: TaskTracker,
    pub(crate) cancel: CancellationToken,
}

impl NetTasks {
    pub(crate) fn new(runtime: tokio::runtime::Handle) -> Self {
        Self {
            runtime,
            tracker: TaskTracker::new(),
            cancel: CancellationToken::new(),
        }
    }

    pub(crate) fn spawn(&self, task: impl Future<Output = ()> + Send + 'static) {
        let cancel = self.cancel.clone();
        self.tracker.spawn_on(
            async move {
                cancel.run_until_cancelled(task).await;
            },
            &self.runtime,
        );
    }
}

pub(crate) struct HttpClient {
    client: reqwest::Client,
    tasks: NetTasks,
}

const MAX_REDIRECTS: usize = 20;
const MAX_RESERVED_BODY: u64 = 16 * 1024 * 1024;

enum NetError {
    Connect,
    Fetch(String),
    Status {
        status: u16,
        redirected: bool,
        length: u64,
    },
}

impl NetError {
    fn into_loader(self, url: &Url) -> LoaderError {
        match self {
            NetError::Connect => LoaderError::InvalidDomain(url.to_string()),
            NetError::Fetch(error) => LoaderError::FetchError(error),
            NetError::Status {
                status,
                redirected,
                length,
            } => LoaderError::HttpNotOk(format!("Got {status}"), status, redirected, length),
        }
    }
}

struct Head {
    url: String,
    status: u16,
    redirected: bool,
    encoding: Option<&'static Encoding>,
    expected_length: Option<u64>,
}

struct Outgoing {
    method: Method,
    url: Url,
    headers: HeaderMap,
    body: Option<Vec<u8>>,
}

impl HttpClient {
    pub(crate) fn new(tasks: NetTasks) -> Self {
        Self::with_client(tasks, reqwest::Client::builder())
    }

    fn with_client(tasks: NetTasks, builder: reqwest::ClientBuilder) -> Self {
        let client = builder
            .cookie_store(true)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("the HTTP client's TLS and resolver settings are static");
        Self { client, tasks }
    }

    pub(crate) fn fetch(
        &self,
        url: Url,
        request: &Request,
    ) -> OwnedFuture<Box<dyn SuccessResponse>, ErrorResponse> {
        let outgoing = outgoing(url.clone(), request);
        let client = self.client.clone();
        let (head_tx, head_rx) = oneshot::channel();
        let (chunk_tx, chunk_rx) = async_channel::bounded(8);
        self.tasks.spawn(async move {
            let requested = outgoing.url.clone();
            let mut response = match send_following_redirects(&client, outgoing).await {
                Ok(response) => response,
                Err(error) => {
                    let _ = head_tx.send(Err(error));
                    return;
                }
            };
            let head = Head {
                url: response.url().to_string(),
                status: response.status().as_u16(),
                redirected: *response.url() != requested,
                encoding: response
                    .headers()
                    .get(CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .and_then(get_encoding),
                expected_length: response.content_length(),
            };
            if !response.status().is_success() {
                let _ = head_tx.send(Err(NetError::Status {
                    status: head.status,
                    redirected: head.redirected,
                    length: head.expected_length.unwrap_or_default(),
                }));
                return;
            }
            if head_tx.send(Ok(head)).is_err() {
                return;
            }
            loop {
                let chunk = match response.chunk().await {
                    Ok(Some(bytes)) => Ok(bytes.to_vec()),
                    Ok(None) => break,
                    Err(error) => Err(error.to_string()),
                };
                let failed = chunk.is_err();
                if chunk_tx.send(chunk).await.is_err() || failed {
                    break;
                }
            }
        });
        Box::pin(async move {
            match head_rx.await {
                Ok(Ok(head)) => Ok(Box::new(NetworkResponse {
                    head,
                    chunks: chunk_rx,
                }) as Box<dyn SuccessResponse>),
                Ok(Err(error)) => Err(ErrorResponse {
                    error: error.into_loader(&url),
                    url: url.to_string(),
                }),
                Err(_) => Err(ErrorResponse {
                    url: url.to_string(),
                    error: LoaderError::Cancelled,
                }),
            }
        })
    }
}

fn outgoing(url: Url, request: &Request) -> Outgoing {
    let method = match request.method() {
        NavigationMethod::Get => Method::GET,
        NavigationMethod::Post => Method::POST,
    };
    let mut headers = HeaderMap::new();
    for (name, value) in request.headers() {
        match (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(value),
        ) {
            (Ok(name), Ok(value)) => {
                headers.append(name, value);
            }
            _ => tracing::warn!(name, "dropped a request header that is not valid HTTP"),
        }
    }
    let body = request.body().as_ref().map(|(body, mime)| {
        if let Ok(mime) = HeaderValue::from_str(mime) {
            headers.insert(CONTENT_TYPE, mime);
        }
        body.clone()
    });
    Outgoing {
        method,
        url,
        headers,
        body,
    }
}

async fn send_following_redirects(
    client: &reqwest::Client,
    mut request: Outgoing,
) -> Result<reqwest::Response, NetError> {
    for _ in 0..=MAX_REDIRECTS {
        let mut headers = request.headers.clone();
        policy::apply_launcher_headers(&mut headers, &request.method, &request.url);
        let mut builder = client
            .request(request.method.clone(), request.url.clone())
            .headers(headers);
        if let Some(body) = &request.body {
            builder = builder.body(body.clone());
        }
        let response = builder.send().await.map_err(|error| {
            if error.is_connect() {
                NetError::Connect
            } else {
                NetError::Fetch(error.to_string())
            }
        })?;
        let status = response.status().as_u16();
        let location = response
            .headers()
            .get(LOCATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|location| request.url.join(location).ok());
        let Some(location) = location.filter(|_| matches!(status, 301 | 302 | 303 | 307 | 308))
        else {
            return Ok(response);
        };
        let becomes_get = status == 303 && request.method != Method::HEAD
            || matches!(status, 301 | 302) && request.method == Method::POST;
        if becomes_get {
            request.method = Method::GET;
            request.body = None;
            request.headers.remove(CONTENT_TYPE);
        }
        if location.origin() != request.url.origin() {
            for name in [AUTHORIZATION, COOKIE, PROXY_AUTHORIZATION] {
                request.headers.remove(name);
            }
        }
        request.url = location;
    }
    Err(NetError::Fetch(format!(
        "more than {MAX_REDIRECTS} redirects"
    )))
}

struct NetworkResponse {
    head: Head,
    chunks: async_channel::Receiver<Result<Vec<u8>, String>>,
}

impl SuccessResponse for NetworkResponse {
    fn url(&self) -> Cow<'_, str> {
        Cow::Borrowed(&self.head.url)
    }

    fn set_url(&mut self, url: String) {
        self.head.url = url;
    }

    fn body(self: Box<Self>) -> OwnedFuture<Vec<u8>, LoaderError> {
        Box::pin(async move {
            let advertised = self.head.expected_length.unwrap_or(0);
            let mut body = Vec::with_capacity(advertised.min(MAX_RESERVED_BODY) as usize);
            while let Ok(chunk) = self.chunks.recv().await {
                body.extend_from_slice(&chunk.map_err(LoaderError::FetchError)?);
            }
            Ok(body)
        })
    }

    fn text_encoding(&self) -> Option<&'static Encoding> {
        self.head.encoding
    }

    fn status(&self) -> u16 {
        self.head.status
    }

    fn redirected(&self) -> bool {
        self.head.redirected
    }

    fn next_chunk(&mut self) -> OwnedFuture<Option<Vec<u8>>, LoaderError> {
        let chunks = self.chunks.clone();
        Box::pin(async move {
            chunks
                .recv()
                .await
                .ok()
                .transpose()
                .map_err(LoaderError::FetchError)
        })
    }

    fn expected_length(&self) -> Result<Option<u64>, LoaderError> {
        Ok(self.head.expected_length)
    }
}

pub(crate) struct AssetResponse {
    url: String,
    bytes: Arc<[u8]>,
    sent: bool,
}

impl AssetResponse {
    pub(crate) fn new(url: &Url, bytes: Arc<[u8]>) -> Self {
        Self {
            url: url.to_string(),
            bytes,
            sent: false,
        }
    }
}

impl SuccessResponse for AssetResponse {
    fn url(&self) -> Cow<'_, str> {
        Cow::Borrowed(&self.url)
    }

    fn set_url(&mut self, url: String) {
        self.url = url;
    }

    fn body(self: Box<Self>) -> OwnedFuture<Vec<u8>, LoaderError> {
        let bytes = self.bytes.to_vec();
        Box::pin(async move { Ok(bytes) })
    }

    fn text_encoding(&self) -> Option<&'static Encoding> {
        None
    }

    fn status(&self) -> u16 {
        200
    }

    fn redirected(&self) -> bool {
        false
    }

    fn next_chunk(&mut self) -> OwnedFuture<Option<Vec<u8>>, LoaderError> {
        let chunk = (!self.sent).then(|| self.bytes.to_vec());
        self.sent = true;
        Box::pin(async move { Ok(chunk) })
    }

    fn expected_length(&self) -> Result<Option<u64>, LoaderError> {
        Ok(Some(self.bytes.len() as u64))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::net::SocketAddr;

    use ruffle_core::backend::navigator::Request;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    const GZIPPED: [u8; 39] = [
        31, 139, 8, 0, 0, 0, 0, 0, 2, 255, 75, 79, 204, 77, 45, 75, 45, 42, 206, 204, 207, 83, 40,
        72, 172, 204, 201, 79, 76, 1, 0, 190, 13, 38, 205, 19, 0, 0, 0,
    ];

    struct Sent {
        line: String,
        headers: BTreeMap<String, String>,
        body: Vec<u8>,
    }

    struct Server {
        port: u16,
        sent: tokio::sync::mpsc::UnboundedReceiver<Sent>,
    }

    fn serve(runtime: &tokio::runtime::Runtime, responses: Vec<Vec<u8>>) -> Server {
        let listener = runtime.block_on(TcpListener::bind("127.0.0.1:0")).unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, sent) = tokio::sync::mpsc::unbounded_channel();
        runtime.spawn(async move {
            for response in responses {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0; 4096];
                let head_end = loop {
                    let read = stream.read(&mut buffer).await.unwrap();
                    bytes.extend_from_slice(&buffer[..read]);
                    if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                        break end;
                    }
                };
                let head = String::from_utf8(bytes[..head_end].to_vec()).unwrap();
                let mut lines = head.split("\r\n");
                let line = lines.next().unwrap().to_owned();
                let headers: BTreeMap<String, String> = lines
                    .map(|header| header.split_once(": ").unwrap())
                    .map(|(name, value)| (name.to_ascii_lowercase(), value.to_owned()))
                    .collect();
                let length: usize = headers
                    .get("content-length")
                    .map_or(0, |length| length.parse().unwrap());
                let mut body = bytes[head_end + 4..].to_vec();
                while body.len() < length {
                    let read = stream.read(&mut buffer).await.unwrap();
                    body.extend_from_slice(&buffer[..read]);
                }
                tx.send(Sent {
                    line,
                    headers,
                    body,
                })
                .unwrap();
                stream.write_all(&response).await.unwrap();
                stream.shutdown().await.unwrap();
            }
        });
        Server { port, sent }
    }

    fn response(status: &str, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
        let mut out = format!(
            "HTTP/1.1 {status}\r\nconnection: close\r\ncontent-length: {}\r\n",
            body.len()
        );
        for (name, value) in headers {
            out.push_str(&format!("{name}: {value}\r\n"));
        }
        out.push_str("\r\n");
        let mut out = out.into_bytes();
        out.extend_from_slice(body);
        out
    }

    fn client(runtime: &tokio::runtime::Runtime) -> HttpClient {
        let loopback: SocketAddr = "127.0.0.1:0".parse().unwrap();
        HttpClient::with_client(
            NetTasks::new(runtime.handle().clone()),
            reqwest::Client::builder()
                .resolve("game.aq.com", loopback)
                .resolve("cdn.example.test", loopback),
        )
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap()
    }

    fn fetch(client: &HttpClient, request: Request) -> Result<Vec<u8>, String> {
        let url = Url::parse(request.url()).unwrap();
        let response = futures::executor::block_on(client.fetch(url, &request))
            .map_err(|error| error.error.to_string())?;
        futures::executor::block_on(response.body()).map_err(|error| error.to_string())
    }

    fn header<'a>(sent: &'a Sent, name: &str) -> Option<&'a str> {
        sent.headers.get(name).map(String::as_str)
    }

    #[test]
    fn sends_launcher_headers_to_artix_and_decodes_the_compressed_reply() {
        let runtime = runtime();
        let mut server = serve(
            &runtime,
            vec![response(
                "200 OK",
                &[("content-encoding", "gzip")],
                &GZIPPED,
            )],
        );
        let client = client(&runtime);
        let url = format!(
            "http://game.aq.com:{}/game/api/data/gameversion",
            server.port
        );
        assert_eq!(
            fetch(&client, Request::get(url)).unwrap(),
            b"gameversion payload"
        );
        let sent = server.sent.blocking_recv().unwrap();
        assert_eq!(sent.line, "GET /game/api/data/gameversion HTTP/1.1");
        assert_eq!(header(&sent, "user-agent"), Some(policy::USER_AGENT_VALUE));
        assert_eq!(
            header(&sent, "x-requested-with"),
            Some("ShockwaveFlash/32.0.0.371")
        );
        assert_eq!(header(&sent, "artixmode"), Some("launcher"));
        assert_eq!(header(&sent, "accept-encoding"), Some("gzip, deflate, br"));
        assert_eq!(header(&sent, "origin"), None);
    }

    #[test]
    fn sends_the_artix_origin_and_body_on_posts() {
        let runtime = runtime();
        let mut server = serve(&runtime, vec![response("200 OK", &[], b"{}")]);
        let client = client(&runtime);
        let url = format!("http://game.aq.com:{}/game/api/login/now", server.port);
        let body = (
            b"user=a".to_vec(),
            "application/x-www-form-urlencoded".to_owned(),
        );
        fetch(&client, Request::post(url, Some(body))).unwrap();
        let sent = server.sent.blocking_recv().unwrap();
        assert_eq!(sent.line, "POST /game/api/login/now HTTP/1.1");
        assert_eq!(
            header(&sent, "origin"),
            Some(format!("http://game.aq.com:{}", server.port).as_str())
        );
        assert_eq!(
            header(&sent, "content-type"),
            Some("application/x-www-form-urlencoded")
        );
        assert_eq!(sent.body, b"user=a");
    }

    #[test]
    fn recomputes_artix_headers_for_each_redirect_hop() {
        let runtime = runtime();
        let mut other = serve(&runtime, vec![response("200 OK", &[], b"moved")]);
        let target = format!("http://cdn.example.test:{}/b", other.port);
        let mut artix = serve(
            &runtime,
            vec![response(
                "307 Temporary Redirect",
                &[("location", &target)],
                b"",
            )],
        );
        let client = client(&runtime);
        let url = format!("http://game.aq.com:{}/a", artix.port);
        let body = (b"x=1".to_vec(), "text/plain".to_owned());
        assert_eq!(
            fetch(&client, Request::post(url, Some(body))).unwrap(),
            b"moved"
        );
        let first = artix.sent.blocking_recv().unwrap();
        let second = other.sent.blocking_recv().unwrap();
        assert_eq!(header(&first, "accept-encoding"), Some("gzip, deflate, br"));
        assert!(header(&first, "origin").is_some());
        assert_eq!(second.line, "POST /b HTTP/1.1");
        assert_eq!(header(&second, "artixmode"), Some("launcher"));
        assert_eq!(
            header(&second, "user-agent"),
            Some(policy::USER_AGENT_VALUE)
        );
        assert_eq!(header(&second, "origin"), None);
        assert_ne!(
            header(&second, "accept-encoding"),
            Some("gzip, deflate, br")
        );
        assert_eq!(second.body, b"x=1");
    }

    #[test]
    fn turns_a_post_into_a_get_on_a_found_redirect() {
        let runtime = runtime();
        let mut second = serve(&runtime, vec![response("200 OK", &[], b"ok")]);
        let target = format!("http://game.aq.com:{}/after", second.port);
        let mut first = serve(
            &runtime,
            vec![response("302 Found", &[("location", &target)], b"")],
        );
        let client = client(&runtime);
        let url = format!("http://game.aq.com:{}/before", first.port);
        fetch(
            &client,
            Request::post(url, Some((b"x=1".to_vec(), "text/plain".to_owned()))),
        )
        .unwrap();
        first.sent.blocking_recv().unwrap();
        let after = second.sent.blocking_recv().unwrap();
        assert_eq!(after.line, "GET /after HTTP/1.1");
        assert_eq!(header(&after, "content-type"), None);
        assert_eq!(header(&after, "origin"), None);
        assert!(after.body.is_empty());
    }

    #[test]
    fn reports_a_non_success_status_as_http_not_ok() {
        let runtime = runtime();
        let server = serve(&runtime, vec![response("403 Forbidden", &[], b"")]);
        let client = client(&runtime);
        let url = format!("http://game.aq.com:{}/x", server.port);
        let error = fetch(&client, Request::get(url)).unwrap_err();
        assert!(error.contains("403"), "{error}");
    }

    #[test]
    fn reads_a_body_without_trusting_its_advertised_length() {
        let (chunks, rx) = async_channel::bounded(1);
        drop(chunks);
        let response = Box::new(NetworkResponse {
            head: Head {
                url: "https://game.aq.com/x".into(),
                status: 200,
                redirected: false,
                encoding: None,
                expected_length: Some(u64::MAX),
            },
            chunks: rx,
        });
        assert_eq!(
            futures::executor::block_on(response.body()).unwrap(),
            Vec::<u8>::new()
        );
    }

    #[test]
    fn drops_credentials_when_a_redirect_changes_origin() {
        let runtime = runtime();
        let mut other = serve(&runtime, vec![response("200 OK", &[], b"ok")]);
        let target = format!("http://cdn.example.test:{}/b", other.port);
        let mut artix = serve(
            &runtime,
            vec![response(
                "307 Temporary Redirect",
                &[("location", &target)],
                b"",
            )],
        );
        let client = client(&runtime);
        let mut request = Request::get(format!("http://game.aq.com:{}/a", artix.port));
        request.set_headers(
            [("Authorization", "Bearer secret"), ("Cookie", "session=1")]
                .into_iter()
                .map(|(name, value)| (name.to_owned(), value.to_owned()))
                .collect(),
        );
        fetch(&client, request).unwrap();
        let first = artix.sent.blocking_recv().unwrap();
        let second = other.sent.blocking_recv().unwrap();
        assert_eq!(header(&first, "authorization"), Some("Bearer secret"));
        assert_eq!(header(&first, "cookie"), Some("session=1"));
        assert_eq!(header(&second, "authorization"), None);
        assert_eq!(header(&second, "cookie"), None);
    }
}
