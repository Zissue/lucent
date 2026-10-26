use bridge::AsValue;
use serde_json::{Map, Number, Value};

pub(crate) fn to_as(value: Value) -> AsValue {
    match value {
        Value::Null => AsValue::Null,
        Value::Bool(b) => AsValue::Bool(b),
        Value::Number(n) => AsValue::Number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => AsValue::String(s),
        Value::Array(items) => AsValue::List(items.into_iter().map(to_as).collect()),
        Value::Object(map) => {
            AsValue::Object(map.into_iter().map(|(k, v)| (k, to_as(v))).collect())
        }
    }
}

/// `None` stands for a top-level `undefined`, which JSON cannot carry.
pub(crate) fn from_as(value: AsValue) -> Option<Value> {
    match value {
        AsValue::Undefined => None,
        other => Some(nested(other)),
    }
}

fn nested(value: AsValue) -> Value {
    match value {
        AsValue::Undefined | AsValue::Null => Value::Null,
        AsValue::Bool(b) => Value::Bool(b),
        AsValue::Number(n) => number(n),
        AsValue::String(s) => Value::String(s),
        AsValue::List(items) => Value::Array(items.into_iter().map(nested).collect()),
        AsValue::Object(map) => Value::Object(
            map.into_iter()
                .map(|(k, v)| (k, nested(v)))
                .collect::<Map<_, _>>(),
        ),
    }
}

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() <= MAX_SAFE_INTEGER && !(n == 0.0 && n.is_sign_negative()) {
        Value::from(n as i64)
    } else {
        Number::from_f64(n).map_or(Value::Null, Value::Number)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trips_json_through_as3_values() {
        let value = json!({"a": [1, 2.5, "x", null, true], "b": {"c": false}});
        assert_eq!(from_as(to_as(value.clone())), Some(value));
    }

    #[test]
    fn maps_undefined_to_none_at_the_top_and_null_inside() {
        assert_eq!(from_as(AsValue::Undefined), None);
        assert_eq!(
            from_as(AsValue::List(vec![AsValue::Undefined])),
            Some(json!([null]))
        );
        assert_eq!(from_as(AsValue::Number(f64::NAN)), Some(Value::Null));
    }
}
