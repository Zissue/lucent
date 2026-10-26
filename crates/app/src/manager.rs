use std::collections::HashSet;

use gpui::{
    App, Bounds, ClickEvent, Context, Entity, FocusHandle, Focusable, Global, KeyBinding,
    Modifiers, SharedString, Subscription, TitlebarOptions, Window, WindowBounds, WindowHandle,
    WindowOptions, actions, div, prelude::*, px, rgb, rgba, size,
};

use crate::accounts::{
    AccountDraft, AccountStore, EditError, GroupPatch, ManagedAccount, Storage, StoreError,
    UpdateError,
};
use crate::login_servers::{self, LoginServer, Ping, Preference};
use crate::lucent::{HostSummary, LaunchRequest, LaunchTarget, Lucent, ScriptChoice};
use crate::ui::{
    self, ACCENT, BACKGROUND, BORDER, BORDER_STRONG, DANGER, MUTED, PANEL, TEXT, TextInput,
    TextInputEvent, button,
};

const CONTEXT: &str = "AccountManager";
const SELECTED: u32 = (ACCENT << 8) | 0x33;

actions!(
    account_manager,
    [
        SelectAllAccounts,
        NewAccount,
        LaunchSelected,
        Dismiss,
        FocusNext,
        FocusPrevious
    ]
);

struct ManagerWindow(Option<WindowHandle<Manager>>);

impl Global for ManagerWindow {}

pub fn open(cx: &mut App) {
    let existing = cx
        .try_global::<ManagerWindow>()
        .and_then(|manager| manager.0);
    if let Some(handle) = existing
        && handle
            .update(cx, |_, window, _| window.activate_window())
            .is_ok()
    {
        return;
    }
    if !cx.has_global::<ManagerWindow>() {
        ui::init(cx);
        bind_keys(cx);
    }
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
            None,
            size(px(760.), px(560.)),
            cx,
        ))),
        titlebar: Some(TitlebarOptions {
            title: Some("Account Manager".into()),
            ..Default::default()
        }),
        window_min_size: Some(size(px(600.), px(400.))),
        ..Default::default()
    };
    let handle = match cx.open_window(options, |window, cx| {
        cx.new(|cx| {
            let mut manager = Manager::new(window, cx);
            manager.load_servers(false, cx);
            manager
        })
    }) {
        Ok(handle) => Some(handle),
        Err(error) => {
            tracing::error!(%error, "could not open the account manager");
            None
        }
    };
    cx.set_global(ManagerWindow(handle));
}

fn bind_keys(cx: &mut App) {
    let context = Some(CONTEXT);
    cx.bind_keys([
        KeyBinding::new("cmd-a", SelectAllAccounts, context),
        KeyBinding::new("cmd-n", NewAccount, context),
        KeyBinding::new("cmd-enter", LaunchSelected, context),
        KeyBinding::new("escape", Dismiss, context),
        KeyBinding::new("tab", FocusNext, context),
        KeyBinding::new("shift-tab", FocusPrevious, context),
    ]);
}

#[derive(Debug, Default)]
struct Selection {
    usernames: HashSet<String>,
    anchor: Option<String>,
}

impl Selection {
    fn contains(&self, username: &str) -> bool {
        self.usernames.contains(username)
    }

    fn click(&mut self, order: &[&str], username: &str, modifiers: Modifiers) {
        let anchor = self
            .anchor
            .as_deref()
            .and_then(|anchor| order.iter().position(|&name| name == anchor));
        let clicked = order.iter().position(|&name| name == username);
        match (modifiers.shift, anchor, clicked) {
            (true, Some(anchor), Some(clicked)) => {
                if !modifiers.secondary() {
                    self.usernames.clear();
                }
                let range = anchor.min(clicked)..=anchor.max(clicked);
                self.usernames
                    .extend(order[range].iter().map(|&name| name.to_owned()));
                return;
            }
            _ if modifiers.secondary() => {
                if !self.usernames.remove(username) {
                    self.usernames.insert(username.to_owned());
                }
            }
            _ => {
                self.usernames.clear();
                self.usernames.insert(username.to_owned());
            }
        }
        self.anchor = Some(username.to_owned());
    }

    fn replace(&mut self, usernames: impl IntoIterator<Item = String>) {
        self.usernames = usernames.into_iter().collect();
        self.anchor = None;
    }

    fn rename(&mut self, from: &str, to: &str) {
        if self.usernames.remove(from) {
            self.usernames.insert(to.to_owned());
        }
        if self.anchor.as_deref() == Some(from) {
            self.anchor = Some(to.to_owned());
        }
    }

    fn retain(&mut self, storage: &Storage) {
        self.usernames
            .retain(|username| storage.account(username).is_some());
        if self
            .anchor
            .as_deref()
            .is_some_and(|anchor| storage.account(anchor).is_none())
        {
            self.anchor = None;
        }
    }

    fn ordered(&self, storage: &Storage) -> Vec<String> {
        storage
            .accounts
            .iter()
            .filter(|account| self.contains(&account.username))
            .map(|account| account.username.clone())
            .collect()
    }
}

