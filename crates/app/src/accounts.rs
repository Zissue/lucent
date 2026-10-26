use std::collections::HashSet;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::hash::{BuildHasher, Hasher, RandomState};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Map, Value, json};

const FILE_NAME: &str = "accounts.json";
const MAX_BYTES: u64 = 8 * 1024 * 1024;
const TEMP_PREFIX: &str = ".lucent-atomic-";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManagedAccount {
    pub label: String,
    pub username: String,
    pub password: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Group {
    pub name: String,
    pub usernames: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Storage {
    pub accounts: Vec<ManagedAccount>,
    pub groups: Vec<Group>,
}

/// A blank label falls back to the username.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AccountDraft {
    pub label: String,
    pub username: String,
    pub password: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GroupPatch {
    pub name: Option<String>,
    pub usernames: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EditError {
    Required(&'static str),
    DuplicateUsername,
    AccountNotFound,
    AccountsNotFound,
    MemberNotFound(String),
    DuplicateMember(String),
    DuplicateGroup,
    GroupNotFound,
}

impl fmt::Display for EditError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Required(field) => write!(f, "{field} is required"),
            Self::DuplicateUsername => f.write_str("An account with this username already exists"),
            Self::AccountNotFound => f.write_str("Account not found"),
            Self::AccountsNotFound => f.write_str("One or more accounts were not found"),
            Self::MemberNotFound(username) => write!(f, "Account not found: {username}"),
            Self::DuplicateMember(username) => write!(f, "Duplicate group member: {username}"),
            Self::DuplicateGroup => f.write_str("A group with this name already exists"),
            Self::GroupNotFound => f.write_str("Group not found"),
        }
    }
}

impl Storage {
    pub fn from_json(value: &Value) -> Storage {
        let Some(root) = value.as_object() else {
            return Storage::default();
        };
        let accounts = dedupe_accounts_by_username(
            root.get("accounts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(parse_account),
        );
        let groups = normalize_groups(root.get("groups"), &accounts);
        Storage { accounts, groups }
    }

    pub fn to_json(&self) -> Value {
        let accounts: Vec<Value> = self
            .accounts
            .iter()
            .map(|account| {
                json!({
                    "label": account.label,
                    "username": account.username,
                    "password": account.password,
                })
            })
            .collect();
        let groups: Map<String, Value> = self
            .groups
            .iter()
            .map(|group| (group.name.clone(), Value::from(group.usernames.clone())))
            .collect();
        json!({ "accounts": accounts, "groups": groups })
    }

    pub fn normalized(&self) -> Storage {
        Storage::from_json(&self.to_json())
    }

    pub fn account(&self, username: &str) -> Option<&ManagedAccount> {
        self.accounts
            .iter()
            .find(|account| account.username == username)
    }

    pub fn create_account(&self, draft: AccountDraft) -> Result<Storage, EditError> {
        let account = normalize_draft(&draft)?;
        if self.has_username(&account.username, None) {
            return Err(EditError::DuplicateUsername);
        }
        let mut next = self.clone();
        next.accounts.push(account);
        Ok(next)
    }

    pub fn update_account(
        &self,
        username: &str,
        draft: AccountDraft,
    ) -> Result<Storage, EditError> {
        let current = required(username, "username")?;
        let account = normalize_draft(&draft)?;
        if self.has_username(&account.username, Some(current)) {
            return Err(EditError::DuplicateUsername);
        }
        let mut next = self.clone();
        let slot = next
            .accounts
            .iter_mut()
            .find(|candidate| candidate.username == current)
            .ok_or(EditError::AccountNotFound)?;
        let renamed = account.username.clone();
        *slot = account;
        rename_group_member(&mut next.groups, current, &renamed);
        Ok(next)
    }

    pub fn delete_accounts(&self, usernames: &[String]) -> Result<Storage, EditError> {
        let requested = usernames
            .iter()
            .map(|username| required(username, "username"))
            .collect::<Result<HashSet<_>, _>>()?;
        if requested.is_empty() {
            return Ok(self.clone());
        }
        let mut next = self.clone();
        next.accounts
            .retain(|account| !requested.contains(account.username.as_str()));
        if self.accounts.len() - next.accounts.len() != requested.len() {
            return Err(EditError::AccountsNotFound);
        }
        for username in requested {
            remove_group_member(&mut next.groups, username);
        }
        Ok(next)
    }

    pub fn create_group(&self, name: &str, usernames: &[String]) -> Result<Storage, EditError> {
        let name = required(name, "group name")?;
        let usernames = self.group_members(usernames)?;
        if self.has_group_name(name, None) {
            return Err(EditError::DuplicateGroup);
        }
        let mut next = self.clone();
        next.groups.push(Group {
            name: name.to_owned(),
            usernames,
        });
        Ok(next)
    }

    pub fn update_group(&self, name: &str, patch: GroupPatch) -> Result<Storage, EditError> {
        let index = self
            .group_index(required(name, "group name")?)
            .ok_or(EditError::GroupNotFound)?;
        let existing = &self.groups[index].name;
        let next_name = match &patch.name {
            Some(name) => required(name, "group name")?,
            None => existing,
        };
        let usernames = patch
            .usernames
            .as_deref()
            .map(|usernames| self.group_members(usernames))
            .transpose()?;
        if self.has_group_name(next_name, Some(existing)) {
            return Err(EditError::DuplicateGroup);
        }
        let mut next = self.clone();
        let group = &mut next.groups[index];
        group.name = next_name.to_owned();
        if let Some(usernames) = usernames {
            group.usernames = usernames;
        }
        Ok(next)
    }

    pub fn delete_group(&self, name: &str) -> Result<Storage, EditError> {
        let index = self
            .group_index(required(name, "group name")?)
            .ok_or(EditError::GroupNotFound)?;
        let mut next = self.clone();
        next.groups.remove(index);
        Ok(next)
    }

    fn has_username(&self, username: &str, except: Option<&str>) -> bool {
        let key = username.to_lowercase();
        let except = except.map(str::to_lowercase);
        self.accounts.iter().any(|account| {
            let candidate = account.username.to_lowercase();
            candidate == key && Some(&candidate) != except.as_ref()
        })
    }

    fn group_index(&self, name: &str) -> Option<usize> {
        let key = name.to_lowercase();
        self.groups
            .iter()
            .position(|group| group.name.to_lowercase() == key)
    }

    fn has_group_name(&self, name: &str, except: Option<&str>) -> bool {
        let key = name.to_lowercase();
        Some(key.clone()) != except.map(str::to_lowercase)
            && self
                .groups
                .iter()
                .any(|group| group.name.to_lowercase() == key)
    }

    fn group_members(&self, usernames: &[String]) -> Result<Vec<String>, EditError> {
        let mut seen = HashSet::new();
        usernames
            .iter()
            .map(|username| {
                let username = required(username, "group username")?;
                if self.account(username).is_none() {
                    return Err(EditError::MemberNotFound(username.to_owned()));
                }
                if !seen.insert(username.to_lowercase()) {
                    return Err(EditError::DuplicateMember(username.to_owned()));
                }
                Ok(username.to_owned())
            })
            .collect()
    }
}

fn required<'a>(value: &'a str, field: &'static str) -> Result<&'a str, EditError> {
    match js_trim(value) {
        "" => Err(EditError::Required(field)),
        trimmed => Ok(trimmed),
    }
}

fn normalize_draft(draft: &AccountDraft) -> Result<ManagedAccount, EditError> {
    let username = required(&draft.username, "username")?;
    let password = required(&draft.password, "password")?;
    let label = match js_trim(&draft.label) {
        "" => username,
        label => label,
    };
    Ok(ManagedAccount {
        label: label.to_owned(),
        username: username.to_owned(),
        password: password.to_owned(),
    })
}

/// `String.prototype.trim`, which differs from `str::trim` on U+FEFF and U+0085.
fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| c == '\u{feff}' || (c != '\u{85}' && c.is_whitespace()))
}

