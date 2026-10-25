use std::cell::Cell;
use std::ops::Range;
use std::rc::Rc;
use std::time::{Duration, Instant};

use bridge::Boot;
use gpui::{
    App, Bounds, ClipboardItem, Context, Corners, CursorStyle, DispatchPhase, ElementInputHandler,
    EntityInputHandler, FocusHandle, HitboxBehavior, KeyDownEvent, KeyUpEvent,
    ModifiersChangedEvent, MouseButton, MouseDownEvent, MouseExitEvent, MouseMoveEvent,
    MouseUpEvent, Pixels, Point, Render, ScrollDelta, ScrollWheelEvent, Task, UTF16Selection,
    Window, canvas, div, prelude::*, px, rgb,
};
use ruffle_host::ruffle::{
    ImeEvent, MouseButton as GameButton, MouseCursor, MouseWheelDelta, PlayerEvent, TextControlCode,
};
use ruffle_host::{
    Engine, InputSink, PlayerConfig, PlayerHost, Presentation, Profile, UiRequest, Viewport,
};

use crate::keys;
use crate::present::Presented;

const SHUTDOWN_DEADLINE: Duration = Duration::from_secs(2);
const LOAD_DELAY: Duration = Duration::from_secs(10);

pub struct GameWindow {
    engine: Engine,
    profile: Profile,
    host: Option<PlayerHost>,
    input: InputSink,
    presented: Presented,
    boot: Boot,
    load_delayed: bool,
    focus: FocusHandle,
    viewport: Rc<Cell<Viewport>>,
    modifiers: gpui::Modifiers,
    composing: Option<Range<usize>>,
    cursor: CursorStyle,
    _tasks: Vec<Task<()>>,
}

impl GameWindow {
    pub fn new(
        engine: Engine,
        profile: Profile,
        host: PlayerHost,
        presentation: Presentation,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let this = cx.entity().downgrade();
        window.on_window_should_close(cx, move |_, cx| {
            this.update(cx, |view, cx| view.close(cx)).unwrap_or(true)
        });
        let focus = cx.focus_handle();
        focus.focus(window, cx);
        let mut view = Self {
            engine,
            profile,
            input: host.input().clone(),
            boot: host.session().status().boot,
            load_delayed: false,
            host: None,
            presented: Presented::default(),
            focus,
            viewport: Rc::new(Cell::new(Viewport::AUTHORED)),
            modifiers: gpui::Modifiers::default(),
            composing: None,
            cursor: CursorStyle::Arrow,
            _tasks: Vec::new(),
        };
        view.attach(host, presentation, cx);
        view
    }

