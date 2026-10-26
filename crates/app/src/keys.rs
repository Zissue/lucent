use gpui::{Keystroke, Modifiers};
use ruffle_host::ruffle::{
    KeyDescriptor, KeyLocation, LogicalKey, NamedKey, PhysicalKey, TextControlCode,
};

pub fn descriptor(keystroke: &Keystroke) -> KeyDescriptor {
    let logical = logical_key(keystroke);
    KeyDescriptor {
        physical_key: physical_key(&keystroke.key, logical),
        logical_key: logical,
        key_location: KeyLocation::Standard,
    }
}

fn logical_key(keystroke: &Keystroke) -> LogicalKey {
    let typed = keystroke.key_char.as_deref().and_then(single_printable);
    if let Some(character) = typed.or_else(|| single_printable(&keystroke.key)) {
        return LogicalKey::Character(character);
    }
    let named = match keystroke.key.as_str() {
        "space" => return LogicalKey::Character(' '),
        "enter" => NamedKey::Enter,
        "tab" => NamedKey::Tab,
        "backspace" => NamedKey::Backspace,
        "escape" => NamedKey::Escape,
        "delete" => NamedKey::Delete,
        "insert" => NamedKey::Insert,
        "home" => NamedKey::Home,
        "end" => NamedKey::End,
        "pageup" => NamedKey::PageUp,
        "pagedown" => NamedKey::PageDown,
        "up" => NamedKey::ArrowUp,
        "down" => NamedKey::ArrowDown,
        "left" => NamedKey::ArrowLeft,
        "right" => NamedKey::ArrowRight,
        key => match function_key(key) {
            Some(named) => named,
            None => return LogicalKey::Unknown,
        },
    };
    LogicalKey::Named(named)
}

fn single_printable(text: &str) -> Option<char> {
    let mut chars = text.chars();
    match (chars.next(), chars.next()) {
        (Some(character), None) if !character.is_control() && character != ' ' => Some(character),
        _ => None,
    }
}

fn function_key(key: &str) -> Option<NamedKey> {
    const KEYS: [NamedKey; 24] = [
        NamedKey::F1,
        NamedKey::F2,
        NamedKey::F3,
        NamedKey::F4,
        NamedKey::F5,
        NamedKey::F6,
        NamedKey::F7,
        NamedKey::F8,
        NamedKey::F9,
        NamedKey::F10,
        NamedKey::F11,
        NamedKey::F12,
        NamedKey::F13,
        NamedKey::F14,
        NamedKey::F15,
        NamedKey::F16,
        NamedKey::F17,
        NamedKey::F18,
        NamedKey::F19,
        NamedKey::F20,
        NamedKey::F21,
        NamedKey::F22,
        NamedKey::F23,
        NamedKey::F24,
    ];
    let number: usize = key.strip_prefix('f')?.parse().ok()?;
    KEYS.get(number.checked_sub(1)?).copied()
}

fn physical_key(key: &str, logical: LogicalKey) -> PhysicalKey {
    match logical {
        LogicalKey::Character(character) => character_key(character.to_ascii_lowercase()),
        LogicalKey::Named(named) => match named {
            NamedKey::Enter => PhysicalKey::Enter,
            NamedKey::Tab => PhysicalKey::Tab,
            NamedKey::Backspace => PhysicalKey::Backspace,
            NamedKey::Escape => PhysicalKey::Escape,
            NamedKey::Delete => PhysicalKey::Delete,
            NamedKey::Insert => PhysicalKey::Insert,
            NamedKey::Home => PhysicalKey::Home,
            NamedKey::End => PhysicalKey::End,
            NamedKey::PageUp => PhysicalKey::PageUp,
            NamedKey::PageDown => PhysicalKey::PageDown,
            NamedKey::ArrowUp => PhysicalKey::ArrowUp,
            NamedKey::ArrowDown => PhysicalKey::ArrowDown,
            NamedKey::ArrowLeft => PhysicalKey::ArrowLeft,
            NamedKey::ArrowRight => PhysicalKey::ArrowRight,
            _ => function_physical(key),
        },
        LogicalKey::Unknown => PhysicalKey::Unknown,
    }
}

