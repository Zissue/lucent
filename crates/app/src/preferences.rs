use std::path::Path;

use serde_json::{Value, json};

const FILE: &str = "native-preferences.json";

/// Native-only preferences. Electron keeps the same choices in renderer storage.
pub fn read(data_dir: &Path) -> Value {
    std::fs::read_to_string(data_dir.join(FILE))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

pub fn write(data_dir: &Path, key: &str, value: Value) {
    let mut preferences = read(data_dir);
    preferences[key] = value;
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(&preferences).unwrap_or_default()
    );
    if let Err(error) =
        std::fs::create_dir_all(data_dir).and_then(|()| std::fs::write(data_dir.join(FILE), text))
    {
        tracing::warn!(%error, "could not save a preference");
    }
}

pub fn muted(data_dir: &Path) -> bool {
    read(data_dir)["muted"].as_bool().unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_other_keys_and_defaults_to_muted() {
        let dir = tempfile::tempdir().unwrap();
        assert!(muted(dir.path()));
        write(dir.path(), "other", json!(1));
        write(dir.path(), "muted", json!(false));
        assert!(!muted(dir.path()));
        assert_eq!(read(dir.path())["other"], json!(1));
    }
}
