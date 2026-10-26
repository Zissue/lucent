mod button;
mod text_input;

use gpui::{App, Global};

pub use button::button;
pub use text_input::{TextInput, TextInputEvent};

pub const BACKGROUND: u32 = 0x09090b;
pub const PANEL: u32 = 0x18181b;
pub const BORDER: u32 = 0x27272a;
pub const BORDER_STRONG: u32 = 0x3f3f46;
pub const TEXT: u32 = 0xd4d4d8;
pub const MUTED: u32 = 0xa1a1aa;
pub const ACCENT: u32 = 0x6366f1;
pub const DANGER: u32 = 0xf87171;

struct Initialized;

impl Global for Initialized {}

pub fn init(cx: &mut App) {
    if cx.has_global::<Initialized>() {
        return;
    }
    cx.set_global(Initialized);
    text_input::bind_keys(cx);
}
