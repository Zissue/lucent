use std::fmt;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ruffle_core::backend::storage::{MemoryStorageBackend, StorageBackend};
use ruffle_frontend_utils::backends::storage::DiskStorageBackend;
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Profile {
    directory: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProfileError {
    EmptyUsername,
}

impl fmt::Display for ProfileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyUsername => f.write_str("account username cannot be empty"),
        }
    }
}

impl std::error::Error for ProfileError {}

impl Profile {
    pub fn account(data_dir: impl AsRef<Path>, username: &str) -> Result<Self, ProfileError> {
        let username = username.trim_matches(ecmascript_whitespace).to_lowercase();
        if username.is_empty() {
            return Err(ProfileError::EmptyUsername);
        }
        let key = format!("{:x}", Sha256::digest(username.as_bytes()));
        Ok(Self {
            directory: data_dir.as_ref().join("game-profiles").join(key),
        })
    }

    pub fn default_profile(data_dir: impl AsRef<Path>) -> Self {
        Self {
            directory: data_dir.as_ref().join("game-profiles/default"),
        }
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }
}

fn ecmascript_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub struct ProfileLease {
    storage: Box<dyn StorageBackend>,
    _lock: Option<Arc<File>>,
}

impl ProfileLease {
    pub fn acquire(profile: &Profile) -> io::Result<Self> {
        fs::create_dir_all(profile.directory())?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(profile.directory().join("lucent.lock"))?;
        match lock.try_lock() {
            Ok(()) => {
                let root = profile.directory().join("SharedObjects");
                fs::create_dir_all(&root)?;
                let root = fs::canonicalize(root)?;
                let lock = Arc::new(lock);
                Ok(Self {
                    storage: Box::new(LeasedStorage {
                        disk: DiskStorageBackend::new(root),
                        _lock: lock.clone(),
                    }),
                    _lock: Some(lock),
                })
            }
            Err(TryLockError::WouldBlock) => Ok(Self {
                storage: Box::new(MemoryStorageBackend::new()),
                _lock: None,
            }),
            Err(TryLockError::Error(error)) => Err(error),
        }
    }

    pub fn take_storage(&mut self) -> Box<dyn StorageBackend> {
        std::mem::replace(&mut self.storage, Box::new(MemoryStorageBackend::new()))
    }
}

struct LeasedStorage {
    disk: DiskStorageBackend,
    _lock: Arc<File>,
}

impl StorageBackend for LeasedStorage {
    fn get(&self, name: &str) -> Option<Vec<u8>> {
        self.disk.get(name)
    }

    fn put(&mut self, name: &str, value: &[u8]) -> bool {
        self.disk.put(name, value)
    }

    fn remove_key(&mut self, name: &str) {
        self.disk.remove_key(name);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_normalized_account_names() {
        let dir = tempfile::tempdir().unwrap();
        let expected = dir
            .path()
            .join("game-profiles")
            .join(format!("{:x}", Sha256::digest(b"alice")));
        for username in ["  Alice ", "alice", "ALICE", "\u{feff}Alice\u{00a0}"] {
            assert_eq!(
                Profile::account(dir.path(), username).unwrap().directory(),
                expected
            );
        }
        assert_eq!(
            Profile::account(dir.path(), " \t\n\u{feff}"),
            Err(ProfileError::EmptyUsername)
        );
        assert_eq!(
            Profile::default_profile(dir.path()).directory(),
            dir.path().join("game-profiles/default")
        );
    }

    #[test]
    fn concurrent_leases_use_isolated_memory_storage() {
        let dir = tempfile::tempdir().unwrap();
        for profile in [
            Profile::account(dir.path(), "Alice").unwrap(),
            Profile::default_profile(dir.path()),
        ] {
            let mut first = ProfileLease::acquire(&profile).unwrap();
            let mut persistent = first.take_storage();
            assert!(persistent.put("game/settings", b"saved"));
            let mut second = ProfileLease::acquire(&profile).unwrap();
            let mut temporary = second.take_storage();
            assert!((&*temporary as &dyn std::any::Any).is::<MemoryStorageBackend>());
            assert_eq!(temporary.get("game/settings"), None);
            assert!(temporary.put("game/settings", b"temporary"));
            assert_eq!(temporary.get("game/settings"), Some(b"temporary".to_vec()));
            assert_eq!(persistent.get("game/settings"), Some(b"saved".to_vec()));
            drop(temporary);
            drop(second);
            drop(persistent);
            drop(first);
            let mut later = ProfileLease::acquire(&profile).unwrap();
            assert_eq!(
                later.take_storage().get("game/settings"),
                Some(b"saved".to_vec())
            );
        }
    }

    #[test]
    fn shared_objects_persist_only_for_the_same_account() {
        let dir = tempfile::tempdir().unwrap();
        let alice = Profile::account(dir.path(), "Alice").unwrap();
        {
            let mut lease = ProfileLease::acquire(&alice).unwrap();
            assert!(lease.take_storage().put("game/settings", b"alice settings"));
        }
        let mut same =
            ProfileLease::acquire(&Profile::account(dir.path(), "  ALICE ").unwrap()).unwrap();
        assert_eq!(
            same.take_storage().get("game/settings"),
            Some(b"alice settings".to_vec())
        );
        let mut other =
            ProfileLease::acquire(&Profile::account(dir.path(), "Bob").unwrap()).unwrap();
        assert_eq!(other.take_storage().get("game/settings"), None);
    }

    #[test]
    fn storage_errors_are_not_treated_as_contention() {
        let dir = tempfile::tempdir().unwrap();
        let profile = Profile::default_profile(dir.path());
        fs::create_dir_all(profile.directory()).unwrap();
        fs::write(profile.directory().join("lucent.lock"), []).unwrap();
        fs::write(
            profile.directory().join("SharedObjects"),
            b"not a directory",
        )
        .unwrap();
        assert!(ProfileLease::acquire(&profile).is_err());
    }

    #[test]
    fn storage_retains_the_lock_if_it_outlives_the_lease() {
        let dir = tempfile::tempdir().unwrap();
        let profile = Profile::default_profile(dir.path());
        let mut lease = ProfileLease::acquire(&profile).unwrap();
        let mut storage = lease.take_storage();
        drop(lease);
        assert!(storage.put("settings", b"still owned"));
        {
            let mut concurrent = ProfileLease::acquire(&profile).unwrap();
            assert_eq!(concurrent.take_storage().get("settings"), None);
        }
        drop(storage);
        let mut later = ProfileLease::acquire(&profile).unwrap();
        assert_eq!(
            later.take_storage().get("settings"),
            Some(b"still owned".to_vec())
        );
    }

    #[test]
    fn shared_objects_work_with_parent_components_in_the_data_directory() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("nested")).unwrap();
        let profile = Profile::default_profile(dir.path().join("nested/.."));
        let mut lease = ProfileLease::acquire(&profile).unwrap();
        let mut storage = lease.take_storage();
        assert!(storage.put("settings", b"relative directory"));
        assert_eq!(
            storage.get("settings"),
            Some(b"relative directory".to_vec())
        );
        storage.remove_key("settings");
        assert_eq!(storage.get("settings"), None);
    }
}
