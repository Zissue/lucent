pub(crate) mod http;
pub(crate) mod policy;

use std::time::Duration;

use async_channel::{Receiver, Sender};
use ruffle_core::backend::navigator::{
    ErrorResponse, NavigationMethod, NavigatorBackend, OwnedFuture, Request, SuccessResponse,
    async_return, create_fetch_error,
};
use ruffle_core::indexmap::IndexMap;
use ruffle_core::loader::Error as LoaderError;
use ruffle_core::socket::{ConnectionState, SocketAction, SocketHandle};
use url::{ParseError, Url};

use crate::executor::LocalSpawner;
use crate::host::Movie;
use http::{AssetResponse, HttpClient};

const ASSET_SCHEME: &str = "lucent-asset";

pub(crate) struct LucentNavigator {
    base: Url,
    movie: Movie,
    http: HttpClient,
    spawner: LocalSpawner,
}

impl LucentNavigator {
    pub(crate) fn new(movie: Movie, http: HttpClient, spawner: LocalSpawner) -> Self {
        let base = movie.url.join("./").expect("the movie URL has a path");
        Self {
            base,
            movie,
            http,
            spawner,
        }
    }
}

impl NavigatorBackend for LucentNavigator {
    fn navigate_to_url(
        &self,
        url: &str,
        _target: &str,
        _vars_method: Option<(NavigationMethod, IndexMap<String, String>)>,
    ) {
        tracing::warn!(
            url,
            "the game asked to open a link, which this build ignores"
        );
    }

    fn fetch(&self, request: Request) -> OwnedFuture<Box<dyn SuccessResponse>, ErrorResponse> {
        let url = match self.resolve_url(request.url()) {
            Ok(url) => url,
            Err(error) => return async_return(Err(create_fetch_error(request.url(), error))),
        };
        tracing::debug!(%url, "fetch");
        match url.scheme() {
            "http" | "https" => self.http.fetch(url, &request),
            ASSET_SCHEME if url == self.movie.url => {
                let response = AssetResponse::new(&url, self.movie.bytes.clone());
                async_return(Ok(Box::new(response) as Box<dyn SuccessResponse>))
            }
            _ => async_return(Err(ErrorResponse {
                url: url.to_string(),
                error: LoaderError::HttpNotOk("Not Found".into(), 404, false, 0),
            })),
        }
    }

    fn resolve_url(&self, url: &str) -> Result<Url, ParseError> {
        self.base.join(url)
    }

    fn spawn_future(&mut self, future: OwnedFuture<(), LoaderError>) {
        self.spawner.spawn(future);
    }

    fn pre_process_url(&self, url: Url) -> Url {
        url
    }

    fn connect_socket(
        &mut self,
        host: String,
        port: u16,
        _timeout: Duration,
        handle: SocketHandle,
        _receiver: Receiver<Vec<u8>>,
        sender: Sender<SocketAction>,
    ) {
        tracing::warn!(
            host,
            port,
            "the game opened a socket, which this build refuses"
        );
        let _ = sender.try_send(SocketAction::Connect(handle, ConnectionState::Failed));
    }
}
