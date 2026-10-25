use std::borrow::Cow;
use std::collections::BTreeMap;
use std::fmt;

#[derive(Clone, Debug, PartialEq)]
pub enum AsValue {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    List(Vec<AsValue>),
    Object(BTreeMap<String, AsValue>),
}

#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct CallbackName(Cow<'static, str>);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InvalidCallbackName(pub String);

impl CallbackName {
    pub fn new(name: impl Into<String>) -> Result<Self, InvalidCallbackName> {
        let name = name.into();
        if is_valid(name.as_bytes()) {
            Ok(Self(Cow::Owned(name)))
        } else {
            Err(InvalidCallbackName(name))
        }
    }

    pub const fn from_static(name: &'static str) -> Self {
        assert!(is_valid(name.as_bytes()), "invalid callback name");
        Self(Cow::Borrowed(name))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

const fn is_valid(bytes: &[u8]) -> bool {
    if bytes.is_empty() || bytes.len() > 128 {
        return false;
    }
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if !(b.is_ascii_alphanumeric() || b == b'_' || b == b'.') {
            return false;
        }
        i += 1;
    }
    true
}

impl fmt::Debug for CallbackName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl fmt::Display for CallbackName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_ascii_callback_names_and_length_boundaries() {
        const NAME: CallbackName = CallbackName::from_static("auth.isLoggedIn");
        assert_eq!(NAME.as_str(), "auth.isLoggedIn");
        assert_eq!(
            CallbackName::new("player.getLevel_09").unwrap().as_str(),
            "player.getLevel_09"
        );
        assert_eq!(CallbackName::new("_").unwrap().as_str(), "_");
        assert_eq!(
            CallbackName::new("a".repeat(128)).unwrap().as_str(),
            "a".repeat(128)
        );
        assert_eq!(CallbackName::new("auth.isLoggedIn").unwrap(), NAME);
        assert_eq!(format!("{NAME}"), "auth.isLoggedIn");
        assert_eq!(format!("{NAME:?}"), "auth.isLoggedIn");
    }

    #[test]
    fn rejects_empty_long_non_ascii_and_punctuated_names() {
        for name in [
            "",
            "player.get-level",
            "a b",
            "a/b",
            "a\0b",
            "café",
            "回",
            "a\nb",
        ] {
            assert_eq!(
                CallbackName::new(name),
                Err(InvalidCallbackName(name.to_owned()))
            );
        }
        assert_eq!(
            CallbackName::new("a".repeat(129)),
            Err(InvalidCallbackName("a".repeat(129)))
        );
    }

    #[test]
    #[should_panic(expected = "invalid callback name")]
    fn rejects_invalid_static_names() {
        let _ = CallbackName::from_static("player.get-level");
    }
}
