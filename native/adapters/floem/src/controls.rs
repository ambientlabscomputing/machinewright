//! Behavior Lab "controls" panel: renders one widget per typed input field
//! (derived from the template's JSON Schema by
//! `machinewright_ui::controls::ControlsViewModel`) and drives edits
//! through the same debounce/reevaluation seam ordinary source edits use.

use std::{
    cell::RefCell,
    path::{Path, PathBuf},
    rc::Rc,
    sync::{Arc, Mutex},
};

use floem::{
    IntoView,
    ext_event::create_signal_from_channel,
    prelude::*,
    reactive::{RwSignal, SignalGet, SignalUpdate, create_effect},
    views::{button, dyn_stack, h_stack, label, slider::slider, text_input, v_stack},
};
use machinewright_app::{EvaluationRuntime, ProjectSession};
use machinewright_ui::controls::{
    ControlField, ControlIntent, ControlKind, ControlsViewModel, reduce_control_intent,
};
use serde_json::Value;

use crate::button_style::{ButtonVariant, ButtonVariantExt};
use crate::theme;
use crate::{LatestEvaluationSender, SharedWorkerSender, schedule_evaluation};

fn cli_executable(worker_executable: &Path) -> PathBuf {
    if cfg!(windows) {
        worker_executable.with_file_name("machinewright.exe")
    } else {
        worker_executable.with_file_name("machinewright")
    }
}

