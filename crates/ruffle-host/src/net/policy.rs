use reqwest::Method;
use reqwest::header::{ACCEPT_ENCODING, HeaderMap, HeaderName, HeaderValue, ORIGIN, USER_AGENT};
use url::Url;

const ARTIX_DOMAINS: [&str; 3] = ["aq.com", "aqworlds.com", "artix.com"];

fn in_domain(host: &str, domain: &str) -> bool {
    host == domain
        || host
            .strip_suffix(domain)
            .is_some_and(|prefix| prefix.ends_with('.'))
}

pub(crate) fn allowed_link(raw: &str) -> Option<Url> {
    let url = Url::parse(raw).ok()?;
    if url.port().is_some() || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let host = url.host_str()?;
    let allowed = url.as_str() == "https://github.com/settings/personal-access-tokens/new"
        || [
            ("https", "aq.com"),
            ("https", "artix.com"),
            ("https", "account.aq.com"),
            ("http", "aqwwiki.wikidot.com"),
            ("https", "heromart.com"),
            ("http", "account.aqworlds.com"),
        ]
        .iter()
        .any(|(scheme, root)| url.scheme() == *scheme && in_domain(host, root));
    allowed.then_some(url)
}

pub(crate) const USER_AGENT_VALUE: &str = if cfg!(target_os = "macos") {
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_16_0) AppleWebKit/537.36 (KHTML, like Gecko) ArtixGameLauncher/2.2.0 Chrome/80.0.3987.163 Electron/8.5.5 Safari/537.36"
} else if cfg!(target_os = "linux") {
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ArtixGameLauncher/2.2.0 Chrome/80.0.3987.163 Electron/8.5.5 Safari/537.36"
} else {
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ArtixGameLauncher/2.2.0 Chrome/80.0.3987.163 Electron/8.5.5 Safari/537.36"
};

pub(crate) fn is_artix_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    ARTIX_DOMAINS.iter().any(|domain| in_domain(&host, domain))
}

pub(crate) fn allow_socket(host: &str, port: u16) -> bool {
    port != 0 && is_artix_host(host)
}