    fn attach(&mut self, host: PlayerHost, presentation: Presentation, cx: &mut Context<Self>) {
        let Presentation { frames, ui } = presentation;
        let frame_task = cx.spawn(async move |this, cx| {
            while let Some(frame) = frames.next().await {
                let presented = this.update(cx, |view, cx| {
                    view.presented.replace(frame);
                    cx.notify();
                });
                if presented.is_err() {
                    break;
                }
            }
        });
        let ui_task = cx.spawn(async move |this, cx| {
            while let Some(request) = ui.next().await {
                if this.update(cx, |view, cx| view.apply(request, cx)).is_err() {
                    break;
                }
            }
        });
        let mut changes = host.session().status_changes();
        let status_task = cx.spawn(async move |this, cx| {
            while let Ok(status) = changes.changed().await {
                if this
                    .update(cx, |view, cx| {
                        view.boot = status.boot;
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        });
        let delay_task = cx.spawn(async move |this, cx| {
            cx.background_executor().timer(LOAD_DELAY).await;
            let _ = this.update(cx, |view, cx| {
                view.load_delayed = true;
                cx.notify();
            });
        });
        self.input = host.input().clone();
        self.boot = host.session().status().boot;
        self.load_delayed = false;
        self.host = Some(host);
        self._tasks = vec![frame_task, ui_task, status_task, delay_task];
        self.viewport.set(Viewport::AUTHORED);
        cx.notify();
    }

    fn reload(&mut self, cx: &mut Context<Self>) {
        if let Some(host) = self.host.take() {
            cx.background_executor()
                .spawn(async move { host.shutdown(Instant::now() + SHUTDOWN_DEADLINE) })
                .detach();
        }
        match PlayerHost::spawn(&self.engine, PlayerConfig::launcher(self.profile.clone())) {
            Ok((host, presentation)) => self.attach(host, presentation, cx),
            Err(error) => {
                tracing::error!(%error, "could not restart the player thread");
                self.boot = Boot::Failed {
                    error: error.to_string(),
                };
                cx.notify();
            }
        }
    }

    pub fn close(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(host) = self.host.take() else {
            return false;
        };
        let shutdown = cx
            .background_executor()
            .spawn(async move { host.shutdown(Instant::now() + SHUTDOWN_DEADLINE) });
        cx.spawn(async move |_, cx| {
            let report = shutdown.await;
            tracing::info!(?report, "player stopped");
            cx.update(|cx| cx.quit());
        })
        .detach();
        false
    }

    fn apply(&mut self, request: UiRequest, cx: &mut Context<Self>) {
        match request {
            UiRequest::Cursor(cursor) => {
                self.cursor = match cursor {
                    MouseCursor::Arrow => CursorStyle::Arrow,
                    MouseCursor::Hand => CursorStyle::PointingHand,
                    MouseCursor::IBeam => CursorStyle::IBeam,
                    MouseCursor::Grab => CursorStyle::ClosedHand,
                };
                cx.notify();
            }
            UiRequest::CursorVisible(visible) => {
                tracing::debug!(
                    visible,
                    "the game changed cursor visibility, which the window does not support"
                );
            }
            UiRequest::SetClipboard(text) => cx.write_to_clipboard(ClipboardItem::new_string(text)),
            UiRequest::OpenUrl(url) => cx.open_url(url.as_str()),
        }
    }

    fn key_down(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) {
        self.input.send(PlayerEvent::KeyDown {
            key: keys::descriptor(&event.keystroke),
        });
        match keys::text_control(&event.keystroke) {
            Some(TextControlCode::Paste) => {
                let text = cx
                    .read_from_clipboard()
                    .and_then(|item| item.text())
                    .unwrap_or_default();
                self.input.paste(text);
            }
            Some(code) => self.input.send(PlayerEvent::TextControl { code }),
            None => {}
        }
    }

    fn key_up(&mut self, event: &KeyUpEvent) {
        self.input.send(PlayerEvent::KeyUp {
            key: keys::descriptor(&event.keystroke),
        });
    }

    fn modifiers_changed(&mut self, event: &ModifiersChangedEvent) {
        let before = keys::modifier_keys(&self.modifiers);
        let after = keys::modifier_keys(&event.modifiers);
        for ((was, _), (is, key)) in before.into_iter().zip(after) {
            match (was, is) {
                (false, true) => self.input.send(PlayerEvent::KeyDown { key }),
                (true, false) => self.input.send(PlayerEvent::KeyUp { key }),
                _ => {}
            }
        }
        self.modifiers = event.modifiers;
    }

    fn release_input(&mut self) {
        for (held, key) in keys::modifier_keys(&self.modifiers) {
            if held {
                self.input.send(PlayerEvent::KeyUp { key });
            }
        }
        self.modifiers = gpui::Modifiers::default();
        self.input.send(PlayerEvent::FocusLost);
    }
}

fn game_button(button: MouseButton) -> GameButton {
    match button {
        MouseButton::Left => GameButton::Left,
        MouseButton::Right => GameButton::Right,
        MouseButton::Middle => GameButton::Middle,
        _ => GameButton::Unknown,
    }
}

fn physical(position: Point<Pixels>, bounds: Bounds<Pixels>, scale: f32) -> (f64, f64) {
    let x = f32::from(position.x - bounds.origin.x) * scale;
    let y = f32::from(position.y - bounds.origin.y) * scale;
    (f64::from(x), f64::from(y))
}

impl Render for GameWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.presented.retire(window);
        let image = self.presented.image();
        let input = self.input.clone();
        let viewport = self.viewport.clone();
        let focus = self.focus.clone();
        let cursor = self.cursor;
        let entity = cx.entity();
        let game = canvas(
            move |bounds, window, _| {
                let scale = window.scale_factor();
                let size = Viewport {
                    width: (f32::from(bounds.size.width) * scale).round().max(1.0) as u32,
                    height: (f32::from(bounds.size.height) * scale).round().max(1.0) as u32,
                    scale: f64::from(scale),
                };
                if viewport.get() != size {
                    viewport.set(size);
                    input.resize(size);
                }
                (window.insert_hitbox(bounds, HitboxBehavior::Normal), input)
            },
            move |bounds, (hitbox, input), window, cx| {
                if let Some(image) = image {
                    let _ = window.paint_image(bounds, Corners::default(), image, 0, false);
                }
                window.set_cursor_style(cursor, &hitbox);
                window.handle_input(&focus, ElementInputHandler::new(bounds, entity), cx);
                let scale = window.scale_factor();
                window.on_mouse_event({
                    let (input, hitbox) = (input.clone(), hitbox.clone());
                    move |event: &MouseDownEvent, phase, window, _| {
                        if phase == DispatchPhase::Bubble && hitbox.is_hovered(window) {
                            let (x, y) = physical(event.position, bounds, scale);
                            input.send(PlayerEvent::MouseDown {
                                x,
                                y,
                                button: game_button(event.button),
                                index: None,
                            });
                        }
                    }
                });
                window.on_mouse_event({
                    let input = input.clone();
                    move |event: &MouseUpEvent, phase, _, _| {
                        if phase == DispatchPhase::Bubble {
                            let (x, y) = physical(event.position, bounds, scale);
                            input.send(PlayerEvent::MouseUp {
                                x,
                                y,
                                button: game_button(event.button),
                            });
                        }
                    }
                });
                window.on_mouse_event({
                    let (input, hitbox) = (input.clone(), hitbox.clone());
                    move |event: &MouseMoveEvent, phase, window, _| {
                        if phase == DispatchPhase::Bubble
                            && (hitbox.is_hovered(window) || event.pressed_button.is_some())
                        {
                            let (x, y) = physical(event.position, bounds, scale);
                            input.send(PlayerEvent::MouseMove { x, y });
                        }
                    }
                });
                window.on_mouse_event({
                    let (input, hitbox) = (input.clone(), hitbox.clone());
                    move |event: &ScrollWheelEvent, phase, window, _| {
                        if phase == DispatchPhase::Bubble && hitbox.is_hovered(window) {
                            let delta = match event.delta {
                                ScrollDelta::Lines(lines) => {
                                    MouseWheelDelta::Lines(f64::from(lines.y))
                                }
                                ScrollDelta::Pixels(pixels) => {
                                    MouseWheelDelta::Pixels(f64::from(f32::from(pixels.y) * scale))
                                }
                            };
                            input.send(PlayerEvent::MouseWheel { delta });
                        }
                    }
                });
                window.on_mouse_event(move |_: &MouseExitEvent, phase, _, _: &mut App| {
                    if phase == DispatchPhase::Bubble {
                        input.send(PlayerEvent::MouseLeave);
                    }
                });
            },
        )
        .size_full();
        div()
            .relative()
            .size_full()
            .bg(rgb(0x000000))
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|view, event, _, cx| view.key_down(event, cx)))
            .on_key_up(cx.listener(|view, event, _, _| view.key_up(event)))
            .on_modifiers_changed(cx.listener(|view, event, _, _| view.modifiers_changed(event)))
            .child(game)
            .when_some(overlay(&self.boot, self.load_delayed), |root, overlay| {
                let reload = overlay.offers_reload.then(|| {
                    div()
                        .id("reload-game")
                        .mt_3()
                        .px_3()
                        .py_1()
                        .rounded_md()
                        .border_1()
                        .border_color(rgb(0x52525b))
                        .cursor_pointer()
                        .hover(|style| style.bg(rgb(0x27272a)))
                        .child("Reload game")
                        .on_click(cx.listener(|view, _, _, cx| view.reload(cx)))
                });
                root.child(
                    div()
                        .absolute()
                        .inset_0()
                        .occlude()
                        .flex()
                        .flex_col()
                        .items_center()
                        .justify_center()
                        .gap_1()
                        .bg(rgb(0x000000))
                        .text_color(rgb(0xd4d4d8))
                        .text_size(px(14.))
                        .child(overlay.title)
                        .children(overlay.detail)
                        .children(reload),
                )
            })
    }
}

