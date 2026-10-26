use futures::FutureExt;
use futures::future::{BoxFuture, LocalBoxFuture};
use gpui::{
    AnyElement, App, Bounds, Context, Entity, FocusHandle, KeyBinding, Render, Subscription,
    TitlebarOptions, Window, WindowBounds, WindowHandle, WindowOptions, actions, div, prelude::*,
    px, rgb, size,
};
use scripting::ConsoleLevel;

use crate::game_view::{self, DialogAnswer, DialogKind, GameView, ScriptDialog, ViewPresentation};
use crate::inputs_form::InputsForm;
use crate::lucent::{HostSummary, LaunchRequest, LaunchTarget, Lucent, ScriptChoice};
use crate::ui::{
    self, ACCENT, BACKGROUND, BORDER, BORDER_STRONG, MUTED, PANEL, TEXT, TextInput, button,
};

/// Electron's `MAX_GAME_VIEWS_PER_WINDOW`.
pub const MAX_TABS: usize = 7;

const CONTEXT: &str = "HostWindow";

actions!(
    host_window,
    [
        NextTab,
        PreviousTab,
        CloseTab,
        NewTab,
        ToggleGrid,
        ToggleConsole,
        SelectTab1,
        SelectTab2,
        SelectTab3,
        SelectTab4,
        SelectTab5,
        SelectTab6,
        SelectTab7
    ]
);

