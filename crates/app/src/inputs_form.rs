use std::collections::HashMap;

use gpui::{Context, Entity, Render, WeakEntity, Window, div, prelude::*, px, rgb};
use serde_json::{Map, Value};

use crate::game_view::{FieldKind, GameView, InputField, ScriptInputs};
use crate::ui::{self, TextInput, button};

/// The form Electron shows from a script's `module.exports.inputs`.
pub struct InputsForm {
    tab: WeakEntity<GameView>,
    fields: Vec<InputField>,
    texts: HashMap<String, Entity<TextInput>>,
    values: Map<String, Value>,
    error: Option<String>,
}

impl InputsForm {
    pub fn new(tab: WeakEntity<GameView>, inputs: &ScriptInputs, cx: &mut Context<Self>) -> Self {
        let mut texts = HashMap::new();
        for field in &inputs.fields {
            if matches!(field.kind, FieldKind::Text | FieldKind::Number) {
                let current = match inputs.values.get(&field.key) {
                    Some(Value::String(text)) => text.clone(),
                    Some(Value::Number(number)) => number.to_string(),
                    _ => String::new(),
                };
                let input = cx.new(|cx| {
                    let mut input = TextInput::new(field.label.clone(), cx);
                    input.set_text(current, cx);
                    input
                });
                texts.insert(field.key.clone(), input);
            }
        }
        Self {
            tab,
            fields: inputs.fields.clone(),
            texts,
            values: inputs.values.clone(),
            error: None,
        }
    }

    pub fn set_error(&mut self, error: Option<String>, cx: &mut Context<Self>) {
        self.error = error;
        cx.notify();
    }

    fn collect(&self, cx: &Context<Self>) -> Result<Map<String, Value>, String> {
        let mut values = self.values.clone();
        for field in &self.fields {
            let Some(input) = self.texts.get(&field.key) else {
                continue;
            };
            let text = input.read(cx).text().trim().to_owned();
            if text.is_empty() {
                values.remove(&field.key);
                continue;
            }
            let value = match field.kind {
                FieldKind::Number => {
                    let number: f64 = text
                        .parse()
                        .map_err(|_| format!("{} must be a number.", field.label))?;
                    serde_json::Number::from_f64(number)
                        .map(Value::Number)
                        .ok_or_else(|| format!("{} must be a finite number.", field.label))?
                }
                _ => Value::String(input.read(cx).text().to_owned()),
            };
            values.insert(field.key.clone(), value);
        }
        Ok(values)
    }

    fn save(&mut self, start: bool, cx: &mut Context<Self>) {
        match self.collect(cx) {
            Ok(values) => {
                self.error = None;
                if let Some(tab) = self.tab.upgrade() {
                    tab.update(cx, |view, cx| view.save_inputs(values, start, cx));
                }
            }
            Err(error) => self.error = Some(error),
        }
        cx.notify();
    }

    fn cancel(&mut self, cx: &mut Context<Self>) {
        if let Some(tab) = self.tab.upgrade() {
            tab.update(cx, |view, cx| view.close_inputs(cx));
        }
    }