pub(crate) fn apply_launcher_headers(headers: &mut HeaderMap, method: &Method, url: &Url) {
    headers.insert(USER_AGENT, HeaderValue::from_static(USER_AGENT_VALUE));
    headers.insert(
        HeaderName::from_static("x-requested-with"),
        HeaderValue::from_static("ShockwaveFlash/32.0.0.371"),
    );
    headers.insert(
        HeaderName::from_static("artixmode"),
        HeaderValue::from_static("launcher"),
    );
    if !url.host_str().is_some_and(is_artix_host) {
        return;
    }
    let dropped: Vec<HeaderName> = headers
        .keys()
        .filter(|name| {
            let name = name.as_str();
            name.starts_with("sec-ch-ua")
                || name == "priority"
                || name == "accept-encoding"
                || name == "origin"
        })
        .cloned()
        .collect();
    for name in dropped {
        headers.remove(name);
    }
    headers.insert(
        ACCEPT_ENCODING,
        HeaderValue::from_static("gzip, deflate, br"),
    );
    if method != Method::GET && method != Method::HEAD {
        let origin = url.origin().ascii_serialization();
        headers.insert(
            ORIGIN,
            HeaderValue::from_str(&origin).expect("a serialized origin is a valid header value"),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_configured_game_domains_and_rejects_other_external_urls() {
        for raw in [
            "https://account.aq.com/CharPage?id=1",
            "https://support.artix.com/help",
            "https://github.com/settings/personal-access-tokens/new",
        ] {
            assert_eq!(allowed_link(raw).as_ref().map(Url::as_str), Some(raw));
        }
        for raw in [
            "https://github.com/settings/profile",
            "https://aq.com.evil.test/help",
            "https://user@aq.com/help",
            "https://aq.com:8443/help",
            "file:///tmp/lucent",
            "not a URL",
            "https://:password@aq.com/",
            "https://github.com/settings/personal-access-tokens/new?extra=1",
        ] {
            assert_eq!(allowed_link(raw), None, "{raw}");
        }
    }

    #[test]
    fn requires_the_configured_scheme() {
        assert_eq!(allowed_link("http://aq.com/"), None);
        assert_eq!(allowed_link("https://aqwwiki.wikidot.com/"), None);
        assert_eq!(
            allowed_link("http://aqwwiki.wikidot.com/class")
                .unwrap()
                .as_str(),
            "http://aqwwiki.wikidot.com/class"
        );
        assert_eq!(
            allowed_link("https://aq.com:443/").unwrap().as_str(),
            "https://aq.com/"
        );
        assert_eq!(
            allowed_link("https://heromart.com/shop").unwrap().as_str(),
            "https://heromart.com/shop"
        );
        assert_eq!(
            allowed_link("http://account.aqworlds.com/")
                .unwrap()
                .as_str(),
            "http://account.aqworlds.com/"
        );
    }

    fn sent(method: Method, url: &str, initial: &[(&str, &str)]) -> Vec<(String, String)> {
        let mut headers = HeaderMap::new();
        for (name, value) in initial {
            headers.append(
                HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        apply_launcher_headers(&mut headers, &method, &Url::parse(url).unwrap());
        let mut out: Vec<_> = headers
            .iter()
            .map(|(name, value)| (name.to_string(), value.to_str().unwrap().to_owned()))
            .collect();
        out.sort();
        out
    }

    fn sorted(expected: &[(&str, &str)]) -> Vec<(String, String)> {
        let mut out: Vec<_> = expected
            .iter()
            .map(|(n, v)| (n.to_string(), v.to_string()))
            .collect();
        out.sort();
        out
    }

    #[test]
    fn identifies_as_the_launcher_on_every_platform() {
        let expected = if cfg!(target_os = "macos") {
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_16_0) AppleWebKit/537.36 (KHTML, like Gecko) ArtixGameLauncher/2.2.0 Chrome/80.0.3987.163 Electron/8.5.5 Safari/537.36"
        } else if cfg!(target_os = "linux") {
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ArtixGameLauncher/2.2.0 Chrome/80.0.3987.163 Electron/8.5.5 Safari/537.36"
        } else {
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ArtixGameLauncher/2.2.0 Chrome/80.0.3987.163 Electron/8.5.5 Safari/537.36"
        };
        assert_eq!(USER_AGENT_VALUE, expected);
    }

    #[test]
    fn sends_launcher_identity_and_encoding_to_artix_gets_without_origin() {
        assert_eq!(
            sent(
                Method::GET,
                "https://game.aq.com/game/api/data/gameversion",
                &[
                    ("Accept-Encoding", "identity"),
                    ("sec-ch-ua", "x"),
                    ("sec-ch-ua-platform", "y"),
                    ("Priority", "u=1")
                ]
            ),
            sorted(&[
                ("user-agent", USER_AGENT_VALUE),
                ("x-requested-with", "ShockwaveFlash/32.0.0.371"),
                ("artixmode", "launcher"),
                ("accept-encoding", "gzip, deflate, br"),
            ])
        );
    }

    #[test]
    fn sends_the_target_origin_on_artix_posts() {
        assert_eq!(
            sent(
                Method::POST,
                "https://game.aq.com/game/api/login/now?ran=1",
                &[("Origin", "lucent-asset://assets")]
            ),
            sorted(&[
                ("user-agent", USER_AGENT_VALUE),
                ("x-requested-with", "ShockwaveFlash/32.0.0.371"),
                ("artixmode", "launcher"),
                ("accept-encoding", "gzip, deflate, br"),
                ("origin", "https://game.aq.com"),
            ])
        );
    }

    #[test]
    fn sends_only_launcher_identity_to_other_hosts() {
        assert_eq!(
            sent(
                Method::POST,
                "https://example.com/a",
                &[("Accept-Encoding", "identity"), ("Origin", "x")]
            ),
            sorted(&[
                ("user-agent", USER_AGENT_VALUE),
                ("x-requested-with", "ShockwaveFlash/32.0.0.371"),
                ("artixmode", "launcher"),
                ("accept-encoding", "identity"),
                ("origin", "x"),
            ])
        );
    }

    #[test]
    fn replaces_identity_headers_the_movie_set() {
        let headers = sent(
            Method::GET,
            "https://example.com/",
            &[("User-Agent", "Shockwave Flash"), ("artixmode", "web")],
        );
        assert_eq!(
            headers
                .iter()
                .filter(|(name, _)| name == "user-agent")
                .count(),
            1
        );
        assert!(headers.contains(&("artixmode".into(), "launcher".into())));
    }

    #[test]
    fn accepts_artix_domains_and_their_subdomains_in_any_case() {
        let hosts = ["aq.com", "game.aq.com", "AQWorlds.com", "cdn.artix.com"];
        assert_eq!(hosts.map(is_artix_host), [true; 4]);
    }

    #[test]
    fn rejects_look_alike_hosts() {
        let hosts = [
            "evilaq.com",
            "aq.com.example.net",
            "artix.co",
            "example.com",
            "aq.com.",
        ];
        assert_eq!(hosts.map(is_artix_host), [false; 5]);
    }

    #[test]
    fn allows_sockets_only_to_artix_hosts_on_a_real_port() {
        assert!(allow_socket("socket.aq.com", 5588));
        assert!(allow_socket("AQWorlds.com", 65535));
        assert!(allow_socket("aq.com", 1));
        assert!(!allow_socket("aq.com", 0));
        assert!(!allow_socket("127.0.0.1", 5588));
        assert!(!allow_socket("aq.com.evil.test", 5588));
    }
}
