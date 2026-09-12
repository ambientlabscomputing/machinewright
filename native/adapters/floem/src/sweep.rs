//! Sweep execution: a dedicated worker process (never the interactive
//! session's) drives a `machinewright_analysis::Sweep` to completion or
//! cancellation on a background thread, streaming one `SweepPointUpdate`
//! per point. A dedicated worker so a long sweep never starves live-edit
//! reevaluation on the interactive worker — see RFD-19 M3's design
//! decisions on this.
//!
//! This module owns *execution* (real threads/processes) — the sweep
//! panel's *view* of this state lives in `machinewright_ui::sweep`
//! (`SweepViewModel`), which this module's caller derives from the
//! `SweepPointUpdate`s this produces.

use std::{
    cell::RefCell,
    path::PathBuf,
    rc::Rc,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};

use floem::{
    IntoView,
    ext_event::create_signal_from_channel,
    prelude::*,
    reactive::{RwSignal, SignalGet, SignalUpdate, create_effect},
    views::{button, dyn_stack, h_stack, label, svg, text_input, v_stack},
};
use machinewright_analysis::{Sweep, SweepStatus};
use machinewright_app::{AppCommand, EvaluationRequest, ProjectSession};
use machinewright_evaluator::{ResourcePolicy, WorkerSender, WorkerSupervisor};
use machinewright_model::ProjectSnapshot;
use machinewright_protocol::v1::{CancelEvaluation, WorkerRequest, worker_request};
use machinewright_render::{Scene, ViewportState};
use machinewright_ui::sweep::{SweepPointInput, SweepViewModel, compare_candidates, render_envelope_svg};
use machinewright_workspace::EnvironmentSpec;
use serde_json::Value;

use crate::button_style::{ButtonVariant, ButtonVariantExt};
use crate::theme;
use crate::{
    LatestViewportSender, VIEWPORT_HEIGHT_PX, VIEWPORT_WIDTH_PX, ViewportRequest,
    controls::effective_inputs, evaluate_supervised, resolve_and_spawn,
};

pub struct SweepRequest {
    pub project_root: PathBuf,
    pub template_id: String,
    pub template_version: String,
    pub environment_digest: String,
    pub base_inputs: Value,
    pub parameter_path: String,
    pub start: f64,
    pub stop: f64,
    pub points: usize,
    /// Root directory each point's evaluation output is written under
    /// (`{output_root}/point-XXXX`), mirroring `machinewright project
    /// sweep`'s own layout.
    pub output_root: PathBuf,
}

/// One point's outcome, streamed back as the sweep runs so the panel can
/// update live rather than waiting for the whole sweep to finish.
#[derive(Clone)]
pub struct SweepPointUpdate {
    pub index: usize,
    pub axis_value: f64,
    pub status: SweepStatus,
    pub snapshot: Option<ProjectSnapshot>,
    /// This point's own evaluation output directory — where its mesh files
    /// live, needed to load its geometry (`Scene::load(snapshot,
    /// artifact_root)`) when the point is later inspected.
    pub artifact_root: PathBuf,
    pub error: Option<String>,
}

/// Lets the adapter cancel a running sweep from the UI thread without
/// blocking on the sweep's own execution thread.
#[derive(Clone)]
pub struct SweepHandle {
    session_id: String,
    sender: WorkerSender,
    cancel_requested: Arc<Mutex<Option<(u64, Instant)>>>,
    cancel_flag: Arc<AtomicBool>,
    running_generation: Arc<Mutex<Option<u64>>>,
}

impl SweepHandle {
    /// No further pending points are started, and if a point is currently
    /// in flight, its generation is cancelled on the sweep's dedicated
    /// worker (a real wire-level `CancelEvaluation`, not just a stop of
    /// future scheduling).
    pub fn cancel(&self) {
        self.cancel_flag.store(true, Ordering::SeqCst);
        let Some(generation) = self
            .running_generation
            .lock()
            .ok()
            .and_then(|guard| *guard)
        else {
            return;
        };
        let _ = self.sender.send(&WorkerRequest {
            request: Some(worker_request::Request::Cancel(CancelEvaluation {
                session_id: self.session_id.clone(),
                generation,
            })),
        });
        if let Ok(mut slot) = self.cancel_requested.lock() {
            *slot = Some((generation, Instant::now()));
        }
    }
}

