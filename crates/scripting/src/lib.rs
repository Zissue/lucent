mod account;
mod hub;
mod router;
mod value;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

pub use account::{AccountEvent, AccountOptions, AccountRuntime, ConsoleLevel};
pub use hub::HubPaths;

/// Owns the router that connects every account runtime to the shared hub.
pub struct Scripting {
    router: Arc<router::Router>,
    next_account: AtomicU64,
    debug: bool,
}

impl Scripting {
    pub fn start(paths: HubPaths, debug: bool) -> std::io::Result<Self> {
        let router = Arc::new(router::Router::default());
        hub::spawn(router.clone(), paths, debug)?;
        Ok(Self {
            router,
            next_account: AtomicU64::new(1),
            debug,
        })
    }

    /// Calls one of the hub's app methods (`servers.get`, `servers.refresh`,
    /// `servers.pings`, `scripts.describe`).
    pub fn hub_call(
        &self,
        method: &str,
        payload: serde_json::Value,
    ) -> futures::channel::oneshot::Receiver<Result<serde_json::Value, String>> {
        let (tx, rx) = futures::channel::oneshot::channel();
        self.router.app_call(method, payload, tx);
        rx
    }

    pub fn open_account(
        &self,
        session: bridge::Session,
    ) -> std::io::Result<(AccountRuntime, async_channel::Receiver<AccountEvent>)> {
        let key = self.next_account.fetch_add(1, Ordering::Relaxed);
        AccountRuntime::open(
            key,
            session,
            self.router.clone(),
            AccountOptions { debug: self.debug },
        )
    }
}