pub fn bind_keys(cx: &mut App) {
    ui::init(cx);
    cx.bind_keys([
        KeyBinding::new("ctrl-tab", NextTab, Some(CONTEXT)),
        KeyBinding::new("ctrl-shift-tab", PreviousTab, Some(CONTEXT)),
        KeyBinding::new("cmd-shift-]", NextTab, Some(CONTEXT)),
        KeyBinding::new("cmd-shift-[", PreviousTab, Some(CONTEXT)),
        KeyBinding::new("cmd-t", NewTab, Some(CONTEXT)),
        KeyBinding::new("cmd-shift-w", CloseTab, Some(CONTEXT)),
        KeyBinding::new("cmd-g", ToggleGrid, Some(CONTEXT)),
        KeyBinding::new("cmd-j", ToggleConsole, Some(CONTEXT)),
        KeyBinding::new("cmd-1", SelectTab1, Some(CONTEXT)),
        KeyBinding::new("cmd-2", SelectTab2, Some(CONTEXT)),
        KeyBinding::new("cmd-3", SelectTab3, Some(CONTEXT)),
        KeyBinding::new("cmd-4", SelectTab4, Some(CONTEXT)),
        KeyBinding::new("cmd-5", SelectTab5, Some(CONTEXT)),
        KeyBinding::new("cmd-6", SelectTab6, Some(CONTEXT)),
        KeyBinding::new("cmd-7", SelectTab7, Some(CONTEXT)),
    ]);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Layout {
    Focused,
    Grid,
}

pub struct HostWindow {
    tabs: Vec<Entity<GameView>>,
    selected: usize,
    layout: Layout,
    console_open: bool,
    focus: FocusHandle,
    inputs_form: Option<(gpui::EntityId, Entity<InputsForm>)>,
    prompt: Option<(gpui::EntityId, u64, Entity<TextInput>)>,
    _observers: Vec<Subscription>,
}

impl HostWindow {
    fn new(grid: bool, cx: &mut Context<Self>) -> Self {
        Self {
            tabs: Vec::new(),
            selected: 0,
            layout: if grid { Layout::Grid } else { Layout::Focused },
            console_open: false,
            focus: cx.focus_handle(),
            inputs_form: None,
            prompt: None,
            _observers: Vec::new(),
        }
    }

    pub fn tab_count(&self) -> usize {
        self.tabs.len()
    }

    fn title(&self, cx: &App) -> String {
        let names: Vec<String> = self.tabs.iter().map(|tab| tab.read(cx).title()).collect();
        if names.is_empty() {
            "Lucent".into()
        } else {
            names.join(", ")
        }
    }

    fn add_tab(
        &mut self,
        account: Option<crate::accounts::ManagedAccount>,
        server: Option<String>,
        script: Option<ScriptChoice>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.tabs.len() >= MAX_TABS {
            return;
        }
        let view = cx.new(|cx| GameView::new(account, server, script, cx));
        game_view::observe_focus(&view, window, cx);
        self._observers.push(cx.subscribe_in(
            &view,
            window,
            |host, view, _: &game_view::CloseRequested, window, cx| {
                if cx.has_global::<crate::soak::SoakCloses>() {
                    cx.global_mut::<crate::soak::SoakCloses>().0 += 1;
                }
                if let Some(index) = host.tabs.iter().position(|tab| tab == view) {
                    host.close_tab(index, window, cx);
                }
            },
        ));
        self._observers.push(cx.observe(&view, |host, _, cx| {
            host.sync_overlays(cx);
            cx.notify();
        }));
        self.tabs.push(view);
        self.select(self.tabs.len() - 1, window, cx);
    }

    fn select(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        if index >= self.tabs.len() {
            return;
        }
        self.selected = index;
        self.sync_visibility(window, cx);
        self.sync_overlays(cx);
        let focus = self.tabs[index].read(cx).focus_handle().clone();
        focus.focus(window, cx);
        cx.notify();
    }

    /// Keeps the inputs form and the prompt field in step with the selected tab.
    fn sync_overlays(&mut self, cx: &mut Context<Self>) {
        let Some(tab) = self.selected_tab().cloned() else {
            self.inputs_form = None;
            self.prompt = None;
            return;
        };
        let id = tab.entity_id();
        let session = &tab.read(cx).session;
        let inputs = session.inputs.clone();
        let inputs_error = session.inputs_error.clone();
        let dialog = session.dialog.clone();
        match inputs {
            Some(inputs) => {
                if self
                    .inputs_form
                    .as_ref()
                    .is_none_or(|(owner, _)| *owner != id)
                {
                    let weak = tab.downgrade();
                    let form = cx.new(|cx| InputsForm::new(weak, &inputs, cx));
                    self.inputs_form = Some((id, form));
                }
                if let Some((_, form)) = &self.inputs_form {
                    form.update(cx, |form, cx| form.set_error(inputs_error, cx));
                }
            }
            None => self.inputs_form = None,
        }
        match dialog {
            Some(ScriptDialog {
                id: dialog_id,
                kind: DialogKind::Prompt { placeholder },
                ..
            }) => {
                if self
                    .prompt
                    .as_ref()
                    .is_none_or(|(owner, current, _)| *owner != id || *current != dialog_id)
                {
                    let input = cx.new(|cx| TextInput::new(placeholder, cx));
                    self.prompt = Some((id, dialog_id, input));
                }
            }
            _ => self.prompt = None,
        }
    }

    fn sync_visibility(&mut self, window: &Window, cx: &mut Context<Self>) {
        let window_active = window.is_window_active();
        let grid = self.layout == Layout::Grid;
        for (index, tab) in self.tabs.iter().enumerate() {
            let active = index == self.selected;
            tab.update(cx, |view, cx| {
                view.set_visible(grid || active);
                view.set_presentation(
                    ViewPresentation {
                        active,
                        grid,
                        window_active,
                    },
                    cx,
                );
            });
        }
    }

    fn close_tab(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        if index >= self.tabs.len() {
            return;
        }
        let tab = self.tabs.remove(index);
        let shutdown = tab.update(cx, |view, _| view.shutdown());
        cx.background_executor().spawn(shutdown).detach();
        if self.tabs.is_empty() {
            window.remove_window();
            return;
        }
        if self.selected >= self.tabs.len() || self.selected > index {
            self.selected = self.selected.saturating_sub(1).min(self.tabs.len() - 1);
        }
        self.select(self.selected, window, cx);
        window.set_window_title(&self.title(cx));
    }

    fn shutdown_all(&mut self, cx: &mut Context<Self>) -> Vec<BoxFuture<'static, ()>> {
        self.tabs
            .drain(..)
            .map(|tab| tab.update(cx, |view, _| view.shutdown()))
            .collect()
    }

    fn selected_tab(&self) -> Option<&Entity<GameView>> {
        self.tabs.get(self.selected)
    }

    fn open_script(&mut self, cx: &mut Context<Self>) {
        let Some(tab) = self.selected_tab().cloned() else {
            return;
        };
        let chosen = Lucent::choose_script(cx);
        cx.spawn(async move |_, cx| match chosen.await {
            Ok(Some(choice)) => tab.update(cx, |view, cx| view.load_script(choice, cx)),
            Ok(None) => {}
            Err(error) => tracing::error!(%error, "could not describe the script"),
        })
        .detach();
    }

    fn for_each_tab(
        &mut self,
        cx: &mut Context<Self>,
        run: impl Fn(&mut GameView, &mut Context<GameView>),
    ) {
        for tab in &self.tabs {
            tab.update(cx, |view, cx| run(view, cx));
        }
    }
}