fn axis_values(start: f64, stop: f64, points: usize) -> Vec<f64> {
    if points < 2 {
        return vec![start];
    }
    (0..points)
        .map(|index| start + (stop - start) * index as f64 / (points - 1) as f64)
        .collect()
}

/// Spawns a dedicated worker process for `request` and runs its sweep on a
/// background thread, streaming one `SweepPointUpdate` per point as it
/// completes. Returns immediately with a handle and the update receiver;
/// the sweep continues until every point is evaluated, cancelled, or the
/// worker fails outright.
pub fn start_sweep(
    request: SweepRequest,
) -> Result<(SweepHandle, crossbeam_channel::Receiver<SweepPointUpdate>), String> {
    if request.points < 2 {
        return Err("a sweep needs at least 2 points".into());
    }
    let (mut worker, _capabilities, _developer_override) = resolve_and_spawn(&request.project_root)?;
    let session_id = format!("sweep-{}", std::process::id());
    let sender = worker.sender();
    let cancel_requested = Arc::new(Mutex::new(None));
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let running_generation = Arc::new(Mutex::new(None));
    let handle = SweepHandle {
        session_id: session_id.clone(),
        sender,
        cancel_requested: Arc::clone(&cancel_requested),
        cancel_flag: Arc::clone(&cancel_flag),
        running_generation: Arc::clone(&running_generation),
    };
    let (update_tx, update_rx) = crossbeam_channel::unbounded::<SweepPointUpdate>();

    std::thread::spawn(move || {
        let values = axis_values(request.start, request.stop, request.points);
        let mut sweep = match Sweep::from_axis(
            &request.base_inputs,
            &request.parameter_path,
            values.iter().copied(),
        ) {
            Ok(sweep) => sweep,
            Err(error) => {
                let _ = update_tx.send(SweepPointUpdate {
                    index: 0,
                    axis_value: request.start,
                    status: SweepStatus::Failed,
                    snapshot: None,
                    artifact_root: request.output_root.clone(),
                    error: Some(error.to_string()),
                });
                return;
            }
        };
        let logs = worker.logs();
        let supervisor = Arc::new(Mutex::new(WorkerSupervisor::new(ResourcePolicy::default())));
        loop {
            if cancel_flag.load(Ordering::SeqCst) {
                break;
            }
            let Some((index, inputs)) = sweep
                .next_pending()
                .map(|point| (point.index, point.inputs.clone()))
            else {
                break;
            };
            let axis_value = values[index];
            let generation = (index + 1) as u64;
            let point_output_directory = request.output_root.join(format!("point-{index:04}"));
            if let Ok(mut slot) = running_generation.lock() {
                *slot = Some(generation);
            }
            let eval_request = EvaluationRequest {
                session_id: session_id.clone(),
                generation,
                project_root: request.project_root.clone(),
                template_id: request.template_id.clone(),
                template_version: request.template_version.clone(),
                inputs_json: serde_json::to_vec(&inputs).unwrap_or_default(),
                output_directory: point_output_directory.clone(),
                overlays: Vec::new(),
                environment_digest: request.environment_digest.clone(),
            };
            let result = evaluate_supervised(
                &mut worker,
                &eval_request,
                &supervisor,
                &cancel_requested,
                &logs,
            );
            if let Ok(mut slot) = running_generation.lock() {
                *slot = None;
            }
            let cancelled_mid_point = cancel_flag.load(Ordering::SeqCst);
            let (status, snapshot, error) = match result {
                Ok(outcome) => (SweepStatus::Succeeded, Some(outcome.snapshot), None),
                Err(port_error) => {
                    let status = if cancelled_mid_point {
                        SweepStatus::Cancelled
                    } else {
                        SweepStatus::Failed
                    };
                    (status, None, Some(port_error.message))
                }
            };
            sweep.points[index].status = status.clone();
            sweep.points[index].error = error.clone();
            let _ = update_tx.send(SweepPointUpdate {
                index,
                axis_value,
                status,
                snapshot,
                artifact_root: point_output_directory,
                error,
            });
            if cancelled_mid_point {
                break;
            }
        }
        if cancel_flag.load(Ordering::SeqCst) {
            sweep.cancel();
            for point in &sweep.points {
                if point.status == SweepStatus::Cancelled {
                    let _ = update_tx.send(SweepPointUpdate {
                        index: point.index,
                        axis_value: values[point.index],
                        status: SweepStatus::Cancelled,
                        snapshot: None,
                        artifact_root: request.output_root.join(format!("point-{:04}", point.index)),
                        error: None,
                    });
                }
            }
        }
        let _ = worker.shutdown();
    });

    Ok((handle, update_rx))
}

