use gpui::{App, ClickEvent, ElementId, SharedString, Window, div, prelude::*, px, rgb};

use super::{ACCENT, BORDER_STRONG, DANGER, PANEL, TEXT};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Secondary,
    Primary,
    Danger,
}

type ClickHandler = Box<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct Button {
    id: ElementId,
    label: SharedString,
    kind: Kind,
    disabled: bool,
    on_click: Option<ClickHandler>,
}

pub fn button(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Button {
    Button {
        id: id.into(),
        label: label.into(),
        kind: Kind::Secondary,
        disabled: false,
        on_click: None,
    }
}

impl Button {
    pub fn primary(mut self) -> Self {
        self.kind = Kind::Primary;
        self
    }

    pub fn danger(mut self) -> Self {
        self.kind = Kind::Danger;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Box::new(handler));
        self
    }
}

impl RenderOnce for Button {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let (background, hover, border, text) = match self.kind {
            Kind::Secondary => (PANEL, 0x27272a, BORDER_STRONG, TEXT),
            Kind::Primary => (ACCENT, 0x4f46e5, ACCENT, 0xffffff),
            Kind::Danger => (0x450a0a, 0x7f1d1d, 0x7f1d1d, DANGER),
        };
        let enabled = !self.disabled;
        div()
            .id(self.id)
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .h(px(28.))
            .px_3()
            .rounded_md()
            .border_1()
            .border_color(rgb(border))
            .bg(rgb(background))
            .text_color(rgb(text))
            .text_size(px(13.))
            .whitespace_nowrap()
            .child(self.label)
            .when(self.disabled, |this| this.opacity(0.45))
            .when(enabled, |this| {
                this.cursor_pointer().hover(|style| style.bg(rgb(hover)))
            })
            .when_some(self.on_click.filter(|_| enabled), |this, handler| {
                this.on_click(handler)
            })
    }
}
