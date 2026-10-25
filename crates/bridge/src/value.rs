use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq)]
pub enum AsValue {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    List(Vec<AsValue>),
    Object(BTreeMap<String, AsValue>),
}