fn parse_account(value: &Value) -> Option<ManagedAccount> {
    let field = |name| value.get(name)?.as_str().map(str::to_owned);
    Some(ManagedAccount {
        label: field("label")?,
        username: field("username")?,
        password: field("password")?,
    })
}

fn dedupe_accounts_by_username(
    accounts: impl IntoIterator<Item = ManagedAccount>,
) -> Vec<ManagedAccount> {
    let mut seen = HashSet::new();
    accounts
        .into_iter()
        .filter(|account| seen.insert(account.username.to_lowercase()))
        .collect()
}

fn normalize_groups(value: Option<&Value>, accounts: &[ManagedAccount]) -> Vec<Group> {
    let known: HashSet<&str> = accounts
        .iter()
        .map(|account| account.username.as_str())
        .collect();
    let mut entries: Vec<(&String, &Value)> = value
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .collect();
    sort_like_object_keys(&mut entries, |(name, _)| name.as_str());
    let mut seen = HashSet::new();
    let mut groups = Vec::new();
    for (raw_name, members) in entries {
        let name = js_trim(raw_name);
        if name.is_empty() || !seen.insert(name.to_lowercase()) {
            continue;
        }
        let mut seen_members = HashSet::new();
        let usernames = members
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|member| known.contains(member) && seen_members.insert(member.to_lowercase()))
            .map(str::to_owned)
            .collect();
        groups.push(Group {
            name: name.to_owned(),
            usernames,
        });
    }
    sort_like_object_keys(&mut groups, |group| &group.name);
    groups
}

