use std::collections::HashMap;
use std::path::Path;

use serde_json::{Value, json};

use crate::preferences;

/// One entry of `AccountServers.get`.
#[derive(Clone, Debug, PartialEq)]
pub struct LoginServer {
    pub name: String,
    pub language: String,
    pub online: bool,
    pub upgrade: bool,
    pub players: u32,
    pub max_players: u32,
}

impl LoginServer {
    pub fn full(&self) -> bool {
        self.players >= self.max_players
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Ping {
    Ok(u32),
    Offline,
    Timeout,
    Unreachable,
}

/// Electron's `AccountLoginServerPreference`.
#[derive(Clone, Debug, PartialEq)]
pub enum Preference {
    None,
    Server(String),
}

pub fn parse_servers(value: &Value) -> Vec<LoginServer> {
    value["servers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|server| {
            Some(LoginServer {
                name: server["name"].as_str()?.to_owned(),
                language: server["language"].as_str().unwrap_or_default().to_owned(),
                online: server["online"].as_bool().unwrap_or(false),
                upgrade: server["upgrade"].as_bool().unwrap_or(false),
                players: server["playerCount"].as_u64().unwrap_or(0) as u32,
                max_players: server["maxPlayers"].as_u64().unwrap_or(0) as u32,
            })
        })
        .collect()
}

pub fn parse_pings(value: &Value) -> HashMap<String, Ping> {
    value["pings"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|ping| {
            let name = ping["serverName"].as_str()?.to_owned();
            let ping = match ping["status"].as_str()? {
                "ok" => Ping::Ok(ping["latencyMs"].as_u64()? as u32),
                "offline" => Ping::Offline,
                "timeout" => Ping::Timeout,
                _ => Ping::Unreachable,
            };
            Some((name, ping))
        })
        .collect()
}

/// `resolveAccountLoginServerPreference`: `Some(None)` means stop at server select, and
/// `None` means no server can be chosen.
pub fn resolve(servers: &[LoginServer], preference: Option<&Preference>) -> Option<Option<String>> {
    match preference {
        Some(Preference::None) => return Some(None),
        Some(Preference::Server(name))
            if servers
                .iter()
                .any(|server| &server.name == name && server.online) =>
        {
            return Some(Some(name.clone()));
        }
        _ => {}
    }
    servers
        .iter()
        .find(|server| server.online && !server.full())
        .map(|server| Some(server.name.clone()))
}

pub fn load_preference(data_dir: &Path) -> Option<Preference> {
    let server = &preferences::read(data_dir)["loginServer"];
    match server["type"].as_str()? {
        "none" => Some(Preference::None),
        "server" => server["name"]
            .as_str()
            .filter(|name| !name.trim().is_empty())
            .map(|name| Preference::Server(name.to_owned())),
        _ => None,
    }
}

pub fn save_preference(data_dir: &Path, preference: &Preference) {
    let value = match preference {
        Preference::None => json!({ "type": "none" }),
        Preference::Server(name) => json!({ "type": "server", "name": name }),
    };
    preferences::write(data_dir, "loginServer", value);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(name: &str, online: bool, players: u32) -> LoginServer {
        LoginServer {
            name: name.into(),
            language: "en".into(),
            online,
            upgrade: false,
            players,
            max_players: 10,
        }
    }

    #[test]
    fn resolves_the_login_server_like_electron() {
        let servers = [
            server("Artix", false, 0),
            server("Twig", true, 10),
            server("Yorumi", true, 3),
        ];
        assert_eq!(resolve(&servers, Some(&Preference::None)), Some(None));
        assert_eq!(
            resolve(&servers, Some(&Preference::Server("Twig".into()))),
            Some(Some("Twig".into()))
        );
        assert_eq!(
            resolve(&servers, Some(&Preference::Server("Artix".into()))),
            Some(Some("Yorumi".into()))
        );
        assert_eq!(resolve(&servers, None), Some(Some("Yorumi".into())));
        assert_eq!(resolve(&[server("Artix", false, 0)], None), None);
    }

    #[test]
    fn reads_servers_and_pings_from_the_hub() {
        let servers = parse_servers(&json!({ "servers": [
            { "name": "Twig", "language": "en", "online": true, "upgrade": false, "playerCount": 4, "maxPlayers": 10 }
        ], "refreshAvailableAt": 0 }));
        assert_eq!(servers, vec![server("Twig", true, 4)]);
        let pings = parse_pings(&json!({ "pings": [
            { "serverName": "Twig", "status": "ok", "latencyMs": 48 },
            { "serverName": "Artix", "status": "timeout" }
        ] }));
        assert_eq!(pings["Twig"], Ping::Ok(48));
        assert_eq!(pings["Artix"], Ping::Timeout);
    }

    #[test]
    fn persists_the_preference() {
        let dir = tempfile::tempdir().unwrap();
        save_preference(dir.path(), &Preference::Server("Twig".into()));
        assert_eq!(
            load_preference(dir.path()),
            Some(Preference::Server("Twig".into()))
        );
        save_preference(dir.path(), &Preference::None);
        assert_eq!(load_preference(dir.path()), Some(Preference::None));
    }
}
