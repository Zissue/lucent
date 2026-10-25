#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ConnId(pub u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    ToServer,
    ToClient,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Packet {
    pub conn: ConnId,
    pub dir: Direction,
    pub bytes: Vec<u8>,
}
