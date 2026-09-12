use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SweepStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Infeasible,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SweepPoint {
    pub index: usize,
    pub inputs: Value,
    pub status: SweepStatus,
    pub snapshot_path: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Sweep {
    pub points: Vec<SweepPoint>,
    cancelled: bool,
}

/// A dotted `parameter_path` (e.g. `"requirements.payload_kg"`) does not
/// address a JSON object field it needs to walk through — mirrors the
/// `{parameter} does not address an object field` check in
/// `machinewright project sweep` (`src/machinewright/commands/project.py`).
#[derive(Debug, Error, PartialEq, Eq)]
#[error("{path} does not address an object field")]
pub struct SweepAxisError {
    pub path: String,
}

/// Patches `document` at `path` (dot-separated segments, creating
/// intermediate objects as needed) to `value`, mirroring the segment walk
/// in `project.py`'s `sweep` command exactly so a sweep built in the native
/// app and one run via that CLI command patch the same field the same way.
/// Also the basis for a single control's edit (`machinewright-ui::controls`)
/// — both patch one field of a full inputs document by the same dotted
/// path convention.
pub fn set_path(document: &mut Value, path: &str, value: Value) -> Result<(), SweepAxisError> {
    let segments: Vec<&str> = path.split('.').collect();
    let mut target = document;
    for segment in &segments[..segments.len().saturating_sub(1)] {
        let object = target.as_object_mut().ok_or_else(|| SweepAxisError {
            path: path.to_owned(),
        })?;
        target = object
            .entry((*segment).to_owned())
            .or_insert_with(|| Value::Object(serde_json::Map::new()));
    }
    let Some(&last) = segments.last() else {
        return Err(SweepAxisError {
            path: path.to_owned(),
        });
    };
    target
        .as_object_mut()
        .ok_or_else(|| SweepAxisError {
            path: path.to_owned(),
        })?
        .insert(last.to_owned(), value);
    Ok(())
}

impl Sweep {
    pub fn new(inputs: impl IntoIterator<Item = Value>) -> Self {
        Self {
            points: inputs
                .into_iter()
                .enumerate()
                .map(|(index, inputs)| SweepPoint {
                    index,
                    inputs,
                    status: SweepStatus::Pending,
                    snapshot_path: None,
                    error: None,
                })
                .collect(),
            cancelled: false,
        }
    }

    /// Builds a sweep over `base` (a full inputs document) by patching
    /// `parameter_path` to each of `values` in turn — the native app's
    /// equivalent of `machinewright project sweep`'s per-point input
    /// construction, so a sweep run in the app and the same range/point
    /// count run via that CLI command evaluate identical per-point inputs.
    pub fn from_axis(
        base: &Value,
        parameter_path: &str,
        values: impl IntoIterator<Item = f64>,
    ) -> Result<Self, SweepAxisError> {
        let points = values
            .into_iter()
            .map(|value| {
                let mut document = base.clone();
                set_path(&mut document, parameter_path, Value::from(value))?;
                Ok(document)
            })
            .collect::<Result<Vec<Value>, SweepAxisError>>()?;
        Ok(Self::new(points))
    }

    pub fn cancel(&mut self) {
        self.cancelled = true;
        for point in &mut self.points {
            if matches!(point.status, SweepStatus::Pending) {
                point.status = SweepStatus::Cancelled;
            }
        }
    }

    pub fn next_pending(&mut self) -> Option<&mut SweepPoint> {
        if self.cancelled {
            return None;
        }
        let point = self
            .points
            .iter_mut()
            .find(|point| point.status == SweepStatus::Pending)?;
        point.status = SweepStatus::Running;
        Some(point)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SemanticChange {
    pub path: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

pub fn compare_json(before: &Value, after: &Value) -> Vec<SemanticChange> {
    let mut changes = Vec::new();
    compare_at("$", before, after, &mut changes);
    changes
}

fn compare_at(path: &str, before: &Value, after: &Value, changes: &mut Vec<SemanticChange>) {
    match (before, after) {
        (Value::Object(left), Value::Object(right)) => {
            let mut keys: Vec<_> = left.keys().chain(right.keys()).collect();
            keys.sort();
            keys.dedup();
            for key in keys {
                match (left.get(key), right.get(key)) {
                    (Some(a), Some(b)) => compare_at(&format!("{path}.{key}"), a, b, changes),
                    (a, b) => changes.push(SemanticChange {
                        path: format!("{path}.{key}"),
                        before: a.map(Value::to_string),
                        after: b.map(Value::to_string),
                    }),
                }
            }
        }
        _ if before != after => changes.push(SemanticChange {
            path: path.to_owned(),
            before: Some(before.to_string()),
            after: Some(after.to_string()),
        }),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn from_axis_patches_a_nested_dotted_path_creating_intermediate_objects() {
        let base = json!({"requirements": {"payload_kg": 10.0}});
        let sweep = Sweep::from_axis(&base, "requirements.payload_kg", [0.0, 30.0, 60.0]).unwrap();
        let values: Vec<f64> = sweep
            .points
            .iter()
            .map(|point| point.inputs["requirements"]["payload_kg"].as_f64().unwrap())
            .collect();
        assert_eq!(values, vec![0.0, 30.0, 60.0]);
    }

    #[test]
    fn from_axis_creates_a_missing_intermediate_object() {
        let base = json!({});
        let sweep = Sweep::from_axis(&base, "requirements.payload_kg", [5.0]).unwrap();
        assert_eq!(sweep.points[0].inputs, json!({"requirements": {"payload_kg": 5.0}}));
    }

    #[test]
    fn from_axis_rejects_a_path_through_a_non_object_field() {
        let base = json!({"requirements": "not an object"});
        let error = Sweep::from_axis(&base, "requirements.payload_kg", [5.0]).unwrap_err();
        assert_eq!(error.path, "requirements.payload_kg");
    }

    #[test]
    fn cancel_mid_sweep_leaves_completed_points_untouched_and_only_flips_pending() {
        let mut sweep = Sweep::new([json!({"a": 1}), json!({"a": 2}), json!({"a": 3})]);
        // Complete the first point, leave the rest pending.
        {
            let first = sweep.next_pending().unwrap();
            first.status = SweepStatus::Succeeded;
            first.snapshot_path = Some("point-0000/evaluation-snapshot.json".into());
        }
        sweep.cancel();

        assert_eq!(sweep.points[0].status, SweepStatus::Succeeded);
        assert_eq!(
            sweep.points[0].snapshot_path.as_deref(),
            Some("point-0000/evaluation-snapshot.json")
        );
        assert_eq!(sweep.points[1].status, SweepStatus::Cancelled);
        assert_eq!(sweep.points[2].status, SweepStatus::Cancelled);
        // Cancellation is sticky: no further points can be pulled.
        assert!(sweep.next_pending().is_none());
    }
}
