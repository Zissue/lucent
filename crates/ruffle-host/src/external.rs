use std::cell::RefCell;
use std::rc::Rc;

use bridge::{AsValue, GameEvent, LoaderEvent};
use ruffle_core::context::UpdateContext;
use ruffle_core::external::{ExternalInterfaceProvider, Value};

use crate::sequencer::Sequencer;

pub(crate) struct LoaderInterface {
    pub(crate) sequencer: Rc<RefCell<Sequencer>>,
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

    fn on_callback_available(&self, _name: &str) {}

    fn get_id(&self) -> Option<String> {
        None
    }
}

fn from_ruffle(value: Value) -> AsValue {
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
