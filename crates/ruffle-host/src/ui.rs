use async_channel::{Receiver, Sender};
use ruffle_core::backend::ui::{
    DialogResultFuture, FileDialogResult, FileFilter, FontDefinition, FullscreenError,
    LanguageIdentifier, MouseCursor, MultiDialogResultFuture, MultiFileDialogResult, US_ENGLISH,
    UiBackend,
};
use ruffle_core::font::FontQuery;
use url::Url;

#[derive(Debug, PartialEq, Eq)]
pub enum UiRequest {
    Cursor(MouseCursor),
    CursorVisible(bool),
    SetClipboard(String),
    OpenUrl(Url),
}

pub struct UiRequests {
    receiver: Receiver<UiRequest>,
}

impl UiRequests {
    pub async fn next(&self) -> Option<UiRequest> {
        self.receiver.recv().await.ok()
    }
}

pub(crate) fn channel() -> (Sender<UiRequest>, UiRequests) {
    let (sender, receiver) = async_channel::unbounded();
    (sender, UiRequests { receiver })
}

pub struct LucentUi {
    requests: Sender<UiRequest>,
    paste: String,
    mouse_visible: bool,
}

impl LucentUi {
    pub fn new(requests: Sender<UiRequest>) -> Self {
        Self {
            requests,
            paste: String::new(),
            mouse_visible: true,
        }
    }

    pub(crate) fn set_paste(&mut self, text: String) {
        self.paste = text;
    }
}

impl UiBackend for LucentUi {
    fn mouse_visible(&self) -> bool {
        self.mouse_visible
    }

    fn set_mouse_visible(&mut self, visible: bool) {
        self.mouse_visible = visible;
        let _ = self.requests.try_send(UiRequest::CursorVisible(visible));
    }

    fn set_mouse_cursor(&mut self, cursor: MouseCursor) {
        let _ = self.requests.try_send(UiRequest::Cursor(cursor));
    }

    fn clipboard_content(&mut self) -> String {
        self.paste.clone()
    }

    fn set_clipboard_content(&mut self, content: String) {
        let _ = self.requests.try_send(UiRequest::SetClipboard(content));
    }

    fn set_fullscreen(&mut self, _is_full: bool) -> Result<(), FullscreenError> {
        Ok(())
    }

    fn display_root_movie_download_failed_message(&self, _invalid_swf: bool, _fetch_error: String) {
    }

    fn message(&self, _message: &str) {}

    fn open_virtual_keyboard(&self) {}

    fn close_virtual_keyboard(&self) {}

    fn language(&self) -> LanguageIdentifier {
        US_ENGLISH.clone()
    }

    fn display_unsupported_video(&self, _url: Url) {}

    fn load_device_font(&self, _query: &FontQuery, _register: &mut dyn FnMut(FontDefinition)) {}

    fn sort_device_fonts(
        &self,
        _query: &FontQuery,
        _register: &mut dyn FnMut(FontDefinition),
    ) -> Vec<FontQuery> {
        Vec::new()
    }

    fn display_file_open_dialog(
        &mut self,
        _filters: Vec<FileFilter>,
    ) -> Option<DialogResultFuture> {
        Some(Box::pin(async { Ok(FileDialogResult::Canceled) }))
    }

    fn display_file_open_dialog_multiple(
        &mut self,
        _filters: Vec<FileFilter>,
    ) -> Option<MultiDialogResultFuture> {
        Some(Box::pin(async { Ok(MultiFileDialogResult::Canceled) }))
    }

    fn display_file_save_dialog(
        &mut self,
        _file_name: String,
        _title: String,
    ) -> Option<DialogResultFuture> {
        None
    }

    fn close_file_dialog(&mut self) {}
}

#[cfg(test)]
mod tests {
    use futures::executor::block_on;

    use super::*;

    #[test]
    fn cursor_requests_preserve_each_cursor() {
        let (sender, requests) = channel();
        let mut ui = LucentUi::new(sender);

        for cursor in [
            MouseCursor::Arrow,
            MouseCursor::Hand,
            MouseCursor::IBeam,
            MouseCursor::Grab,
        ] {
            ui.set_mouse_cursor(cursor);
            assert_eq!(block_on(requests.next()), Some(UiRequest::Cursor(cursor)));
        }
    }

    #[test]
    fn visibility_requests_update_the_reported_visibility() {
        let (sender, requests) = channel();
        let mut ui = LucentUi::new(sender);
        assert!(ui.mouse_visible());

        ui.set_mouse_visible(false);
        assert!(!ui.mouse_visible());
        assert_eq!(
            block_on(requests.next()),
            Some(UiRequest::CursorVisible(false))
        );

        ui.set_mouse_visible(true);
        assert!(ui.mouse_visible());
        assert_eq!(
            block_on(requests.next()),
            Some(UiRequest::CursorVisible(true))
        );
    }

    #[test]
    fn copied_text_is_requested_without_changing_the_paste_text() {
        let (sender, requests) = channel();
        let mut ui = LucentUi::new(sender);
        assert!(!ui.clipboard_available());

        ui.set_paste("paste from window".into());
        assert!(ui.clipboard_available());
        ui.set_clipboard_content("copy from movie".into());

        assert_eq!(
            block_on(requests.next()),
            Some(UiRequest::SetClipboard("copy from movie".into()))
        );
        assert_eq!(ui.clipboard_content(), "paste from window");

        ui.set_paste(String::new());
        assert!(!ui.clipboard_available());
    }

    #[test]
    fn request_stream_delivers_urls_and_finishes_when_senders_close() {
        let (sender, requests) = channel();
        let url = Url::parse("https://www.aq.com/").unwrap();
        sender.try_send(UiRequest::OpenUrl(url.clone())).unwrap();
        drop(sender);

        assert_eq!(block_on(requests.next()), Some(UiRequest::OpenUrl(url)));
        assert_eq!(block_on(requests.next()), None);
    }

    #[test]
    fn unsupported_dialogs_and_fullscreen_match_the_null_backend() {
        let (sender, _requests) = channel();
        let mut ui = LucentUi::new(sender);

        assert_eq!(ui.language().to_string(), "en-US");
        assert_eq!(ui.set_fullscreen(true), Ok(()));
        assert_eq!(ui.set_fullscreen(false), Ok(()));
        assert!(matches!(
            block_on(ui.display_file_open_dialog(Vec::new()).unwrap()).unwrap(),
            FileDialogResult::Canceled
        ));
        assert!(matches!(
            block_on(ui.display_file_open_dialog_multiple(Vec::new()).unwrap()).unwrap(),
            MultiFileDialogResult::Canceled
        ));
        assert!(
            ui.display_file_save_dialog("save.txt".into(), "Save".into())
                .is_none()
        );
    }
}