fn status_color(view: &GameView) -> u32 {
    if view.session.runtime_error.is_some() {
        return 0xef4444;
    }
    if view.session.status.is_active() {
        return 0x22c55e;
    }
    match view.boot() {
        bridge::Boot::Ready if view.session.player.is_some() => 0x3b82f6,
        bridge::Boot::Ready => 0x71717a,
        bridge::Boot::Failed { .. } => 0xef4444,
        _ => 0xf59e0b,
    }
}

impl HostWindow {
    fn render_tabs(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let tabs = self.tabs.iter().enumerate().map(|(index, tab)| {
            let view = tab.read(cx);
            let selected = index == self.selected;
            let has_dialog = view.session.dialog.is_some();
            div()
                .id(("tab", index))
                .flex()
                .items_center()
                .gap_2()
                .h_full()
                .px_3()
                .max_w(px(200.))
                .border_r_1()
                .border_color(rgb(BORDER))
                .bg(rgb(if selected { PANEL } else { BACKGROUND }))
                .text_color(rgb(if selected { TEXT } else { MUTED }))
                .text_size(px(12.))
                .cursor_pointer()
                .on_click(cx.listener(move |host, _, window, cx| host.select(index, window, cx)))
                .child(
                    div()
                        .size(px(7.))
                        .rounded_full()
                        .bg(rgb(status_color(view))),
                )
                .child(
                    div()
                        .flex_1()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .child(view.title()),
                )
                .when(has_dialog, |tab| {
                    tab.child(div().text_color(rgb(ACCENT)).child("•"))
                })
                .child(
                    div()
                        .id(("close-tab", index))
                        .px_1()
                        .rounded_sm()
                        .text_color(rgb(MUTED))
                        .hover(|style| style.bg(rgb(0x3f3f46)))
                        .child("×")
                        .on_click(cx.listener(move |host, _, window, cx| {
                            cx.stop_propagation();
                            host.close_tab(index, window, cx);
                        })),
                )
        });
        let can_add = self.tabs.len() < MAX_TABS;
        div()
            .flex()
            .flex_none()
            .h(px(30.))
            .items_center()
            .border_b_1()
            .border_color(rgb(BORDER))
            .bg(rgb(BACKGROUND))
            .children(tabs)
            .when(can_add, |bar| {
                bar.child(
                    div()
                        .id("new-tab")
                        .px_3()
                        .h_full()
                        .flex()
                        .items_center()
                        .text_color(rgb(MUTED))
                        .cursor_pointer()
                        .hover(|style| style.text_color(rgb(TEXT)))
                        .child("+")
                        .on_click(cx.listener(|host, _, window, cx| {
                            host.add_tab(None, None, None, window, cx);
                        })),
                )
            })
            .child(div().flex_1())
            .child(
                div().pr_2().child(
                    button(
                        "layout",
                        if self.layout == Layout::Grid {
                            "Focused"
                        } else {
                            "Grid"
                        },
                    )
                    .on_click(cx.listener(|host, _, window, cx| host.toggle_grid(window, cx))),
                ),
            )
            .into_any_element()
    }

    fn toggle_grid(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.layout = match self.layout {
            Layout::Focused => Layout::Grid,
            Layout::Grid => Layout::Focused,
        };
        self.select(self.selected, window, cx);
    }

