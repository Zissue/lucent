use ruffle_core::backend::navigator::{NavigationMethod, NavigatorBackend};
use ruffle_core::indexmap::IndexMap;

use super::{LucentNavigator, policy};
use crate::UiRequest;

impl LucentNavigator {
    pub(super) fn open_link(
        &self,
        raw: &str,
        vars_method: Option<(NavigationMethod, IndexMap<String, String>)>,
    ) {
        let Ok(mut url) = self.resolve_url(raw) else {
            tracing::warn!(url = raw, "refused an invalid game link");
            return;
        };
        if let Some((NavigationMethod::Get, vars)) = vars_method
            && !vars.is_empty()
        {
            url.query_pairs_mut().extend_pairs(vars);
        }
        match policy::allowed_link(url.as_str()) {
            Some(url) => {
                let _ = self.ui.try_send(UiRequest::OpenUrl(url));
            }
            None => tracing::warn!(%url, "refused a game link outside the allowed policy"),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use futures::FutureExt;
    use futures::executor::block_on;
    use url::Url;

    use super::*;
    use crate::doorbell::Doorbell;
    use crate::executor::LocalExecutor;
    use crate::host::Movie;
    use crate::net::http::{HttpClient, NetTasks};
    use crate::ui;

    #[test]
    fn navigator_resolves_links_appends_get_variables_and_applies_policy() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let tasks = LocalExecutor::new(Doorbell::new());
        let (sender, requests) = ui::channel();
        let opened = bridge::open(
            bridge::SessionConfig::default(),
            std::task::Waker::noop().clone(),
        );
        let sequencer =
            std::rc::Rc::new(std::cell::RefCell::new(crate::sequencer::Sequencer::new(
                opened.player.events,
                NetTasks::new(runtime.handle().clone()),
                Doorbell::new(),
                crate::net::policy::allow_socket,
            )));
        let navigator = LucentNavigator::new(
            Movie {
                url: Url::parse("https://account.aq.com/game/loader.swf").unwrap(),
                bytes: Arc::from([]),
            },
            HttpClient::new(NetTasks::new(runtime.handle().clone())),
            tasks.spawner(),
            sequencer,
            sender,
        );
        navigator.navigate_to_url(
            "../CharPage?existing=1#stats",
            "_blank",
            Some((
                NavigationMethod::Get,
                IndexMap::from([
                    ("id".into(), "A B&1".into()),
                    ("existing".into(), "2".into()),
                ]),
            )),
        );
        assert_eq!(
            block_on(requests.next()),
            Some(UiRequest::OpenUrl(
                Url::parse(
                    "https://account.aq.com/CharPage?existing=1&id=A+B%261&existing=2#stats"
                )
                .unwrap()
            ))
        );
        navigator.navigate_to_url(
            "https://heromart.com/shop",
            "_blank",
            Some((
                NavigationMethod::Post,
                IndexMap::from([("secret".into(), "ignored".into())]),
            )),
        );
        assert_eq!(
            block_on(requests.next()),
            Some(UiRequest::OpenUrl(
                Url::parse("https://heromart.com/shop").unwrap()
            ))
        );
        for raw in [
            "http://aq.com/",
            "https://aq.com.evil.test/",
            "https://user@aq.com/",
            "https://[invalid",
        ] {
            navigator.navigate_to_url(raw, "_blank", None);
            assert!(requests.next().now_or_never().is_none());
        }
        navigator.navigate_to_url(
            "https://github.com/settings/personal-access-tokens/new",
            "_blank",
            Some((NavigationMethod::Get, IndexMap::new())),
        );
        assert_eq!(
            requests.next().now_or_never(),
            Some(Some(UiRequest::OpenUrl(
                Url::parse("https://github.com/settings/personal-access-tokens/new").unwrap()
            )))
        );
        navigator.navigate_to_url(
            "https://github.com/settings/personal-access-tokens/new",
            "_blank",
            Some((
                NavigationMethod::Get,
                IndexMap::from([("scope".into(), "all".into())]),
            )),
        );
        assert!(requests.next().now_or_never().is_none());
    }
}
