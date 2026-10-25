use std::sync::Arc;

use gpui::{RenderImage, Window};
use ruffle_host::Frame;

#[derive(Default)]
pub struct Presented {
    current: Option<Arc<RenderImage>>,
    last_drawn: Option<Arc<RenderImage>>,
    retiring: Vec<Arc<RenderImage>>,
}

impl Presented {
    pub fn replace(&mut self, frame: Frame) {
        let Some(pixels) = image::RgbaImage::from_raw(frame.width, frame.height, frame.bgra) else {
            tracing::error!(
                frame.width,
                frame.height,
                "frame size does not match its pixels"
            );
            return;
        };
        let image = Arc::new(RenderImage::new([image::Frame::new(pixels)]));
        if let Some(old) = self.current.replace(image) {
            let drawn = self
                .last_drawn
                .as_ref()
                .is_some_and(|last| last.id == old.id);
            if !drawn {
                self.retiring.push(old);
            }
        }
    }

    pub fn image(&self) -> Option<Arc<RenderImage>> {
        self.current.clone()
    }

    // GPUI keeps an uploaded image in the atlas until drop_image. The image the previous
    // scene drew may still be on the GPU, so it is dropped one render later.
    pub fn retire(&mut self, window: &mut Window) {
        for image in self.retiring.drain(..) {
            let _ = window.drop_image(image);
        }
        let current_id = self.current.as_ref().map(|image| image.id);
        if let Some(last) = self.last_drawn.take()
            && Some(last.id) != current_id
        {
            self.retiring.push(last);
        }
        self.last_drawn = self.current.clone();
    }
}