    fn render_field(
        &self,
        index: usize,
        field: &InputField,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let key = field.key.clone();
        let control = match &field.kind {
            FieldKind::Text | FieldKind::Number => div()
                .children(self.texts.get(&field.key).cloned())
                .into_any_element(),
            FieldKind::Boolean => {
                let on = self.values.get(&key) == Some(&Value::Bool(true));
                button(("toggle", index), if on { "On" } else { "Off" })
                    .on_click(cx.listener(move |form, _, _, cx| {
                        let next = form.values.get(&key) != Some(&Value::Bool(true));
                        form.values.insert(key.clone(), Value::Bool(next));
                        cx.notify();
                    }))
                    .into_any_element()
            }
            FieldKind::Select(options) | FieldKind::MultiSelect(options) => {
                let multi = matches!(field.kind, FieldKind::MultiSelect(_));
                let chosen: Vec<String> = match self.values.get(&key) {
                    Some(Value::String(value)) => vec![value.clone()],
                    Some(Value::Array(values)) => values
                        .iter()
                        .filter_map(|value| value.as_str().map(str::to_owned))
                        .collect(),
                    _ => Vec::new(),
                };
                div()
                    .flex()
                    .flex_wrap()
                    .gap_1()
                    .children(options.iter().enumerate().map(|(option_index, option)| {
                        let selected = chosen.contains(option);
                        let (key, option) = (key.clone(), option.clone());
                        div()
                            .id(("option", index * 1000 + option_index))
                            .px_2()
                            .py(px(2.))
                            .rounded_md()
                            .border_1()
                            .border_color(rgb(if selected {
                                ui::ACCENT
                            } else {
                                ui::BORDER_STRONG
                            }))
                            .bg(rgb(if selected { 0x1e1b4b } else { ui::BACKGROUND }))
                            .text_size(px(12.))
                            .cursor_pointer()
                            .child(option.clone())
                            .on_click(cx.listener(move |form, _, _, cx| {
                                if multi {
                                    let mut values: Vec<Value> = match form.values.get(&key) {
                                        Some(Value::Array(values)) => values.clone(),
                                        _ => Vec::new(),
                                    };
                                    let entry = Value::String(option.clone());
                                    if let Some(at) =
                                        values.iter().position(|value| *value == entry)
                                    {
                                        values.remove(at);
                                    } else {
                                        values.push(entry);
                                    }
                                    form.values.insert(key.clone(), Value::Array(values));
                                } else {
                                    form.values
                                        .insert(key.clone(), Value::String(option.clone()));
                                }
                                cx.notify();
                            }))
                    }))
                    .into_any_element()
            }
        };
        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(
                div()
                    .text_size(px(12.))
                    .text_color(rgb(ui::TEXT))
                    .child(if field.required {
                        format!("{} *", field.label)
                    } else {
                        field.label.clone()
                    }),
            )
            .children(field.description.clone().map(|description| {
                div()
                    .text_size(px(11.))
                    .text_color(rgb(ui::MUTED))
                    .child(description)
            }))
            .child(control)
    }
}

impl Render for InputsForm {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let fields: Vec<_> = self
            .fields
            .clone()
            .iter()
            .enumerate()
            .map(|(index, field)| self.render_field(index, field, cx).into_any_element())
            .collect();
        div()
            .w(px(460.))
            .max_h(px(560.))
            .flex()
            .flex_col()
            .rounded_lg()
            .border_1()
            .border_color(rgb(ui::BORDER_STRONG))
            .bg(rgb(ui::PANEL))
            .text_color(rgb(ui::TEXT))
            .child(
                div()
                    .px_4()
                    .pt_4()
                    .pb_2()
                    .text_size(px(14.))
                    .child("Script inputs"),
            )
            .child(
                div()
                    .id("inputs-fields")
                    .flex_1()
                    .overflow_y_scroll()
                    .px_4()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .children(fields),
            )
            .children(self.error.clone().map(|error| {
                div()
                    .px_4()
                    .pt_2()
                    .text_size(px(12.))
                    .text_color(rgb(ui::DANGER))
                    .child(error)
            }))
            .child(
                div()
                    .p_4()
                    .flex()
                    .justify_end()
                    .gap_2()
                    .child(
                        button("inputs-cancel", "Cancel")
                            .on_click(cx.listener(|form, _, _, cx| form.cancel(cx))),
                    )
                    .child(
                        button("inputs-save", "Save")
                            .on_click(cx.listener(|form, _, _, cx| form.save(false, cx))),
                    )
                    .child(
                        button("inputs-start", "Save and start")
                            .primary()
                            .on_click(cx.listener(|form, _, _, cx| form.save(true, cx))),
                    ),
            )
    }
}