fn function_physical(key: &str) -> PhysicalKey {
    const KEYS: [PhysicalKey; 12] = [
        PhysicalKey::F1,
        PhysicalKey::F2,
        PhysicalKey::F3,
        PhysicalKey::F4,
        PhysicalKey::F5,
        PhysicalKey::F6,
        PhysicalKey::F7,
        PhysicalKey::F8,
        PhysicalKey::F9,
        PhysicalKey::F10,
        PhysicalKey::F11,
        PhysicalKey::F12,
    ];
    key.strip_prefix('f')
        .and_then(|number| number.parse::<usize>().ok())
        .and_then(|number| KEYS.get(number.checked_sub(1)?).copied())
        .unwrap_or(PhysicalKey::Unknown)
}

fn character_key(character: char) -> PhysicalKey {
    const LETTERS: [PhysicalKey; 26] = [
        PhysicalKey::KeyA,
        PhysicalKey::KeyB,
        PhysicalKey::KeyC,
        PhysicalKey::KeyD,
        PhysicalKey::KeyE,
        PhysicalKey::KeyF,
        PhysicalKey::KeyG,
        PhysicalKey::KeyH,
        PhysicalKey::KeyI,
        PhysicalKey::KeyJ,
        PhysicalKey::KeyK,
        PhysicalKey::KeyL,
        PhysicalKey::KeyM,
        PhysicalKey::KeyN,
        PhysicalKey::KeyO,
        PhysicalKey::KeyP,
        PhysicalKey::KeyQ,
        PhysicalKey::KeyR,
        PhysicalKey::KeyS,
        PhysicalKey::KeyT,
        PhysicalKey::KeyU,
        PhysicalKey::KeyV,
        PhysicalKey::KeyW,
        PhysicalKey::KeyX,
        PhysicalKey::KeyY,
        PhysicalKey::KeyZ,
    ];
    const DIGITS: [PhysicalKey; 10] = [
        PhysicalKey::Digit0,
        PhysicalKey::Digit1,
        PhysicalKey::Digit2,
        PhysicalKey::Digit3,
        PhysicalKey::Digit4,
        PhysicalKey::Digit5,
        PhysicalKey::Digit6,
        PhysicalKey::Digit7,
        PhysicalKey::Digit8,
        PhysicalKey::Digit9,
    ];
    match character {
        'a'..='z' => LETTERS[(character as u8 - b'a') as usize],
        '0'..='9' => DIGITS[(character as u8 - b'0') as usize],
        ' ' => PhysicalKey::Space,
        '`' => PhysicalKey::Backquote,
        '-' => PhysicalKey::Minus,
        '=' => PhysicalKey::Equal,
        '[' => PhysicalKey::BracketLeft,
        ']' => PhysicalKey::BracketRight,
        '\\' => PhysicalKey::Backslash,
        ';' => PhysicalKey::Semicolon,
        '\'' => PhysicalKey::Quote,
        ',' => PhysicalKey::Comma,
        '.' => PhysicalKey::Period,
        '/' => PhysicalKey::Slash,
        _ => PhysicalKey::Unknown,
    }
}

pub fn modifier_keys(modifiers: &Modifiers) -> [(bool, KeyDescriptor); 4] {
    let key = |physical_key, named| KeyDescriptor {
        physical_key,
        logical_key: LogicalKey::Named(named),
        key_location: KeyLocation::Left,
    };
    [
        (
            modifiers.shift,
            key(PhysicalKey::ShiftLeft, NamedKey::Shift),
        ),
        (
            modifiers.control,
            key(PhysicalKey::ControlLeft, NamedKey::Control),
        ),
        (modifiers.alt, key(PhysicalKey::AltLeft, NamedKey::Alt)),
        (
            modifiers.platform,
            key(PhysicalKey::SuperLeft, NamedKey::Super),
        ),
    ]
}

