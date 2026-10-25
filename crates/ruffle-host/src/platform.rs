use std::any::Any;
use std::time::Duration;

use async_channel::Sender;
use bridge::{GameEvent, Lifecycle};
use ruffle_core::events::{PlayerEvent, TextControlCode};
use ruffle_core::{Player, PlayerBuilder};
use ruffle_frontend_utils::backends::audio::CpalAudioBackend;

use crate::host::ShutdownReport;
use crate::player_loop::{self, PlayerInit};
use crate::{LucentUi, Profile, ProfileLease, UiRequest};

pub(crate) struct PlatformConfig {
    pub(crate) profile: Profile,
    pub(crate) ui: Sender<UiRequest>,
}

pub(crate) fn run(mut init: PlayerInit) -> ShutdownReport {
    let mut lease = match ProfileLease::acquire(&init.platform.profile) {
        Ok(lease) => lease,
        Err(error) => {
            tracing::error!(%error, "could not acquire game profile storage");
            init.side
                .events
                .publish(GameEvent::Lifecycle(Lifecycle::Failed {
                    error: error.to_string(),
                }));
            return ShutdownReport::clean(Duration::ZERO, 0, 0);
        }
    };
    player_loop::run(init, &mut lease)
}

pub(crate) fn builder(lease: &mut ProfileLease, ui: Sender<UiRequest>) -> PlayerBuilder {
    let builder = PlayerBuilder::new()
        .with_storage(lease.take_storage())
        .with_ui(LucentUi::new(ui));
    match CpalAudioBackend::new(None) {
        Ok(audio) => builder.with_audio(audio),
        Err(error) => {
            tracing::warn!(%error, "could not start game audio");
            builder
        }
    }
}

pub(crate) fn paste(player: &mut Player, text: String) {
    let ui = player.ui_mut() as &mut dyn Any;
    ui.downcast_mut::<LucentUi>()
        .expect("the player uses LucentUi")
        .set_paste(text);
    player.handle_event(PlayerEvent::TextControl {
        code: TextControlCode::Paste,
    });
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use ruffle_core::PlayerBuilder;

    use crate::doorbell::Doorbell;
    use crate::input::{Command, InputSink};
    use crate::{LucentUi, platform, ui};

    #[test]
    fn paste_hands_the_window_text_to_the_player_ui() {
        let (tx, commands) = mpsc::channel();
        let input = InputSink {
            tx,
            doorbell: Doorbell::new(),
        };
        let (sender, _requests) = ui::channel();
        let player = PlayerBuilder::new().with_ui(LucentUi::new(sender)).build();
        let mut player = player.lock().unwrap();

        for expected in ["window clipboard", "next paste", ""] {
            input.paste(expected.into());
            let Command::Paste(text) = commands.try_recv().unwrap() else {
                panic!("expected a paste command");
            };
            platform::paste(&mut player, text);
            assert_eq!(player.ui_mut().clipboard_content(), expected);
        }
    }
}