/// JavaScript enumerates array-index keys first, in numeric order, so Electron reads
/// and writes groups named like "2" ahead of the rest.
fn sort_like_object_keys<T>(items: &mut [T], key: impl Fn(&T) -> &str) {
    items.sort_by_key(|item| array_index(key(item)).map_or((1, 0), |index| (0, index)));
}

fn array_index(key: &str) -> Option<u32> {
    let canonical = key == "0"
        || (key.starts_with(|c: char| ('1'..='9').contains(&c))
            && key.bytes().all(|b| b.is_ascii_digit()));
    canonical
        .then(|| key.parse().ok())
        .flatten()
        .filter(|&index| index != u32::MAX)
}

fn rename_group_member(groups: &mut [Group], current: &str, next: &str) {
    if current == next {
        return;
    }
    for group in groups {
        let mut seen = HashSet::new();
        group.usernames = std::mem::take(&mut group.usernames)
            .into_iter()
            .map(|username| {
                if username == current {
                    next.to_owned()
                } else {
                    username
                }
            })
            .filter(|username| seen.insert(username.to_lowercase()))
            .collect();
    }
}

fn remove_group_member(groups: &mut [Group], username: &str) {
    for group in groups {
        group.usernames.retain(|member| member != username);
    }
}

#[derive(Debug)]
pub enum StoreError {
    Read(PathBuf, io::Error),
    TooLarge(PathBuf),
    Write(PathBuf, io::Error),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Read(path, error) => write!(f, "Could not read {}: {error}", path.display()),
            Self::TooLarge(path) => write!(f, "{} is larger than 8 MB", path.display()),
            Self::Write(path, error) => write!(f, "Could not save {}: {error}", path.display()),
        }
    }
}

#[derive(Debug)]
pub enum UpdateError {
    Edit(EditError),
    Store(StoreError),
}

impl From<EditError> for UpdateError {
    fn from(error: EditError) -> Self {
        Self::Edit(error)
    }
}

impl fmt::Display for UpdateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Edit(error) => error.fmt(f),
            Self::Store(error) => error.fmt(f),
        }
    }
}

pub struct AccountStore {
    path: PathBuf,
    storage: Storage,
    unreadable: Option<String>,
}

