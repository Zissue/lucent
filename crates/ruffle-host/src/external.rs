use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;

use bridge::{AsValue, GameEvent, LoaderEvent};
use ruffle_core::context::UpdateContext;
use ruffle_core::external::{ExternalInterfaceProvider, Value};

use crate::sequencer::Sequencer;

pub(crate) struct LoaderInterface {
    pub(crate) sequencer: Rc<RefCell<Sequencer>>,
    pub(crate) callbacks: Rc<RefCell<HashSet<String>>>,
}

impl ExternalInterfaceProvider for LoaderInterface {
    fn call_method(&self, _context: &mut UpdateContext<'_>, name: &str, args: &[Value]) -> Value {
        let args = args.iter().cloned().map(from_ruffle).collect();
        let event = LoaderEvent::parse(name, args);
        if event == LoaderEvent::Loaded {
            tracing::info!("loader registered its callbacks");
        }
        self.sequencer
            .borrow_mut()
            .publish(GameEvent::Loader(event));
        Value::Undefined
    }

    fn on_callback_available(&self, name: &str) {
        self.callbacks.borrow_mut().insert(name.to_owned());
    }

    fn get_id(&self) -> Option<String> {
        None
    }
}

pub(crate) fn from_ruffle(value: Value) -> AsValue {
    match value {
        Value::Undefined => AsValue::Undefined,
        Value::Null => AsValue::Null,
        Value::Bool(b) => AsValue::Bool(b),
        Value::Number(n) => AsValue::Number(n),
        Value::String(s) => AsValue::String(s),
        Value::List(items) => AsValue::List(items.into_iter().map(from_ruffle).collect()),
        Value::Object(map) => {
            AsValue::Object(map.into_iter().map(|(k, v)| (k, from_ruffle(v))).collect())
        }
    }
}

pub(crate) fn to_ruffle(value: AsValue) -> Value {
    match value {
        AsValue::Undefined => Value::Undefined,
        AsValue::Null => Value::Null,
        AsValue::Bool(b) => Value::Bool(b),
        AsValue::Number(n) => Value::Number(n),
        AsValue::String(s) => Value::String(s),
        AsValue::List(items) => Value::List(items.into_iter().map(to_ruffle).collect()),
        AsValue::Object(map) => {
            Value::Object(map.into_iter().map(|(k, v)| (k, to_ruffle(v))).collect())
        }
    }
}
