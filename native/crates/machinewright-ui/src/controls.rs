//! Framework-neutral view-model/intent pair for the Behavior Lab's controls
//! panel: turns a template's JSON Schema (`MachineTemplate.input_schema()`
//! on the Python side) plus the session's effective inputs into a flat list
//! of renderable fields, and turns "a field changed" into the
//! `AppCommand::SetInputOverride` that carries it out.

use machinewright_analysis::set_path;
use machinewright_app::AppCommand;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub enum ControlKind {
    /// A numeric field with both a lower and upper bound in the schema
    /// (`minimum`/`exclusiveMinimum` and `maximum`/`exclusiveMaximum`) —
    /// rendered as a slider.
    Bounded {
        min: f64,
        max: f64,
    },
    /// A numeric field with no schema bounds — rendered as a plain number
    /// field.
    Number,
    Text,
    Boolean,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ControlField {
    /// Dot-separated path into the inputs document, e.g.
    /// `"requirements.payload_kg"`.
    pub path: String,
    pub label: String,
    pub kind: ControlKind,
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ControlsViewModel {
    pub fields: Vec<ControlField>,
}

impl ControlsViewModel {
    /// `schema` is the template's JSON Schema (draft 2020-12, as produced by
    /// `MachineTemplate.input_schema()`); `effective_inputs` is the current
    /// inputs document (the session's input override if one is set,
    /// otherwise the on-disk input file) used to populate each field's
    /// starting value.
    pub fn derive(schema: &Value, effective_inputs: &Value) -> Self {
        let mut fields = Vec::new();
        collect_fields(schema, effective_inputs, "", &mut fields);
        Self { fields }
    }
}

fn value_at_path<'a>(document: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.')
        .try_fold(document, |value, segment| value.get(segment))
}

fn collect_fields(
    schema: &Value,
    effective_inputs: &Value,
    prefix: &str,
    fields: &mut Vec<ControlField>,
) {
    let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
        return;
    };
    for (key, field_schema) in properties {
        // A `const` field (e.g. a Contract's `schema_version`) is not
        // user-editable — its value is fixed by the schema itself.
        if field_schema.get("const").is_some() {
            continue;
        }
        let path = if prefix.is_empty() {
            key.clone()
        } else {
            format!("{prefix}.{key}")
        };
        let field_type = field_schema.get("type").and_then(Value::as_str);
        if field_type == Some("object") {
            collect_fields(field_schema, effective_inputs, &path, fields);
            continue;
        }
        let kind = match field_type {
            Some("number" | "integer") => {
                let min = field_schema
                    .get("minimum")
                    .or_else(|| field_schema.get("exclusiveMinimum"))
                    .and_then(Value::as_f64);
                let max = field_schema
                    .get("maximum")
                    .or_else(|| field_schema.get("exclusiveMaximum"))
                    .and_then(Value::as_f64);
                match (min, max) {
                    (Some(min), Some(max)) => ControlKind::Bounded { min, max },
                    _ => ControlKind::Number,
                }
            }
            Some("boolean") => ControlKind::Boolean,
            Some("string") => ControlKind::Text,
            // A union/untyped/array schema isn't renderable as a single
            // simple control in M3 — left for a future amendment rather
            // than guessed at here.
            _ => continue,
        };
        let value = value_at_path(effective_inputs, &path)
            .cloned()
            .or_else(|| field_schema.get("default").cloned())
            .unwrap_or(Value::Null);
        let label = field_schema
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or(key)
            .to_owned();
        fields.push(ControlField {
            path,
            label,
            kind,
            value,
        });
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ControlIntent {
    FieldChanged { path: String, value: Value },
}

/// Turns a control-panel intent into the session command that carries it
/// out: patches `base_inputs` (the document the override replaces) at the
/// changed field's path and wraps the result as `SetInputOverride`. The
/// debounce/reevaluation that follows is the same seam ordinary source
/// edits already use (`EvaluationRuntime`, wired in the adapter).
pub fn reduce_control_intent(
    base_inputs: &Value,
    intent: ControlIntent,
) -> Result<AppCommand, machinewright_analysis::SweepAxisError> {
    match intent {
        ControlIntent::FieldChanged { path, value } => {
            let mut document = base_inputs.clone();
            set_path(&mut document, &path, value)?;
            let bytes = serde_json::to_vec(&document).unwrap_or_default();
            Ok(AppCommand::SetInputOverride(bytes))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn reference_schema() -> Value {
        json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "title": "machinewright.reference.simple@1.0.0 inputs",
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "requirements": {
                    "additionalProperties": false,
                    "properties": {
                        "schema_version": {
                            "const": "1.0",
                            "default": "1.0",
                            "title": "Schema Version",
                            "type": "string"
                        },
                        "payload_kg": {
                            "default": 10.0,
                            "exclusiveMinimum": 0,
                            "maximum": 100,
                            "title": "Payload Kg",
                            "type": "number"
                        }
                    },
                    "title": "ReferenceInputs",
                    "type": "object"
                }
            },
            "required": ["requirements"]
        })
    }

    #[test]
    fn derive_produces_one_bounded_field_for_the_reference_project() {
        let schema = reference_schema();
        let effective_inputs = json!({"requirements": {"payload_kg": 24.0}});
        let view_model = ControlsViewModel::derive(&schema, &effective_inputs);

        assert_eq!(view_model.fields.len(), 1);
        let field = &view_model.fields[0];
        assert_eq!(field.path, "requirements.payload_kg");
        assert_eq!(field.label, "Payload Kg");
        assert_eq!(
            field.kind,
            ControlKind::Bounded {
                min: 0.0,
                max: 100.0
            }
        );
        assert_eq!(field.value, json!(24.0));
    }

    #[test]
    fn derive_falls_back_to_the_schema_default_when_the_input_is_missing() {
        let schema = reference_schema();
        let view_model = ControlsViewModel::derive(&schema, &json!({}));
        assert_eq!(view_model.fields[0].value, json!(10.0));
    }

    #[test]
    fn derive_skips_const_fields() {
        let schema = reference_schema();
        let view_model = ControlsViewModel::derive(&schema, &json!({}));
        assert!(
            view_model
                .fields
                .iter()
                .all(|field| field.path != "requirements.schema_version")
        );
    }

    #[test]
    fn field_changed_reduces_to_set_input_override_with_the_patched_document() {
        let base_inputs = json!({"requirements": {"payload_kg": 10.0}});
        let command = reduce_control_intent(
            &base_inputs,
            ControlIntent::FieldChanged {
                path: "requirements.payload_kg".into(),
                value: json!(42.0),
            },
        )
        .unwrap();
        match command {
            AppCommand::SetInputOverride(bytes) => {
                let patched: Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(patched, json!({"requirements": {"payload_kg": 42.0}}));
            }
            other => panic!("expected SetInputOverride, got {other:?}"),
        }
    }
}