impl AccountStore {
    /// A missing file loads as empty. A file that is not a JSON object also loads as
    /// empty but stays on disk, reported by `unreadable`, until the next changed save.
    pub fn load(data_dir: &Path) -> Result<AccountStore, StoreError> {
        let path = data_dir.join(FILE_NAME);
        let mut store = AccountStore {
            storage: Storage::default(),
            unreadable: None,
            path,
        };
        let Some(bytes) = read_bounded(&store.path)? else {
            return Ok(store);
        };
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(value) => match value.as_object() {
                Some(root) => {
                    store.storage = Storage::from_json(&value);
                    warn_invalid_entries(&store.path, root, &store.storage);
                }
                None => store.unreadable = Some("the file is not a JSON object".into()),
            },
            Err(error) => {
                store.unreadable = Some(format!(
                    "invalid JSON at line {} column {}",
                    error.line(),
                    error.column()
                ))
            }
        }
        if let Some(reason) = &store.unreadable {
            tracing::warn!(path = %store.path.display(), reason, "Saved accounts could not be read; using defaults until the next save");
        }
        Ok(store)
    }

    pub fn storage(&self) -> &Storage {
        &self.storage
    }

    pub fn unreadable(&self) -> Option<&str> {
        self.unreadable.as_deref()
    }

    pub fn update(
        &mut self,
        edit: impl FnOnce(&Storage) -> Result<Storage, EditError>,
    ) -> Result<(), UpdateError> {
        let next = edit(&self.storage)?.normalized();
        if next == self.storage {
            return Ok(());
        }
        let write =
            |error: io::Error| UpdateError::Store(StoreError::Write(self.path.clone(), error));
        let mut bytes =
            serde_json::to_vec_pretty(&next.to_json()).map_err(|error| write(error.into()))?;
        bytes.push(b'\n');
        if bytes.len() as u64 > MAX_BYTES {
            return Err(UpdateError::Store(StoreError::TooLarge(self.path.clone())));
        }
        write_atomic(&self.path, &bytes).map_err(write)?;
        self.storage = next;
        self.unreadable = None;
        Ok(())
    }
}

fn read_bounded(path: &Path) -> Result<Option<Vec<u8>>, StoreError> {
    let read_error = |error| StoreError::Read(path.to_owned(), error);
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(read_error(error)),
    };
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(read_error)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(StoreError::TooLarge(path.to_owned()));
    }
    Ok(Some(bytes))
}

