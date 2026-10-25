pub(crate) enum Framed<'a> {
    Message(&'a [u8]),
    Oversize(usize),
}

pub(crate) struct Framer {
    partial: Vec<u8>,
    limit: usize,
    skipping: bool,
}

impl Framer {
    pub(crate) fn new(limit: usize) -> Self {
        Self {
            partial: Vec::new(),
            limit,
            skipping: false,
        }
    }

    pub(crate) fn push(&mut self, mut chunk: &[u8], mut on: impl FnMut(Framed<'_>)) {
        while let Some(end) = chunk.iter().position(|&byte| byte == 0) {
            if self.skipping {
                self.skipping = false;
            } else if self.partial.len() + end > self.limit {
                on(Framed::Oversize(self.partial.len() + end));
                self.partial.clear();
            } else if self.partial.is_empty() {
                on(Framed::Message(&chunk[..end]));
            } else {
                self.partial.extend_from_slice(&chunk[..end]);
                on(Framed::Message(&self.partial));
                self.partial.clear();
            }
            chunk = &chunk[end + 1..];
        }
        if self.skipping {
            return;
        }
        if self.partial.len() + chunk.len() > self.limit {
            on(Framed::Oversize(self.partial.len() + chunk.len()));
            self.partial.clear();
            self.skipping = true;
        } else {
            self.partial.extend_from_slice(chunk);
        }
    }

    pub(crate) fn pending(&self) -> usize {
        self.partial.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MESSAGES: [&str; 4] = [
        "<msg t='sys'><body action='verChk' r='0'><ver v='157' /></body></msg>",
        "%xt%zm%moveToCell%1%battleon-1%Enter%Spawn%",
        "{\"t\":\"xt\",\"b\":{\"r\":-1,\"o\":{\"cmd\":\"ct\"}}}",
        "%xt%uotls%-1%Hérø%intHP:100%",
    ];

    fn wire() -> Vec<u8> {
        MESSAGES
            .iter()
            .flat_map(|message| message.bytes().chain([0]))
            .collect()
    }

    fn collect(framer: &mut Framer, chunks: &[&[u8]]) -> Vec<String> {
        let mut out = Vec::new();
        for chunk in chunks {
            framer.push(chunk, |framed| match framed {
                Framed::Message(bytes) => out.push(String::from_utf8(bytes.to_vec()).unwrap()),
                Framed::Oversize(len) => out.push(format!("<oversize {len}>")),
            });
        }
        out
    }

    #[test]
    fn yields_every_message_when_reads_are_coalesced() {
        let mut framer = Framer::new(1 << 20);
        assert_eq!(collect(&mut framer, &[&wire()]), MESSAGES);
        assert_eq!(framer.pending(), 0);
    }

    #[test]
    fn yields_the_same_messages_for_every_split_point() {
        let bytes = wire();
        for split in 0..=bytes.len() {
            let mut framer = Framer::new(1 << 20);
            let (head, tail) = bytes.split_at(split);
            assert_eq!(
                collect(&mut framer, &[head, tail]),
                MESSAGES,
                "split at {split}"
            );
        }
    }

    #[test]
    fn yields_the_same_messages_one_byte_at_a_time() {
        let bytes = wire();
        let chunks: Vec<&[u8]> = bytes.chunks(1).collect();
        assert_eq!(collect(&mut Framer::new(1 << 20), &chunks), MESSAGES);
    }

    #[test]
    fn keeps_an_unterminated_tail_until_its_terminator_arrives() {
        let mut framer = Framer::new(1 << 20);
        assert!(collect(&mut framer, &[b"%xt%zm%gar%"]).is_empty());
        assert_eq!(framer.pending(), 11);
        assert_eq!(collect(&mut framer, &[b"-1%\0"]), ["%xt%zm%gar%-1%"]);
    }

    #[test]
    fn reports_consecutive_terminators_as_empty_messages() {
        assert_eq!(
            collect(&mut Framer::new(1 << 20), &[b"a\0\0b\0"]),
            ["a", "", "b"]
        );
    }

    #[test]
    fn reports_an_oversize_message_once_and_resumes_at_the_next_terminator() {
        let mut framer = Framer::new(8);
        assert_eq!(
            collect(&mut framer, &[b"ok\x00012345", b"6789", b"abc\0next\0"]),
            ["ok", "<oversize 10>", "next"]
        );
        assert_eq!(
            collect(&mut Framer::new(8), &[b"0123456789\0x\0"]),
            ["<oversize 10>", "x"]
        );
    }
}