struct Overlay {
    title: String,
    detail: Option<&'static str>,
    offers_reload: bool,
}

fn overlay(boot: &Boot, delayed: bool) -> Option<Overlay> {
    let loading = |title: String| {
        if delayed {
            Overlay {
                title: "Still loading...".into(),
                detail: Some(
                    "The game is taking longer than expected. You can keep waiting or reload it.",
                ),
                offers_reload: true,
            }
        } else {
            Overlay {
                title,
                detail: None,
                offers_reload: false,
            }
        }
    };
    Some(match boot {
        Boot::Ready => return None,
        Boot::Starting => loading("Loading".into()),
        Boot::Downloading { percent } => loading(format!("Loading {percent}%")),
        Boot::Failed { error } => Overlay {
            title: format!("The game could not start: {error}"),
            detail: None,
            offers_reload: true,
        },
        Boot::Stopping => Overlay {
            title: "Closing".into(),
            detail: None,
            offers_reload: false,
        },
    })
}

impl EntityInputHandler for GameWindow {
    fn text_for_range(
        &mut self,
        _: Range<usize>,
        _: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        None
    }

    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: 0..0,
            reversed: false,
        })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.composing.clone()
    }

    fn unmark_text(&mut self, _: &mut Window, _: &mut Context<Self>) {
        if self.composing.take().is_some() {
            self.input
                .send(PlayerEvent::Ime(ImeEvent::Preedit(String::new(), None)));
        }
    }

    fn replace_text_in_range(
        &mut self,
        _: Option<Range<usize>>,
        text: &str,
        _: &mut Window,
        _: &mut Context<Self>,
    ) {
        if self.composing.take().is_some() {
            self.input
                .send(PlayerEvent::Ime(ImeEvent::Commit(text.to_owned())));
            return;
        }
        // Control characters arrive as key downs and text controls, so inserting them too would repeat them.
        for codepoint in text.chars().filter(|character| !character.is_control()) {
            self.input.send(PlayerEvent::TextInput { codepoint });
        }
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        _: Option<Range<usize>>,
        text: &str,
        selected: Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) {
        let length = text.encode_utf16().count();
        self.composing = (length > 0).then_some(0..length);
        let cursor = selected.map(|range| (range.start, range.end));
        self.input
            .send(PlayerEvent::Ime(ImeEvent::Preedit(text.to_owned(), cursor)));
    }

    fn bounds_for_range(
        &mut self,
        _: Range<usize>,
        element_bounds: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        Some(element_bounds)
    }

    fn character_index_for_point(
        &mut self,
        _: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        None
    }
}

