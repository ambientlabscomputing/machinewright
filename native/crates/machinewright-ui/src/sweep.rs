//! Framework-neutral view-model/intent pair for the Behavior Lab's sweep
//! panel and plot. The sweep *execution* (spawning a worker, running
//! `next_pending`, real threads/processes) stays adapter-side — this module
//! only owns turning retained sweep state into something renderable, and
//! turning a point click into the `AppCommand` that browses it.

use machinewright_analysis::{SemanticChange, SweepStatus, compare_json};
use machinewright_app::AppCommand;
use machinewright_model::{ObservableKind, ProjectSnapshot};

/// One sweep point as the adapter's sweep runner tracks it: the axis value
/// it evaluated, its terminal/in-progress status, and (once evaluated) its
/// snapshot — everything the view model needs to derive rows and series
/// without reaching back into `machinewright-analysis::Sweep` or the
/// worker-execution machinery directly.
pub struct SweepPointInput<'a> {
    pub index: usize,
    pub axis_value: f64,
    pub status: SweepStatus,
    pub snapshot: Option<&'a ProjectSnapshot>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ObservablePoint {
    pub observable_id: String,
    pub label: String,
    pub kind: ObservableKind,
    pub value: f64,
    pub feasible: Option<bool>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SweepRow {
    pub index: usize,
    pub axis_value: f64,
    pub status: SweepStatus,
    pub observables: Vec<ObservablePoint>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ObservableSeries {
    pub observable_id: String,
    pub label: String,
    pub kind: ObservableKind,
    /// `(axis_value, value)` pairs from succeeded points, in axis order.
    pub samples: Vec<(f64, f64)>,
    /// `(axis_value, feasible)` pairs, for feasibility-region shading —
    /// only present for observables that report `feasible`.
    pub feasible_samples: Vec<(f64, bool)>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct SweepViewModel {
    pub parameter_path: String,
    pub rows: Vec<SweepRow>,
}

impl SweepViewModel {
    pub fn derive(parameter_path: &str, points: &[SweepPointInput<'_>]) -> Self {
        let rows = points
            .iter()
            .map(|point| {
                let observables = point
                    .snapshot
                    .and_then(|snapshot| snapshot.typed_observables().ok())
                    .unwrap_or_default()
                    .into_iter()
                    // Only a numeric `value` can be plotted on the
                    // envelope's axis; a series/interval/extension
                    // observable whose value isn't a plain number is
                    // omitted here rather than guessed at.
                    .filter_map(|observable| {
                        let value = observable.value.as_f64()?;
                        Some(ObservablePoint {
                            observable_id: observable.observable_id,
                            label: observable.label,
                            kind: observable.kind,
                            value,
                            feasible: observable.feasible,
                        })
                    })
                    .collect();
                SweepRow {
                    index: point.index,
                    axis_value: point.axis_value,
                    status: point.status.clone(),
                    observables,
                }
            })
            .collect();
        Self {
            parameter_path: parameter_path.to_owned(),
            rows,
        }
    }

    /// Groups every row's observables by `observable_id` into plottable
    /// series, in axis order. A series only includes samples from rows
    /// whose sweep point succeeded (a failed/cancelled/pending point has no
    /// observables to contribute).
    pub fn series(&self) -> Vec<ObservableSeries> {
        let mut series: Vec<ObservableSeries> = Vec::new();
        for row in &self.rows {
            if row.status != SweepStatus::Succeeded {
                continue;
            }
            for observable in &row.observables {
                let entry = match series
                    .iter_mut()
                    .find(|series| series.observable_id == observable.observable_id)
                {
                    Some(entry) => entry,
                    None => {
                        series.push(ObservableSeries {
                            observable_id: observable.observable_id.clone(),
                            label: observable.label.clone(),
                            kind: observable.kind,
                            samples: Vec::new(),
                            feasible_samples: Vec::new(),
                        });
                        series.last_mut().expect("just pushed")
                    }
                };
                entry.samples.push((row.axis_value, observable.value));
                if let Some(feasible) = observable.feasible {
                    entry.feasible_samples.push((row.axis_value, feasible));
                }
            }
        }
        series
    }
}

#[derive(Debug, Clone)]
pub enum SweepIntent {
    /// A row/plot point was clicked — `snapshot` is the adapter's retained
    /// snapshot for that point, resolved from the clicked index before
    /// building this intent (this module doesn't retain sweep state
    /// itself, so it can't look the snapshot up from just an index).
    PointClicked { snapshot: ProjectSnapshot },
    /// Return to the live authored snapshot after browsing sweep points.
    ReturnToLive,
}

pub fn reduce_sweep_intent(intent: SweepIntent) -> AppCommand {
    match intent {
        SweepIntent::PointClicked { snapshot } => AppCommand::InspectSnapshot(snapshot),
        SweepIntent::ReturnToLive => AppCommand::ReturnToLive,
    }
}

/// One observable's value at two candidate points — the RFD's own example
/// of a "candidate change" ("Candidate A peak margin changes from +8% to
/// -11%") is exactly this, generalized to whichever numeric observables
/// both points share.
#[derive(Debug, Clone, PartialEq)]
pub struct ObservableDelta {
    pub observable_id: String,
    pub label: String,
    pub before: f64,
    pub after: f64,
    pub delta: f64,
    pub feasible_before: Option<bool>,
    pub feasible_after: Option<bool>,
}

/// The full comparison between two evaluated sweep points: observable
/// deltas for whatever numeric observables both points report, plus a
/// generic structural diff of their graphs (reusing
/// `machinewright_analysis::compare_json` — the same primitive the RFD's
/// broader semantic-change model is meant to build on). Formatting and any
/// display cap on `graph_changes` (which can be large for a big graph) are
/// left to the caller, matching how `SweepRow`/`ObservableSeries` also stay
/// structured rather than pre-formatted.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct CandidateComparison {
    pub observable_deltas: Vec<ObservableDelta>,
    pub graph_changes: Vec<SemanticChange>,
}

/// Compares two evaluated sweep points (or any two snapshots — nothing
/// here is sweep-specific). An observable present in only one snapshot, or
/// whose `value` isn't a plain number in both, is omitted from
/// `observable_deltas` rather than guessed at, mirroring
/// `SweepViewModel::derive`'s own numeric-only filtering.
pub fn compare_candidates(a: &ProjectSnapshot, b: &ProjectSnapshot) -> CandidateComparison {
    let observables_a = a.typed_observables().unwrap_or_default();
    let observables_b = b.typed_observables().unwrap_or_default();
    let observable_deltas = observables_a
        .iter()
        .filter_map(|oa| {
            let before = oa.value.as_f64()?;
            let ob = observables_b
                .iter()
                .find(|ob| ob.observable_id == oa.observable_id)?;
            let after = ob.value.as_f64()?;
            Some(ObservableDelta {
                observable_id: oa.observable_id.clone(),
                label: oa.label.clone(),
                before,
                after,
                delta: after - before,
                feasible_before: oa.feasible,
                feasible_after: ob.feasible,
            })
        })
        .collect();
    let graph_changes = compare_json(&a.evaluation().graph, &b.evaluation().graph);
    CandidateComparison {
        observable_deltas,
        graph_changes,
    }
}

const SERIES_COLORS: [&str; 5] = ["#2563eb", "#d97706", "#059669", "#7c3aed", "#dc2626"];
const FEASIBLE_COLOR: &str = "#16a34a";
const INFEASIBLE_COLOR: &str = "#dc2626";
const AXIS_COLOR: &str = "#6b7280";
const TEXT_COLOR: &str = "#374151";

/// Escapes text for safe placement inside SVG element content — an
/// observable's `label` comes from the project's own Python source, but
/// nothing stops it from containing `<`/`&`/etc., which would otherwise
/// break the generated markup.
fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn min_max(values: impl Iterator<Item = f64>) -> Option<(f64, f64)> {
    let (mut min, mut max) = (f64::INFINITY, f64::NEG_INFINITY);
    let mut any = false;
    for value in values {
        any = true;
        min = min.min(value);
        max = max.max(value);
    }
    if !any {
        return None;
    }
    if (max - min).abs() < f64::EPSILON {
        // A degenerate (zero-span) axis would divide by ~zero below; widen
        // it symmetrically so a single-valued series still plots sensibly.
        Some((min - 1.0, max + 1.0))
    } else {
        Some((min, max))
    }
}

/// Renders the swept parameter (x-axis) against one or more observable
/// series as a self-contained SVG string — a real plot, not a text
/// summary, but scoped to exactly this: one shared x-axis, each series
/// independently normalized to its own y-range (labeled with that range in
/// the legend, since the series are not assumed to share comparable
/// units), point markers colored by feasibility where an observable
/// reports it. No zoom/pan/hover; `width`/`height` are in SVG user units.
pub fn render_envelope_svg(series: &[ObservableSeries], width: f64, height: f64) -> String {
    let Some((x_min, x_max)) = min_max(
        series
            .iter()
            .flat_map(|entry| entry.samples.iter().map(|(x, _)| *x)),
    ) else {
        return format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}"><text x="8" y="20" font-size="12" fill="{TEXT_COLOR}">No succeeded points yet</text></svg>"#
        );
    };
    let x_span = (x_max - x_min).max(f64::EPSILON);

    let left = 40.0;
    let right = width - 8.0;
    let top = 10.0;
    let bottom = height - 22.0;
    let plot_width = (right - left).max(1.0);
    let plot_height = (bottom - top).max(1.0);
    let to_x = |value: f64| left + (value - x_min) / x_span * plot_width;

    let mut body = String::new();
    body.push_str(&format!(
        r#"<line x1="{left:.1}" y1="{bottom:.1}" x2="{right:.1}" y2="{bottom:.1}" stroke="{AXIS_COLOR}"/>"#
    ));
    body.push_str(&format!(
        r#"<text x="{left:.1}" y="{label_y:.1}" font-size="10" fill="{TEXT_COLOR}">{x_min:.3}</text>"#,
        label_y = bottom + 14.0,
    ));
    body.push_str(&format!(
        r#"<text x="{right:.1}" y="{label_y:.1}" font-size="10" text-anchor="end" fill="{TEXT_COLOR}">{x_max:.3}</text>"#,
        label_y = bottom + 14.0,
    ));

    for (index, entry) in series.iter().enumerate() {
        let color = SERIES_COLORS[index % SERIES_COLORS.len()];
        let Some((y_min, y_max)) = min_max(entry.samples.iter().map(|(_, y)| *y)) else {
            continue;
        };
        let y_span = (y_max - y_min).max(f64::EPSILON);
        let to_y = |value: f64| bottom - (value - y_min) / y_span * plot_height;
        let feasible_at = |x: f64| -> Option<bool> {
            entry
                .feasible_samples
                .iter()
                .find(|(sample_x, _)| *sample_x == x)
                .map(|(_, feasible)| *feasible)
        };

        let points = entry
            .samples
            .iter()
            .map(|(x, y)| format!("{:.1},{:.1}", to_x(*x), to_y(*y)))
            .collect::<Vec<_>>()
            .join(" ");
        body.push_str(&format!(
            r#"<polyline points="{points}" fill="none" stroke="{color}" stroke-width="2"/>"#
        ));
        for (x, y) in &entry.samples {
            let marker_color = match feasible_at(*x) {
                Some(true) => FEASIBLE_COLOR,
                Some(false) => INFEASIBLE_COLOR,
                None => color,
            };
            body.push_str(&format!(
                r#"<circle cx="{:.1}" cy="{:.1}" r="3" fill="{marker_color}"/>"#,
                to_x(*x),
                to_y(*y),
            ));
        }

        let legend_y = top + 10.0 + index as f64 * 14.0;
        body.push_str(&format!(
            r#"<rect x="{lx:.1}" y="{ly:.1}" width="8" height="8" fill="{color}"/><text x="{tx:.1}" y="{ty:.1}" font-size="10" fill="{TEXT_COLOR}">{label} ({y_min:.3} to {y_max:.3})</text>"#,
            lx = left + 4.0,
            ly = legend_y - 8.0,
            tx = left + 16.0,
            ty = legend_y,
            label = xml_escape(&entry.label),
        ));
    }

    if series.len() > 1 {
        body.push_str(&format!(
            r#"<text x="{right:.1}" y="{y:.1}" font-size="9" text-anchor="end" fill="{AXIS_COLOR}">each series scaled to its own range</text>"#,
            y = top + 8.0,
        ));
    }

    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}">{body}</svg>"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot_with_observable(generation: u64, value: f64, feasible: bool) -> ProjectSnapshot {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("snapshot.json");
        std::fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({
                "schema_version": "1.0",
                "generation": generation,
                "graph_digest": "sha256:graph",
                "artifact_manifest_digest": "sha256:manifest",
                "graph": {"nodes": [], "containment": []},
                "observables": [
                    {
                        "observable_id": "payload_margin",
                        "kind": "constraint_margin",
                        "label": "Payload margin",
                        "value": value,
                        "unit": "kg",
                        "feasible": feasible,
                        "source_ids": [],
                    }
                ],
                "provenance": {},
            }))
            .unwrap(),
        )
        .unwrap();
        Box::leak(Box::new(dir));
        ProjectSnapshot::load(&path).unwrap()
    }

    fn snapshot_with_observable_and_graph(
        generation: u64,
        value: f64,
        feasible: bool,
        graph: serde_json::Value,
    ) -> ProjectSnapshot {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("snapshot.json");
        std::fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({
                "schema_version": "1.0",
                "generation": generation,
                "graph_digest": "sha256:graph",
                "artifact_manifest_digest": "sha256:manifest",
                "graph": graph,
                "observables": [
                    {
                        "observable_id": "payload_margin",
                        "kind": "constraint_margin",
                        "label": "Payload margin",
                        "value": value,
                        "unit": "kg",
                        "feasible": feasible,
                        "source_ids": [],
                    }
                ],
                "provenance": {},
            }))
            .unwrap(),
        )
        .unwrap();
        Box::leak(Box::new(dir));
        ProjectSnapshot::load(&path).unwrap()
    }

    #[test]
    fn derive_extracts_numeric_observables_only_from_succeeded_points() {
        let succeeded = snapshot_with_observable(1, 12.0, true);
        let points = vec![
            SweepPointInput {
                index: 0,
                axis_value: 40.0,
                status: SweepStatus::Succeeded,
                snapshot: Some(&succeeded),
            },
            SweepPointInput {
                index: 1,
                axis_value: 50.0,
                status: SweepStatus::Failed,
                snapshot: None,
            },
        ];
        let view_model = SweepViewModel::derive("requirements.payload_kg", &points);
        assert_eq!(view_model.rows.len(), 2);
        assert_eq!(view_model.rows[0].observables.len(), 1);
        assert_eq!(view_model.rows[0].observables[0].value, 12.0);
        assert!(view_model.rows[1].observables.is_empty());
    }

    #[test]
    fn series_groups_samples_by_observable_id_and_skips_non_succeeded_rows() {
        let a = snapshot_with_observable(1, 12.0, true);
        let b = snapshot_with_observable(2, -2.0, false);
        let points = vec![
            SweepPointInput {
                index: 0,
                axis_value: 40.0,
                status: SweepStatus::Succeeded,
                snapshot: Some(&a),
            },
            SweepPointInput {
                index: 1,
                axis_value: 55.0,
                status: SweepStatus::Cancelled,
                snapshot: None,
            },
            SweepPointInput {
                index: 2,
                axis_value: 60.0,
                status: SweepStatus::Succeeded,
                snapshot: Some(&b),
            },
        ];
        let view_model = SweepViewModel::derive("requirements.payload_kg", &points);
        let series = view_model.series();
        assert_eq!(series.len(), 1);
        assert_eq!(series[0].observable_id, "payload_margin");
        assert_eq!(series[0].samples, vec![(40.0, 12.0), (60.0, -2.0)]);
        assert_eq!(
            series[0].feasible_samples,
            vec![(40.0, true), (60.0, false)]
        );
    }

    #[test]
    fn point_clicked_reduces_to_inspect_snapshot() {
        let snapshot = snapshot_with_observable(1, 12.0, true);
        let command = reduce_sweep_intent(SweepIntent::PointClicked {
            snapshot: snapshot.clone(),
        });
        match command {
            AppCommand::InspectSnapshot(installed) => {
                assert_eq!(installed.evaluation().generation, 1);
            }
            other => panic!("expected InspectSnapshot, got {other:?}"),
        }
    }

    fn series_from(
        samples: Vec<(f64, f64)>,
        feasible_samples: Vec<(f64, bool)>,
    ) -> ObservableSeries {
        ObservableSeries {
            observable_id: "payload_margin".into(),
            label: "Payload margin".into(),
            kind: ObservableKind::ConstraintMargin,
            samples,
            feasible_samples,
        }
    }

    #[test]
    fn render_envelope_svg_is_well_formed_and_plots_every_sample() {
        let series = vec![series_from(
            vec![(0.0, 10.0), (30.0, 5.0), (60.0, -1.0)],
            vec![(0.0, true), (30.0, true), (60.0, false)],
        )];
        let svg = render_envelope_svg(&series, 480.0, 240.0);
        assert!(svg.starts_with("<svg"));
        assert!(svg.ends_with("</svg>"));
        assert_eq!(svg.matches("<circle").count(), 3);
        assert_eq!(svg.matches("<polyline").count(), 1);
        // Two feasible markers (green) and one infeasible (red).
        assert_eq!(svg.matches(FEASIBLE_COLOR).count(), 2);
        assert!(svg.contains(INFEASIBLE_COLOR));
        assert!(svg.contains("0.000"));
        assert!(svg.contains("60.000"));
    }

    #[test]
    fn render_envelope_svg_handles_no_succeeded_points_without_panicking() {
        let svg = render_envelope_svg(&[], 480.0, 240.0);
        assert!(svg.starts_with("<svg"));
        assert!(svg.contains("No succeeded points yet"));
    }

    #[test]
    fn render_envelope_svg_escapes_labels() {
        let mut series = series_from(vec![(0.0, 1.0)], vec![]);
        series.label = "A & B < C".into();
        let svg = render_envelope_svg(&[series], 480.0, 240.0);
        assert!(svg.contains("A &amp; B &lt; C"));
        assert!(!svg.contains("A & B < C"));
    }

    #[test]
    fn render_envelope_svg_labels_multiple_series_with_their_own_ranges() {
        let a = series_from(vec![(0.0, 10.0), (10.0, 20.0)], vec![]);
        let mut b = series_from(vec![(0.0, 100.0), (10.0, 200.0)], vec![]);
        b.observable_id = "other".into();
        b.label = "Other".into();
        let svg = render_envelope_svg(&[a, b], 480.0, 240.0);
        assert_eq!(svg.matches("<polyline").count(), 2);
        assert!(svg.contains("each series scaled to its own range"));
    }

    #[test]
    fn compare_candidates_reports_the_observable_delta_and_feasibility_flip() {
        let a = snapshot_with_observable(1, 5.0, true);
        let b = snapshot_with_observable(2, -2.0, false);
        let comparison = compare_candidates(&a, &b);
        assert_eq!(comparison.observable_deltas.len(), 1);
        let delta = &comparison.observable_deltas[0];
        assert_eq!(delta.observable_id, "payload_margin");
        assert_eq!(delta.before, 5.0);
        assert_eq!(delta.after, -2.0);
        assert_eq!(delta.delta, -7.0);
        assert_eq!(delta.feasible_before, Some(true));
        assert_eq!(delta.feasible_after, Some(false));
    }

    #[test]
    fn compare_candidates_reports_graph_structure_changes() {
        let graph_a = serde_json::json!({
            "nodes": [
                {"node_id": "a", "instance_key": "a", "kind": "part", "definition_id": "test.part", "parameters": {}},
            ],
            "containment": [],
        });
        let graph_b = serde_json::json!({
            "nodes": [
                {"node_id": "a", "instance_key": "a", "kind": "part", "definition_id": "test.part.v2", "parameters": {}},
                {"node_id": "b", "instance_key": "b", "kind": "part", "definition_id": "test.part", "parameters": {}},
            ],
            "containment": [],
        });
        let a = snapshot_with_observable_and_graph(1, 5.0, true, graph_a);
        let b = snapshot_with_observable_and_graph(2, 5.0, true, graph_b);
        let comparison = compare_candidates(&a, &b);
        // Identical observables produce no delta...
        assert!(
            comparison
                .observable_deltas
                .iter()
                .all(|delta| delta.delta == 0.0)
        );
        // ...but the graph genuinely changed (a new node, a changed definition_id).
        assert!(!comparison.graph_changes.is_empty());
    }

    #[test]
    fn compare_candidates_omits_an_observable_present_in_only_one_snapshot() {
        let a = snapshot_with_observable(1, 5.0, true);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("snapshot.json");
        std::fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({
                "schema_version": "1.0",
                "generation": 2,
                "graph_digest": "sha256:graph",
                "artifact_manifest_digest": "sha256:manifest",
                "graph": {"nodes": [], "containment": []},
                "observables": [],
                "provenance": {},
            }))
            .unwrap(),
        )
        .unwrap();
        Box::leak(Box::new(dir));
        let b = ProjectSnapshot::load(&path).unwrap();
        let comparison = compare_candidates(&a, &b);
        assert!(comparison.observable_deltas.is_empty());
    }
}
