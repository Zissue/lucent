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
use ruffle_host::{InputSink, PlayerHost, Presentation, UiRequest, Viewport};

use crate::keys;
use crate::present::Presented;

const SHUTDOWN_DEADLINE: Duration = Duration::from_secs(2);

pub struct GameWindow {
    host: Option<PlayerHost>,
    input: InputSink,
    presented: Presented,
    boot: Boot,
    focus: FocusHandle,
    viewport: Rc<Cell<Viewport>>,
    modifiers: gpui::Modifiers,
    composing: Option<Range<usize>>,
    cursor: CursorStyle,
    _tasks: Vec<Task<()>>,
}

impl GameWindow {
    pub fn new(
        host: PlayerHost,
        presentation: Presentation,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
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
        let this = cx.entity().downgrade();
        window.on_window_should_close(cx, move |_, cx| {
            this.update(cx, |view, cx| view.close(cx)).unwrap_or(true)
        });
        let focus = cx.focus_handle();
        focus.focus(window, cx);
        Self {
            input: host.input().clone(),
            boot: host.session().status().boot,
            host: Some(host),
            presented: Presented::default(),
            focus,
            viewport: Rc::new(Cell::new(Viewport::AUTHORED)),
            modifiers: gpui::Modifiers::default(),
            composing: None,
            cursor: CursorStyle::Arrow,
            _tasks: vec![frame_task, ui_task, status_task],
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
            .when_some(overlay_text(&self.boot), |root, text| {
                root.child(
                    div()
                        .absolute()
                        .inset_0()
                        .occlude()
                        .flex()
                        .items_center()
                        .justify_center()
                        .bg(rgb(0x000000))
                        .text_color(rgb(0xd4d4d8))
                        .text_size(px(14.))
                        .child(text),
                )
            })
    }
}

fn overlay_text(boot: &Boot) -> Option<String> {
    match boot {
        Boot::Ready => None,
        Boot::Starting => Some("Loading".into()),
        Boot::Downloading { percent } => Some(format!("Loading {percent}%")),
        Boot::Failed { error } => Some(format!("The game could not start: {error}")),
        Boot::Stopping => Some("Closing".into()),
    }
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
