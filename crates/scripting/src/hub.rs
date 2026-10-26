use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use js::{Arg, Exit, Host, HostError, Ret};
use serde_json::{Value, json};
use sha1::Sha1;
use sha2::{Digest, Sha256};

use crate::router::Router;

const HUB_BUNDLE: &str = include_str!("../../../assets/native/hub.js");
const HEAP_LIMIT: usize = 512 << 20;
const HTTP_BODY_LIMIT: usize = 64 << 20;
const HTTP_TIMEOUT: Duration = Duration::from_secs(120);
const TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Where the hub's services read and write, the same places Electron uses.
#[derive(Clone, Debug)]
pub struct HubPaths {
    pub app_data: PathBuf,
    pub workspace: PathBuf,
    pub assets: PathBuf,
    pub home: PathBuf,
    pub temp: PathBuf,
}

impl HubPaths {
    /// Electron's production locations for this OS.
    pub fn electron_defaults(assets: PathBuf) -> Self {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
        let base = if cfg!(target_os = "macos") {
            home.join("Library/Application Support")
        } else if cfg!(target_os = "windows") {
            dirs::config_dir().unwrap_or_else(|| home.join("AppData/Roaming"))
        } else {
            dirs::data_dir().unwrap_or_else(|| home.join(".local/share"))
        };
        let documents = dirs::document_dir().unwrap_or_else(|| home.join("Documents"));
        Self {
            app_data: base.join("lucent"),
            workspace: documents.join("Lucent"),
            assets,
            temp: std::env::temp_dir(),
            home,
        }
    }
}

pub(crate) fn spawn(router: Arc<Router>, paths: HubPaths, debug: bool) -> io::Result<()> {
    let http = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("hub-http")
        .enable_all()
        .build()?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(io::Error::other)?;
    let host = HubHost {
        router: Arc::downgrade(&router),
        paths: paths.clone(),
        debug,
        http: Arc::new(http),
        client,
        requests: Arc::new(Mutex::new(HashMap::new())),
        next_request: 1,
    };
    let weak = Arc::downgrade(&router);
    let runtime = js::Runtime::spawn(
        js::Config {
            name: "hub".into(),
            source: Arc::from(HUB_BUNDLE),
            heap_limit: HEAP_LIMIT,
            watchdog: None,
        },
        host,
        move |exit| {
            match &exit {
                Exit::Stopped => return,
                Exit::Failed(error) => tracing::error!(%error, "the hub failed"),
                Exit::Terminated(reason) => tracing::error!(%reason, "the hub was terminated"),
            }
            if let Some(router) = weak.upgrade() {
                router.set_hub(None);
            }
        },
    )?;
    router.set_hub(Some(runtime));
    Ok(())
}

struct HubHost {
    router: Weak<Router>,
    paths: HubPaths,
    debug: bool,
    http: Arc<tokio::runtime::Runtime>,
    client: reqwest::Client,
    requests: Arc<Mutex<HashMap<u64, tokio::task::AbortHandle>>>,
    next_request: u64,
}

fn arg_string(args: &mut std::vec::IntoIter<Arg>, what: &str) -> Result<String, HostError> {
    args.next()
        .and_then(Arg::into_string)
        .ok_or_else(|| HostError::argument(format!("expected {what}")))
}

fn arg_number(args: &mut std::vec::IntoIter<Arg>, what: &str) -> Result<f64, HostError> {
    args.next()
        .and_then(|arg| arg.as_number())
        .ok_or_else(|| HostError::argument(format!("expected {what}")))
}