fn warn_invalid_entries(path: &Path, root: &Map<String, Value>, storage: &Storage) {
    let accounts = root.get("accounts");
    let groups = root.get("groups");
    let raw_accounts = accounts.and_then(Value::as_array).map_or(0, Vec::len);
    let raw_groups = groups.and_then(Value::as_object);
    let raw_members: usize = raw_groups
        .into_iter()
        .flat_map(Map::values)
        .filter_map(Value::as_array)
        .map(Vec::len)
        .sum();
    let ignored_accounts = raw_accounts - storage.accounts.len();
    let ignored_groups = raw_groups.map_or(0, Map::len) - storage.groups.len();
    let ignored_members = raw_members
        - storage
            .groups
            .iter()
            .map(|group| group.usernames.len())
            .sum::<usize>();
    let reset_accounts = accounts.is_some_and(|value| !value.is_array());
    let reset_groups = groups.is_some_and(|value| !value.is_object())
        || raw_groups.is_some_and(|groups| groups.values().any(|members| !members.is_array()));
    if ignored_accounts + ignored_groups + ignored_members > 0 || reset_accounts || reset_groups {
        tracing::warn!(
            path = %path.display(),
            ignored_accounts,
            ignored_groups,
            ignored_members,
            reset_accounts,
            reset_groups,
            "Saved accounts had invalid entries; ignoring them until the next save"
        );
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let dir = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(dir)?;
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    let temp = dir.join(format!(
        "{TEMP_PREFIX}{}-{:016x}.tmp",
        std::process::id(),
        hasher.finish()
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    let result = file.write_all(bytes).and_then(|()| {
        drop(file);
        fs::rename(&temp, path)
    });
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(label: &str, username: &str, password: &str) -> ManagedAccount {
        ManagedAccount {
            label: label.into(),
            username: username.into(),
            password: password.into(),
        }
    }

    fn group(name: &str, usernames: &[&str]) -> Group {
        Group {
            name: name.into(),
            usernames: usernames.iter().map(|&username| username.into()).collect(),
        }
    }

    fn draft(username: &str, password: &str) -> AccountDraft {
        AccountDraft {
            label: String::new(),
            username: username.into(),
            password: password.into(),
        }
    }

    fn names(usernames: &[&str]) -> Vec<String> {
        usernames.iter().map(|&username| username.into()).collect()
    }

    fn with_accounts(usernames: &[&str]) -> Storage {
        usernames
            .iter()
            .fold(Storage::default(), |storage, username| {
                storage.create_account(draft(username, "secret")).unwrap()
            })
    }

    #[test]
    fn normalizes_existing_account_json_while_preserving_the_saved_shape() {
        let normalized = Storage::from_json(&json!({
            "accounts": [
                { "label": "Main", "username": "Hero", "password": "secret" },
                { "label": "Duplicate", "username": "hero", "password": "ignored" },
                { "label": "Alt", "username": "Alt", "password": "alt-secret" },
                { "label": "Broken", "username": "NoPassword" },
            ],
            "groups": {
                "Farmers": ["Hero", "Alt", "Missing", "Hero"],
                " ": ["Hero"],
            },
        }));

        let expected = Storage {
            accounts: vec![
                account("Main", "Hero", "secret"),
                account("Alt", "Alt", "alt-secret"),
            ],
            groups: vec![group("Farmers", &["Hero", "Alt"])],
        };
        assert_eq!(normalized, expected);
        assert_eq!(normalized.normalized(), expected);
    }

    #[test]
    fn drops_invalid_entries_and_trims_group_names() {
        let normalized = Storage::from_json(&json!({
            "accounts": [
                { "label": "Hero", "username": "Hero", "password": "secret" },
                { "label": "Duplicate", "username": "hero", "password": "private" },
                { "label": "Broken", "username": "Broken", "password": 42 },
                null,
            ],
            "groups": {
                "Raiders": ["Hero", "Hero", "Missing", 42],
                " raiders ": ["Hero"],
                " ": ["Hero"],
                " Solo\u{feff}": 42,
            },
        }));

        assert_eq!(
            normalized,
            Storage {
                accounts: vec![account("Hero", "Hero", "secret")],
                groups: vec![group("Raiders", &["Hero"]), group("Solo", &[])],
            }
        );
    }

    #[test]
    fn orders_index_like_group_names_first_as_javascript_does() {
        let normalized = Storage::from_json(&json!({
            "groups": { "Farmers": [], "10": [], "02": [], "2": [], "Alts": [] },
        }));

        let order: Vec<&str> = normalized
            .groups
            .iter()
            .map(|group| group.name.as_str())
            .collect();
        assert_eq!(order, ["2", "10", "Farmers", "02", "Alts"]);
    }

    #[test]
    fn keeps_group_membership_aligned_with_account_renames_and_deletes() {
        let mut groups = vec![group("Farmers", &["Hero", "Alt"]), group("Solo", &["Hero"])];
        let mut renamed = groups.clone();
        rename_group_member(&mut renamed, "Hero", "Main");
        assert_eq!(
            renamed,
            [group("Farmers", &["Main", "Alt"]), group("Solo", &["Main"])]
        );

        remove_group_member(&mut groups, "Hero");
        assert_eq!(groups, [group("Farmers", &["Alt"]), group("Solo", &[])]);
    }

    #[test]
    fn creates_accounts_and_groups() {
        let storage = Storage::default()
            .create_account(draft(" Alice ", " secret "))
            .unwrap()
            .create_group("Party", &names(&["Alice"]))
            .unwrap();

        assert_eq!(storage.accounts, [account("Alice", "Alice", "secret")]);
        assert_eq!(storage.groups, [group("Party", &["Alice"])]);
        assert_eq!(
            storage.create_account(draft("alice", "other")),
            Err(EditError::DuplicateUsername)
        );
        assert_eq!(
            storage.create_account(draft("  ", "x")),
            Err(EditError::Required("username"))
        );
        assert_eq!(
            storage.create_account(draft("Bob", " ")),
            Err(EditError::Required("password"))
        );
        assert_eq!(
            EditError::Required("username").to_string(),
            "username is required"
        );
    }

    #[test]
    fn deletes_multiple_accounts_and_group_memberships_atomically() {
        let storage = with_accounts(&["Alice", "Bob", "Cara"])
            .create_group("Party", &names(&["Alice", "Bob", "Cara"]))
            .unwrap();

        assert_eq!(
            storage.delete_accounts(&names(&["Alice", "Missing"])),
            Err(EditError::AccountsNotFound)
        );
        let deleted = storage.delete_accounts(&names(&["Alice", "Bob"])).unwrap();
        assert_eq!(deleted.accounts, [account("Cara", "Cara", "secret")]);
        assert_eq!(deleted.groups, [group("Party", &["Cara"])]);
    }

    #[test]
    fn renames_propagate_into_groups() {
        let storage = with_accounts(&["Alice", "Bob"])
            .create_group("Party", &names(&["Alice", "Bob"]))
            .unwrap();
        let rename = AccountDraft {
            label: "Main".into(),
            username: "Alicia".into(),
            password: "new".into(),
        };

        let renamed = storage.update_account("Alice", rename.clone()).unwrap();
        assert_eq!(renamed.accounts[0], account("Main", "Alicia", "new"));
        assert_eq!(renamed.groups, [group("Party", &["Alicia", "Bob"])]);

        let recased = storage
            .update_account("Alice", draft("ALICE", "secret"))
            .unwrap();
        assert_eq!(recased.accounts[0], account("ALICE", "ALICE", "secret"));
        assert_eq!(
            storage.update_account("Alice", draft("bob", "secret")),
            Err(EditError::DuplicateUsername)
        );
        assert_eq!(
            storage.update_account("Zed", rename),
            Err(EditError::AccountNotFound)
        );
    }

    #[test]
    fn validates_group_names_and_members() {
        let storage = with_accounts(&["Alice", "Bob"])
            .create_group("Party", &names(&["Alice"]))
            .unwrap();

        assert_eq!(
            storage.create_group("party", &[]),
            Err(EditError::DuplicateGroup)
        );
        assert_eq!(
            storage.create_group(" ", &[]),
            Err(EditError::Required("group name"))
        );
        assert_eq!(
            storage.create_group("Raid", &names(&["Missing"])),
            Err(EditError::MemberNotFound("Missing".into()))
        );
        assert_eq!(
            storage.create_group("Raid", &names(&["Alice", "Alice"])),
            Err(EditError::DuplicateMember("Alice".into()))
        );
        assert_eq!(storage.delete_group("Nope"), Err(EditError::GroupNotFound));
        assert_eq!(storage.delete_group("PARTY").unwrap().groups, []);
    }

    #[test]
    fn updates_group_names_and_members() {
        let storage = with_accounts(&["Alice", "Bob"])
            .create_group("Party", &names(&["Alice"]))
            .unwrap()
            .create_group("Solo", &[])
            .unwrap();

        let recased = storage
            .update_group(
                "party",
                GroupPatch {
                    name: Some("PARTY".into()),
                    usernames: Some(names(&["Bob", "Alice"])),
                },
            )
            .unwrap();
        assert_eq!(
            recased.groups,
            [group("PARTY", &["Bob", "Alice"]), group("Solo", &[])]
        );
        assert_eq!(
            storage.update_group(
                "Party",
                GroupPatch {
                    name: Some("solo".into()),
                    usernames: None,
                }
            ),
            Err(EditError::DuplicateGroup)
        );
        assert_eq!(
            storage.update_group("Raid", GroupPatch::default()),
            Err(EditError::GroupNotFound)
        );
    }

    fn data_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn file_text(dir: &Path) -> String {
        fs::read_to_string(dir.join(FILE_NAME)).unwrap()
    }

    #[test]
    fn missing_file_loads_empty_without_creating_it() {
        let dir = data_dir();
        let store = AccountStore::load(dir.path()).unwrap();

        assert_eq!(store.storage(), &Storage::default());
        assert_eq!(store.unreadable(), None);
        assert!(!dir.path().join(FILE_NAME).exists());
    }

    #[test]
    fn saves_pretty_json_in_electron_order() {
        let dir = data_dir();
        let mut store = AccountStore::load(&dir.path().join("nested")).unwrap();
        store
            .update(|storage| {
                storage
                    .create_account(draft("Hero", "secret"))?
                    .create_group("Zeta", &names(&["Hero"]))?
                    .create_group("Alpha", &[])
            })
            .unwrap();

        assert_eq!(
            file_text(&dir.path().join("nested")),
            r#"{
  "accounts": [
    {
      "label": "Hero",
      "username": "Hero",
      "password": "secret"
    }
  ],
  "groups": {
    "Zeta": [
      "Hero"
    ],
    "Alpha": []
  }
}
"#
        );
        let entries: Vec<_> = fs::read_dir(dir.path().join("nested"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(entries, [FILE_NAME]);
        let reloaded = AccountStore::load(&dir.path().join("nested")).unwrap();
        assert_eq!(reloaded.storage(), store.storage());
    }

    #[test]
    fn keeps_invalid_source_until_a_changed_save() {
        let dir = data_dir();
        let source = r#"{"accounts":[{"label":"Hero","username":"Hero","password":"secret"},{"label":"Dup","username":"hero","password":"x"}],"groups":{}}"#;
        fs::write(dir.path().join(FILE_NAME), source).unwrap();
        let mut store = AccountStore::load(dir.path()).unwrap();
        assert_eq!(
            store.storage().accounts,
            [account("Hero", "Hero", "secret")]
        );

        store.update(|storage| Ok(storage.clone())).unwrap();
        assert_eq!(file_text(dir.path()), source);

        store
            .update(|storage| storage.create_group("Alts", &[]))
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&file_text(dir.path())).unwrap(),
            json!({
                "accounts": [{ "label": "Hero", "username": "Hero", "password": "secret" }],
                "groups": { "Alts": [] },
            })
        );
    }

    #[test]
    fn unreadable_source_loads_empty_and_is_only_replaced_by_a_changed_save() {
        for source in ["{not-json", "[]", "null", "42"] {
            let dir = data_dir();
            fs::write(dir.path().join(FILE_NAME), source).unwrap();
            let mut store = AccountStore::load(dir.path()).unwrap();
            assert_eq!(store.storage(), &Storage::default(), "{source}");
            assert!(store.unreadable().is_some(), "{source}");
            assert_eq!(file_text(dir.path()), source);

            store.update(|storage| Ok(storage.clone())).unwrap();
            assert_eq!(file_text(dir.path()), source);

            store
                .update(|storage| storage.create_group("Raiders", &[]))
                .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&file_text(dir.path())).unwrap(),
                json!({ "accounts": [], "groups": { "Raiders": [] } })
            );
            assert_eq!(store.unreadable(), None);
        }
    }

    #[test]
    fn rejects_files_above_the_read_limit_without_replacing_them() {
        let dir = data_dir();
        let source = format!(
            r#"{{"accounts":[],"padding":"{}"}}"#,
            "x".repeat(MAX_BYTES as usize)
        );
        fs::write(dir.path().join(FILE_NAME), &source).unwrap();

        assert!(matches!(
            AccountStore::load(dir.path()),
            Err(StoreError::TooLarge(_))
        ));
        assert_eq!(file_text(dir.path()).len(), source.len());
    }

    #[test]
    fn keeps_storage_when_a_save_fails() {
        let dir = data_dir();
        let mut store = AccountStore::load(dir.path()).unwrap();
        store
            .update(|storage| storage.create_group("Raiders", &[]))
            .unwrap();
        fs::remove_file(dir.path().join(FILE_NAME)).unwrap();
        fs::create_dir(dir.path().join(FILE_NAME)).unwrap();

        let error = store
            .update(|storage| storage.create_group("Alts", &[]))
            .unwrap_err();
        assert!(
            matches!(error, UpdateError::Store(StoreError::Write(..))),
            "{error:?}"
        );
        assert_eq!(store.storage().groups, [group("Raiders", &[])]);
        let entries: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(entries, [FILE_NAME]);
    }
}
