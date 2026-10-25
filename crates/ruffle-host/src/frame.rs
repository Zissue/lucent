use ruffle_render_wgpu::backend::WgpuRenderBackend;
use ruffle_render_wgpu::target::TextureTarget;
use ruffle_render_wgpu::utils::capture_image;

pub struct Frame {
    pub seq: u64,
    pub width: u32,
    pub height: u32,
    pub bgra: Vec<u8>,
}

pub struct FrameStream {
    rx: async_channel::Receiver<Frame>,
}

impl FrameStream {
    pub async fn next(&self) -> Option<Frame> {
        self.rx.recv().await.ok()
    }
}

pub(crate) struct FrameSender {
    tx: async_channel::Sender<Frame>,
    next_seq: u64,
}

pub(crate) fn mailbox() -> (FrameSender, FrameStream) {
    let (tx, rx) = async_channel::bounded(1);
    (FrameSender { tx, next_seq: 1 }, FrameStream { rx })
}

impl FrameSender {
    pub(crate) fn wanted(&self) -> bool {
        !self.tx.is_closed()
    }

    pub(crate) fn post(&mut self, width: u32, height: u32, bgra: Vec<u8>) {
        let frame = Frame {
            seq: self.next_seq,
            width,
            height,
            bgra,
        };
        self.next_seq += 1;
        let _ = self.tx.force_send(frame);
    }
}

pub(crate) fn read_back(
    renderer: &WgpuRenderBackend<TextureTarget>,
) -> Option<(u32, u32, Vec<u8>)> {
    let target = renderer.target();
    let (buffer, dimensions) = target.buffer.as_ref()?.buffer.inner();
    let (width, height) = (target.size.width, target.size.height);
    capture_image(
        renderer.device(),
        buffer,
        dimensions,
        None,
        |padded, padded_row| {
            let mut bgra =
                Vec::with_capacity(dimensions.unpadded_bytes_per_row * dimensions.height);
            for row in padded.chunks(padded_row as usize).take(dimensions.height) {
                premultiplied_rgba_to_straight_bgra(
                    &row[..dimensions.unpadded_bytes_per_row],
                    &mut bgra,
                );
            }
            (width, height, bgra)
        },
    )
}

fn premultiplied_rgba_to_straight_bgra(rgba: &[u8], out: &mut Vec<u8>) {
    for &[r, g, b, a] in rgba.as_chunks::<4>().0 {
        match a {
            255 => out.extend_from_slice(&[b, g, r, 255]),
            0 => out.extend_from_slice(&[0, 0, 0, 0]),
            a => {
                let straight =
                    |c: u8| ((u16::from(c) * 255 + u16::from(a) / 2) / u16::from(a)).min(255) as u8;
                out.extend_from_slice(&[straight(b), straight(g), straight(r), a]);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swaps_opaque_pixels_to_bgra_unchanged() {
        let mut out = Vec::new();
        premultiplied_rgba_to_straight_bgra(&[10, 20, 30, 255, 0, 0, 0, 0], &mut out);
        assert_eq!(out, [30, 20, 10, 255, 0, 0, 0, 0]);
    }

    #[test]
    fn unpremultiplies_translucent_pixels() {
        let mut out = Vec::new();
        premultiplied_rgba_to_straight_bgra(&[64, 32, 0, 128], &mut out);
        assert_eq!(out, [0, 64, 128, 128]);
    }

    #[test]
    fn keeps_only_the_newest_unread_frame() {
        let (mut sender, stream) = mailbox();
        sender.post(1, 1, vec![0; 4]);
        sender.post(1, 1, vec![1; 4]);
        let frame = futures::executor::block_on(stream.next()).unwrap();
        assert_eq!((frame.seq, frame.bgra), (2, vec![1; 4]));
    }

    #[test]
    fn stops_wanting_frames_once_the_view_drops_its_stream() {
        let (sender, stream) = mailbox();
        assert!(sender.wanted());
        drop(stream);
        assert!(!sender.wanted());
    }
}
