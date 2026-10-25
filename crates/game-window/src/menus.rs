use gpui::{App, KeyBinding, Menu, MenuItem, SystemMenuType, WindowHandle, actions};

use crate::window::GameWindow;

actions!(
    game_window,
    [Quit, CloseWindow, Minimize, Zoom, Hide, HideOthers, ShowAll]
);

pub fn install(window: WindowHandle<GameWindow>, cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-q", Quit, None),
        KeyBinding::new("cmd-w", CloseWindow, None),
        KeyBinding::new("cmd-m", Minimize, None),
        KeyBinding::new("cmd-h", Hide, None),
        KeyBinding::new("alt-cmd-h", HideOthers, None),
    ]);
    let close = move |cx: &mut App| {
        let _ = window.update(cx, |view, _, cx| view.close(cx));
    };
    cx.on_action(move |_: &Quit, cx| close(cx));
    cx.on_action(move |_: &CloseWindow, cx| close(cx));
    cx.on_action(move |_: &Minimize, cx| {
        let _ = window.update(cx, |_, window, _| window.minimize_window());
    });
    cx.on_action(move |_: &Zoom, cx| {
        let _ = window.update(cx, |_, window, _| window.zoom_window());
    });
    cx.on_action(|_: &Hide, cx| cx.hide());
    cx.on_action(|_: &HideOthers, cx| cx.hide_other_apps());
    cx.on_action(|_: &ShowAll, cx| cx.unhide_other_apps());
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
            MenuItem::action("Minimize", Minimize),
            MenuItem::action("Zoom", Zoom),
            MenuItem::separator(),
            MenuItem::action("Close", CloseWindow),
        ]),
    ]);
}