pub fn text_control(keystroke: &Keystroke) -> Option<TextControlCode> {
    let shift = keystroke.modifiers.shift;
    let command =
        keystroke.modifiers.control || (cfg!(target_os = "macos") && keystroke.modifiers.platform);
    Some(match keystroke.key.as_str() {
        "enter" => TextControlCode::Enter,
        "a" if command => TextControlCode::SelectAll,
        "c" if command => TextControlCode::Copy,
        "v" if command => TextControlCode::Paste,
        "x" if command => TextControlCode::Cut,
        "backspace" if command => TextControlCode::BackspaceWord,
        "backspace" => TextControlCode::Backspace,
        "delete" if command => TextControlCode::DeleteWord,
        "delete" => TextControlCode::Delete,
        "left" if command && shift => TextControlCode::SelectLeftWord,
        "left" if command => TextControlCode::MoveLeftWord,
        "left" if shift => TextControlCode::SelectLeft,
        "left" => TextControlCode::MoveLeft,
        "right" if command && shift => TextControlCode::SelectRightWord,
        "right" if command => TextControlCode::MoveRightWord,
        "right" if shift => TextControlCode::SelectRight,
        "right" => TextControlCode::MoveRight,
        "home" if command && shift => TextControlCode::SelectLeftDocument,
        "home" if command => TextControlCode::MoveLeftDocument,
        "home" if shift => TextControlCode::SelectLeftLine,
        "home" => TextControlCode::MoveLeftLine,
        "end" if command && shift => TextControlCode::SelectRightDocument,
        "end" if command => TextControlCode::MoveRightDocument,
        "end" if shift => TextControlCode::SelectRightLine,
        "end" => TextControlCode::MoveRightLine,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keystroke(text: &str) -> Keystroke {
        Keystroke::parse(text).unwrap()
    }

    #[test]
    fn maps_typed_characters_to_their_character_and_us_physical_key() {
        let mut shifted = keystroke("shift-a");
        shifted.key_char = Some("A".into());
        assert_eq!(descriptor(&shifted).logical_key, LogicalKey::Character('A'));
        assert_eq!(descriptor(&shifted).physical_key, PhysicalKey::KeyA);
        assert_eq!(
            descriptor(&keystroke("7")).physical_key,
            PhysicalKey::Digit7
        );
        assert_eq!(
            descriptor(&keystroke("space")).logical_key,
            LogicalKey::Character(' ')
        );
        assert_eq!(
            descriptor(&keystroke("space")).physical_key,
            PhysicalKey::Space
        );
    }

    #[test]
    fn maps_named_and_function_keys() {
        assert_eq!(
            descriptor(&keystroke("enter")).logical_key,
            LogicalKey::Named(NamedKey::Enter)
        );
        assert_eq!(
            descriptor(&keystroke("left")).physical_key,
            PhysicalKey::ArrowLeft
        );
        assert_eq!(
            descriptor(&keystroke("f12")).logical_key,
            LogicalKey::Named(NamedKey::F12)
        );
        assert_eq!(descriptor(&keystroke("f12")).physical_key, PhysicalKey::F12);
        assert_eq!(
            descriptor(&keystroke("f13")).physical_key,
            PhysicalKey::Unknown
        );
    }

    #[test]
    fn maps_editing_shortcuts_to_text_controls() {
        let paste = if cfg!(target_os = "macos") {
            "cmd-v"
        } else {
            "ctrl-v"
        };
        assert_eq!(
            text_control(&keystroke(paste)),
            Some(TextControlCode::Paste)
        );
        assert_eq!(
            text_control(&keystroke("shift-left")),
            Some(TextControlCode::SelectLeft)
        );
        assert_eq!(
            text_control(&keystroke("backspace")),
            Some(TextControlCode::Backspace)
        );
        assert_eq!(text_control(&keystroke("v")), None);
    }
}