struct AccountForm {
    editing: Option<String>,
    username_error: Option<&'static str>,
    password_error: Option<&'static str>,
    error: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Confirm {
    DeleteAccounts,
    DeleteGroup,
}

struct Manager {
    focus: FocusHandle,
    store: Result<AccountStore, StoreError>,
    selection: Selection,
    selected_group: Option<String>,
    form: Option<AccountForm>,
    confirm: Option<Confirm>,
    notice: Option<String>,
    group_error: Option<String>,
    hosts: Vec<HostSummary>,
    target: Option<HostSummary>,
    target_menu: bool,
    grid: bool,
    password_visible: bool,
    label: Entity<TextInput>,
    username: Entity<TextInput>,
    password: Entity<TextInput>,
    group_name: Entity<TextInput>,
    servers: Vec<LoginServer>,
    pings: std::collections::HashMap<String, Ping>,
    login_server: Option<Option<String>>,
    server_menu: bool,
    servers_loading: bool,
    servers_error: Option<String>,
    script: Option<ScriptChoice>,
    _subscriptions: Vec<Subscription>,
}

impl Focusable for Manager {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Manager {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let label = cx.new(|cx| TextInput::new("Defaults to username", cx));
        let username = cx.new(|cx| TextInput::new("Username", cx));
        let password = cx.new(|cx| TextInput::new("Password", cx).masked(true));
        let group_name = cx.new(|cx| TextInput::new("Group name", cx));
        let _subscriptions = vec![
            cx.subscribe_in(&label, window, Self::on_form_input),
            cx.subscribe_in(&username, window, Self::on_form_input),
            cx.subscribe_in(&password, window, Self::on_form_input),
            cx.subscribe_in(&group_name, window, Self::on_group_input),
        ];
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        Self {
            focus,
            store: load(cx),
            selection: Selection::default(),
            selected_group: None,
            form: None,
            confirm: None,
            notice: None,
            group_error: None,
            hosts: Vec::new(),
            target: None,
            target_menu: false,
            grid: false,
            password_visible: false,
            label,
            username,
            password,
            group_name,
            servers: Vec::new(),
            pings: std::collections::HashMap::new(),
            login_server: None,
            server_menu: false,
            servers_loading: false,
            servers_error: None,
            script: None,
            _subscriptions,
        }
    }

    fn load_servers(&mut self, refresh: bool, cx: &mut Context<Self>) {
        self.servers_loading = true;
        self.servers_error = None;
        let scripting = &Lucent::get(cx).scripting;
        let servers = scripting.hub_call(
            if refresh {
                "servers.refresh"
            } else {
                "servers.get"
            },
            serde_json::Value::Null,
        );
        cx.spawn(async move |this, cx| {
            let result = servers
                .await
                .unwrap_or_else(|_| Err("The script runtime stopped.".into()));
            let pings = this
                .update(cx, |this, cx| {
                    this.servers_loading = false;
                    match result {
                        Ok(value) => {
                            this.servers = login_servers::parse_servers(&value);
                            if this.login_server.is_none() {
                                let preference =
                                    login_servers::load_preference(&Lucent::get(cx).data_dir);
                                this.login_server =
                                    login_servers::resolve(&this.servers, preference.as_ref());
                            }
                            cx.notify();
                            Some(
                                Lucent::get(cx)
                                    .scripting
                                    .hub_call("servers.pings", serde_json::Value::Null),
                            )
                        }
                        Err(error) => {
                            this.servers_error = Some(error);
                            cx.notify();
                            None
                        }
                    }
                })
                .ok()
                .flatten();
            if let Some(pings) = pings
                && let Ok(Ok(value)) = pings.await
            {
                let _ = this.update(cx, |this, cx| {
                    this.pings = login_servers::parse_pings(&value);
                    cx.notify();
                });
            }
        })
        .detach();
        cx.notify();
    }

    fn choose_server(&mut self, server: Option<String>, cx: &mut Context<Self>) {
        let preference = match &server {
            Some(name) => Preference::Server(name.clone()),
            None => Preference::None,
        };
        login_servers::save_preference(&Lucent::get(cx).data_dir, &preference);
        self.login_server = Some(server);
        self.server_menu = false;
        cx.notify();
    }