fn path_str(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

impl Host for HubHost {
    fn call(&mut self, op: &str, args: Vec<Arg>) -> Result<Ret, HostError> {
        let mut args = args.into_iter();
        match op {
            "config" => Ok(Ret::Str(
                json!({
                    "appDataDir": path_str(&self.paths.app_data),
                    "assetsDir": path_str(&self.paths.assets),
                    "debug": self.debug,
                    "home": path_str(&self.paths.home),
                    "isDev": self.paths.assets.join("../docs/public/script-api.d.ts").is_file(),
                    "platform": if cfg!(target_os = "macos") { "darwin" } else if cfg!(target_os = "windows") { "win32" } else { "linux" },
                    "temp": path_str(&self.paths.temp),
                    "workspaceDir": path_str(&self.paths.workspace),
                })
                .to_string(),
            )),
            "reply" => {
                let to = arg_number(&mut args, "an account")? as u64;
                let id = arg_number(&mut args, "a call id")? as u64;
                let envelope = arg_string(&mut args, "a JSON envelope")?;
                if let Some(router) = self.router.upgrade() {
                    router.reply(to, id, &envelope);
                }
                Ok(Ret::Undefined)
            }
            "emit" => {
                let to = arg_number(&mut args, "an account")? as u64;
                let channel = arg_string(&mut args, "a channel")?;
                let payload = arg_string(&mut args, "a JSON payload")?;
                if let Some(router) = self.router.upgrade() {
                    router.emit(to, &channel, &payload);
                }
                Ok(Ret::Undefined)
            }
            "fs" => {
                let op = arg_string(&mut args, "a filesystem op")?;
                let path = PathBuf::from(arg_string(&mut args, "a path")?);
                fs_op(&op, &path, args).map_err(|error| HostError::new("FsError", error))
            }
            "hash" => {
                let algorithm = arg_string(&mut args, "an algorithm")?;
                let data = arg_string(&mut args, "base64 data")?;
                if algorithm != "sha256" && algorithm != "sha1" {
                    return Err(HostError::argument(format!("unsupported digest {algorithm}")));
                }
                let bytes = BASE64
                    .decode(data)
                    .map_err(|error| HostError::argument(error.to_string()))?;
                Ok(Ret::Str(match algorithm.as_str() {
                    "sha1" => hex(&Sha1::digest(bytes)),
                    _ => hex(&Sha256::digest(bytes)),
                }))
            }
            "random" => {
                let length = (arg_number(&mut args, "a length")? as usize).min(65_536);
                let mut bytes = vec![0u8; length];
                getrandom::fill(&mut bytes).map_err(|error| HostError::new("Error", error.to_string()))?;
                Ok(Ret::Str(hex(&bytes)))
            }
            "http" => {
                let request = arg_string(&mut args, "a JSON request")?;
                let request: Value = serde_json::from_str(&request)
                    .map_err(|error| HostError::argument(error.to_string()))?;
                let id = self.next_request;
                self.next_request += 1;
                self.start_http(id, request);
                Ok(Ret::Number(id as f64))
            }
            "appReply" => {
                let id = arg_number(&mut args, "a call id")? as u64;
                let result = arg_string(&mut args, "a JSON result")?;
                let result: Value = serde_json::from_str(&result)
                    .map_err(|error| HostError::argument(error.to_string()))?;
                if let Some(router) = self.router.upgrade() {
                    router.app_reply(id, result);
                }
                Ok(Ret::Undefined)
            }
            "tcpConnect" => {
                let host = arg_string(&mut args, "a host")?;
                let port = arg_number(&mut args, "a port")? as u16;
                let id = self.next_request;
                self.next_request += 1;
                self.start_connect(id, host, port);
                Ok(Ret::Number(id as f64))
            }
            "tcpCancel" | "httpCancel" => {
                let id = arg_number(&mut args, "a request id")? as u64;
                if let Some(handle) = self.requests.lock().unwrap().remove(&id) {
                    handle.abort();
                }
                Ok(Ret::Undefined)
            }
            "open" => {
                let target = arg_string(&mut args, "a path or URL")?;
                Ok(Ret::Bool(open::that_detached(&target).is_ok()))
            }
            "reveal" => {
                let path = arg_string(&mut args, "a path")?;
                let parent = Path::new(&path).parent().map(Path::to_path_buf).unwrap_or_default();
                let _ = open::that_detached(parent);
                Ok(Ret::Undefined)
            }
            _ => Err(HostError::argument(format!("unknown op {op}"))),
        }
    }
}

impl HubHost {
    fn start_http(&self, id: u64, request: Value) {
        let client = self.client.clone();
        let router = self.router.clone();
        let requests = self.requests.clone();
        let task = self.http.spawn(async move {
            let completion = match send(&client, &request).await {
                Ok(response) => json!({ "t": "http", "id": id, "ok": true, "response": response }),
                Err(message) => json!({ "t": "http", "id": id, "ok": false, "message": message }),
            };
            requests.lock().unwrap().remove(&id);
            if let Some(router) = router.upgrade() {
                router.post_hub(completion.to_string());
            }
        });
        self.requests
            .lock()
            .unwrap()
            .insert(id, task.abort_handle());
    }
}

impl HubHost {
    fn start_connect(&self, id: u64, host: String, port: u16) {
        let router = self.router.clone();
        let requests = self.requests.clone();
        let task = self.http.spawn(async move {
            let outcome = tokio::time::timeout(
                TCP_CONNECT_TIMEOUT,
                tokio::net::TcpStream::connect((host.as_str(), port)),
            )
            .await;
            let completion = match outcome {
                Ok(Ok(_)) => json!({ "t": "tcp", "id": id, "ok": true }),
                Ok(Err(error)) => {
                    json!({ "t": "tcp", "id": id, "ok": false, "message": error.to_string() })
                }
                Err(_) => json!({ "t": "tcp", "id": id, "ok": false, "message": "timed out" }),
            };
            requests.lock().unwrap().remove(&id);
            if let Some(router) = router.upgrade() {
                router.post_hub(completion.to_string());
            }
        });
        self.requests
            .lock()
            .unwrap()
            .insert(id, task.abort_handle());
    }
}

async fn send(client: &reqwest::Client, request: &Value) -> Result<Value, String> {
    let url = request["url"].as_str().ok_or("the request has no URL")?;
    let method =
        reqwest::Method::from_bytes(request["method"].as_str().unwrap_or("GET").as_bytes())
            .map_err(|error| error.to_string())?;
    let mut builder = client.request(method, url);
    if let Some(headers) = request["headers"].as_object() {
        for (name, value) in headers {
            if let Some(value) = value.as_str() {
                builder = builder.header(name, value);
            }
        }
    }
    if let Some(body) = request["body"].as_str() {
        builder = builder.body(BASE64.decode(body).map_err(|error| error.to_string())?);
    }
    let mut response = builder.send().await.map_err(|error| error.to_string())?;
    let mut headers = serde_json::Map::new();
    for name in response.headers().keys() {
        let values: Vec<Value> = response
            .headers()
            .get_all(name)
            .iter()
            .map(|value| Value::String(String::from_utf8_lossy(value.as_bytes()).into_owned()))
            .collect();
        let value = if name == reqwest::header::SET_COOKIE || values.len() > 1 {
            Value::Array(values)
        } else {
            values.into_iter().next().unwrap_or(Value::Null)
        };
        headers.insert(name.as_str().to_owned(), value);
    }
    let status = response.status();
    let final_url = response.url().to_string();
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        if body.len() + chunk.len() > HTTP_BODY_LIMIT {
            return Err(format!(
                "HTTP response exceeds the {HTTP_BODY_LIMIT} byte limit."
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(json!({
        "status": status.as_u16(),
        "statusText": status.canonical_reason().unwrap_or_default(),
        "url": final_url,
        "headers": headers,
        "body": BASE64.encode(body),
    }))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn code(error: &io::Error) -> &'static str {
    match error.kind() {
        io::ErrorKind::NotFound => "ENOENT",
        io::ErrorKind::AlreadyExists => "EEXIST",
        io::ErrorKind::PermissionDenied => "EACCES",
        io::ErrorKind::NotADirectory => "ENOTDIR",
        io::ErrorKind::IsADirectory => "EISDIR",
        io::ErrorKind::DirectoryNotEmpty => "ENOTEMPTY",
        io::ErrorKind::ReadOnlyFilesystem => "EROFS",
        io::ErrorKind::ResourceBusy => "EBUSY",
        io::ErrorKind::InvalidInput | io::ErrorKind::InvalidFilename => "EINVAL",
        _ => "EIO",
    }
}

fn fail(error: io::Error) -> String {
    format!("{}: {error}", code(&error))
}

fn millis(time: io::Result<SystemTime>) -> f64 {
    time.ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |elapsed| elapsed.as_secs_f64() * 1000.0)
}

fn kind(file_type: fs::FileType) -> &'static str {
    if file_type.is_symlink() {
        "symlink"
    } else if file_type.is_dir() {
        "directory"
    } else if file_type.is_file() {
        "file"
    } else {
        "other"
    }
}

fn stat_json(metadata: &fs::Metadata) -> Value {
    #[cfg(unix)]
    let (mode, dev, ino, nlink, uid, gid, ctime) = {
        use std::os::unix::fs::MetadataExt;
        (
            metadata.mode(),
            metadata.dev(),
            metadata.ino(),
            metadata.nlink(),
            metadata.uid(),
            metadata.gid(),
            metadata.ctime() as f64 * 1000.0 + metadata.ctime_nsec() as f64 / 1e6,
        )
    };
    #[cfg(not(unix))]
    let (mode, dev, ino, nlink, uid, gid, ctime) = (
        0u32,
        0u64,
        0u64,
        1u64,
        0u32,
        0u32,
        millis(metadata.modified()),
    );
    json!({
        "kind": kind(metadata.file_type()),
        "size": metadata.len(),
        "mode": mode,
        "dev": dev,
        "ino": ino,
        "nlink": nlink,
        "uid": uid,
        "gid": gid,
        "atimeMs": millis(metadata.accessed()),
        "mtimeMs": millis(metadata.modified()),
        "ctimeMs": ctime,
        "birthtimeMs": millis(metadata.created()),
    })
}

fn random_suffix() -> String {
    let mut bytes = [0u8; 6];
    let _ = getrandom::fill(&mut bytes);
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    bytes
        .iter()
        .map(|byte| ALPHABET[*byte as usize % ALPHABET.len()] as char)
        .collect()
}

fn fs_op(op: &str, path: &Path, args: std::vec::IntoIter<Arg>) -> Result<Ret, String> {
    let mut args = args;
    let mut next = || args.next().unwrap_or(Arg::Undefined);
    match op {
        "stat" => {
            let follow = next().as_bool().unwrap_or(true);
            let metadata = if follow {
                fs::metadata(path)
            } else {
                fs::symlink_metadata(path)
            }
            .map_err(fail)?;
            Ok(Ret::Str(stat_json(&metadata).to_string()))
        }
        "readFile" => {
            let limit = next().as_number().map(|limit| limit as u64);
            let file = File::open(path).map_err(fail)?;
            if file.metadata().map_err(fail)?.is_dir() {
                return Err(fail(io::Error::from(io::ErrorKind::IsADirectory)));
            }
            let mut bytes = Vec::new();
            match limit {
                Some(limit) => file.take(limit).read_to_end(&mut bytes),
                None => (&file).read_to_end(&mut bytes),
            }
            .map_err(fail)?;
            Ok(Ret::Str(BASE64.encode(bytes)))
        }
        "writeFile" => {
            let data = next().into_string().unwrap_or_default();
            let flag = next().into_string().unwrap_or_else(|| "w".into());
            let mode = next().as_number().map(|mode| mode as u32);
            let bytes = BASE64
                .decode(data)
                .map_err(|error| format!("EINVAL: {error}"))?;
            let mut options = OpenOptions::new();
            match flag.as_str() {
                "wx" | "wx+" => options.write(true).create_new(true),
                "a" | "a+" => options.append(true).create(true),
                "ax" | "ax+" => options.append(true).create_new(true),
                _ => options.write(true).create(true).truncate(true),
            };
            #[cfg(unix)]
            if let Some(mode) = mode {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(mode);
            }
            #[cfg(not(unix))]
            let _ = mode;
            let mut file = options.open(path).map_err(fail)?;
            file.write_all(&bytes).map_err(fail)?;
            Ok(Ret::Undefined)
        }
        "rename" => {
            let to = next().into_string().ok_or("EINVAL: missing destination")?;
            fs::rename(path, to).map_err(fail)?;
            Ok(Ret::Undefined)
        }
        "mkdir" => {
            let recursive = next().as_bool().unwrap_or(false);
            if recursive {
                fs::create_dir_all(path).map_err(fail)?;
            } else {
                fs::create_dir(path).map_err(fail)?;
            }
            Ok(Ret::Undefined)
        }
        "rm" => {
            let recursive = next().as_bool().unwrap_or(false);
            let force = next().as_bool().unwrap_or(false);
            let result = match fs::symlink_metadata(path) {
                Ok(metadata) if metadata.is_dir() => {
                    if recursive {
                        fs::remove_dir_all(path)
                    } else {
                        fs::remove_dir(path)
                    }
                }
                Ok(_) => fs::remove_file(path),
                Err(error) => Err(error),
            };
            match result {
                Err(error) if force && error.kind() == io::ErrorKind::NotFound => {
                    Ok(Ret::Undefined)
                }
                Err(error) => Err(fail(error)),
                Ok(()) => Ok(Ret::Undefined),
            }
        }
        "readdir" => {
            let mut entries = Vec::new();
            for entry in fs::read_dir(path).map_err(fail)? {
                let entry = entry.map_err(fail)?;
                let file_type = entry.file_type().map_err(fail)?;
                entries.push(json!({
                    "name": entry.file_name().to_string_lossy(),
                    "kind": kind(file_type),
                }));
            }
            Ok(Ret::Str(Value::Array(entries).to_string()))
        }
        "mkdtemp" => {
            for _ in 0..16 {
                let candidate = PathBuf::from(format!("{}{}", path.display(), random_suffix()));
                match fs::create_dir(&candidate) {
                    Ok(()) => return Ok(Ret::Str(path_str(&candidate))),
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(error) => return Err(fail(error)),
                }
            }
            Err("EEXIST: could not create a unique directory".into())
        }
        "realpath" => Ok(Ret::Str(path_str(&fs::canonicalize(path).map_err(fail)?))),
        "readlink" => Ok(Ret::Str(path_str(&fs::read_link(path).map_err(fail)?))),
        "symlink" => {
            let target = next().into_string().ok_or("EINVAL: missing target")?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(target, path).map_err(fail)?;
            #[cfg(not(unix))]
            return Err(format!("EPERM: symlinks are not supported ({target})"));
            #[cfg(unix)]
            Ok(Ret::Undefined)
        }
        "copyFile" => {
            let to = next().into_string().ok_or("EINVAL: missing destination")?;
            fs::copy(path, to).map_err(fail)?;
            Ok(Ret::Undefined)
        }
        "chmod" => {
            let mode = next().as_number().unwrap_or(0o644 as f64) as u32;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(fail)?;
            }
            #[cfg(not(unix))]
            let _ = mode;
            Ok(Ret::Undefined)
        }
        "truncate" => {
            let length = next().as_number().unwrap_or(0.0) as u64;
            OpenOptions::new()
                .write(true)
                .open(path)
                .and_then(|file| file.set_len(length))
                .map_err(fail)?;
            Ok(Ret::Undefined)
        }
        "utimes" => {
            let accessed = next().as_number().unwrap_or(0.0);
            let modified = next().as_number().unwrap_or(0.0);
            let at = |ms: f64| UNIX_EPOCH + Duration::from_secs_f64((ms / 1000.0).max(0.0));
            let times = fs::FileTimes::new()
                .set_accessed(at(accessed))
                .set_modified(at(modified));
            File::options()
                .write(true)
                .open(path)
                .and_then(|file| file.set_times(times))
                .map_err(fail)?;
            Ok(Ret::Undefined)
        }
        other => Err(format!("EINVAL: unknown filesystem op {other}")),
    }
}
