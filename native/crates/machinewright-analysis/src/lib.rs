use serde::{Deserialize, Serialize};
use serde_json::Value;

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