/// One point's retained UI state: enough to render its row and, once
/// evaluated, to inspect its geometry on click.
#[derive(Clone)]
struct SweepRowState {
    index: usize,
    axis_value: f64,
    status: SweepStatus,
    snapshot: Option<ProjectSnapshot>,
    artifact_root: PathBuf,
    error: Option<String>,
}

impl From<SweepPointUpdate> for SweepRowState {
    fn from(update: SweepPointUpdate) -> Self {
        Self {
            index: update.index,
            axis_value: update.axis_value,
            status: update.status,
            snapshot: update.snapshot,
            artifact_root: update.artifact_root,
            error: update.error,
        }
    }
}

fn format_row_summary(parameter_path: &str, row: &SweepRowState) -> String {
    let inputs = [SweepPointInput {
        index: row.index,
        axis_value: row.axis_value,
        status: row.status.clone(),
        snapshot: row.snapshot.as_ref(),
    }];
    let view_model = SweepViewModel::derive(parameter_path, &inputs);
    let observables = &view_model.rows[0].observables;
    if observables.is_empty() {
        return String::new();
    }
    observables
        .iter()
        .map(|observable| match observable.feasible {
            Some(feasible) => format!(
                "{}={:.3} ({})",
                observable.label,
                observable.value,
                if feasible { "feasible" } else { "infeasible" }
            ),
            None => format!("{}={:.3}", observable.label, observable.value),
        })
        .collect::<Vec<_>>()
        .join(" · ")
}