    fn choose_script(&mut self, cx: &mut Context<Self>) {
        let chosen = Lucent::choose_script(cx);
        cx.spawn(async move |this, cx| {
            let result = chosen.await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(Some(choice)) => this.script = Some(choice),
                    Ok(None) => {}
                    Err(error) => {
                        this.notice = Some(format!("Could not choose the script: {error}"))
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn storage(&self) -> Option<&Storage> {
        self.store.as_ref().ok().map(AccountStore::storage)
    }

    fn apply(
        &mut self,
        edit: impl FnOnce(&Storage) -> Result<Storage, EditError>,
    ) -> Result<(), UpdateError> {
        let Ok(store) = &mut self.store else {
            return Ok(());
        };
        store.update(edit)?;
        let storage = store.storage();
        self.selection.retain(storage);
        if self
            .selected_group
            .as_ref()
            .is_some_and(|name| !storage.groups.iter().any(|group| &group.name == name))
        {
            self.selected_group = None;
        }
        Ok(())
    }

    fn reload(&mut self, cx: &mut Context<Self>) {
        self.store = load(cx);
        self.selection = Selection::default();
        self.selected_group = None;
        self.form = None;
        self.confirm = None;
        cx.notify();
    }

    fn on_form_input(
        &mut self,
        input: &Entity<TextInput>,
        event: &TextInputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            TextInputEvent::Submit => self.save_form(window, cx),
            TextInputEvent::Cancel => self.dismiss(&Dismiss, window, cx),
            TextInputEvent::Changed => {
                if let Some(form) = &mut self.form {
                    if *input == self.username {
                        form.username_error = None;
                    } else if *input == self.password {
                        form.password_error = None;
                    }
                    cx.notify();
                }
            }
        }
    }

    fn on_group_input(
        &mut self,
        _: &Entity<TextInput>,
        event: &TextInputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            TextInputEvent::Submit => self.create_group(window, cx),
            TextInputEvent::Cancel => self.dismiss(&Dismiss, window, cx),
            TextInputEvent::Changed => {
                if self.group_error.take().is_some() {
                    cx.notify();
                }
            }
        }
    }

    fn click_account(
        &mut self,
        username: &str,
        event: &ClickEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        window.focus(&self.focus, cx);
        let modifiers = event.modifiers();
        self.confirm = None;
        if event.click_count() >= 2 && !modifiers.shift && !modifiers.secondary() {
            self.selection.replace([username.to_owned()]);
            self.open_form(Some(username.to_owned()), window, cx);
            return;
        }
        if let Ok(store) = &self.store {
            let order: Vec<&str> = store
                .storage()
                .accounts
                .iter()
                .map(|account| account.username.as_str())
                .collect();
            self.selection.click(&order, username, modifiers);
        }
        cx.notify();
    }

    fn select_all(&mut self, _: &SelectAllAccounts, _: &mut Window, cx: &mut Context<Self>) {
        if let Ok(store) = &self.store {
            self.selection.replace(
                store
                    .storage()
                    .accounts
                    .iter()
                    .map(|account| account.username.clone()),
            );
            self.confirm = None;
            cx.notify();
        }
    }

    fn clear_selection(&mut self, cx: &mut Context<Self>) {
        self.selection.replace([]);
        self.confirm = None;
        cx.notify();
    }

    fn select_group(&mut self, name: &str, cx: &mut Context<Self>) {
        let Some(group) = self
            .storage()
            .and_then(|storage| storage.groups.iter().find(|group| group.name == name))
        else {
            return;
        };
        let usernames = group.usernames.clone();
        self.selection.replace(usernames);
        self.selected_group = Some(name.to_owned());
        self.confirm = None;
        self.group_error = None;
        cx.notify();
    }

    fn new_account(&mut self, _: &NewAccount, window: &mut Window, cx: &mut Context<Self>) {
        if self.store.is_ok() {
            self.open_form(None, window, cx);
        }
    }

    fn open_form(&mut self, editing: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        let account = editing
            .as_deref()
            .and_then(|username| self.storage()?.account(username))
            .cloned()
            .unwrap_or(ManagedAccount {
                label: String::new(),
                username: String::new(),
                password: String::new(),
            });
        self.label
            .update(cx, |input, cx| input.set_text(account.label, cx));
        self.username
            .update(cx, |input, cx| input.set_text(account.username, cx));
        self.password.update(cx, |input, cx| {
            input.set_text(account.password, cx);
            input.set_masked(true, cx);
        });
        self.password_visible = false;
        self.confirm = None;
        self.form = Some(AccountForm {
            editing,
            username_error: None,
            password_error: None,
            error: None,
        });
        window.focus(&self.username.focus_handle(cx), cx);
        cx.notify();
    }

    fn toggle_password(&mut self, cx: &mut Context<Self>) {
        self.password_visible = !self.password_visible;
        let masked = !self.password_visible;
        self.password
            .update(cx, |input, cx| input.set_masked(masked, cx));
        cx.notify();
    }

    fn save_form(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(form) = &mut self.form else {
            return;
        };
        let draft = AccountDraft {
            label: self.label.read(cx).text().to_owned(),
            username: self.username.read(cx).text().to_owned(),
            password: self.password.read(cx).text().to_owned(),
        };
        form.username_error = draft
            .username
            .trim()
            .is_empty()
            .then_some("Enter a username.");
        form.password_error = draft
            .password
            .trim()
            .is_empty()
            .then_some("Enter a password.");
        form.error = None;
        let invalid = match (form.username_error, form.password_error) {
            (Some(_), _) => Some(self.username.clone()),
            (None, Some(_)) => Some(self.password.clone()),
            (None, None) => None,
        };
        if let Some(input) = invalid {
            window.focus(&input.focus_handle(cx), cx);
            cx.notify();
            return;
        }
        let editing = form.editing.clone();
        let result = match &editing {
            Some(current) => {
                let index = self.storage().and_then(|storage| {
                    storage
                        .accounts
                        .iter()
                        .position(|account| &account.username == current)
                });
                self.apply(|storage| storage.update_account(current, draft))
                    .map(|()| {
                        let renamed = index.and_then(|index| {
                            Some(self.storage()?.accounts.get(index)?.username.clone())
                        });
                        if let Some(renamed) = renamed {
                            self.selection.rename(current, &renamed);
                        }
                    })
            }
            None => self
                .apply(|storage| storage.create_account(draft))
                .map(|()| {
                    let created = self
                        .storage()
                        .and_then(|storage| storage.accounts.last())
                        .map(|account| account.username.clone());
                    self.selection.replace(created);
                }),
        };
        match result {
            Ok(()) => {
                self.form = None;
                window.focus(&self.focus, cx);
            }
            Err(error) => {
                if let Some(form) = &mut self.form {
                    form.error = Some(error.to_string());
                }
            }
        }
        cx.notify();
    }

    fn delete_selected(&mut self, cx: &mut Context<Self>) {
        let Some(usernames) = self
            .storage()
            .map(|storage| self.selection.ordered(storage))
        else {
            return;
        };
        self.confirm = None;
        match self.apply(|storage| storage.delete_accounts(&usernames)) {
            Ok(()) => {
                if self
                    .form
                    .as_ref()
                    .and_then(|form| form.editing.as_ref())
                    .is_some_and(|editing| usernames.contains(editing))
                {
                    self.form = None;
                }
            }
            Err(error) => self.notice = Some(error.to_string()),
        }
        cx.notify();
    }

    fn create_group(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(usernames) = self
            .storage()
            .map(|storage| self.selection.ordered(storage))
        else {
            return;
        };
        let name = self.group_name.read(cx).text().to_owned();
        if name.trim().is_empty() {
            self.group_error = Some("Enter a group name.".into());
            window.focus(&self.group_name.focus_handle(cx), cx);
        } else if usernames.is_empty() {
            self.group_error = Some("Select at least one account.".into());
        } else {
            match self.apply(|storage| storage.create_group(&name, &usernames)) {
                Ok(()) => {
                    self.selected_group = self
                        .storage()
                        .and_then(|storage| storage.groups.last())
                        .map(|group| group.name.clone());
                    self.group_error = None;
                    self.group_name
                        .update(cx, |input, cx| input.set_text("", cx));
                    window.focus(&self.focus, cx);
                }
                Err(error) => self.group_error = Some(error.to_string()),
            }
        }
        cx.notify();
    }

    fn save_group_members(&mut self, cx: &mut Context<Self>) {
        let (Some(name), Some(usernames)) = (
            self.selected_group.clone(),
            self.storage()
                .map(|storage| self.selection.ordered(storage)),
        ) else {
            return;
        };
        let patch = GroupPatch {
            name: None,
            usernames: Some(usernames),
        };
        self.group_error = self
            .apply(|storage| storage.update_group(&name, patch))
            .err()
            .map(|error| error.to_string());
        cx.notify();
    }

    fn delete_group(&mut self, cx: &mut Context<Self>) {
        let Some(name) = self.selected_group.clone() else {
            return;
        };
        self.confirm = None;
        match self.apply(|storage| storage.delete_group(&name)) {
            Ok(()) => {
                self.selected_group = None;
                self.group_error = None;
            }
            Err(error) => self.group_error = Some(error.to_string()),
        }
        cx.notify();
    }

    fn toggle_target_menu(&mut self, cx: &mut Context<Self>) {
        self.target_menu = !self.target_menu;
        if self.target_menu {
            self.hosts = Lucent::hosts(cx);
        }
        cx.notify();
    }

    fn choose_target(&mut self, target: Option<HostSummary>, cx: &mut Context<Self>) {
        self.target = target;
        self.target_menu = false;
        cx.notify();
    }

    fn launch(&mut self, _: &LaunchSelected, window: &mut Window, cx: &mut Context<Self>) {
        let script = self.script.clone();
        self.launch_with(script, window, cx);
    }

    fn launch_with(
        &mut self,
        script: Option<ScriptChoice>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let accounts: Vec<ManagedAccount> = self
            .storage()
            .into_iter()
            .flat_map(|storage| &storage.accounts)
            .filter(|account| self.selection.contains(&account.username))
            .cloned()
            .collect();
        if accounts.is_empty() {
            return;
        }
        let server = self.login_server.clone().flatten();
        let target = match &self.target {
            None => LaunchTarget::NewWindow,
            Some(target) => {
                let window_id = target.handle.window_id();
                match Lucent::hosts(cx)
                    .into_iter()
                    .find(|host| host.handle.window_id() == window_id)
                {
                    Some(host) => LaunchTarget::Window(host.handle),
                    None => {
                        self.target = None;
                        self.notice = Some("The selected game window was closed. Choose a target and launch again.".into());
                        cx.notify();
                        return;
                    }
                }
            }
        };
        let grid = self.grid && accounts.len() > 1;
        self.target_menu = false;
        cx.defer(move |cx| {
            Lucent::launch(
                LaunchRequest {
                    accounts,
                    script,
                    server,
                    target,
                    grid,
                },
                cx,
            )
        });
        cx.notify();
    }

    fn dismiss(&mut self, _: &Dismiss, window: &mut Window, cx: &mut Context<Self>) {
        if self.target_menu || self.server_menu {
            self.target_menu = false;
            self.server_menu = false;
        } else if self.confirm.is_some() {
            self.confirm = None;
        } else {
            self.form = None;
        }
        window.focus(&self.focus, cx);
        cx.notify();
    }

    fn focus_next(&mut self, _: &FocusNext, window: &mut Window, cx: &mut Context<Self>) {
        window.focus_next(cx);
    }

    fn focus_previous(&mut self, _: &FocusPrevious, window: &mut Window, cx: &mut Context<Self>) {
        window.focus_prev(cx);
    }

    fn render_notices(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let banner = |text: SharedString| {
            div()
                .flex()
                .items_center()
                .gap_3()
                .px_3()
                .py_2()
                .border_b_1()
                .border_color(rgb(0x7f1d1d))
                .bg(rgb(0x2a0f0f))
                .text_color(rgb(DANGER))
                .child(div().flex_1().min_w_0().child(text))
        };
        let store = match &self.store {
            Err(error) => Some(banner(format!("{error}").into()).child(
                button("reload-accounts", "Retry").on_click(cx.listener(|this, _, _, cx| this.reload(cx))),
            )),
            Ok(store) => store.unreadable().map(|reason| {
                banner(
                    format!(
                        "Saved accounts could not be read ({reason}). The file is left untouched until you change an account or group, which replaces it."
                    )
                    .into(),
                )
            }),
        };
        let notice = self.notice.clone().map(|notice| {
            banner(notice.into()).child(button("dismiss-notice", "Dismiss").on_click(cx.listener(
                |this, _, _, cx| {
                    this.notice = None;
                    cx.notify();
                },
            )))
        });
        div().flex_none().children(store).children(notice)
    }

    fn render_groups(
        &self,
        storage: Option<&Storage>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement + use<> {
        let editable = storage.is_some();
        let groups = storage
            .map(|storage| storage.groups.as_slice())
            .unwrap_or_default();
        let rows = groups.iter().enumerate().map(|(index, group)| {
            let selected = self.selected_group.as_deref() == Some(group.name.as_str());
            let name = group.name.clone();
            div()
                .id(("group", index))
                .flex()
                .items_center()
                .gap_2()
                .px_3()
                .h(px(30.))
                .cursor_pointer()
                .when(selected, |row| row.bg(rgba(SELECTED)))
                .when(!selected, |row| row.hover(|style| style.bg(rgb(BORDER))))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .child(group.name.clone()),
                )
                .child(
                    div()
                        .text_color(rgb(MUTED))
                        .child(group.usernames.len().to_string()),
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    window.focus(&this.focus, cx);
                    this.select_group(&name, cx);
                }))
        });
        let selected_actions =
            self.selected_group.as_ref().map(|name| {
                let confirming = self.confirm == Some(Confirm::DeleteGroup);
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .p_3()
                    .border_t_1()
                    .border_color(rgb(BORDER))
                    .child(
                        div()
                            .text_color(rgb(MUTED))
                            .truncate()
                            .child(format!("Group: {name}")),
                    )
                    .child(if confirming {
                        div()
                            .flex()
                            .gap_2()
                            .child(
                                button("confirm-delete-group", "Delete")
                                    .danger()
                                    .on_click(cx.listener(|this, _, _, cx| this.delete_group(cx))),
                            )
                            .child(
                                button("cancel-delete-group", "Cancel").on_click(cx.listener(
                                    |this, _, _, cx| {
                                        this.confirm = None;
                                        cx.notify();
                                    },
                                )),
                            )
                    } else {
                        div()
                            .flex()
                            .gap_2()
                            .child(button("save-group-members", "Use selection").on_click(
                                cx.listener(|this, _, _, cx| this.save_group_members(cx)),
                            ))
                            .child(button("delete-group", "Delete").on_click(cx.listener(
                                |this, _, _, cx| {
                                    this.confirm = Some(Confirm::DeleteGroup);
                                    cx.notify();
                                },
                            )))
                    })
            });
        div()
            .flex()
            .flex_col()
            .flex_none()
            .w(px(210.))
            .border_r_1()
            .border_color(rgb(BORDER))
            .bg(rgb(PANEL))
            .child(section_title("Groups"))
            .child(
                div()
                    .id("groups")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .children(rows)
                    .when(groups.is_empty(), |list| {
                        list.child(empty("No groups yet."))
                    }),
            )
            .children(selected_actions)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .p_3()
                    .border_t_1()
                    .border_color(rgb(BORDER))
                    .child(self.group_name.clone())
                    .child(
                        button("create-group", "Create from selection")
                            .disabled(!editable)
                            .on_click(
                                cx.listener(|this, _, window, cx| this.create_group(window, cx)),
                            ),
                    )
                    .children(self.group_error.clone().map(error_text)),
            )
    }