    fn render_script_bar(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let Some(tab) = self.selected_tab() else {
            return div().into_any_element();
        };
        let view = tab.read(cx);
        let session = &view.session;
        let script = session
            .script
            .as_ref()
            .map(|script| script.choice.name.clone())
            .unwrap_or_else(|| "No script loaded".into());
        let ready = session.runtime_ready && !session.busy;
        let active = session.status.is_active();
        let main_action = if active {
            button("stop", "Stop").on_click(cx.listener(|host, _, _, cx| {
                if let Some(tab) = host.selected_tab().cloned() {
                    tab.update(cx, |view, cx| view.stop_script(cx));
                }
            }))
        } else {
            button("start", "Start")
                .primary()
                .disabled(!ready || session.script.is_none())
                .on_click(cx.listener(|host, _, _, cx| {
                    if let Some(tab) = host.selected_tab().cloned() {
                        tab.update(cx, |view, cx| view.start_script(cx));
                    }
                }))
        };
        let multi = self.tabs.len() > 1;
        div()
            .flex()
            .flex_none()
            .h(px(36.))
            .items_center()
            .gap_2()
            .px_2()
            .border_b_1()
            .border_color(rgb(BORDER))
            .bg(rgb(PANEL))
            .text_size(px(12.))
            .text_color(rgb(TEXT))
            .child(
                button("open-script", "Load script…")
                    .disabled(!session.runtime_ready)
                    .on_click(cx.listener(|host, _, _, cx| host.open_script(cx))),
            )
            .child(
                div()
                    .max_w(px(260.))
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_color(rgb(if session.script.is_some() {
                        TEXT
                    } else {
                        MUTED
                    }))
                    .child(script),
            )
            .when(view.has_inputs(), |bar| {
                bar.child(
                    button("inputs", "Inputs…")
                        .disabled(!ready)
                        .on_click(cx.listener(|host, _, _, cx| {
                            if let Some(tab) = host.selected_tab().cloned() {
                                tab.update(cx, |view, cx| view.edit_inputs(cx));
                            }
                        })),
                )
            })
            .child(main_action)
            .child(div().text_color(rgb(MUTED)).child(session.status.label()))
            .child(div().flex_1())
            .when(multi, |bar| {
                bar.child(button("start-all", "Start all").on_click(cx.listener(
                    |host, _, _, cx| {
                        host.for_each_tab(cx, |view, cx| {
                            if !view.session.status.is_active() {
                                view.start_script(cx);
                            }
                        });
                    },
                )))
                .child(
                    button("stop-all", "Stop all").on_click(cx.listener(|host, _, _, cx| {
                        host.for_each_tab(cx, |view, cx| {
                            if view.session.status.is_active() {
                                view.stop_script(cx);
                            }
                        });
                    })),
                )
            })
            .child(
                button(
                    "console",
                    if self.console_open {
                        "Hide console"
                    } else {
                        "Console"
                    },
                )
                .on_click(cx.listener(|host, _, _, cx| {
                    host.console_open = !host.console_open;
                    cx.notify();
                })),
            )
            .into_any_element()
    }

    fn render_console(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let Some(tab) = self.selected_tab() else {
            return div().into_any_element();
        };
        let lines = tab
            .read(cx)
            .session
            .console
            .iter()
            .enumerate()
            .map(|(index, line)| {
                let color = match line.level {
                    ConsoleLevel::Error => 0xf87171,
                    ConsoleLevel::Warn => 0xfbbf24,
                    ConsoleLevel::Debug => 0x71717a,
                    ConsoleLevel::Info => TEXT,
                };
                div()
                    .id(("line", index))
                    .text_color(rgb(color))
                    .child(line.text.clone())
            });
        div()
            .flex()
            .flex_col()
            .flex_none()
            .h(px(180.))
            .border_t_1()
            .border_color(rgb(BORDER))
            .bg(rgb(BACKGROUND))
            .child(
                div()
                    .flex()
                    .items_center()
                    .px_2()
                    .py_1()
                    .text_size(px(11.))
                    .text_color(rgb(MUTED))
                    .child("Console")
                    .child(div().flex_1())
                    .child(button("clear-console", "Clear").on_click(cx.listener(
                        |host, _, _, cx| {
                            if let Some(tab) = host.selected_tab().cloned() {
                                tab.update(cx, |view, cx| view.clear_console(cx));
                            }
                        },
                    ))),
            )
            .child(
                div()
                    .id("console-lines")
                    .flex_1()
                    .overflow_y_scroll()
                    .px_2()
                    .pb_2()
                    .font_family("Menlo")
                    .text_size(px(11.))
                    .children(lines),
            )
            .into_any_element()
    }