/// Builds the Behavior Lab's sweep panel: pick a dotted input path and a
/// start/stop/point-count range, run a cancellable sweep against a
/// dedicated worker, and click a completed point to load its geometry into
/// the same viewport the live session uses (without disturbing the live
/// session's own snapshot/selection — see `AppCommand::InspectSnapshot`).
pub(crate) fn sweep_panel(
    session: Rc<RefCell<ProjectSession>>,
    evaluation_status: RwSignal<String>,
    viewport_state: Rc<RefCell<ViewportState>>,
    current_scene: Rc<RefCell<Scene>>,
    viewport_requests: LatestViewportSender,
) -> impl IntoView {
    let parameter_path_text = RwSignal::new(String::new());
    let start_text = RwSignal::new("0".to_string());
    let stop_text = RwSignal::new("100".to_string());
    let points_text = RwSignal::new("11".to_string());
    let status = RwSignal::new(String::new());
    let rows: RwSignal<im::Vector<SweepRowState>> = RwSignal::new(im::Vector::new());
    let handle: Rc<RefCell<Option<SweepHandle>>> = Rc::new(RefCell::new(None));
    let inspecting: RwSignal<bool> = RwSignal::new(false);

    let run_session = Rc::clone(&session);
    let run_handle = Rc::clone(&handle);
    let run = button("Run sweep").action(move || {
        let (project_root, template_id, template_version) = {
            let session = run_session.borrow();
            (
                session.project.root.clone(),
                session.project.template_id.clone(),
                session.project.template_version.clone(),
            )
        };
        let environment_digest = match EnvironmentSpec::resolve(&project_root) {
            Ok(spec) => spec.lock_digest,
            Err(error) => {
                status.set(error.to_string());
                return;
            }
        };
        let parameter_path = parameter_path_text.get();
        let (Ok(start), Ok(stop), Ok(points)) = (
            start_text.get().trim().parse::<f64>(),
            stop_text.get().trim().parse::<f64>(),
            points_text.get().trim().parse::<usize>(),
        ) else {
            status.set("start/stop must be numbers, points must be a whole number".into());
            return;
        };
        let base_inputs = effective_inputs(&run_session.borrow());
        let output_root = std::env::temp_dir()
            .join("machinewright-native")
            .join(std::process::id().to_string())
            .join("sweep")
            .join(format!("run-{}", std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or_default()));
        let request = SweepRequest {
            project_root,
            template_id,
            template_version,
            environment_digest,
            base_inputs,
            parameter_path,
            start,
            stop,
            points,
            output_root,
        };
        match start_sweep(request) {
            Ok((new_handle, update_rx)) => {
                *run_handle.borrow_mut() = Some(new_handle);
                rows.set(im::Vector::new());
                status.set("Sweep running…".into());
                let updates = create_signal_from_channel(update_rx);
                let effect_rows = rows;
                let effect_status = status;
                create_effect(move |_| {
                    let Some(update) = updates.get() else {
                        return;
                    };
                    let is_terminal_failure =
                        matches!(update.status, SweepStatus::Failed) && update.snapshot.is_none();
                    if is_terminal_failure && let Some(error) = &update.error {
                        effect_status.set(format!("Point {} failed: {error}", update.index));
                    }
                    effect_rows.update(|rows| {
                        let row = SweepRowState::from(update);
                        match rows.iter().position(|existing| existing.index == row.index) {
                            Some(position) => {
                                rows.set(position, row);
                            }
                            None => {
                                let insert_at = rows
                                    .iter()
                                    .position(|existing| existing.index > row.index)
                                    .unwrap_or(rows.len());
                                rows.insert(insert_at, row);
                            }
                        }
                    });
                });
            }
            Err(error) => status.set(error),
        }
    })
    .variant(ButtonVariant::Primary);

    let cancel_handle = Rc::clone(&handle);
    let cancel_status = status;
    let cancel = button("Cancel")
        .action(move || {
            if let Some(handle) = cancel_handle.borrow().as_ref() {
                handle.cancel();
                cancel_status.set("Cancelling…".into());
            }
        })
        .variant(ButtonVariant::Destructive);

    let return_to_live_session = Rc::clone(&session);
    let return_to_live_state = Rc::clone(&viewport_state);
    let return_to_live_scene = Rc::clone(&current_scene);
    let return_to_live_requests = viewport_requests.clone();
    let return_to_live_inspecting = inspecting;
    let return_to_live = button("Return to live").action(move || {
        let _ = return_to_live_session
            .borrow_mut()
            .dispatch(AppCommand::ReturnToLive);
        let state = return_to_live_state.borrow().clone();
        let _ = return_to_live_requests.try_send(ViewportRequest {
            scene: return_to_live_scene.borrow().clone(),
            state,
            width: VIEWPORT_WIDTH_PX as u32,
            height: VIEWPORT_HEIGHT_PX as u32,
        });
        return_to_live_inspecting.set(false);
    })
    .variant(ButtonVariant::Ghost);

    const PLOT_WIDTH: f64 = 460.0;
    const PLOT_HEIGHT: f64 = 180.0;
    let plot_view = svg(String::new())
        .update_value(move || {
            let current_rows = rows.get();
            let parameter_path = parameter_path_text.get_untracked();
            let inputs: Vec<SweepPointInput> = current_rows
                .iter()
                .map(|row| SweepPointInput {
                    index: row.index,
                    axis_value: row.axis_value,
                    status: row.status.clone(),
                    snapshot: row.snapshot.as_ref(),
                })
                .collect();
            let view_model = SweepViewModel::derive(&parameter_path, &inputs);
            render_envelope_svg(&view_model.series(), PLOT_WIDTH, PLOT_HEIGHT)
        })
        .style(|style| style.width(PLOT_WIDTH).height(PLOT_HEIGHT));

    // Candidate change comparison (RFD-19 M3's "candidate changes" — see
    // `machinewright_ui::sweep::compare_candidates`): two rows the user
    // has marked "A"/"B" via the per-row buttons below. Holds a row
    // *index*, not a snapshot directly, so the marked candidates track
    // whichever row currently has that index even as the sweep keeps
    // streaming in updates.
    let candidate_a: RwSignal<Option<usize>> = RwSignal::new(None);
    let candidate_b: RwSignal<Option<usize>> = RwSignal::new(None);

    let row_session = Rc::clone(&session);
    let row_viewport_state = Rc::clone(&viewport_state);
    let row_viewport_requests = viewport_requests.clone();
    let row_evaluation_status = evaluation_status;
    let row_inspecting = inspecting;
    let row_parameter_path = parameter_path_text;
    let rows_view = dyn_stack(
        move || rows.get(),
        |row: &SweepRowState| row.index,
        move |row: SweepRowState| {
            let summary = format_row_summary(&row_parameter_path.get_untracked(), &row);
            let detail = match (&row.error, summary.is_empty()) {
                (Some(error), _) => format!("  ·  {error}"),
                (None, false) => format!("  ·  {summary}"),
                (None, true) => String::new(),
            };
            let base_text = format!("#{:03}  {:.4}  {:?}{detail}", row.index, row.axis_value, row.status);
            let can_inspect = row.snapshot.is_some();
            let row_index = row.index;
            let session = Rc::clone(&row_session);
            let viewport_state = Rc::clone(&row_viewport_state);
            let viewport_requests = row_viewport_requests.clone();
            let evaluation_status = row_evaluation_status;
            let inspecting = row_inspecting;
            let snapshot = row.snapshot.clone();
            let artifact_root = row.artifact_root.clone();
            let view = button("View").action(move || {
                let Some(snapshot) = snapshot.clone() else {
                    return;
                };
                let _ = session
                    .borrow_mut()
                    .dispatch(AppCommand::InspectSnapshot(snapshot.clone()));
                match Scene::load(&snapshot, &artifact_root) {
                    Ok(scene) => {
                        let state = viewport_state.borrow().clone();
                        let _ = viewport_requests.try_send(ViewportRequest {
                            scene,
                            state,
                            width: VIEWPORT_WIDTH_PX as u32,
                            height: VIEWPORT_HEIGHT_PX as u32,
                        });
                        inspecting.set(true);
                    }
                    Err(error) => evaluation_status.set(format!("Failed to load point geometry: {error}")),
                }
            })
            .disabled(move || !can_inspect)
            .variant(ButtonVariant::Secondary);
            let set_a = button("A")
                .action(move || candidate_a.set(Some(row_index)))
                .disabled(move || !can_inspect)
                .variant(ButtonVariant::Icon);
            let set_b = button("B")
                .action(move || candidate_b.set(Some(row_index)))
                .disabled(move || !can_inspect)
                .variant(ButtonVariant::Icon);
            let row_label = label(move || {
                let marker = match (candidate_a.get() == Some(row_index), candidate_b.get() == Some(row_index)) {
                    (true, true) => "  [A,B]",
                    (true, false) => "  [A]",
                    (false, true) => "  [B]",
                    (false, false) => "",
                };
                format!("{base_text}{marker}")
            });
            h_stack((row_label, view, set_a, set_b))
                .style(|style| style.gap(theme::space::SM).padding_vert(theme::space::XS).items_center())
        },
    );

    // Renders `compare_candidates` once both A and B are marked on rows
    // that have actually evaluated — the RFD's own "candidate changes"
    // example (observable deltas plus what changed structurally) rather
    // than just the envelope plot.
    const MAX_GRAPH_CHANGES_SHOWN: usize = 15;
    let comparison_view = label(move || {
        let (Some(a_index), Some(b_index)) = (candidate_a.get(), candidate_b.get()) else {
            return "Mark two evaluated points \"A\" and \"B\" to compare them.".to_string();
        };
        let current_rows = rows.get();
        let find = |index: usize| {
            current_rows
                .iter()
                .find(|row| row.index == index)
                .and_then(|row| row.snapshot.clone())
        };
        let (Some(snapshot_a), Some(snapshot_b)) = (find(a_index), find(b_index)) else {
            return "Waiting for both candidates to finish evaluating…".to_string();
        };
        let comparison = compare_candidates(&snapshot_a, &snapshot_b);
        let mut lines = vec![format!("Candidate changes: #{a_index:03} (A) vs #{b_index:03} (B)")];
        if comparison.observable_deltas.is_empty() {
            lines.push("  (no shared numeric observables)".to_string());
        }
        for delta in &comparison.observable_deltas {
            let feasibility = match (delta.feasible_before, delta.feasible_after) {
                (Some(before), Some(after)) if before != after => format!(
                    "  [{} → {}]",
                    if before { "feasible" } else { "infeasible" },
                    if after { "feasible" } else { "infeasible" }
                ),
                _ => String::new(),
            };
            lines.push(format!(
                "  {}: {:.4} → {:.4}  (Δ {:+.4}){feasibility}",
                delta.label, delta.before, delta.after, delta.delta
            ));
        }
        if comparison.graph_changes.is_empty() {
            lines.push("  Graph unchanged.".to_string());
        } else {
            lines.push(format!("  Graph changes ({}):", comparison.graph_changes.len()));
            for change in comparison.graph_changes.iter().take(MAX_GRAPH_CHANGES_SHOWN) {
                lines.push(format!(
                    "    {}: {} → {}",
                    change.path,
                    change.before.as_deref().unwrap_or("(absent)"),
                    change.after.as_deref().unwrap_or("(absent)"),
                ));
            }
            if comparison.graph_changes.len() > MAX_GRAPH_CHANGES_SHOWN {
                lines.push(format!(
                    "    … {} more",
                    comparison.graph_changes.len() - MAX_GRAPH_CHANGES_SHOWN
                ));
            }
        }
        lines.join("\n")
    })
    .style(|style| style.padding_vert(theme::space::SM));

    v_stack((
        label(|| "Behavior Lab · Sweep".to_string()),
        h_stack((
            label(|| "Parameter path".to_string()),
            text_input(parameter_path_text).style(|style| style.width(200.0)),
        ))
        .style(|style| style.gap(theme::space::SM)),
        h_stack((
            label(|| "Start".to_string()),
            text_input(start_text).style(|style| style.width(70.0)),
            label(|| "Stop".to_string()),
            text_input(stop_text).style(|style| style.width(70.0)),
            label(|| "Points".to_string()),
            text_input(points_text).style(|style| style.width(60.0)),
            run,
            cancel,
            return_to_live,
        ))
        .style(|style| style.gap(theme::space::SM).items_center()),
        label(move || status.get()),
        label(move || {
            if inspecting.get() {
                "Viewport is showing a sweep point — Return to live to resume editing.".to_string()
            } else {
                String::new()
            }
        }),
        plot_view,
        rows_view,
        comparison_view,
    ))
    .style(|style| style.gap(theme::space::SM).padding(theme::space::MD).width_full())
}

#[cfg(test)]
mod tests {
    use super::axis_values;

    #[test]
    fn axis_values_spans_start_to_stop_inclusive() {
        let values = axis_values(0.0, 60.0, 21);
        assert_eq!(values.len(), 21);
        assert_eq!(values[0], 0.0);
        assert_eq!(values[20], 60.0);
        assert_eq!(values[10], 30.0);
    }
}