    fn render_toolbar(
        &self,
        storage: Option<&Storage>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement + use<> {
        let editable = storage.is_some();
        let selected = storage.map_or(0, |storage| self.selection.ordered(storage).len());
        let total = storage.map_or(0, |storage| storage.accounts.len());
        let bar = div()
            .flex()
            .flex_none()
            .items_center()
            .gap_2()
            .px_3()
            .h(px(44.))
            .border_b_1()
            .border_color(rgb(BORDER));
        if self.confirm == Some(Confirm::DeleteAccounts) {
            let noun = if selected == 1 { "account" } else { "accounts" };
            return bar
                .child(
                    div()
                        .flex_1()
                        .text_color(rgb(DANGER))
                        .child(format!("Delete {selected} {noun}?")),
                )
                .child(
                    button("cancel-delete-accounts", "Cancel").on_click(cx.listener(
                        |this, _, _, cx| {
                            this.confirm = None;
                            cx.notify();
                        },
                    )),
                )
                .child(
                    button("confirm-delete-accounts", "Delete")
                        .danger()
                        .on_click(cx.listener(|this, _, _, cx| this.delete_selected(cx))),
                );
        }
        let editing = (selected == 1)
            .then(|| storage.map(|storage| self.selection.ordered(storage)))
            .flatten()
            .and_then(|usernames| usernames.into_iter().next());
        bar.child(
            div()
                .flex_1()
                .text_color(rgb(MUTED))
                .child(format!("{selected} of {total} selected")),
        )
        .child(
            button("add-account", "Add")
                .disabled(!editable)
                .on_click(cx.listener(|this, _, window, cx| this.open_form(None, window, cx))),
        )
        .child(
            button("edit-account", "Edit")
                .disabled(editing.is_none())
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.open_form(editing.clone(), window, cx)
                })),
        )
        .child(
            button("delete-accounts", "Delete")
                .disabled(selected == 0)
                .on_click(cx.listener(|this, _, _, cx| {
                    this.confirm = Some(Confirm::DeleteAccounts);
                    cx.notify();
                })),
        )
        .child(if selected == total && total > 0 {
            button("clear-selection", "Clear")
                .on_click(cx.listener(|this, _, _, cx| this.clear_selection(cx)))
        } else {
            button("select-all", "Select all")
                .disabled(total == 0)
                .on_click(cx.listener(|this, _, window, cx| {
                    this.select_all(&SelectAllAccounts, window, cx)
                }))
        })
    }

    fn render_form(&self, form: &AccountForm, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let field =
            |label: &'static str, input: &Entity<TextInput>, error: Option<&'static str>| {
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .gap_1()
                    .child(div().text_size(px(12.)).text_color(rgb(MUTED)).child(label))
                    .child(input.clone())
                    .children(error.map(error_text))
            };
        let reveal = div()
            .id("toggle-password")
            .text_size(px(12.))
            .text_color(rgb(ACCENT))
            .cursor_pointer()
            .child(if self.password_visible {
                "Hide"
            } else {
                "Show"
            })
            .on_click(cx.listener(|this, _, _, cx| this.toggle_password(cx)));
        let password = div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .gap_1()
            .child(
                div()
                    .flex()
                    .justify_between()
                    .text_size(px(12.))
                    .text_color(rgb(MUTED))
                    .child("Password")
                    .child(reveal),
            )
            .child(self.password.clone())
            .children(form.password_error.map(error_text));
        div()
            .flex()
            .flex_col()
            .flex_none()
            .gap_3()
            .p_3()
            .border_b_1()
            .border_color(rgb(BORDER))
            .bg(rgb(PANEL))
            .child(div().child(if form.editing.is_some() {
                "Edit account"
            } else {
                "Add account"
            }))
            .child(
                div()
                    .flex()
                    .gap_2()
                    .child(field("Label", &self.label, None))
                    .child(field("Username", &self.username, form.username_error))
                    .child(password),
            )
            .children(form.error.clone().map(error_text))
            .child(
                div()
                    .flex()
                    .justify_end()
                    .gap_2()
                    .child(button("cancel-account", "Cancel").on_click(
                        cx.listener(|this, _, window, cx| this.dismiss(&Dismiss, window, cx)),
                    ))
                    .child(
                        button("save-account", "Save").primary().on_click(
                            cx.listener(|this, _, window, cx| this.save_form(window, cx)),
                        ),
                    ),
            )
    }

    fn render_accounts(
        &self,
        storage: Option<&Storage>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement + use<> {
        let accounts = storage
            .map(|storage| storage.accounts.as_slice())
            .unwrap_or_default();
        let rows = accounts.iter().enumerate().map(|(index, account)| {
            let selected = self.selection.contains(&account.username);
            let title = if account.label.is_empty() {
                &account.username
            } else {
                &account.label
            };
            let username = account.username.clone();
            div()
                .id(("account", index))
                .flex()
                .items_center()
                .gap_3()
                .px_3()
                .h(px(36.))
                .border_b_1()
                .border_color(rgb(BORDER))
                .cursor_pointer()
                .when(selected, |row| row.bg(rgba(SELECTED)))
                .when(!selected, |row| row.hover(|style| style.bg(rgb(PANEL))))
                .child(check(selected))
                .child(div().flex_1().min_w_0().truncate().child(title.clone()))
                .when(title != &account.username, |row| {
                    row.child(
                        div()
                            .flex_none()
                            .max_w(px(200.))
                            .truncate()
                            .text_color(rgb(MUTED))
                            .child(account.username.clone()),
                    )
                })
                .on_click(cx.listener(move |this, event, window, cx| {
                    this.click_account(&username, event, window, cx)
                }))
        });
        div()
            .id("accounts")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .children(rows)
            .when(storage.is_some() && accounts.is_empty(), |list| {
                list.child(empty("No accounts yet. Add one to get started."))
            })
    }

    fn render_launch_bar(
        &self,
        storage: Option<&Storage>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let selected = storage.map_or(0, |storage| self.selection.ordered(storage).len());
        let target_label: SharedString = match &self.target {
            None => "New window".into(),
            Some(host) => host.title.clone().into(),
        };
        let menu = self.target_menu.then(|| {
            let hosts = self.hosts.iter().enumerate().map(|(index, host)| {
                let summary = host.clone();
                let tabs = if host.tabs == 1 {
                    "1 tab".to_owned()
                } else {
                    format!("{} tabs", host.tabs)
                };
                menu_item(("target", index), format!("{} ({tabs})", host.title)).on_click(
                    cx.listener(move |this, _, _, cx| {
                        this.choose_target(Some(summary.clone()), cx)
                    }),
                )
            });
            div()
                .absolute()
                .bottom(px(34.))
                .left_0()
                .min_w(px(220.))
                .py_1()
                .rounded_md()
                .border_1()
                .border_color(rgb(BORDER_STRONG))
                .bg(rgb(PANEL))
                .occlude()
                .child(
                    menu_item("target-new", "New window".to_owned())
                        .on_click(cx.listener(|this, _, _, cx| this.choose_target(None, cx))),
                )
                .children(hosts)
        });
        let grid = div()
            .id("grid-toggle")
            .flex()
            .flex_none()
            .items_center()
            .gap_2()
            .cursor_pointer()
            .child(check(self.grid))
            .child("Grid layout")
            .on_click(cx.listener(|this, _, _, cx| {
                this.grid = !this.grid;
                cx.notify();
            }));
        let noun = if selected == 1 { "account" } else { "accounts" };
        let server_label: SharedString = match &self.login_server {
            _ if self.servers_loading && self.servers.is_empty() => "Loading servers…".into(),
            Some(Some(name)) => format!("Server: {name}").into(),
            Some(None) => "Server: choose in game".into(),
            None => "Server: none available".into(),
        };
        let server_menu = self.server_menu.then(|| {
            let current = self.login_server.clone().flatten();
            let entries = self.servers.iter().enumerate().map(|(index, server)| {
                let ping = match self.pings.get(&server.name) {
                    Some(Ping::Ok(ms)) => format!("{ms} ms"),
                    Some(Ping::Timeout) => "timeout".into(),
                    Some(Ping::Unreachable) => "unreachable".into(),
                    Some(Ping::Offline) | None if !server.online => "offline".into(),
                    _ => String::new(),
                };
                let name = server.name.clone();
                let selectable = server.online;
                let marker = if current.as_deref() == Some(server.name.as_str()) {
                    "● "
                } else {
                    ""
                };
                let upgrade = if server.upgrade { " (member)" } else { "" };
                div()
                    .id(("server", index))
                    .flex()
                    .gap_3()
                    .px_3()
                    .py_1()
                    .when(selectable, |row| {
                        row.cursor_pointer()
                            .hover(|style| style.bg(rgb(BORDER)))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.choose_server(Some(name.clone()), cx)
                            }))
                    })
                    .when(!selectable, |row| row.text_color(rgb(MUTED)))
                    .child(
                        div()
                            .flex_1()
                            .truncate()
                            .child(format!("{marker}{}{upgrade}", server.name)),
                    )
                    .child(
                        div()
                            .text_color(rgb(MUTED))
                            .child(format!("{}/{}", server.players, server.max_players)),
                    )
                    .child(div().w(px(80.)).text_color(rgb(MUTED)).child(ping))
            });
            div()
                .id("server-menu")
                .absolute()
                .bottom(px(34.))
                .left_0()
                .w(px(320.))
                .max_h(px(320.))
                .overflow_y_scroll()
                .py_1()
                .rounded_md()
                .border_1()
                .border_color(rgb(BORDER_STRONG))
                .bg(rgb(PANEL))
                .occlude()
                .child(
                    menu_item("server-none", "Choose in game (server select)".to_owned())
                        .on_click(cx.listener(|this, _, _, cx| this.choose_server(None, cx))),
                )
                .children(entries)
                .child(
                    menu_item("server-refresh", "Refresh servers".to_owned()).on_click(
                        cx.listener(|this, _, _, cx| {
                            this.server_menu = false;
                            this.load_servers(true, cx);
                        }),
                    ),
                )
        });
        let script_row = div()
            .flex()
            .items_center()
            .gap_2()
            .min_w_0()
            .child(
                button(
                    "choose-script",
                    if self.script.is_some() {
                        "Change script…"
                    } else {
                        "Choose script…"
                    },
                )
                .on_click(cx.listener(|this, _, _, cx| this.choose_script(cx))),
            )
            .children(self.script.as_ref().map(|script| {
                div()
                    .flex()
                    .items_center()
                    .gap_1()
                    .min_w_0()
                    .child(div().truncate().child(script.name.clone()))
                    .child(
                        div()
                            .id("clear-script")
                            .px_1()
                            .rounded_sm()
                            .cursor_pointer()
                            .text_color(rgb(MUTED))
                            .hover(|style| style.bg(rgb(BORDER)))
                            .child("×")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.script = None;
                                cx.notify();
                            })),
                    )
            }));
        let launch_label = if self.script.is_some() {
            format!("Launch {selected} {noun} with script")
        } else {
            format!("Launch {selected} {noun}")
        };
        div()
            .flex()
            .flex_col()
            .flex_none()
            .gap_2()
            .px_3()
            .py_2()
            .border_t_1()
            .border_color(rgb(BORDER))
            .bg(rgb(PANEL))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_3()
                    .child(
                        div()
                            .relative()
                            .flex_none()
                            .child(
                                button("launch-target", format!("{target_label} ▾")).on_click(
                                    cx.listener(|this, _, _, cx| this.toggle_target_menu(cx)),
                                ),
                            )
                            .children(menu),
                    )
                    .child(
                        div()
                            .relative()
                            .flex_none()
                            .child(
                                button("login-server", format!("{server_label} ▾")).on_click(
                                    cx.listener(|this, _, _, cx| {
                                        this.server_menu = !this.server_menu;
                                        this.target_menu = false;
                                        if this.server_menu
                                            && this.servers.is_empty()
                                            && !this.servers_loading
                                        {
                                            this.load_servers(false, cx);
                                        }
                                        cx.notify();
                                    }),
                                ),
                            )
                            .children(server_menu),
                    )
                    .children(self.servers_error.clone().map(error_text))
                    .child(grid),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(script_row)
                    .child(div().flex_1())
                    .when(self.script.is_some(), |row| {
                        row.child(
                            button("launch-plain", "Launch without script")
                                .disabled(selected == 0)
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.launch_with(None, window, cx)
                                })),
                        )
                    })
                    .child(
                        button("launch", launch_label)
                            .primary()
                            .disabled(selected == 0)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.launch(&LaunchSelected, window, cx)
                            })),
                    ),
            )
    }
}