/// Fetches a template's input JSON Schema via `machinewright project
/// schema`, using the project's own resolved environment — the CLI already
/// produces exactly this from `MachineTemplate.input_schema()`, so there is
/// no need for a dedicated wire-protocol schema-request message (see
/// RFD-19 M3's design decisions on this).
pub(crate) fn fetch_input_schema(
    worker_executable: &Path,
    project_root: &Path,
    template_id: &str,
    template_version: &str,
) -> Result<Value, String> {
    let cli = cli_executable(worker_executable);
    let output_path = std::env::temp_dir().join(format!(
        "machinewright-schema-{}-{}-{}.json",
        std::process::id(),
        template_id.replace(['.', '@', '/'], "_"),
        template_version.replace(['.', '@', '/'], "_"),
    ));
    let status = std::process::Command::new(&cli)
        .args(["project", "schema", template_id, template_version])
        .arg(&output_path)
        .arg("--root")
        .arg(project_root)
        .status()
        .map_err(|error| format!("failed to launch {}: {error}", cli.display()))?;
    if !status.success() {
        return Err(format!("machinewright project schema exited with {status}"));
    }
    let bytes = std::fs::read(&output_path).map_err(|error| error.to_string())?;
    let _ = std::fs::remove_file(&output_path);
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

/// The inputs document the next evaluation would actually use: the
/// session's override if one is set, otherwise the on-disk input file —
/// mirrors `PortableProject::session_evaluation_request`'s own fallback.
pub(crate) fn effective_inputs(session: &ProjectSession) -> Value {
    let bytes = session
        .input_override
        .clone()
        .or_else(|| std::fs::read(&session.project.input_path).ok())
        .unwrap_or_default();
    serde_json::from_slice(&bytes).unwrap_or_else(|_| Value::Object(serde_json::Map::new()))
}

fn format_control_value(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn parse_control_value(kind: &ControlKind, raw: &str) -> Result<Value, String> {
    match kind {
        ControlKind::Bounded { min, max } => {
            let parsed: f64 = raw
                .trim()
                .parse()
                .map_err(|_| format!("{raw:?} is not a number"))?;
            if parsed < *min || parsed > *max {
                return Err(format!("{parsed} is outside [{min}, {max}]"));
            }
            Ok(serde_json::json!(parsed))
        }
        ControlKind::Number => {
            let parsed: f64 = raw
                .trim()
                .parse()
                .map_err(|_| format!("{raw:?} is not a number"))?;
            Ok(serde_json::json!(parsed))
        }
        ControlKind::Boolean => match raw.trim().to_ascii_lowercase().as_str() {
            "true" => Ok(Value::Bool(true)),
            "false" => Ok(Value::Bool(false)),
            _ => Err(format!("{raw:?} is not true/false")),
        },
        ControlKind::Text => Ok(Value::String(raw.to_owned())),
    }
}

/// Builds the controls panel for the session's currently declared template.
/// The schema is fetched once (a single subprocess call) when the panel is
/// constructed; see `fetch_input_schema`'s doc comment for why this isn't a
/// wire-protocol request.
pub(crate) fn controls_panel(
    session: Rc<RefCell<ProjectSession>>,
    evaluation_runtime: Arc<Mutex<EvaluationRuntime>>,
    worker_sender: SharedWorkerSender,
    requests: LatestEvaluationSender,
    evaluation_status: RwSignal<String>,
    worker_executable: PathBuf,
) -> impl IntoView {
    let (project_root, template_id, template_version) = {
        let session = session.borrow();
        (
            session.project.root.clone(),
            session.project.template_id.clone(),
            session.project.template_version.clone(),
        )
    };

    let status = RwSignal::new("Loading input schema…".to_string());
    let fields: RwSignal<im::Vector<ControlField>> = RwSignal::new(im::Vector::new());

    // Fetched on a background thread, never the UI thread — this is a
    // subprocess call (see `fetch_input_schema`'s doc comment), and RFD-19
    // hard requirement #7 ("Python evaluation never blocks the
    // foreground/UI thread") applies just as much to a one-time schema
    // fetch as to an evaluation.
    let (schema_tx, schema_rx) = crossbeam_channel::bounded(1);
    std::thread::spawn(move || {
        let result =
            fetch_input_schema(&worker_executable, &project_root, &template_id, &template_version);
        let _ = schema_tx.send(result);
    });
    let schema_signal = create_signal_from_channel(schema_rx);
    let schema_session = Rc::clone(&session);
    create_effect(move |_| {
        let Some(result) = schema_signal.get() else {
            return;
        };
        match result {
            Ok(schema) => {
                let inputs = effective_inputs(&schema_session.borrow());
                let view_model = ControlsViewModel::derive(&schema, &inputs);
                fields.set(view_model.fields.into_iter().collect());
                status.set(String::new());
            }
            Err(error) => status.set(format!("Failed to load input schema: {error}")),
        }
    });

    let rows = dyn_stack(
        move || fields.get(),
        |field: &ControlField| field.path.clone(),
        move |field: ControlField| {
            let row_label = field.label.clone();

            // Shared by both control kinds below: applies one field change
            // through the same reduce/dispatch/debounce path a source edit
            // uses. `Rc<dyn Fn>` so both a slider's live `on_change_pct`
            // and a button's one-shot `action` can each hold a cheap clone
            // of the same closure.
            let apply_change: Rc<dyn Fn(Value)> = {
                let session = Rc::clone(&session);
                let runtime = Arc::clone(&evaluation_runtime);
                let sender = worker_sender.clone();
                let requests = requests.clone();
                let status = evaluation_status;
                let path = field.path.clone();
                Rc::new(move |value: Value| {
                    let base_inputs = effective_inputs(&session.borrow());
                    let command = match reduce_control_intent(
                        &base_inputs,
                        ControlIntent::FieldChanged {
                            path: path.clone(),
                            value,
                        },
                    ) {
                        Ok(command) => command,
                        Err(error) => {
                            status.set(error.to_string());
                            return;
                        }
                    };
                    if session.borrow_mut().dispatch(command).is_ok() {
                        status.set("Waiting for evaluation…".into());
                        if let Err(error) =
                            schedule_evaluation(&session, &runtime, &sender, &requests)
                        {
                            status.set(error);
                        }
                    }
                })
            };

            let control = match field.kind.clone() {
                ControlKind::Bounded { min, max } => {
                    let value = RwSignal::new(field.value.as_f64().unwrap_or(min));
                    let on_change = Rc::clone(&apply_change);
                    // Fires continuously while dragging (every pointer-move
                    // while held, not just on release), which is exactly
                    // what `EvaluationRuntime`'s debounce/cancel-on-supersede
                    // path already exists to absorb — see
                    // `schedule_evaluation`.
                    let slider_view = slider(move || {
                        let span = (max - min).max(f64::EPSILON);
                        ((value.get() - min) / span * 100.0).clamp(0.0, 100.0).pct()
                    })
                    .on_change_pct(move |pct| {
                        let new_value = min + (pct.0 / 100.0) * (max - min);
                        value.set(new_value);
                        on_change(serde_json::json!(new_value));
                    })
                    .style(|style| style.width(140.0));
                    h_stack((
                        slider_view,
                        label(move || format!("{:.3}", value.get())).style(|style| style.width(70.0)),
                    ))
                    .style(|style| style.gap(theme::space::SM).items_center())
                    .into_any()
                }
                kind => {
                    let text = RwSignal::new(format_control_value(&field.value));
                    let on_change = Rc::clone(&apply_change);
                    let parse_status = evaluation_status;
                    let apply = button("Apply")
                        .action(move || {
                            let raw = text.get();
                            match parse_control_value(&kind, &raw) {
                                Ok(value) => on_change(value),
                                // `apply_change` reports its own errors through
                                // `evaluation_status` once dispatched — a parse
                                // failure never reaches it, so it must be
                                // reported here instead of silently dropped.
                                Err(error) => parse_status.set(error),
                            }
                        })
                        .variant(ButtonVariant::Secondary);
                    h_stack((
                        text_input(text).style(|style| style.width(120.0)),
                        apply,
                    ))
                    .style(|style| style.gap(theme::space::SM).items_center())
                    .into_any()
                }
            };

            h_stack((
                label(move || row_label.clone()).style(|style| style.width(180.0)),
                control,
            ))
            .style(|style| style.gap(theme::space::SM).padding_vert(theme::space::XS).items_center())
        },
    );

    v_stack((
        label(|| "Behavior Lab · Controls".to_string()),
        rows,
        label(move || status.get()),
    ))
    .style(|style| style.gap(theme::space::SM).padding(theme::space::MD).width_full())
}
