use gpui::{App, KeyBinding, Menu, MenuItem, SystemMenuType, actions};

actions!(
    lucent,
    [
        Quit,
        CloseWindow,
        Minimize,
        Zoom,
        Hide,
        HideOthers,
        ShowAll,
        ShowAccountManager,
        ToggleGameAudio
    ]
);

pub fn install(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-q", Quit, None),
        KeyBinding::new("cmd-w", CloseWindow, None),
        KeyBinding::new("cmd-m", Minimize, None),
        KeyBinding::new("cmd-h", Hide, None),
        KeyBinding::new("alt-cmd-h", HideOthers, None),
        KeyBinding::new("cmd-shift-a", ShowAccountManager, None),
        KeyBinding::new("cmd-alt-m", ToggleGameAudio, None),
    ]);
    cx.on_action(|_: &Quit, cx| cx.quit());
    cx.on_action(|_: &CloseWindow, cx| {
        let Some(window) = cx.active_window() else {
            return;
        };
        match window.downcast::<crate::host::HostWindow>() {
            Some(host) => crate::host::close_window(host, cx),
            None => {
                let _ = window.update(cx, |_, window, _| window.remove_window());
            }
        }
    });
    cx.on_action(|_: &Minimize, cx| {
        if let Some(window) = cx.active_window() {
            let _ = window.update(cx, |_, window, _| window.minimize_window());
        }
    });
    cx.on_action(|_: &Zoom, cx| {
        if let Some(window) = cx.active_window() {
            let _ = window.update(cx, |_, window, _| window.zoom_window());
        }
    });
    cx.on_action(|_: &Hide, cx| cx.hide());
    cx.on_action(|_: &HideOthers, cx| cx.hide_other_apps());
    cx.on_action(|_: &ShowAll, cx| cx.unhide_other_apps());
    cx.on_action(|_: &ShowAccountManager, cx| crate::manager::open(cx));
    cx.on_action(|_: &ToggleGameAudio, cx| crate::lucent::Lucent::toggle_muted(cx));
    cx.set_menus([
        Menu::new("Lucent").items([
            MenuItem::os_submenu("Services", SystemMenuType::Services),
            MenuItem::separator(),
            MenuItem::action("Hide Lucent", Hide),
            MenuItem::action("Hide Others", HideOthers),
            MenuItem::action("Show All", ShowAll),
            MenuItem::separator(),
            MenuItem::action("Quit Lucent", Quit),
        ]),
        Menu::new("Window").items([
            MenuItem::action("Account Manager", ShowAccountManager),
            MenuItem::action("Mute or Unmute Game Audio", ToggleGameAudio),
            MenuItem::separator(),
            MenuItem::action("Minimize", Minimize),
            MenuItem::action("Zoom", Zoom),
            MenuItem::separator(),
            MenuItem::action("Close", CloseWindow),
        ]),
    ]);
}