impl Render for Manager {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let storage = self.storage();
        let form = self.form.as_ref().map(|form| self.render_form(form, cx));
        div()
            .key_context(CONTEXT)
            .track_focus(&self.focus)
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(Self::new_account))
            .on_action(cx.listener(Self::launch))
            .on_action(cx.listener(Self::dismiss))
            .on_action(cx.listener(Self::focus_next))
            .on_action(cx.listener(Self::focus_previous))
            .flex()
            .flex_col()
            .size_full()
            .bg(rgb(BACKGROUND))
            .text_color(rgb(TEXT))
            .text_size(px(13.))
            .font_family(".SystemUIFont")
            .child(self.render_notices(cx))
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .child(self.render_groups(storage, cx))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .child(self.render_toolbar(storage, cx))
                            .children(form)
                            .child(self.render_accounts(storage, cx)),
                    ),
            )
            .child(self.render_launch_bar(storage, cx))
    }
}

fn load(cx: &App) -> Result<AccountStore, StoreError> {
    AccountStore::load(&Lucent::get(cx).data_dir).inspect_err(|error| {
        tracing::warn!(%error, "could not load saved accounts");
    })
}

fn section_title(title: &'static str) -> impl IntoElement {
    div()
        .flex()
        .flex_none()
        .items_center()
        .px_3()
        .h(px(44.))
        .border_b_1()
        .border_color(rgb(BORDER))
        .text_color(rgb(MUTED))
        .child(title)
}