    fn render_dialog(&mut self, dialog: &ScriptDialog, cx: &mut Context<Self>) -> AnyElement {
        let answer = |answer: DialogAnswer| {
            cx.listener(move |host: &mut HostWindow, _, _, cx| {
                if let Some(tab) = host.selected_tab().cloned() {
                    let answer = answer.clone();
                    tab.update(cx, |view, cx| view.answer_dialog(answer, cx));
                }
            })
        };
        let buttons = match &dialog.kind {
            DialogKind::Alert => {
                div().child(button("dialog-ok", "OK").on_click(answer(DialogAnswer::Dismissed)))
            }
            DialogKind::Confirm => div()
                .flex()
                .gap_2()
                .child(
                    button("dialog-cancel", "Cancel")
                        .on_click(answer(DialogAnswer::Confirmed(false))),
                )
                .child(button("dialog-ok", "OK").on_click(answer(DialogAnswer::Confirmed(true)))),
            DialogKind::Prompt { .. } => div()
                .flex()
                .gap_2()
                .child(
                    button("dialog-cancel", "Cancel")
                        .on_click(answer(DialogAnswer::Prompted(None))),
                )
                .child(button("dialog-ok", "OK").primary().on_click(cx.listener(
                    |host, _, _, cx| {
                        let value = host
                            .prompt
                            .as_ref()
                            .map(|(_, _, input)| input.read(cx).text().to_owned())
                            .unwrap_or_default();
                        if let Some(tab) = host.selected_tab().cloned() {
                            tab.update(cx, |view, cx| {
                                view.answer_dialog(DialogAnswer::Prompted(Some(value)), cx)
                            });
                        }
                    },
                ))),
        };
        let prompt = matches!(dialog.kind, DialogKind::Prompt { .. })
            .then(|| self.prompt.as_ref().map(|(_, _, input)| input.clone()))
            .flatten();
        div()
            .absolute()
            .inset_0()
            .occlude()
            .flex()
            .items_center()
            .justify_center()
            .bg(gpui::rgba(0x00000099))
            .child(
                div()
                    .w(px(380.))
                    .p_4()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .rounded_lg()
                    .border_1()
                    .border_color(rgb(BORDER_STRONG))
                    .bg(rgb(PANEL))
                    .text_size(px(13.))
                    .text_color(rgb(TEXT))
                    .when(!dialog.source.is_empty(), |panel| {
                        panel.child(
                            div()
                                .text_size(px(11.))
                                .text_color(rgb(MUTED))
                                .child(dialog.source.clone()),
                        )
                    })
                    .child(dialog.message.clone())
                    .children(prompt)
                    .child(div().flex().justify_end().child(buttons)),
            )
            .into_any_element()
    }

    fn render_content(&mut self, cx: &mut Context<Self>) -> AnyElement {
        if self.tabs.is_empty() {
            return div()
                .flex_1()
                .flex()
                .items_center()
                .justify_center()
                .text_color(rgb(MUTED))
                .child("No games are open.")
                .into_any_element();
        }
        match self.layout {
            Layout::Focused => {
                let tab = self.tabs[self.selected].clone();
                div().flex_1().relative().child(tab).into_any_element()
            }
            Layout::Grid => {
                let count = self.tabs.len();
                let columns = (count as f64).sqrt().ceil() as usize;
                let rows = count.div_ceil(columns);
                let mut grid = div().flex_1().flex().flex_col().bg(rgb(BORDER)).gap(px(1.));
                for row in 0..rows {
                    let mut line = div().flex_1().flex().gap(px(1.));
                    for column in 0..columns {
                        let index = row * columns + column;
                        let Some(tab) = self.tabs.get(index).cloned() else {
                            line = line.child(div().flex_1().bg(rgb(BACKGROUND)));
                            continue;
                        };
                        let selected = index == self.selected;
                        line = line.child(
                            div()
                                .id(("cell", index))
                                .flex_1()
                                .relative()
                                .border_1()
                                .border_color(rgb(if selected { ACCENT } else { BACKGROUND }))
                                .on_mouse_down(
                                    gpui::MouseButton::Left,
                                    cx.listener(move |host, _, window, cx| {
                                        if host.selected != index {
                                            host.select(index, window, cx);
                                        }
                                    }),
                                )
                                .child(tab),
                        );
                    }
                    grid = grid.child(line);
                }
                grid.into_any_element()
            }
        }
    }
}

