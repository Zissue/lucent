use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

use serde_json::Value;

use crate::account::AccountInner;

/// Carries `window.desktop` invokes from account runtimes to the hub, and the hub's
/// replies and events back, the way Electron IPC connects game renderers to main.
pub(crate) type AppReply = futures::channel::oneshot::Sender<Result<Value, String>>;

#[derive(Default)]
pub(crate) struct Router {
    hub: Mutex<Option<Arc<js::Runtime>>>,
    accounts: Mutex<HashMap<u64, Weak<AccountInner>>>,
    app_calls: Mutex<HashMap<u64, AppReply>>,
    next_app_call: std::sync::atomic::AtomicU64,
}

impl Router {
    pub(crate) fn set_hub(&self, hub: Option<Arc<js::Runtime>>) {
        *self.hub.lock().unwrap() = hub;
    }

    pub(crate) fn register(&self, key: u64, account: Weak<AccountInner>) {
        self.accounts.lock().unwrap().insert(key, account);
    }

    pub(crate) fn unregister(&self, key: u64) {
        self.accounts.lock().unwrap().remove(&key);
        self.post_hub(format!(r#"{{"t":"closed","account":{key}}}"#));
    }

    fn account(&self, key: u64) -> Option<Arc<AccountInner>> {
        self.accounts
            .lock()
            .unwrap()
            .get(&key)
            .and_then(Weak::upgrade)
    }

    pub(crate) fn post_hub(&self, item: String) -> bool {
        match &*self.hub.lock().unwrap() {
            Some(hub) => {
                hub.post(item);
                true
            }
            None => false,
        }
    }

    pub(crate) fn invoke(&self, from: u64, id: u64, channel: &str, payload: Option<&str>) {
        let channel_json = Value::String(channel.to_owned()).to_string();
        let item = match payload {
            Some(payload) => format!(
                r#"{{"t":"invoke","from":{from},"id":{id},"channel":{channel_json},"payload":{payload}}}"#
            ),
            None => format!(r#"{{"t":"invoke","from":{from},"id":{id},"channel":{channel_json}}}"#),
        };
        if !self.post_hub(item) {
            let message = Value::String(format!("{channel} is not available")).to_string();
            self.reply(from, id, &format!(r#"{{"ok":false,"message":{message}}}"#));
        }
    }

    pub(crate) fn reply(&self, to: u64, id: u64, envelope: &str) {
        if let Some(account) = self.account(to) {
            account.post(format!(
                r#"{{"t":"reply","id":{id},"envelope":{envelope}}}"#
            ));
        }
    }

    pub(crate) fn emit(&self, to: u64, channel: &str, payload: &str) {
        if let Some(account) = self.account(to) {
            let channel = Value::String(channel.to_owned()).to_string();
            account.post(format!(
                r#"{{"t":"event","channel":{channel},"payload":{payload}}}"#
            ));
        }
    }

    pub(crate) fn app_call(&self, method: &str, payload: Value, reply: AppReply) {
        let id = self
            .next_app_call
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.app_calls.lock().unwrap().insert(id, reply);
        let item =
            serde_json::json!({ "t": "app", "id": id, "method": method, "payload": payload });
        if !self.post_hub(item.to_string())
            && let Some(reply) = self.app_calls.lock().unwrap().remove(&id)
        {
            let _ = reply.send(Err("The script runtime is not running.".into()));
        }
    }

    pub(crate) fn app_reply(&self, id: u64, result: Value) {
        if let Some(reply) = self.app_calls.lock().unwrap().remove(&id) {
            let outcome = if result["ok"] == Value::Bool(true) {
                Ok(result["value"].clone())
            } else {
                Err(result["message"]
                    .as_str()
                    .unwrap_or("The hub call failed.")
                    .to_owned())
            };
            let _ = reply.send(outcome);
        }
    }
}