fn empty(text: &'static str) -> impl IntoElement {
    div().p_3().text_color(rgb(MUTED)).child(text)
}

fn error_text(text: impl Into<SharedString>) -> impl IntoElement {
    div()
        .text_size(px(12.))
        .text_color(rgb(DANGER))
        .child(text.into())
}

fn check(checked: bool) -> impl IntoElement {
    div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(14.))
        .rounded_sm()
        .border_1()
        .border_color(rgb(if checked { ACCENT } else { BORDER_STRONG }))
        .when(checked, |check| {
            check
                .bg(rgb(ACCENT))
                .text_color(rgb(0xffffff))
                .text_size(px(10.))
                .child("✓")
        })
}

fn menu_item(id: impl Into<gpui::ElementId>, label: String) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .px_3()
        .py_1()
        .truncate()
        .cursor_pointer()
        .hover(|style| style.bg(rgb(BORDER)))
        .child(label)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORDER: [&str; 5] = ["Alice", "Bob", "Cara", "Dan", "Eve"];

    fn shift() -> Modifiers {
        Modifiers {
            shift: true,
            ..Modifiers::default()
        }
    }

    fn selected(selection: &Selection) -> Vec<&str> {
        ORDER
            .into_iter()
            .filter(|name| selection.contains(name))
            .collect()
    }

    #[test]
    fn click_selects_one_and_secondary_click_toggles() {
        let mut selection = Selection::default();
        selection.click(&ORDER, "Bob", Modifiers::default());
        selection.click(&ORDER, "Dan", Modifiers::secondary_key());
        assert_eq!(selected(&selection), ["Bob", "Dan"]);

        selection.click(&ORDER, "Bob", Modifiers::secondary_key());
        assert_eq!(selected(&selection), ["Dan"]);

        selection.click(&ORDER, "Cara", Modifiers::default());
        assert_eq!(selected(&selection), ["Cara"]);
    }

    #[test]
    fn shift_click_selects_the_range_from_the_anchor() {
        let mut selection = Selection::default();
        selection.click(&ORDER, "Dan", shift());
        assert_eq!(selected(&selection), ["Dan"]);

        selection.click(&ORDER, "Bob", shift());
        assert_eq!(selected(&selection), ["Bob", "Cara", "Dan"]);

        selection.click(&ORDER, "Eve", shift());
        assert_eq!(selected(&selection), ["Dan", "Eve"]);

        selection.click(&ORDER, "Alice", Modifiers::secondary_key());
        selection.click(
            &ORDER,
            "Bob",
            Modifiers {
                shift: true,
                ..Modifiers::secondary_key()
            },
        );
        assert_eq!(selected(&selection), ["Alice", "Bob", "Dan", "Eve"]);
    }
}