impl Render for HostWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        window.set_window_title(&self.title(cx));
        let dialog = self
            .selected_tab()
            .and_then(|tab| tab.read(cx).session.dialog.clone());
        let tabs = self.render_tabs(cx);
        let bar = self.render_script_bar(cx);
        let content = self.render_content(cx);
        let console = self.console_open.then(|| self.render_console(cx));
        let dialog = dialog.map(|dialog| self.render_dialog(&dialog, cx));
        let inputs = self.inputs_form.as_ref().map(|(_, form)| {
            div()
                .absolute()
                .inset_0()
                .occlude()
                .flex()
                .items_center()
                .justify_center()
                .bg(gpui::rgba(0x00000099))
                .child(form.clone())
        });
        div()
            .key_context(CONTEXT)
            .track_focus(&self.focus)
            .on_action(
                cx.listener(|host, _: &crate::menus::CloseWindow, window, cx| {
                    for shutdown in host.shutdown_all(cx) {
                        cx.background_executor().spawn(shutdown).detach();
                    }
                    window.remove_window();
                }),
            )
            .on_action(cx.listener(|host, _: &NextTab, window, cx| {
                let next = (host.selected + 1) % host.tabs.len().max(1);
                host.select(next, window, cx);
            }))
            .on_action(cx.listener(|host, _: &PreviousTab, window, cx| {
                let count = host.tabs.len().max(1);
                host.select((host.selected + count - 1) % count, window, cx);
            }))
            .on_action(cx.listener(|host, _: &NewTab, window, cx| {
                host.add_tab(None, None, None, window, cx)
            }))
            .on_action(cx.listener(|host, _: &CloseTab, window, cx| {
                let selected = host.selected;
                host.close_tab(selected, window, cx);
            }))
            .on_action(cx.listener(|host, _: &ToggleGrid, window, cx| host.toggle_grid(window, cx)))
            .on_action(cx.listener(|host, _: &ToggleConsole, _, cx| {
                host.console_open = !host.console_open;
                cx.notify();
            }))
            .on_action(cx.listener(|host, _: &SelectTab1, window, cx| host.select(0, window, cx)))
            .on_action(cx.listener(|host, _: &SelectTab2, window, cx| host.select(1, window, cx)))
            .on_action(cx.listener(|host, _: &SelectTab3, window, cx| host.select(2, window, cx)))
            .on_action(cx.listener(|host, _: &SelectTab4, window, cx| host.select(3, window, cx)))
            .on_action(cx.listener(|host, _: &SelectTab5, window, cx| host.select(4, window, cx)))
            .on_action(cx.listener(|host, _: &SelectTab6, window, cx| host.select(5, window, cx)))
            .on_action(cx.listener(|host, _: &SelectTab7, window, cx| host.select(6, window, cx)))
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .bg(rgb(BACKGROUND))
            .font_family(".SystemUIFont")
            .child(tabs)
            .child(bar)
            .child(content)
            .children(console)
            .children(inputs)
            .children(dialog)
    }
}

fn open_window(grid: bool, cx: &mut App) -> Option<WindowHandle<HostWindow>> {
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
            None,
            size(px(1100.), px(740.)),
            cx,
        ))),
        titlebar: Some(TitlebarOptions {
            title: Some("Lucent".into()),
            ..Default::default()
        }),
        ..Default::default()
    };
    let opened = cx.open_window(options, |window, cx| {
        let host = cx.new(|cx| HostWindow::new(grid, cx));
        host.update(cx, |host, cx| {
            host._observers
                .push(cx.observe_window_activation(window, |host, window, cx| {
                    host.sync_visibility(window, cx);
                }));
        });
        let weak = host.downgrade();
        window.on_window_should_close(cx, move |_, cx| {
            if let Some(host) = weak.upgrade() {
                let shutdowns = host.update(cx, |host, cx| host.shutdown_all(cx));
                for shutdown in shutdowns {
                    cx.background_executor().spawn(shutdown).detach();
                }
            }
            true
        });
        host
    });
    match opened {
        Ok(handle) => {
            let entity = handle.entity(cx).ok()?.downgrade();
            cx.global_mut::<Lucent>().hosts.push((handle, entity));
            Some(handle)
        }
        Err(error) => {
            tracing::error!(%error, "could not open a game window");
            None
        }
    }
}