pub fn observe_focus(view: &gpui::Entity<GameWindow>, window: &mut Window, cx: &mut App) {
    let focus = view.read(cx).focus.clone();
    let view = view.downgrade();
    window
        .on_focus_out(&focus, cx, move |_, _, cx| {
            let _ = view.update(cx, |view, _| view.release_input());
        })
        .detach();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shown(boot: Boot, delayed: bool) -> Option<(String, bool)> {
        overlay(&boot, delayed).map(|overlay| (overlay.title, overlay.offers_reload))
    }

    #[test]
    fn offers_a_reload_once_loading_is_slow_or_has_failed() {
        assert_eq!(
            shown(Boot::Downloading { percent: 40 }, false),
            Some(("Loading 40%".into(), false))
        );
        assert_eq!(
            shown(Boot::Downloading { percent: 40 }, true),
            Some(("Still loading...".into(), true))
        );
        assert_eq!(
            shown(Boot::Starting, true),
            Some(("Still loading...".into(), true))
        );
        assert_eq!(
            shown(
                Boot::Failed {
                    error: "offline".into()
                },
                false
            ),
            Some(("The game could not start: offline".into(), true))
        );
        assert_eq!(shown(Boot::Stopping, true), Some(("Closing".into(), false)));
        assert_eq!(shown(Boot::Ready, true), None);
    }
}