/// A host is live while its root entity is; reading through the window handle fails
/// while GPUI has that window checked out for an update.
fn live_hosts(cx: &mut App) -> Vec<WindowHandle<HostWindow>> {
    let lucent = cx.global_mut::<Lucent>();
    lucent
        .hosts
        .retain(|(_, entity)| entity.upgrade().is_some());
    lucent.hosts.iter().map(|(handle, _)| *handle).collect()
}

fn host_entity(handle: WindowHandle<HostWindow>, cx: &App) -> Option<Entity<HostWindow>> {
    cx.global::<Lucent>()
        .hosts
        .iter()
        .find(|(candidate, _)| *candidate == handle)
        .and_then(|(_, entity)| entity.upgrade())
}

/// Closes a game window the way its close button does, stopping its games first.
pub fn close_window(handle: WindowHandle<HostWindow>, cx: &mut App) {
    if let Some(host) = host_entity(handle, cx) {
        let shutdowns = host.update(cx, |host, cx| host.shutdown_all(cx));
        for shutdown in shutdowns {
            cx.background_executor().spawn(shutdown).detach();
        }
    }
    let _ = handle.update(cx, |_, window, _| window.remove_window());
}

pub fn summaries(cx: &mut App) -> Vec<HostSummary> {
    live_hosts(cx)
        .into_iter()
        .enumerate()
        .filter_map(|(index, handle)| {
            let host = host_entity(handle, cx)?.read(cx);
            Some(HostSummary {
                handle,
                title: format!("Window {}: {}", index + 1, host.title(cx)),
                tabs: host.tab_count(),
            })
        })
        .collect()
}

pub fn launch(request: LaunchRequest, cx: &mut App) {
    let mut accounts = request.accounts.into_iter().peekable();
    let mut target = match request.target {
        LaunchTarget::Window(handle) if host_entity(handle, cx).is_some() => Some(handle),
        _ => None,
    };
    while accounts.peek().is_some() {
        let handle = match target.take() {
            Some(handle) => handle,
            None => match open_window(request.grid, cx) {
                Some(handle) => handle,
                None => return,
            },
        };
        let _ = handle.update(cx, |host, window, cx| {
            while host.tabs.len() < MAX_TABS {
                let Some(account) = accounts.next() else {
                    break;
                };
                host.add_tab(
                    Some(account),
                    request.server.clone(),
                    request.script.clone(),
                    window,
                    cx,
                );
            }
            window.activate_window();
        });
    }
}

pub fn set_muted(muted: bool, cx: &mut App) {
    for handle in live_hosts(cx) {
        let _ = handle.update(cx, |host, _, cx| {
            host.for_each_tab(cx, |view, _| view.set_muted(muted));
        });
    }
}

pub fn open_empty(cx: &mut App) {
    if let Some(handle) = open_window(false, cx) {
        let _ = handle.update(cx, |host, window, cx| {
            host.add_tab(None, None, None, window, cx)
        });
    }
}

/// Stops every player and script runtime before the process exits.
pub fn shutdown_all(cx: &mut App) -> LocalBoxFuture<'static, ()> {
    let mut shutdowns = Vec::new();
    for handle in live_hosts(cx) {
        let _ = handle.update(cx, |host, _, cx| shutdowns.extend(host.shutdown_all(cx)));
    }
    let executor = cx.background_executor().clone();
    async move {
        let tasks: Vec<_> = shutdowns
            .into_iter()
            .map(|shutdown| executor.spawn(shutdown))
            .collect();
        futures::future::join_all(tasks).await;
    }
    .boxed_local()
}
