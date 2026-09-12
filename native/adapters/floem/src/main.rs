use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    rc::Rc,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use floem::ext_event::create_signal_from_channel;
use floem::{
    Application, IntoView,
    event::{Event, EventListener, EventPropagation},
    keyboard::{Key, Modifiers, NamedKey},
    kurbo::{Point, Size},
    pointer::PointerButton,
    prelude::*,
    quit_app,
    reactive::{RwSignal, SignalGet, SignalUpdate, create_effect},
    style::Style,
    views::{
        VirtualDirection, VirtualItemSize, button, dyn_container, dyn_stack, empty, h_stack, img,
        label, scroll, text_editor, text_input, v_stack,
    },
    window::WindowConfig,
};
use floem_editor_core::{cursor::CursorMode, editor::EditType, selection::Selection};
use machinewright_app::{
    AppCommand, AppEvent, EvaluationOutcome, EvaluationPort, EvaluationRequest, EvaluationRuntime,
    LanguagePort, PortError, PortableProject, PresentationUpdate, ProjectSession, RuntimeCommand,
    WorkerCapabilities,
};
use machinewright_cache::{CacheLease, SnapshotImport, SnapshotRecord, SnapshotStore};
use machinewright_editor::PythonSyntax;
use machinewright_evaluator::{
    ResourcePolicy, SupervisorAction, WorkerLog, WorkerMonitor, WorkerProcess, WorkerSender,
    WorkerSupervisor, force_kill,
};
use machinewright_language::TyLanguageServer;
use machinewright_model::ProjectSnapshot;
use machinewright_protocol::v1::{CancelEvaluation, WorkerRequest, worker_request};
use machinewright_render::{
    AxisView, OffscreenRenderer, PickTarget, Scene, ViewportCommand, ViewportState,
    orbit_drag_command, pan_drag_command, wheel_zoom_command,
};
use machinewright_ui::command_palette::{CommandPaletteViewModel, PaletteCommand, PaletteCommandId};
use machinewright_ui::graph::{GraphIntent, GraphRow, graph_rows, reduce_graph_intent};
use machinewright_ui::workspace::{Dock, PanelId, WorkspaceLayout, WorkspaceIntent, reduce_workspace_intent};
use machinewright_workspace::{
    Cursor as WorkspaceCursor, DiffKind, DiskChange, EnvironmentSpec, ProjectWatcher, TrustStore,
    WorkspacePreferences, is_relevant_project_path,
};
use sha2::{Digest, Sha256};

mod button_style;
mod command_palette_view;
mod controls;
mod sweep;
mod theme;
mod toolbar;

use button_style::{ButtonVariant, ButtonVariantExt};
use command_palette_view::{command_palette_overlay, open_palette};
use toolbar::toolbar_divider;

#[derive(Clone)]
struct EvaluationResult {
    generation: u64,
    artifact_root: PathBuf,
    result: Result<ProjectSnapshot, PortError>,
    lease: Option<Arc<CacheLease>>,
    source_blobs: BTreeMap<String, PathBuf>,
}

#[derive(Clone)]
pub(crate) struct LatestEvaluationSender {
    pending: Arc<Mutex<Option<EvaluationRequest>>>,
    wake: crossbeam_channel::Sender<()>,
}

impl LatestEvaluationSender {
    fn send(&self, request: EvaluationRequest) -> Result<(), String> {
        *self
            .pending
            .lock()
            .map_err(|_| "evaluation queue is unavailable")? = Some(request);
        match self.wake.try_send(()) {
            Ok(()) | Err(crossbeam_channel::TrySendError::Full(())) => Ok(()),
            Err(crossbeam_channel::TrySendError::Disconnected(())) => {
                Err("evaluation service stopped".into())
            }
        }
    }
}

/// A `WorkerSender` that survives worker respawns: cancellation is sent
/// through the currently-live worker's stdin, and the supervisor loop swaps
/// the inner sender in place after a crash restarts the process. Also
/// records when a cancellation was requested for a generation, so the
/// supervisor can force-terminate a worker that ignores it past its grace
/// period.
#[derive(Clone)]
pub(crate) struct SharedWorkerSender {
    inner: Arc<Mutex<Option<WorkerSender>>>,
    cancel_requested: Arc<Mutex<Option<(u64, Instant)>>>,
}

impl SharedWorkerSender {
    /// `None` means no worker has ever connected yet (environment
    /// resolution or the initial spawn failed at startup) — distinct from a
    /// live sender that later fails to write, and from `recovery_required`
    /// blocking the background loop, but all three end up surfacing the
    /// same "use Retry Worker" outcome to callers.
    fn new(sender: Option<WorkerSender>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(sender)),
            cancel_requested: Arc::new(Mutex::new(None)),
        }
    }

    fn send(&self, request: &WorkerRequest) -> Result<(), String> {
        let sender = self
            .inner
            .lock()
            .map_err(|_| "worker sender is unavailable".to_string())?;
        let sender = sender
            .as_ref()
            .ok_or_else(|| "worker is not connected".to_string())?;
        sender.send(request).map_err(|error| error.to_string())
    }

    fn send_cancel(&self, session_id: String, generation: u64) -> Result<(), String> {
        self.send(&WorkerRequest {
            request: Some(worker_request::Request::Cancel(CancelEvaluation {
                session_id,
                generation,
            })),
        })?;
        if let Ok(mut slot) = self.cancel_requested.lock() {
            *slot = Some((generation, Instant::now()));
        }
        Ok(())
    }

    fn replace(&self, sender: WorkerSender) {
        if let Ok(mut slot) = self.inner.lock() {
            *slot = Some(sender);
        }
    }
}

#[derive(Debug, PartialEq)]
enum LanguageRequest {
    Diagnostics {
        revision: u64,
        path: PathBuf,
        source: String,
    },
    Saved(PathBuf),
    WatchedFiles(Vec<PathBuf>),
    Close(PathBuf),
}

#[derive(Clone)]
struct LanguageResult {
    revision: u64,
    path: PathBuf,
    result: Result<Vec<machinewright_app::EditorDiagnostic>, String>,
}

type WorkerRuntime = (
    Option<WorkerCapabilities>,
    bool,
    SharedWorkerSender,
    LatestEvaluationSender,
    crossbeam_channel::Receiver<EvaluationResult>,
    crossbeam_channel::Receiver<Vec<String>>,
    crossbeam_channel::Receiver<String>,
    crossbeam_channel::Sender<()>,
    Arc<Mutex<EvaluationRuntime>>,
);

type LanguageRuntime = (
    crossbeam_channel::Sender<LanguageRequest>,
    crossbeam_channel::Receiver<LanguageResult>,
);

#[derive(Clone)]
pub(crate) struct ViewportRequest {
    pub(crate) scene: Scene,
    pub(crate) state: ViewportState,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

#[derive(Clone)]
pub(crate) struct LatestViewportSender {
    pending: Arc<Mutex<Option<(u64, ViewportRequest)>>>,
    wake: crossbeam_channel::Sender<()>,
    revision: Arc<AtomicU64>,
}

impl LatestViewportSender {
    pub(crate) fn try_send(&self, request: ViewportRequest) -> Result<(), ()> {
        let revision = self.revision.fetch_add(1, Ordering::SeqCst) + 1;
        *self.pending.lock().map_err(|_| ())? = Some((revision, request));
        match self.wake.try_send(()) {
            Ok(()) | Err(crossbeam_channel::TrySendError::Full(())) => Ok(()),
            Err(crossbeam_channel::TrySendError::Disconnected(())) => Err(()),
        }
    }

    fn revision(&self) -> u64 {
        self.revision.load(Ordering::SeqCst)
    }
}

#[derive(Clone)]
struct ViewportFrame {
    revision: u64,
    rgba: Arc<Vec<u8>>,
    width: u32,
    height: u32,
}

fn start_viewport() -> (
    LatestViewportSender,
    crossbeam_channel::Receiver<Result<ViewportFrame, String>>,
) {
    let pending = Arc::new(Mutex::new(None::<(u64, ViewportRequest)>));
    let (wake_tx, wake_rx) = crossbeam_channel::bounded::<()>(1);
    let request_tx = LatestViewportSender {
        pending: Arc::clone(&pending),
        wake: wake_tx,
        revision: Arc::new(AtomicU64::new(0)),
    };
    let (result_tx, result_rx) = crossbeam_channel::unbounded();
    std::thread::spawn(move || {
        let mut renderer = match pollster::block_on(OffscreenRenderer::new()) {
            Ok(renderer) => renderer,
            Err(error) => {
                let _ = result_tx.send(Err(error.to_string()));
                return;
            }
        };
        while wake_rx.recv().is_ok() {
            let Some((revision, request)) = pending.lock().ok().and_then(|mut slot| slot.take())
            else {
                continue;
            };
            let result = renderer
                .render_rgba(
                    &request.scene,
                    &request.state,
                    request.width,
                    request.height,
                )
                .map_err(|error| error.to_string())
                .map(|rgba| ViewportFrame {
                    revision,
                    rgba: Arc::new(rgba),
                    width: request.width,
                    height: request.height,
                });
            if result_tx.send(result).is_err() {
                break;
            }
        }
    });
    (request_tx, result_rx)
}

/// Everything one accepted snapshot install/restore needs once its scene
/// finishes loading, carried across the loader thread and back so the
/// continuation (in a `create_effect`, since it touches Floem signals the
/// loader thread itself cannot touch) can finish the job started before the
/// (potentially slow) decode/BVH-build work was handed off.
#[derive(Clone)]
struct SceneLoadRequest {
    update: PresentationUpdate,
    artifact_root: PathBuf,
    lease: Option<Arc<CacheLease>>,
    source_blobs: BTreeMap<String, PathBuf>,
    /// Whether to fit the camera once loaded — true only for the very
    /// first snapshot a session shows; see the call sites.
    is_first_load: bool,
    ready_status: String,
}

#[derive(Clone)]
struct SceneLoadResult {
    request: SceneLoadRequest,
    outcome: Result<Scene, String>,
}

/// Moves `Scene::load`'s filesystem read, mesh decode, placement, and BVH
/// construction off the UI thread: previously this ran synchronously
/// inside the same Floem reactive effect that installs a snapshot,
/// blocking the whole UI on every restore and every evaluation result.
fn start_scene_loader() -> (
    crossbeam_channel::Sender<SceneLoadRequest>,
    crossbeam_channel::Receiver<SceneLoadResult>,
) {
    let (request_tx, request_rx) = crossbeam_channel::unbounded::<SceneLoadRequest>();
    let (result_tx, result_rx) = crossbeam_channel::unbounded();
    std::thread::spawn(move || {
        while let Ok(request) = request_rx.recv() {
            let outcome = Scene::load(&request.update.snapshot, &request.artifact_root)
                .map_err(|error| error.to_string());
            if result_tx.send(SceneLoadResult { request, outcome }).is_err() {
                break;
            }
        }
    });
    (request_tx, result_rx)
}

/// Collapses consecutive `Diagnostics` requests for the same path down to
/// the latest one queued — typing quickly can queue several before the
/// single language-service thread gets to any of them, and an intermediate
/// one is superseded before it could ever be answered. Every other request
/// (`Saved`/`WatchedFiles`/`Close`, and `Diagnostics` for a different path)
/// keeps its relative order, since save/close ordering matters.
fn coalesce_language_requests(batch: Vec<LanguageRequest>) -> Vec<LanguageRequest> {
    let mut requests: Vec<LanguageRequest> = Vec::with_capacity(batch.len());
    for request in batch {
        if let LanguageRequest::Diagnostics { path, .. } = &request
            && let Some(LanguageRequest::Diagnostics {
                path: previous_path,
                ..
            }) = requests.last()
            && previous_path == path
        {
            requests.pop();
        }
        requests.push(request);
    }
    requests
}

fn start_language(root: &Path) -> LanguageRuntime {
    let executable = std::env::var_os("MACHINEWRIGHT_TY").unwrap_or_else(|| {
        let local = root.join(".venv/bin/ty");
        if local.is_file() {
            local.into_os_string()
        } else {
            "ty".into()
        }
    });
    let root = root.to_path_buf();
    let (request_tx, request_rx) = crossbeam_channel::unbounded::<LanguageRequest>();
    let (result_tx, result_rx) = crossbeam_channel::unbounded();
    std::thread::spawn(move || {
        // A minimum interval between respawn attempts, so a persistently
        // broken environment (missing `ty` binary, a crash loop) doesn't
        // retry on every keystroke-driven diagnostics request. Unlike the
        // worker, the language server has no resource/timeout policy to
        // enforce — a failed request is itself the crash signal, so this
        // is a much smaller mechanism than `WorkerSupervisor`.
        const MIN_RESPAWN_INTERVAL: Duration = Duration::from_secs(2);
        let respawn =
            |last_attempt: &mut Instant| -> Result<TyLanguageServer, machinewright_app::PortError> {
                *last_attempt = Instant::now();
                TyLanguageServer::spawn(&executable, &root)
            };
        let mut last_spawn_attempt = Instant::now();
        let mut server = TyLanguageServer::spawn(&executable, &root);
        'requests: while let Ok(first) = request_rx.recv() {
            // Drain whatever else is already queued and coalesce
            // consecutive `Diagnostics` requests for the same path down to
            // the latest one: typing quickly can queue several before this
            // single service thread gets to any of them, and an
            // intermediate one is superseded before it could ever be
            // answered. Every other request (Saved/WatchedFiles/Close, and
            // Diagnostics for a different path) keeps its relative order.
            let mut batch = vec![first];
            while let Ok(next) = request_rx.try_recv() {
                batch.push(next);
            }
            for request in coalesce_language_requests(batch) {
                if server.is_err() && last_spawn_attempt.elapsed() >= MIN_RESPAWN_INTERVAL {
                    server = respawn(&mut last_spawn_attempt);
                }
                match request {
                    LanguageRequest::Diagnostics {
                        revision,
                        path,
                        source,
                    } => {
                        let mut result = match server.as_mut() {
                            Ok(active) => active
                                .diagnostics(&path, &source)
                                .map_err(|error| error.to_string()),
                            Err(error) => Err(error.to_string()),
                        };
                        if result.is_err() && last_spawn_attempt.elapsed() >= MIN_RESPAWN_INTERVAL {
                            // The live server just failed a request, which is
                            // the only crash signal available — retry once
                            // against a freshly respawned process before
                            // reporting failure for this request.
                            server = respawn(&mut last_spawn_attempt);
                            result = match server.as_mut() {
                                Ok(active) => active
                                    .diagnostics(&path, &source)
                                    .map_err(|error| error.to_string()),
                                Err(error) => Err(error.to_string()),
                            };
                        }
                        if result_tx
                            .send(LanguageResult {
                                revision,
                                path,
                                result,
                            })
                            .is_err()
                        {
                            break 'requests;
                        }
                    }
                    LanguageRequest::Saved(path) => {
                        if let Ok(active) = server.as_mut() {
                            let _ = active.did_save(&path);
                        }
                    }
                    LanguageRequest::WatchedFiles(paths) => {
                        if let Ok(active) = server.as_mut() {
                            let _ = active.watched_files(&paths);
                        }
                    }
                    LanguageRequest::Close(path) => {
                        if let Ok(active) = server.as_mut() {
                            let _ = active.did_close(&path);
                        }
                    }
                }
            }
        }
    });
    (request_tx, result_rx)
}

/// Spawns a worker process, negotiates its protocol/capabilities, and
/// validates its declared environment. Used both for the initial worker and
/// for every respawn after a crash, so the same checks apply either way.
pub(crate) fn spawn_worker(
    environment: &EnvironmentSpec,
) -> Result<(WorkerProcess, WorkerCapabilities), String> {
    let mut worker =
        WorkerProcess::spawn(&environment.worker_executable, std::iter::empty::<&str>())
            .map_err(|error| error.to_string())?;
    let capabilities = worker.connect().map_err(|error| error.to_string())?;
    if !capabilities.transports.iter().any(|item| item == "stdio") {
        return Err("worker does not support the bootstrap stdio transport".into());
    }
    if capabilities.machinewright_version == "unknown"
        || capabilities.cad_backend_version == "unknown"
    {
        return Err(format!(
            "declared environment is incomplete: Machinewright {}, CAD backend {}",
            capabilities.machinewright_version, capabilities.cad_backend_version
        ));
    }
    if !environment.developer_override {
        let expected_environment = environment
            .worker_executable
            .parent()
            .and_then(Path::parent)
            .expect("project worker path has a virtual-environment parent");
        if !capabilities.interpreter.starts_with(expected_environment) {
            return Err(format!(
                "worker launched an interpreter outside the declared environment: {}",
                capabilities.interpreter.display()
            ));
        }
    }
    Ok((worker, capabilities))
}

/// Runs one evaluation while a background monitor thread samples the
/// worker's resource usage and force-terminates it if it exceeds the
/// timeout/memory/cancellation-grace policy in `supervisor`. Returns the
/// same result `WorkerProcess::evaluate` would, so a forced termination
/// surfaces as an ordinary I/O error to the caller, which can then inspect
/// `worker.try_wait()` to tell a crash apart from a benign failure.
/// `None` if `sources` agrees with every digest the worker reported for a
/// path it also captured; a mismatch is only checked for paths present in
/// both — a path the worker read that Rust's independent scan didn't
/// capture (or vice versa) isn't itself treated as suspicious here.
fn source_provenance_mismatch(
    evaluated_source_digests: &BTreeMap<String, String>,
    sources: &BTreeMap<PathBuf, Vec<u8>>,
) -> Option<String> {
    for (relative_path, expected_digest) in evaluated_source_digests {
        let Some(bytes) = sources.get(Path::new(relative_path.as_str())) else {
            continue;
        };
        let actual_digest = format!("sha256:{:x}", Sha256::digest(bytes));
        if &actual_digest != expected_digest {
            return Some(format!(
                "source provenance mismatch for {relative_path}: the worker evaluated \
                 different bytes than were captured for caching (a concurrent external \
                 edit may have changed the file)"
            ));
        }
    }
    None
}

pub(crate) fn evaluate_supervised(
    worker: &mut WorkerProcess,
    request: &EvaluationRequest,
    supervisor: &Arc<Mutex<WorkerSupervisor>>,
    cancel_requested: &Arc<Mutex<Option<(u64, Instant)>>>,
    logs: &machinewright_evaluator::WorkerLog,
) -> Result<EvaluationOutcome, PortError> {
    if let Ok(mut guard) = supervisor.lock() {
        guard.begin_evaluation();
    }
    let started = Instant::now();
    let running = Arc::new(AtomicBool::new(true));
    let monitor_running = Arc::clone(&running);
    let monitor_supervisor = Arc::clone(supervisor);
    let monitor_cancel_requested = Arc::clone(cancel_requested);
    let monitor_generation = request.generation;
    let monitor_pid = worker.process_id();
    let monitor_logs = logs.clone();
    let monitor_handle = std::thread::spawn(move || {
        let mut resource_monitor = WorkerMonitor::new();
        let mut cancellation_signalled = false;
        while monitor_running.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(200));
            if !cancellation_signalled
                && let Ok(slot) = monitor_cancel_requested.lock()
                && let Some((generation, requested_at)) = *slot
                && generation == monitor_generation
            {
                let elapsed_at_request = requested_at.saturating_duration_since(started);
                if let Ok(mut guard) = monitor_supervisor.lock() {
                    guard.request_cancellation(elapsed_at_request);
                }
                cancellation_signalled = true;
            }
            let Some(sample) = resource_monitor.sample(monitor_pid, started.elapsed()) else {
                continue;
            };
            let action = match monitor_supervisor.lock() {
                Ok(mut guard) => guard.observe(sample),
                Err(_) => continue,
            };
            if let SupervisorAction::Terminate(reason) = action {
                monitor_logs.push(format!("supervisor: terminating worker ({reason:?})"));
                force_kill(monitor_pid);
                break;
            }
        }
    });
    let result = worker.evaluate(request);
    running.store(false, Ordering::SeqCst);
    let _ = monitor_handle.join();
    result
}

/// Resolves the project's declared environment and spawns/negotiates a
/// worker against it. Called both for the very first connection attempt and
/// every later respawn (crash recovery or explicit Retry), so a fix applied
/// after startup (e.g. `uv sync`) or an environment change is picked up
/// without restarting the application.
pub(crate) fn resolve_and_spawn(
    project_root: &Path,
) -> Result<(WorkerProcess, WorkerCapabilities, bool), String> {
    let environment = EnvironmentSpec::resolve(project_root).map_err(|error| error.to_string())?;
    let (worker, capabilities) = spawn_worker(&environment)?;
    Ok((worker, capabilities, environment.developer_override))
}

fn start_worker(
    project_root: PathBuf,
    project_key: String,
    store: SnapshotStore,
    log_path: PathBuf,
) -> WorkerRuntime {
    // A failed initial connection (missing environment, spawn failure) is
    // not fatal to startup: the workspace still launches with cached
    // inspection available, an explicit "disconnected" status, and a
    // working Retry — see R5 in docs/m2-implementation-review-2026-09-10.md.
    let (initial_worker, capabilities, developer_override, initial_error) =
        match resolve_and_spawn(&project_root) {
            Ok((worker, capabilities, developer_override)) => {
                (Some(worker), Some(capabilities), developer_override, None)
            }
            Err(error) => (None, None, false, Some(error)),
        };
    if let Some(worker) = &initial_worker
        && let Err(error) = worker
            .logs()
            .enable_file_sink(log_path.clone(), 8 * 1024 * 1024)
    {
        worker.logs().push(format!(
            "failed to enable worker log file at {}: {error}",
            log_path.display()
        ));
    }
    let sender = SharedWorkerSender::new(initial_worker.as_ref().map(|worker| worker.sender()));
    let pending = Arc::new(Mutex::new(None::<EvaluationRequest>));
    let (wake_tx, wake_rx) = crossbeam_channel::bounded::<()>(1);
    let request_tx = LatestEvaluationSender {
        pending: Arc::clone(&pending),
        wake: wake_tx,
    };
    let (result_tx, result_rx) = crossbeam_channel::unbounded();
    let (log_tx, log_rx) = crossbeam_channel::bounded(1);
    let (health_tx, health_rx) = crossbeam_channel::unbounded::<String>();
    let (retry_tx, retry_rx) = crossbeam_channel::unbounded::<()>();
    if let Some(error) = initial_error {
        let _ = health_tx.send(format!(
            "Worker unavailable ({error}) — use Retry Worker to continue."
        ));
    }
    // Tracks the most recently *requested* generation, updated by
    // `schedule_evaluation` (via `EvaluationRuntime::content_changed`) as
    // soon as a new evaluation is scheduled — not just the one currently
    // running. The eval loop consults `accepts()` before committing to the
    // durable snapshot cache, so a superseded generation is never written
    // as "last valid" ahead of being discarded by the UI.
    let runtime = Arc::new(Mutex::new(EvaluationRuntime::new()));
    let current_logs = Arc::new(Mutex::new(
        initial_worker
            .as_ref()
            .map_or_else(|| WorkerLog::new(2_000), |worker| worker.logs()),
    ));
    {
        let current_logs = Arc::clone(&current_logs);
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_millis(500));
                let lines = current_logs
                    .lock()
                    .map(|logs| logs.search(""))
                    .unwrap_or_default();
                if log_tx.send(lines).is_err() {
                    break;
                }
            }
        });
    }
    let eval_sender = sender.clone();
    let eval_runtime = Arc::clone(&runtime);
    std::thread::spawn(move || {
        let supervisor = Arc::new(Mutex::new(WorkerSupervisor::new(ResourcePolicy::default())));
        let thread_started = Instant::now();
        let mut recovery_required = initial_worker.is_none();
        let mut worker = initial_worker;
        // The most recent request that couldn't run because the worker was
        // dead, so Retry can resubmit it immediately instead of requiring
        // the user to make another edit just to discover the worker is
        // still unusable.
        let mut last_failed_request: Option<EvaluationRequest> = None;
        // Spawns and negotiates a replacement worker, rewiring the shared
        // sender/log sink used by the rest of this loop. Shared by the
        // crash-recovery path below and the explicit Retry Worker path so
        // both go through identical spawn/negotiate/rewire logic, and
        // re-resolves the environment fresh each time so a fix applied
        // after startup (e.g. `uv sync`) is picked up.
        let respawn_worker = |worker: &mut Option<WorkerProcess>| -> Result<(), String> {
            let (new_worker, _capabilities, _developer_override) =
                resolve_and_spawn(&project_root)?;
            if let Err(sink_error) = new_worker
                .logs()
                .enable_file_sink(log_path.clone(), 8 * 1024 * 1024)
            {
                new_worker.logs().push(format!(
                    "failed to enable worker log file at {}: {sink_error}",
                    log_path.display()
                ));
            }
            eval_sender.replace(new_worker.sender());
            if let Ok(mut slot) = current_logs.lock() {
                *slot = new_worker.logs();
            }
            *worker = Some(new_worker);
            Ok(())
        };
        loop {
            crossbeam_channel::select! {
                recv(wake_rx) -> message => {
                    if message.is_err() {
                        break;
                    }
                }
                recv(retry_rx) -> message => {
                    if message.is_err() {
                        break;
                    }
                    if let Ok(mut guard) = supervisor.lock() {
                        guard.retry_explicitly();
                    }
                    match respawn_worker(&mut worker) {
                        Ok(()) => {
                            recovery_required = false;
                            let _ = health_tx.send(String::new());
                            if let Some(request) = last_failed_request.take()
                                && let Ok(mut slot) = pending.lock()
                            {
                                *slot = Some(request);
                            }
                            // Fall through to the pending-request check below
                            // so a retained request is resubmitted right
                            // away instead of waiting for another edit.
                        }
                        Err(spawn_error) => {
                            let _ = health_tx.send(format!(
                                "Worker respawn failed ({spawn_error}) — use Retry Worker to continue."
                            ));
                            continue;
                        }
                    }
                }
            }
            let Some(request) = pending.lock().ok().and_then(|mut slot| slot.take()) else {
                continue;
            };
            let generation = request.generation;
            let artifact_root = request.output_directory.clone();
            if recovery_required {
                last_failed_request = Some(request);
                let _ = result_tx.send(EvaluationResult {
                    generation,
                    artifact_root,
                    result: Err(PortError::new(
                        "worker recovery required — use Retry Worker to continue",
                    )),
                    lease: None,
                    source_blobs: BTreeMap::new(),
                });
                continue;
            }
            let mut result_artifact_root = artifact_root.clone();
            let mut lease = None;
            let mut source_blobs = BTreeMap::new();
            let worker_logs = current_logs
                .lock()
                .map(|logs| logs.clone())
                .unwrap_or_else(|_| {
                    worker
                        .as_ref()
                        .expect("recovery_required guards this")
                        .logs()
                });
            // Captured immediately before `evaluate_supervised` runs the
            // worker, which copies the same on-disk tree for anything not
            // overlaid (`_materialize_overlay` in worker.py). Reading it here
            // rather than after evaluation completes keeps the window in
            // which a concurrent external edit could diverge from what the
            // worker actually saw as small as possible.
            let mut sources = request
                .overlays
                .iter()
                .map(|(path, bytes)| (path.clone(), bytes.clone()))
                .collect::<BTreeMap<_, _>>();
            match machinewright_workspace::read_all_project_files(&request.project_root) {
                Ok(files) => {
                    for (path, bytes) in files {
                        sources.entry(path).or_insert(bytes);
                    }
                }
                Err(error) => {
                    worker_logs.push(format!(
                        "failed to capture full project read-set for caching: {error}"
                    ));
                }
            }
            let result = evaluate_supervised(
                worker.as_mut().expect("recovery_required guards this"),
                &request,
                &supervisor,
                &eval_sender.cancel_requested,
                &worker_logs,
            )
            .and_then(|outcome| {
                let accepted = eval_runtime
                    .lock()
                    .map(|guard| guard.accepts(generation))
                    .unwrap_or(false);
                if !accepted {
                    return Err(PortError::new(format!(
                        "evaluation for generation {generation} superseded before it could be cached"
                    )));
                }
                // Cross-check against what the worker actually read
                // (`_materialize_overlay` in worker.py): Rust's own read of
                // the project tree above happened at a different instant,
                // so an external edit in between could otherwise cache
                // bytes that don't match what was actually evaluated.
                if let Some(mismatch) =
                    source_provenance_mismatch(&outcome.evaluated_source_digests, &sources)
                {
                    return Err(PortError::new(mismatch));
                }
                store
                    .import(SnapshotImport {
                        project_key: &project_key,
                        session_id: &request.session_id,
                        generation,
                        environment_digest: &request.environment_digest,
                        snapshot_path: &artifact_root.join("evaluation-snapshot.json"),
                        artifact_root: &artifact_root,
                        sources: &sources,
                    })
                    .map(|(record, cache_lease)| {
                        let _ = store.evict_to_limit(20 * 1024 * 1024 * 1024);
                        if !record.promoted_last_valid {
                            // A different process sharing this cache root
                            // already accepted a newer generation for this
                            // project — this result is still valid and
                            // shown here, it just didn't become the durable
                            // last-valid pointer a future cold start reads.
                            worker_logs.push(format!(
                                "generation {generation} cached but not promoted to last-valid \
                                 (a newer generation was already accepted)"
                            ));
                        }
                        lease = Some(Arc::new(cache_lease));
                        source_blobs = record.source_blobs;
                        result_artifact_root = record.artifact_root;
                        record.snapshot
                    })
                    .map_err(|error| PortError::new(error.to_string()))
            });
            let result = match result {
                Ok(snapshot) => Ok(snapshot),
                Err(error) => {
                    let crashed = matches!(
                        worker
                            .as_mut()
                            .expect("recovery_required guards this")
                            .try_wait(),
                        Ok(Some(_)) | Err(_)
                    );
                    if crashed {
                        let action = supervisor
                            .lock()
                            .map(|mut guard| guard.record_exit(thread_started.elapsed()))
                            .unwrap_or(SupervisorAction::RecoveryRequired);
                        match action {
                            SupervisorAction::RecoveryRequired => {
                                recovery_required = true;
                                last_failed_request = Some(request.clone());
                                worker_logs.push(
                                    "worker crashed repeatedly; automatic restart exhausted".into(),
                                );
                                let _ = health_tx.send(
                                    "Worker crashed repeatedly — use Retry Worker to continue."
                                        .into(),
                                );
                            }
                            _ => {
                                worker_logs.push(format!("worker crashed ({error}); restarting"));
                                if let Err(spawn_error) = respawn_worker(&mut worker) {
                                    recovery_required = true;
                                    last_failed_request = Some(request.clone());
                                    worker_logs
                                        .push(format!("worker respawn failed: {spawn_error}"));
                                    let _ = health_tx.send(format!(
                                        "Worker respawn failed ({spawn_error}) — use Retry Worker to continue."
                                    ));
                                }
                            }
                        }
                    }
                    Err(error)
                }
            };
            if result_tx
                .send(EvaluationResult {
                    generation,
                    artifact_root: result_artifact_root,
                    result,
                    lease,
                    source_blobs,
                })
                .is_err()
            {
                break;
            }
        }
        if let Some(worker) = worker {
            let _ = worker.shutdown();
        }
    });
    (
        capabilities,
        developer_override,
        sender,
        request_tx,
        result_rx,
        log_rx,
        health_rx,
        retry_tx,
        runtime,
    )
}

pub(crate) fn schedule_evaluation(
    session: &Rc<RefCell<ProjectSession>>,
    runtime: &Arc<Mutex<EvaluationRuntime>>,
    sender: &SharedWorkerSender,
    requests: &LatestEvaluationSender,
) -> Result<u64, String> {
    let generation = session.borrow_mut().begin_evaluation();
    let output = std::env::temp_dir()
        .join("machinewright-native")
        .join(std::process::id().to_string())
        .join(format!("generation-{generation}"));
    let request = session
        .borrow()
        .evaluation_request(output)
        .map_err(|error| error.to_string())?;
    let command = runtime
        .lock()
        .map_err(|_| "evaluation runtime lock poisoned".to_string())?
        .content_changed(request);
    if let RuntimeCommand::Cancel {
        session_id,
        generation: running,
    } = command
    {
        sender.send_cancel(session_id, running)?;
    }
    let requests = requests.clone();
    let runtime = Arc::clone(runtime);
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        let command = runtime
            .lock()
            .map(|mut guard| guard.debounce_elapsed(generation))
            .unwrap_or(RuntimeCommand::None);
        if let RuntimeCommand::Send(request) = command {
            let _ = requests.send(request);
        }
    });
    Ok(generation)
}

/// The platform's native "primary" shortcut modifier: Cmd on macOS, Ctrl
/// elsewhere, matching how every other native application binds Save/Undo/
/// Redo on each platform.
#[cfg(target_os = "macos")]
const PRIMARY_MODIFIER: Modifiers = Modifiers::META;
#[cfg(not(target_os = "macos"))]
const PRIMARY_MODIFIER: Modifiers = Modifiers::CONTROL;

fn matches_chord(event: &floem::keyboard::KeyEvent, character: &str, modifiers: Modifiers) -> bool {
    let key_matches = match &event.key.logical_key {
        Key::Character(value) => value.eq_ignore_ascii_case(character),
        _ => false,
    };
    key_matches && event.modifiers == modifiers
}

fn matches_named(event: &floem::keyboard::KeyEvent, key: NamedKey, modifiers: Modifiers) -> bool {
    event.key.logical_key == Key::Named(key) && event.modifiers == modifiers
}

/// Reference resolution the viewport is always rendered/picked against
/// (independent of the widget's actual on-screen size), matching the
/// existing convention in the pick handler below.
pub(crate) const VIEWPORT_WIDTH_PX: f64 = 800.0;
pub(crate) const VIEWPORT_HEIGHT_PX: f64 = 600.0;
/// Total pointer movement (in pixels) below which a press-and-release on the
/// viewport is still treated as a pick click rather than a camera drag.
const CLICK_MOVEMENT_THRESHOLD: f64 = 4.0;

#[derive(Debug, Clone, Copy)]
struct ViewportDragState {
    button: Option<PointerButton>,
    last_pos: Point,
    total_movement: f64,
}

impl Default for ViewportDragState {
    fn default() -> Self {
        Self {
            button: None,
            last_pos: Point::ZERO,
            total_movement: 0.0,
        }
    }
}

fn source_for_node(snapshot: &ProjectSnapshot, node_id: &str) -> String {
    snapshot.source_for_node(node_id).map_or_else(
        || "No source mapping".into(),
        |span| format!("{}:{}", span.path, span.start_line),
    )
}

/// Formats one evaluator diagnostic (the `{code, severity, message,
/// source_path, context}` shape `machinewright.diagnostics.Diagnostic`
/// serializes to) for display — tolerant of a differently-shaped or
/// malformed object, since this crosses the Python/Rust boundary as
/// arbitrary JSON.
fn format_evaluation_diagnostic(value: &serde_json::Value) -> String {
    let severity = value
        .get("severity")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("info");
    let message = value
        .get("message")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("(no message)");
    match value.get("code").and_then(serde_json::Value::as_str) {
        Some(code) => format!("{severity} · {code} · {message}"),
        None => format!("{severity} · {message}"),
    }
}

fn evaluation_diagnostics_from_snapshot(snapshot: &ProjectSnapshot) -> Vec<String> {
    snapshot
        .evaluation()
        .diagnostics
        .iter()
        .map(format_evaluation_diagnostic)
        .collect()
}

fn evaluation_diagnostics_from_failure(error: &PortError) -> Vec<String> {
    error
        .diagnostics_json
        .as_deref()
        .and_then(|bytes| serde_json::from_slice::<Vec<serde_json::Value>>(bytes).ok())
        .map(|items| items.iter().map(format_evaluation_diagnostic).collect())
        .unwrap_or_default()
}

fn untrusted_app(
    path: PathBuf,
    source: String,
    project_root: PathBuf,
    trust_path: PathBuf,
) -> impl IntoView {
    let status = RwSignal::new(
        "This project contains executable Python. Review it before trusting.".to_string(),
    );
    let restart_path = path.clone();
    let trust = button("Trust and Run").action(move || {
        let result = TrustStore::load(&trust_path).and_then(|mut store| store.trust(&project_root));
        match result {
            Ok(()) => match std::env::current_exe().and_then(|executable| {
                std::process::Command::new(executable)
                    .arg(&restart_path)
                    .spawn()
            }) {
                Ok(_) => quit_app(),
                Err(error) => status.set(format!("Trusted, but restart failed: {error}")),
            },
            Err(error) => status.set(format!("Could not store trust: {error}")),
        }
    })
    .variant(ButtonVariant::Primary);
    v_stack((
        h_stack((
            label(move || format!("Machinewright · {} · Browse only", path.display())),
            trust,
            label(move || status.get()),
        ))
        .style(|style| style.gap(theme::space::MD).padding(theme::space::MD).items_center()),
        text_editor(source)
            .disabled(|| true)
            .style(|style| style.width_full().height_full().flex_grow(1.0)),
    ))
    .style(|style| style.width_full().height_full())
}

fn startup_error_app(path: PathBuf, source: String, message: String) -> impl IntoView {
    v_stack((
        label(move || format!("Machinewright · {}", path.display())),
        label(move || message.clone())
            .style(|style| style.padding(theme::space::MD).background(theme::infeasible_tint())),
        text_editor(source)
            .disabled(|| true)
            .style(|style| style.width_full().height_full().flex_grow(1.0)),
    ))
    .style(|style| style.width_full().height_full().gap(theme::space::SM).padding(theme::space::MD))
}

/// A dock zone's tab strip and collapse toggle — Zed/VS Code-style: a row
/// of tab buttons switching which panel is active within this zone (via
/// `WorkspaceIntent::ActivatePanel`), plus a button folding the whole zone
/// away (`WorkspaceIntent::ToggleCollapsed`). Owns no content itself —
/// see `dock_zone_shell`, which pairs this with the zone's (already-built)
/// panel views.
/// `PanelId`'s stable title doubles as its persisted key —
/// `WorkspacePreferences` stores dock state as plain strings rather than
/// depending on `machinewright-ui`'s type (see that field's doc comment),
/// so this and `panel_id_from_key` are the two-way translation.
fn panel_id_to_key(panel: PanelId) -> String {
    panel.title().to_owned()
}

fn panel_id_from_key(key: &str) -> Option<PanelId> {
    match key {
        "Graph" => Some(PanelId::Graph),
        "Diagnostics" => Some(PanelId::Diagnostics),
        "Controls" => Some(PanelId::Controls),
        "Sweep" => Some(PanelId::Sweep),
        _ => None,
    }
}

/// Reconstructs a `WorkspaceLayout` from persisted preferences, starting
/// from the default panel assignment (which panels live in which zone
/// isn't itself persisted — only collapsed/active state is) and applying
/// whatever collapsed/active state was saved. An unrecognized or missing
/// `*_active` key (a fresh preferences file, or one from before a panel
/// existed) falls back to `default_for_machinewright`'s own choice.
fn workspace_layout_from_preferences(preferences: &WorkspacePreferences) -> WorkspaceLayout {
    let mut layout = WorkspaceLayout::default_for_machinewright();
    layout.right.collapsed = preferences.right_dock_collapsed;
    if let Some(panel) = preferences
        .right_dock_active
        .as_deref()
        .and_then(panel_id_from_key)
    {
        layout.right.active = Some(panel);
    }
    layout.bottom.collapsed = preferences.bottom_dock_collapsed;
    if let Some(panel) = preferences
        .bottom_dock_active
        .as_deref()
        .and_then(panel_id_from_key)
    {
        layout.bottom.active = Some(panel);
    }
    layout
}

/// The inverse of `workspace_layout_from_preferences` — applied to a
/// freshly-`capture`d `WorkspacePreferences` before it's sent for saving,
/// since `capture` itself only knows about `ProjectWorkspace` state.
fn apply_workspace_layout_to_preferences(preferences: &mut WorkspacePreferences, layout: &WorkspaceLayout) {
    preferences.right_dock_collapsed = layout.right.collapsed;
    preferences.right_dock_active = layout.right.active.map(panel_id_to_key);
    preferences.bottom_dock_collapsed = layout.bottom.collapsed;
    preferences.bottom_dock_active = layout.bottom.active.map(panel_id_to_key);
}

fn dock_header(workspace_layout: RwSignal<WorkspaceLayout>, dock: Dock) -> impl IntoView {
    let tabs = dyn_stack(
        move || workspace_layout.get().dock(dock).panels.clone(),
        |panel: &PanelId| *panel,
        move |panel: PanelId| {
            button(panel.title())
                .action(move || {
                    workspace_layout.update(|layout| {
                        *layout = reduce_workspace_intent(layout, WorkspaceIntent::ActivatePanel(panel));
                    });
                })
                .style(move |style| {
                    let active = workspace_layout.get().dock(dock).active == Some(panel);
                    let style = button_style::apply_variant(style, ButtonVariant::Ghost);
                    if active {
                        style.apply(Style::new().background(theme::accent_tint()).color(theme::ink()))
                    } else {
                        style
                    }
                })
        },
    );
    let collapse = button(label(move || {
        if workspace_layout.get().dock(dock).collapsed {
            "Expand"
        } else {
            "Collapse"
        }
    }))
    .action(move || {
        workspace_layout.update(|layout| {
            *layout = reduce_workspace_intent(layout, WorkspaceIntent::ToggleCollapsed(dock));
        });
    })
    .variant(ButtonVariant::Ghost);
    h_stack((tabs, toolbar_divider(), collapse)).style(|style| {
        style
            .gap(theme::space::SM)
            .items_center()
            .padding(theme::space::XS)
            .background(theme::surface())
    })
}

/// Pairs a dock zone's header with its (already-built, always-mounted)
/// panel content: `content` is a view containing every panel this zone can
/// show, each individually wrapped by its builder to hide itself unless
/// `WorkspaceLayout::is_visible` says otherwise (see the Graph/Diagnostics/
/// Controls/Sweep construction in `app()`) — panels are built exactly
/// once, not reconstructed on every tab switch, since some (Controls,
/// Sweep) spawn background work on construction that must not repeat.
/// `expanded_size` is the zone's fixed width (Right) or height (Bottom)
/// when not collapsed; collapsing folds it to zero rather than hiding the
/// header, so the tabs/expand button stay reachable.
fn dock_zone_shell(
    workspace_layout: RwSignal<WorkspaceLayout>,
    dock: Dock,
    content: impl IntoView + 'static,
    expanded_size: f64,
    vertical: bool,
) -> impl IntoView {
    let header = dock_header(workspace_layout, dock);
    let body = scroll(content).style(move |style| {
        let collapsed = workspace_layout.get().dock(dock).collapsed;
        let size = if collapsed { 0.0 } else { expanded_size };
        if vertical {
            style.width_full().height(size)
        } else {
            style.width(size).height_full()
        }
    });
    v_stack((header, body)).style(move |style| {
        if vertical {
            style.width_full()
        } else {
            style.height_full()
        }
    })
}

/// Opens `target` into the session and mirrors it into the editor/tab
/// state: dispatches `AppCommand::OpenDocument`, then replaces the editor's
/// content and restores the reopened document's cursor position, updates
/// `active_path`/`open_tabs`, and refreshes `dirty`. Shared by the file
/// tree's own click-to-open handler and the command palette's "open file"
/// command, which must behave identically — this is the exact body that
/// used to live only in the file tree's `on_select` closure.
#[allow(clippy::too_many_arguments)]
fn open_file_into_session(
    target: &Path,
    session: &Rc<RefCell<ProjectSession>>,
    active_path: RwSignal<PathBuf>,
    open_tabs: RwSignal<Vec<PathBuf>>,
    document: &Rc<dyn floem::views::editor::text::Document>,
    programmatic_edit: &Rc<Cell<bool>>,
    editor_cursor: RwSignal<floem_editor_core::cursor::Cursor>,
    dirty: RwSignal<bool>,
    save_status: RwSignal<String>,
) -> bool {
    if let Err(error) = session
        .borrow_mut()
        .dispatch(AppCommand::OpenDocument(target.to_path_buf()))
    {
        save_status.set(error.to_string());
        return false;
    }
    let canonical = target.canonicalize().unwrap_or_else(|_| target.to_path_buf());
    let (source, cursors) = {
        let session = session.borrow();
        let opened = session
            .workspace
            .document(&canonical)
            .expect("opened document exists");
        (opened.text(), opened.cursors().to_vec())
    };
    active_path.set(canonical.clone());
    open_tabs.set(session.borrow().workspace.tabs().to_vec());
    programmatic_edit.set(true);
    document.edit_single(Selection::region(0, document.text().len()), &source, EditType::Other);
    let mut selection = Selection::new();
    for cursor in cursors {
        selection.add_region(floem_editor_core::selection::SelRegion::new(
            cursor.anchor,
            cursor.head,
            None,
        ));
    }
    editor_cursor.update(|cursor| cursor.mode = CursorMode::Insert(selection));
    dirty.set(
        session
            .borrow()
            .workspace
            .document(&canonical)
            .is_some_and(|document| document.is_dirty()),
    );
    true
}

/// Builds the command palette's v1 registry: "open project in a new
/// window" (always present, discoverable even for users who don't know
/// the `Cmd+O` shortcut) plus one "open file" entry per project file.
/// Adapter-local, not part of `machinewright_ui::command_palette` — the
/// module itself is generic over any registry; this is the app-specific
/// data that fills it.
fn build_palette_commands(project_files: &im::Vector<PathBuf>) -> Vec<PaletteCommand> {
    let primary_key_label = if cfg!(target_os = "macos") { "Cmd" } else { "Ctrl" };
    let mut commands = vec![PaletteCommand::new(
        "open-project-new-window",
        "Open Project in New Window…",
    )
    .with_subtitle(format!("{primary_key_label}+O"))];
    for relative in project_files {
        let title = relative
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| relative.to_string_lossy().into_owned());
        let subtitle = relative
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .map(|parent| parent.to_string_lossy().into_owned());
        let mut command = PaletteCommand::new(format!("open-file:{}", relative.display()), title);
        if let Some(subtitle) = subtitle {
            command = command.with_subtitle(subtitle);
        }
        commands.push(command);
    }
    commands
}

/// Restarts the app as an independent process rooted at `root`, exactly
/// like the existing "Trust and Run" restart (`std::env::current_exe` +
/// `Command::new(..).arg(..).spawn()`) — a second OS process is a complete,
/// independent window, sidestepping floem's single-window-per-`Application`
/// model entirely rather than trying to open a second window in-process.
fn spawn_project_window(root: &Path) {
    if let Ok(executable) = std::env::current_exe() {
        let _ = std::process::Command::new(executable).arg(root).spawn();
    }
}

#[allow(clippy::too_many_arguments)]
fn app(
    path: PathBuf,
    project: PortableProject,
    session: Rc<RefCell<ProjectSession>>,
    runtime: WorkerRuntime,
    language_runtime: LanguageRuntime,
    restored: Option<(SnapshotRecord, Arc<CacheLease>)>,
    preferences_path: PathBuf,
    trust_path: PathBuf,
) -> impl IntoView {
    let (
        capabilities,
        developer_override,
        worker_sender,
        requests,
        results,
        worker_logs,
        worker_health,
        worker_retry,
        evaluation_runtime,
    ) = runtime;
    // Which panel is visible in which dock zone — see
    // `machinewright_ui::workspace` for why this state lives there rather
    // than being adapter-local: it's the same shape a future non-Floem
    // adapter would need. Seeded from the same preferences file document/
    // cursor state was restored from in `main()` — a second, cheap load
    // (missing-file tolerant) rather than threading the already-loaded
    // value through as another `app()` parameter.
    let workspace_layout = RwSignal::new(workspace_layout_from_preferences(
        &WorkspacePreferences::load(&preferences_path).unwrap_or_default(),
    ));
    let worker_health_status = RwSignal::new(String::new());
    let worker_health_signal = create_signal_from_channel(worker_health);
    create_effect(move |_| {
        if let Some(message) = worker_health_signal.get() {
            worker_health_status.set(message);
        }
    });
    let retry_worker = button(label(move || {
        if worker_health_status.get().is_empty() {
            "Retry Worker".to_string()
        } else {
            format!("Retry Worker · {}", worker_health_status.get())
        }
    }))
    .action(move || {
        let _ = worker_retry.send(());
    })
    .variant(ButtonVariant::Icon);
    let (preferences_tx, preferences_rx) = crossbeam_channel::bounded::<WorkspacePreferences>(1);
    std::thread::spawn(move || {
        while let Ok(mut preferences) = preferences_rx.recv() {
            while let Ok(newer) = preferences_rx.try_recv() {
                preferences = newer;
            }
            let _ = preferences.save(&preferences_path);
        }
    });
    // Toggling a dock's collapsed state or switching its active tab saves
    // promptly, rather than waiting for the next cursor-movement-triggered
    // capture below to happen to pick it up.
    let layout_preferences_session = Rc::clone(&session);
    let layout_preferences_tx = preferences_tx.clone();
    create_effect(move |_| {
        let layout = workspace_layout.get();
        let mut preferences =
            WorkspacePreferences::capture(&layout_preferences_session.borrow().workspace);
        apply_workspace_layout_to_preferences(&mut preferences, &layout);
        let _ = layout_preferences_tx.try_send(preferences);
    });
    let status = match &capabilities {
        Some(capabilities) => format!(
            "connected · protocol {}{}",
            capabilities.protocol_version,
            if developer_override {
                " · developer worker override"
            } else {
                ""
            }
        ),
        // Startup couldn't reach the evaluator (see R5 in
        // docs/m2-implementation-review-2026-09-10.md) — the workspace still
        // launches with cached inspection available; Retry Worker attempts
        // the first connection just as it does a later reconnect.
        None => "not connected — use Retry Worker".to_string(),
    };
    let dirty = RwSignal::new(false);
    let active_path = RwSignal::new(path.clone());
    let open_tabs = RwSignal::new(session.borrow().workspace.tabs().to_vec());
    let project_files: RwSignal<im::Vector<PathBuf>> =
        RwSignal::new(session.borrow().workspace.files().iter().cloned().collect());
    // Command palette (`Cmd+P`/`Cmd+O`): see `machinewright_ui::command_palette`
    // for the pure filtering/selection state this drives, and
    // `command_palette_view` for the floating overlay built from it.
    let command_palette = RwSignal::new(CommandPaletteViewModel::default());
    let command_palette_query = RwSignal::new(String::new());
    let save_status = RwSignal::new(String::new());
    let evaluation_status = RwSignal::new("Waiting for edits".to_string());
    let language_status = RwSignal::new("ty starting…".to_string());
    let syntax_status = RwSignal::new("syntax · ready".to_string());
    let syntax_diagnostic_lines = RwSignal::new(Vec::<String>::new());
    let diagnostic_lines = RwSignal::new(Vec::<String>::new());
    // Distinguishable from language (`diagnostic_lines`) and syntax
    // diagnostics: hardware validation/compatibility findings the
    // evaluator itself reports, on both success (warnings alongside valid
    // geometry) and failure (linked to the error via `PortError`).
    let evaluation_diagnostic_lines = RwSignal::new(Vec::<String>::new());
    let graph_nodes: RwSignal<im::Vector<GraphRow>> = RwSignal::new(im::Vector::new());
    let selected = RwSignal::new(None::<String>);
    // Every graph node owned by the same source mapping as `selected` (e.g.
    // two instances created by the same call site) — drives highlighting
    // in the viewport and the graph list, which `selected` alone (a single
    // "primary" node used for navigation/labeling) can't represent.
    let selected_set = RwSignal::new(BTreeSet::<String>::new());
    let source_location = RwSignal::new("No selection".to_string());
    let node_details = RwSignal::new("Select a component to inspect it".to_string());
    let measurement_status = RwSignal::new("Measurement off".to_string());
    let evaluated_revision_text = RwSignal::new(None::<String>);
    let worker_log_lines = RwSignal::new(Vec::<String>::new());
    let diff_lines = RwSignal::new(Vec::<String>::new());
    let viewport_frame = RwSignal::new(ViewportFrame {
        revision: 0,
        rgba: Arc::new(vec![7, 9, 14, 255]),
        width: 1,
        height: 1,
    });
    let current_snapshot = Rc::new(RefCell::new(None::<ProjectSnapshot>));
    let current_scene = Rc::new(RefCell::new(Scene::default()));
    let viewport_state = Rc::new(RefCell::new(ViewportState::default()));
    let current_cache_lease = Rc::new(RefCell::new(None::<Arc<CacheLease>>));
    let current_source_blobs = Rc::new(RefCell::new(BTreeMap::<String, PathBuf>::new()));
    let language_revision = Arc::new(AtomicU64::new(0));
    let worker_log_signal = create_signal_from_channel(worker_logs);
    create_effect(move |_| {
        if let Some(lines) = worker_log_signal.get() {
            worker_log_lines.set(lines);
        }
    });
    let (viewport_requests, viewport_results) = start_viewport();
    let (scene_load_requests, scene_load_results) = start_scene_loader();
    let viewport_result_revision = viewport_requests.clone();
    let viewport_result_signal = create_signal_from_channel(viewport_results);
    create_effect(move |_| {
        let Some(result) = viewport_result_signal.get() else {
            return;
        };
        match result {
            Ok(frame) if frame.revision == viewport_result_revision.revision() => {
                viewport_frame.set(frame);
            }
            Ok(_) => {}
            Err(error) => {
                evaluation_status.set(format!("Viewport unavailable: {error}"));
            }
        }
    });

    let scene_load_signal = create_signal_from_channel(scene_load_results);
    let scene_load_current_scene = Rc::clone(&current_scene);
    let scene_load_current_snapshot = Rc::clone(&current_snapshot);
    let scene_load_current_cache_lease = Rc::clone(&current_cache_lease);
    let scene_load_current_source_blobs = Rc::clone(&current_source_blobs);
    let scene_load_viewport_state = Rc::clone(&viewport_state);
    let scene_load_viewport_requests = viewport_requests.clone();
    create_effect(move |_| {
        let Some(result) = scene_load_signal.get() else {
            return;
        };
        let SceneLoadResult { request, outcome } = result;
        match outcome {
            Ok(scene) => {
                graph_nodes.set(graph_rows(&request.update.snapshot).into());
                evaluation_diagnostic_lines
                    .set(evaluation_diagnostics_from_snapshot(&request.update.snapshot));
                let mut state = scene_load_viewport_state.borrow_mut();
                if request.is_first_load {
                    scene.fit_camera(&mut state.camera);
                }
                selected.set(request.update.selection.graph_node_id.clone());
                selected_set.set(
                    request
                        .update
                        .selection
                        .graph_node_ids
                        .iter()
                        .cloned()
                        .collect(),
                );
                state.selected = request
                    .update
                    .selection
                    .graph_node_id
                    .clone()
                    .map(|graph_node_id| PickTarget {
                        graph_node_id,
                        primitive: request.update.selection.primitive,
                    });
                state.selected_nodes = request
                    .update
                    .selection
                    .graph_node_ids
                    .iter()
                    .cloned()
                    .collect();
                let _ = scene_load_viewport_requests.try_send(ViewportRequest {
                    scene: scene.clone(),
                    state: state.clone(),
                    width: 800,
                    height: 600,
                });
                drop(state);
                *scene_load_current_scene.borrow_mut() = scene;
                *scene_load_current_snapshot.borrow_mut() = Some(request.update.snapshot);
                *scene_load_current_cache_lease.borrow_mut() = request.lease;
                *scene_load_current_source_blobs.borrow_mut() = request.source_blobs;
                evaluation_status.set(request.ready_status);
            }
            Err(error) => evaluation_status.set(format!("Mesh error: {error}")),
        }
    });

    if let Some((record, lease)) = restored {
        match session.borrow_mut().accept_snapshot(record.snapshot, true) {
            Ok(Some(update)) => {
                let _ = scene_load_requests.send(SceneLoadRequest {
                    update,
                    artifact_root: record.artifact_root,
                    lease: Some(lease),
                    source_blobs: record.source_blobs,
                    is_first_load: true,
                    ready_status: "Restored last valid snapshot · checking current source…"
                        .into(),
                });
            }
            Ok(None) => {}
            Err(error) => evaluation_status.set(format!("Failed to restore snapshot: {error}")),
        }
    }

    let (language_requests, language_results) = language_runtime;
    let language_result_signal = create_signal_from_channel(language_results);
    let result_language_revision = Arc::clone(&language_revision);
    create_effect(move |_| {
        let Some(event) = language_result_signal.get() else {
            return;
        };
        if event.revision != result_language_revision.load(Ordering::SeqCst) {
            return;
        }
        // The revision counter alone doesn't identify which document a
        // pending request was for, so diagnostics for a tab the user has
        // since switched away from could otherwise land against whatever is
        // now active. Guard on the target path too, mirroring the same
        // "does this still target the active document" check `AsyncTag`
        // already applies to evaluation results.
        if event.path != active_path.get() {
            return;
        }
        match event.result {
            Ok(diagnostics) => {
                language_status.set(if diagnostics.is_empty() {
                    "ty · no issues".into()
                } else {
                    format!("ty · {} issue(s)", diagnostics.len())
                });
                diagnostic_lines.set(
                    diagnostics
                        .into_iter()
                        .map(|item| {
                            format!("{}..{} · {}", item.start_byte, item.end_byte, item.message)
                        })
                        .collect(),
                );
            }
            Err(error) => {
                language_status.set(format!("ty unavailable · {error}"));
                diagnostic_lines.set(Vec::new());
            }
        }
    });

    let result_signal = create_signal_from_channel(results);
    let result_snapshot = Rc::clone(&current_snapshot);
    let result_runtime = Arc::clone(&evaluation_runtime);
    let result_session = Rc::clone(&session);
    let result_scene_load_requests = scene_load_requests.clone();
    create_effect(move |_| {
        let Some(event) = result_signal.get() else {
            return;
        };
        let accepted = result_runtime
            .lock()
            .map(|mut guard| {
                let accepted = guard.accepts(event.generation);
                guard.mark_result_received(event.generation);
                accepted
            })
            .unwrap_or(false);
        if !accepted {
            return;
        }
        match event.result {
            Ok(snapshot) => match result_session.borrow_mut().accept_snapshot(snapshot, false) {
                Ok(Some(update)) => {
                    // Fit only on the very first snapshot this session
                    // shows (cache restore or first live eval) — an
                    // ordinary re-evaluation must not reset the user's
                    // inspection angle/zoom. The existing "Fit" viewport
                    // button remains available for an explicit re-frame.
                    let is_first_load = result_snapshot.borrow().is_none();
                    let generation = update.generation;
                    let _ = result_scene_load_requests.send(SceneLoadRequest {
                        update,
                        artifact_root: event.artifact_root,
                        lease: event.lease,
                        source_blobs: event.source_blobs,
                        is_first_load,
                        ready_status: format!("Generation {generation} ready"),
                    });
                }
                // A newer generation already superseded this result;
                // whichever install wins will drive the UI instead.
                Ok(None) => {}
                Err(error) => {
                    evaluation_status.set(format!("Failed to install snapshot: {error}"));
                }
            },
            Err(error) => {
                evaluation_status.set(format!("Evaluation failed: {error}"));
                // The last valid geometry/graph stay exactly as they were —
                // only the diagnostics/status reflect the new failure.
                evaluation_diagnostic_lines.set(evaluation_diagnostics_from_failure(&error));
            }
        }
    });

    let initial_source = session
        .borrow()
        .workspace
        .document(&path)
        .expect("active document is open")
        .text();
    let syntax = Rc::new(RefCell::new(PythonSyntax::new()));
    let initial_syntax = syntax.borrow_mut().update(&initial_source);
    syntax_status.set(if initial_syntax.is_empty() {
        "syntax · valid".into()
    } else {
        format!("syntax · {} issue(s)", initial_syntax.len())
    });
    syntax_diagnostic_lines.set(
        initial_syntax
            .into_iter()
            .map(|item| format!("{}..{} · {}", item.start_byte, item.end_byte, item.message))
            .collect(),
    );
    let editor = text_editor(initial_source);
    let editor_cursor = editor.editor().cursor;
    if let Some(saved) = session.borrow().workspace.document(&path) {
        let mut selection = Selection::new();
        for cursor in saved.cursors() {
            selection.add_region(floem_editor_core::selection::SelRegion::new(
                cursor.anchor,
                cursor.head,
                None,
            ));
        }
        editor_cursor.update(|cursor| cursor.mode = CursorMode::Insert(selection));
    }
    let document = editor.doc();
    let programmatic_edit = Rc::new(Cell::new(false));
    let watcher_document = Rc::clone(&document);
    let watcher_programmatic_edit = Rc::clone(&programmatic_edit);
    let reload_document = Rc::clone(&document);
    let reload_programmatic_edit = Rc::clone(&programmatic_edit);
    let cursor_session = Rc::clone(&session);
    let cursor_scene = Rc::clone(&current_scene);
    let cursor_viewport_state = Rc::clone(&viewport_state);
    let cursor_viewport_requests = viewport_requests.clone();
    let cursor_root = project.root.clone();
    create_effect(move |_| {
        let cursor = editor_cursor.get();
        let offset = cursor.offset();
        let cursor_path = active_path.get();
        {
            let mut session = cursor_session.borrow_mut();
            if let Some(document) = session.workspace.document_mut(&cursor_path) {
                let cursors = cursor
                    .regions_iter()
                    .map(|(anchor, head)| WorkspaceCursor { anchor, head })
                    .collect();
                let _ = document.set_cursors(cursors);
            }
            let mut preferences = WorkspacePreferences::capture(&session.workspace);
            apply_workspace_layout_to_preferences(&mut preferences, &workspace_layout.get_untracked());
            let _ = preferences_tx.try_send(preferences);
        }
        if cursor_session
            .borrow_mut()
            .dispatch(AppCommand::SelectSource {
                relative_path: cursor_path
                    .strip_prefix(&cursor_root)
                    .unwrap_or(&cursor_path)
                    .to_string_lossy()
                    .replace('\\', "/"),
                byte: offset as u64,
            })
            .is_err()
        {
            return;
        }
        let selection = cursor_session.borrow().selection.clone();
        selected.set(selection.graph_node_id.clone());
        selected_set.set(selection.graph_node_ids.iter().cloned().collect());
        let mut state = cursor_viewport_state.borrow_mut();
        state.selected = selection.graph_node_id.map(|graph_node_id| PickTarget {
            graph_node_id,
            primitive: selection.primitive,
        });
        state.selected_nodes = selection.graph_node_ids.iter().cloned().collect();
        let _ = cursor_viewport_requests.try_send(ViewportRequest {
            scene: cursor_scene.borrow().clone(),
            state: state.clone(),
            width: 800,
            height: 600,
        });
    });
    let watcher_session = Rc::clone(&session);
    let watcher_language_requests = language_requests.clone();
    let watcher_trust_path = trust_path.clone();
    let watcher_project_root = project.root.clone();
    let watcher_manifest_path = project.root.join("machinewright.toml");
    let watcher_environment_lock = project.environment_lock.clone();
    let watcher_runtime = Arc::clone(&evaluation_runtime);
    let watcher_sender = worker_sender.clone();
    let watcher_requests = requests.clone();
    let (file_event_tx, file_event_rx) = crossbeam_channel::unbounded();
    let watch_root = project.root.clone();
    std::thread::spawn(move || match ProjectWatcher::watch(&watch_root) {
        Ok(mut watcher) => loop {
            match watcher.recv_timeout(Duration::from_secs(1)) {
                Ok(Some(event)) => {
                    if file_event_tx.send(Ok(event)).is_err() {
                        break;
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    let _ = file_event_tx.send(Err(error.to_string()));
                    break;
                }
            }
        },
        Err(error) => {
            let _ = file_event_tx.send(Err(error.to_string()));
        }
    });
    let file_event_signal = create_signal_from_channel(file_event_rx);
    create_effect(move |_| {
        let Some(event) = file_event_signal.get() else {
            return;
        };
        let event = match event {
            Ok(event) => event,
            Err(error) => {
                save_status.set(format!("File watcher unavailable: {error}"));
                return;
            }
        };
        let _ = watcher_language_requests.send(LanguageRequest::WatchedFiles(event.paths.clone()));
        if event.paths.iter().any(|changed| {
            changed == &watcher_manifest_path || changed == &watcher_environment_lock
        }) {
            let still_trusted = TrustStore::load(&watcher_trust_path)
                .and_then(|store| store.is_trusted(&watcher_project_root))
                .unwrap_or(false);
            if !still_trusted {
                save_status.set(
                    "Project trust was revoked or the manifest/lock changed — restart Machinewright to re-review and trust this project."
                        .into(),
                );
            }
        }
        if let Some((from, to)) = &event.rename {
            // Reconciles every open tab that matches `from`, not just the
            // active one — a background tab renamed on disk (in Finder, a
            // terminal, another tool) would otherwise keep pointing at a
            // path that no longer exists until the user happened to select
            // it.
            // Bound first, not matched directly in the condition: a plain
            // `if`'s condition temporaries can otherwise still be alive
            // when the body re-borrows the same `RefCell`, mirroring the
            // `match` gotcha explained by the `close` button handler
            // above.
            let renamed = watcher_session
                .borrow_mut()
                .workspace
                .rename_document(from, to);
            if renamed {
                open_tabs.set(watcher_session.borrow().workspace.tabs().to_vec());
                if active_path.get() == *from {
                    active_path.set(to.clone());
                }
                save_status.set(format!("Renamed {} → {}", from.display(), to.display()));
            }
        }
        let refreshed = watcher_session
            .borrow_mut()
            .workspace
            .refresh_files()
            .unwrap_or(false);
        if refreshed {
            project_files.set(
                watcher_session
                    .borrow()
                    .workspace
                    .files()
                    .iter()
                    .cloned()
                    .collect(),
            );
        }
        let watcher_path = active_path.get();
        // A changed file that isn't the active document (e.g. an imported
        // helper module) still affects the next evaluation, since evaluation
        // reads unopened files straight from disk — invalidate the result
        // rather than silently leaving it stale until some unrelated edit
        // happens to retrigger it.
        if event.paths.iter().any(|changed| {
            changed != &watcher_path && is_relevant_project_path(&watcher_project_root, changed)
        }) {
            evaluation_status.set("Waiting for evaluation…".into());
            if let Err(error) = schedule_evaluation(
                &watcher_session,
                &watcher_runtime,
                &watcher_sender,
                &watcher_requests,
            ) {
                evaluation_status.set(error);
            }
        }
        if !event.paths.iter().any(|changed| changed == &watcher_path) {
            return;
        }
        let outcome = watcher_session
            .borrow_mut()
            .workspace
            .document_mut(&watcher_path)
            .expect("watched document remains open")
            .reconcile_disk();
        match outcome {
            Ok(DiskChange::Reloaded) => {
                let source = watcher_session
                    .borrow()
                    .workspace
                    .document(&watcher_path)
                    .expect("reloaded document remains open")
                    .text();
                let old_len = watcher_document.text().len();
                watcher_programmatic_edit.set(true);
                watcher_document.edit_single(
                    Selection::region(0, old_len),
                    &source,
                    EditType::Other,
                );
                save_status.set("Reloaded external change".into());
                // An external edit to the active document replaces the
                // authoritative source (unlike a tab rebind), so it must
                // reevaluate.
                evaluation_status.set("Waiting for evaluation…".into());
                if let Err(error) = schedule_evaluation(
                    &watcher_session,
                    &watcher_runtime,
                    &watcher_sender,
                    &watcher_requests,
                ) {
                    evaluation_status.set(error);
                }
            }
            Ok(DiskChange::Conflict(_)) => {
                save_status.set(
                    "File changed on disk · save is blocked until Compare, Reload, or Keep Editor Version"
                        .into(),
                );
            }
            Ok(DiskChange::Unchanged) => {}
            Err(error) => save_status.set(format!("File change error: {error}")),
        }
    });
    let update_session = Rc::clone(&session);
    let update_programmatic_edit = Rc::clone(&programmatic_edit);
    let edit_document = Rc::clone(&document);
    let update_syntax = Rc::clone(&syntax);
    let edit_session = Rc::clone(&session);
    let edit_runtime = Arc::clone(&evaluation_runtime);
    let edit_sender = worker_sender.clone();
    let edit_requests = requests.clone();
    let edit_language_requests = language_requests.clone();
    let edit_language_revision = Arc::clone(&language_revision);
    let disabled_session = Rc::clone(&session);
    let editor = editor
        .disabled(move || {
            disabled_session
                .borrow()
                .workspace
                .document(&active_path.get())
                .is_some_and(|document| document.is_read_only())
        })
        .update(move |_| {
            let source = edit_document.text().to_string();
            let edit_path = active_path.get();
            // A programmatic content swap (opening a file, switching tabs,
            // restoring tabs on launch, undo/redo, reload-from-disk, "Open
            // Evaluated Revision") fires this same `update` callback as a
            // real keystroke does. It must not re-run evaluation — the code
            // on disk/already evaluated hasn't changed just because the
            // editor is now displaying something else — only genuine typing
            // should schedule a new evaluation.
            let is_programmatic_edit = update_programmatic_edit.replace(false);
            if !is_programmatic_edit
                && let Err(error) =
                    update_session
                        .borrow_mut()
                        .dispatch(AppCommand::ReplaceDocument {
                            path: edit_path.clone(),
                            source: source.clone(),
                        })
            {
                save_status.set(error.to_string());
                return;
            }
            let revision = update_session
                .borrow()
                .workspace
                .document(&edit_path)
                .expect("edited document remains open")
                .revision();
            dirty.set(
                update_session
                    .borrow()
                    .workspace
                    .document(&edit_path)
                    .is_some_and(|document| document.is_dirty()),
            );
            edit_language_revision.store(revision, Ordering::SeqCst);
            let syntax_diagnostics = update_syntax.borrow_mut().update(&source);
            syntax_status.set(if syntax_diagnostics.is_empty() {
                "syntax · valid".into()
            } else {
                format!("syntax · {} issue(s)", syntax_diagnostics.len())
            });
            syntax_diagnostic_lines.set(
                syntax_diagnostics
                    .into_iter()
                    .map(|item| {
                        format!("{}..{} · {}", item.start_byte, item.end_byte, item.message)
                    })
                    .collect(),
            );
            let _ = edit_language_requests.send(LanguageRequest::Diagnostics {
                revision,
                path: edit_path.clone(),
                source: source.clone(),
            });
            if !is_programmatic_edit {
                evaluation_status.set("Waiting for evaluation…".into());
                if let Err(error) = schedule_evaluation(
                    &edit_session,
                    &edit_runtime,
                    &edit_sender,
                    &edit_requests,
                ) {
                    evaluation_status.set(error);
                }
            }
        })
        .style(|style| style.width_full().height_full().flex_grow(1.0));

    let save_session = Rc::clone(&session);
    let save_language_requests = language_requests.clone();
    let save = button("Save").action(move || {
        match save_session
            .borrow_mut()
            .dispatch(AppCommand::SaveDocument {
                path: active_path.get(),
                force: false,
            }) {
            Ok(_) => {
                dirty.set(false);
                save_status.set("Saved".into());
                let _ = save_language_requests.send(LanguageRequest::Saved(active_path.get()));
            }
            Err(error) => save_status.set(error.to_string()),
        }
    })
    .variant(ButtonVariant::Secondary);

    let keep_session = Rc::clone(&session);
    let keep_editor = button("Keep Editor Version")
        .action(move || {
            match keep_session
                .borrow_mut()
                .dispatch(AppCommand::AcknowledgeEditorVersion(active_path.get()))
            {
                Ok(_) => save_status.set("Editor version retained; use Force Save to overwrite the acknowledged disk revision".into()),
                Err(error) => save_status.set(error.to_string()),
            }
        })
        .variant(ButtonVariant::Secondary);

    let force_session = Rc::clone(&session);
    let force_save = button("Force Save").action(move || {
        match force_session
            .borrow_mut()
            .dispatch(AppCommand::SaveDocument {
                path: active_path.get(),
                force: true,
            }) {
            Ok(_) => {
                dirty.set(false);
                save_status.set("Saved editor version over acknowledged disk revision".into());
            }
            Err(error) => save_status.set(error.to_string()),
        }
    })
    .variant(ButtonVariant::Secondary);

    let reload_session = Rc::clone(&session);
    let reload_runtime = Arc::clone(&evaluation_runtime);
    let reload_sender = worker_sender.clone();
    let reload_requests = requests.clone();
    let reload = button("Reload from Disk").action(move || {
        let result = reload_session
            .borrow_mut()
            .workspace
            .document_mut(&active_path.get())
            .expect("reloaded document remains open")
            .reload_discarding_edits();
        match result {
            Ok(()) => {
                let source = reload_session
                    .borrow()
                    .workspace
                    .document(&active_path.get())
                    .expect("reloaded document remains open")
                    .text();
                reload_programmatic_edit.set(true);
                reload_document.edit_single(
                    Selection::region(0, reload_document.text().len()),
                    &source,
                    EditType::Other,
                );
                dirty.set(false);
                save_status.set("Reloaded from disk".into());
                // Reload replaces the authoritative source (unlike a tab
                // rebind), so it must reevaluate.
                evaluation_status.set("Waiting for evaluation…".into());
                if let Err(error) = schedule_evaluation(
                    &reload_session,
                    &reload_runtime,
                    &reload_sender,
                    &reload_requests,
                ) {
                    evaluation_status.set(error);
                }
            }
            Err(error) => save_status.set(error.to_string()),
        }
    })
    .variant(ButtonVariant::Secondary);

    let history_control = |label_text: &'static str, command: fn(PathBuf) -> AppCommand| {
        let history_session = Rc::clone(&session);
        let history_document = Rc::clone(&document);
        let history_programmatic = Rc::clone(&programmatic_edit);
        let history_runtime = Arc::clone(&evaluation_runtime);
        let history_sender = worker_sender.clone();
        let history_requests = requests.clone();
        button(label_text).action(move || {
            if let Err(error) = history_session
                .borrow_mut()
                .dispatch(command(active_path.get()))
            {
                save_status.set(error.to_string());
                return;
            }
            let source = history_session
                .borrow()
                .workspace
                .document(&active_path.get())
                .expect("history document remains open")
                .text();
            history_programmatic.set(true);
            history_document.edit_single(
                Selection::region(0, history_document.text().len()),
                &source,
                EditType::Other,
            );
            // Undo/Redo change the authoritative source (unlike a tab
            // rebind, which reuses this same edit_single mechanism to
            // redisplay already-current content), so they must reevaluate.
            evaluation_status.set("Waiting for evaluation…".into());
            if let Err(error) = schedule_evaluation(
                &history_session,
                &history_runtime,
                &history_sender,
                &history_requests,
            ) {
                evaluation_status.set(error);
            }
        })
        .variant(ButtonVariant::Secondary)
    };
    let undo = history_control("Undo", AppCommand::Undo);
    let redo = history_control("Redo", AppCommand::Redo);

    let compare_session = Rc::clone(&session);
    let (diff_tx, diff_rx) = crossbeam_channel::bounded::<Result<Vec<String>, String>>(1);
    let diff_signal = create_signal_from_channel(diff_rx);
    create_effect(move |_| {
        let Some(result) = diff_signal.get() else {
            return;
        };
        match result {
            Ok(lines) => {
                save_status.set(format!("Compare · {} line(s)", lines.len()));
                diff_lines.set(lines);
            }
            Err(error) => save_status.set(format!("Cannot compare disk file: {error}")),
        }
    });
    let compare = button("Compare Disk").action(move || {
        let document = compare_session
            .borrow()
            .workspace
            .document(&active_path.get())
            .expect("compared document remains open")
            .clone();
        let sender = diff_tx.clone();
        std::thread::spawn(move || {
            let result = document
                .diff_against_disk()
                .map(|lines| {
                    lines
                        .into_iter()
                        .map(|line| {
                            let prefix = match line.kind {
                                DiffKind::Equal => "  ",
                                DiffKind::EditorOnly => "+ ",
                                DiffKind::DiskOnly => "- ",
                            };
                            format!("{prefix}{}", line.text)
                        })
                        .collect()
                })
                .map_err(|error| error.to_string());
            let _ = sender.try_send(result);
        });
    })
    .variant(ButtonVariant::Secondary);

    let evaluate_session = Rc::clone(&session);
    let evaluate_runtime = Arc::clone(&evaluation_runtime);
    let evaluate_sender = worker_sender.clone();
    let evaluate_requests = requests.clone();
    let evaluate = button("Evaluate").action(move || {
        evaluation_status.set("Waiting for evaluation…".into());
        if let Err(error) = schedule_evaluation(
            &evaluate_session,
            &evaluate_runtime,
            &evaluate_sender,
            &evaluate_requests,
        ) {
            evaluation_status.set(error);
        }
    })
    .variant(ButtonVariant::Primary);

    evaluation_status.set("Waiting for initial evaluation…".into());
    if let Err(error) =
        schedule_evaluation(&session, &evaluation_runtime, &worker_sender, &requests)
    {
        evaluation_status.set(error);
    }
    let initial_revision = session
        .borrow()
        .workspace
        .document(&path)
        .expect("initial document remains open")
        .revision();
    language_revision.store(initial_revision, Ordering::SeqCst);
    let _ = language_requests.send(LanguageRequest::Diagnostics {
        revision: initial_revision,
        path: path.clone(),
        source: session
            .borrow()
            .workspace
            .document(&path)
            .expect("initial document remains open")
            .text(),
    });

    let graph_navigation_document = Rc::clone(&document);
    let pick_navigation_document = Rc::clone(&document);
    let file_session = Rc::clone(&session);
    let file_document = Rc::clone(&document);
    let file_programmatic = Rc::clone(&programmatic_edit);
    let file_root = project.root.clone();
    // Virtualized (only visible rows are materialized) so a project with
    // thousands of files doesn't render every row up front.
    const TREE_ROW_HEIGHT: f64 = 24.0;
    // `virtual_list` (rather than `virtual_stack`) so the tree stays
    // virtualized *and* gets arrow-key/Home/End navigation and an
    // accessibility-visible selection state for free — row content just
    // renders a label, and `on_select` (fired by a click or by the list's
    // own keyboard handling) runs the same open-document logic either way.
    let workspace_tree = virtual_list(
        VirtualDirection::Vertical,
        VirtualItemSize::Fixed(Box::new(|| TREE_ROW_HEIGHT)),
        move || project_files.get(),
        Clone::clone,
        move |relative: PathBuf| {
            let display = relative.to_string_lossy().into_owned();
            label(move || display.clone()).style(|style| style.height(TREE_ROW_HEIGHT))
        },
    )
    .on_select(move |index| {
        let Some(index) = index else {
            return;
        };
        let Some(relative) = project_files.with_untracked(|files| files.get(index).cloned()) else {
            return;
        };
        let target = file_root.join(&relative);
        open_file_into_session(
            &target,
            &file_session,
            active_path,
            open_tabs,
            &file_document,
            &file_programmatic,
            editor_cursor,
            dirty,
            save_status,
        );
    });
    let workspace_tree = scroll(workspace_tree).style(|style| style.width_full().max_height(220.0));

    let tab_session = Rc::clone(&session);
    let tab_document = Rc::clone(&document);
    let tab_programmatic = Rc::clone(&programmatic_edit);
    let tab_language_requests = language_requests.clone();
    let tab_strip = scroll(h_stack((dyn_stack(
        move || open_tabs.get(),
        Clone::clone,
        move |target| {
            let label_text = target
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            let session = Rc::clone(&tab_session);
            let document = Rc::clone(&tab_document);
            let programmatic = Rc::clone(&tab_programmatic);
            let open_target = target.clone();
            let open = button(label(move || label_text.clone()))
                .variant(ButtonVariant::Ghost)
                .action(move || {
                if session
                    .borrow_mut()
                    .dispatch(AppCommand::SetActiveDocument(open_target.clone()))
                    .is_err()
                {
                    return;
                }
                let (source, cursors, read_only) = {
                    let session = session.borrow();
                    let tab = session
                        .workspace
                        .document(&open_target)
                        .expect("tab document exists");
                    (tab.text(), tab.cursors().to_vec(), tab.is_read_only())
                };
                active_path.set(open_target.clone());
                programmatic.set(true);
                document.edit_single(
                    Selection::region(0, document.text().len()),
                    &source,
                    EditType::Other,
                );
                let mut selection = Selection::new();
                for cursor in cursors {
                    selection.add_region(floem_editor_core::selection::SelRegion::new(
                        cursor.anchor,
                        cursor.head,
                        None,
                    ));
                }
                editor_cursor.update(|cursor| cursor.mode = CursorMode::Insert(selection));
                dirty.set(
                    !read_only
                        && session
                            .borrow()
                            .workspace
                            .document(&open_target)
                            .is_some_and(|document| document.is_dirty()),
                );
                save_status.set(if read_only {
                    "Evaluated revision · read only".into()
                } else {
                    String::new()
                });
            });
            let close_session = Rc::clone(&tab_session);
            let close_document = Rc::clone(&tab_document);
            let close_programmatic = Rc::clone(&tab_programmatic);
            let close_language_requests = tab_language_requests.clone();
            let close = button("×")
                .variant(ButtonVariant::Destructive)
                .action(move || {
                // Bound to a variable first, not matched directly: a
                // `match`'s scrutinee temporaries (here, the `RefMut` from
                // `borrow_mut()`) live for the whole match, arms included,
                // so re-borrowing `close_session` inside an arm would
                // otherwise panic with "already mutably borrowed."
                let result = close_session
                    .borrow_mut()
                    .dispatch(AppCommand::CloseDocument(target.clone()));
                match result {
                    Ok(_) => {
                        let _ =
                            close_language_requests.send(LanguageRequest::Close(target.clone()));
                        open_tabs.set(close_session.borrow().workspace.tabs().to_vec());
                        let next = close_session
                            .borrow()
                            .workspace
                            .active()
                            .map(Path::to_path_buf);
                        if let Some(next) = next {
                            let source = close_session
                                .borrow()
                                .workspace
                                .document(&next)
                                .expect("active tab exists")
                                .text();
                            active_path.set(next);
                            close_programmatic.set(true);
                            close_document.edit_single(
                                Selection::region(0, close_document.text().len()),
                                &source,
                                EditType::Other,
                            );
                        }
                    }
                    Err(error) => save_status.set(error.to_string()),
                }
            });
            h_stack((open, close))
        },
    ),)))
    .style(|style| style.width_full().max_height(42.0));
    let primary_key_label = if cfg!(target_os = "macos") {
        "Cmd"
    } else {
        "Ctrl"
    };
    let shortcuts_visible = RwSignal::new(false);
    let shortcuts_toggle = button(label(move || {
        if shortcuts_visible.get() {
            "Hide Shortcuts".to_string()
        } else {
            "Shortcuts".to_string()
        }
    }))
    .action(move || shortcuts_visible.update(|visible| *visible = !*visible))
    .variant(ButtonVariant::Ghost);
    let shortcuts_panel = label(move || {
        if shortcuts_visible.get() {
            format!(
                "{primary_key_label}+S Save · {primary_key_label}+Z Undo · \
                 {primary_key_label}+Shift+Z Redo · {primary_key_label}+Enter Evaluate · \
                 {primary_key_label}+G Go to Line · \
                 Viewport: drag to orbit · right-drag to pan · scroll to zoom · \
                 Measure toggles click between selecting and measuring · \
                 Alt+F Fit · Alt+Arrows Orbit · Alt+=/- Zoom · Alt+1/2/3 Front/Right/Top · \
                 Alt+P Projection · Alt+H Hide · Alt+I Isolate · Alt+X Section · \
                 Alt+M Measure · Escape cancels a pending measurement · \
                 Graph/File tree: Arrows/Home/End to navigate"
            )
        } else {
            String::new()
        }
    })
    .style(|style| style.padding(theme::space::SM));

    // Renames the active tab in place: a small text input bound to the
    // filename plus Confirm/Cancel, toggled by a "Rename" button. This is
    // the first single-line text-input widget in the app, so it's kept
    // deliberately minimal — one target (the active document), no drag/drop,
    // no inline tab-strip editing.
    let renaming = RwSignal::new(false);
    let rename_input_text = RwSignal::new(String::new());
    let rename_status = RwSignal::new(String::new());
    let start_rename = button("Rename")
        .action(move || {
            let current = active_path.get();
            let name = current
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            rename_input_text.set(name);
            rename_status.set(String::new());
            renaming.set(true);
        })
        .variant(ButtonVariant::Ghost);
    let rename_session = Rc::clone(&session);
    let rename_row = dyn_container(
        move || renaming.get(),
        move |is_renaming| {
            if !is_renaming {
                return empty().into_any();
            }
            let confirm_session = Rc::clone(&rename_session);
            let confirm = button("Confirm").action(move || {
                let new_name = rename_input_text.get();
                let trimmed = new_name.trim();
                if trimmed.is_empty() {
                    rename_status.set("Name cannot be empty".into());
                    return;
                }
                let from = active_path.get();
                let Some(parent) = from.parent() else {
                    rename_status.set("Cannot determine the containing folder".into());
                    return;
                };
                let to = parent.join(trimmed);
                if to == from {
                    renaming.set(false);
                    return;
                }
                // See the `close` handler above for why this can't be a
                // direct `match x.borrow_mut()...` — the arms re-borrow
                // `confirm_session`.
                let result = confirm_session.borrow_mut().dispatch(AppCommand::RenameDocument {
                    from: from.clone(),
                    to,
                });
                match result {
                    Ok(events) => {
                        if let Some(AppEvent::DocumentRenamed { to, .. }) =
                            events.into_iter().next()
                        {
                            open_tabs.set(confirm_session.borrow().workspace.tabs().to_vec());
                            active_path.set(to.clone());
                            save_status.set(format!("Renamed to {}", to.display()));
                        }
                        renaming.set(false);
                    }
                    Err(error) => rename_status.set(error.to_string()),
                }
            })
            .variant(ButtonVariant::Primary);
            let cancel = button("Cancel")
                .action(move || renaming.set(false))
                .variant(ButtonVariant::Secondary);
            h_stack((
                text_input(rename_input_text).style(|style| style.width(220.0)),
                confirm,
                cancel,
                label(move || rename_status.get()),
            ))
            .style(|style| style.gap(theme::space::SM).padding(theme::space::SM).items_center())
            .into_any()
        },
    );

    // Find/Replace and Go to Line: `AppCommand::ReplaceAll`/`GoToLine`
    // already exist and are exercised by machinewright-workspace's own
    // tests, but the September 9 M2 amendment named them as UI that should
    // exist in the adapter and none did — this is that minimal exposure,
    // scoped to the active document like Rename above.
    let find_replace_visible = RwSignal::new(false);
    let find_query = RwSignal::new(String::new());
    let find_replacement = RwSignal::new(String::new());
    let find_status = RwSignal::new(String::new());
    let find_replace_toggle = button(label(move || {
        if find_replace_visible.get() {
            "Hide Find/Replace".to_string()
        } else {
            "Find/Replace".to_string()
        }
    }))
    .action(move || find_replace_visible.update(|visible| *visible = !*visible))
    .variant(ButtonVariant::Ghost);
    let find_replace_session = Rc::clone(&session);
    let find_replace_document = Rc::clone(&document);
    let find_replace_programmatic = Rc::clone(&programmatic_edit);
    let find_replace_runtime = Arc::clone(&evaluation_runtime);
    let find_replace_sender = worker_sender.clone();
    let find_replace_requests = requests.clone();
    let find_replace_row = dyn_container(
        move || find_replace_visible.get(),
        move |visible| {
            if !visible {
                return empty().into_any();
            }
            let replace_session = Rc::clone(&find_replace_session);
            let replace_document = Rc::clone(&find_replace_document);
            let replace_programmatic = Rc::clone(&find_replace_programmatic);
            let replace_runtime = Arc::clone(&find_replace_runtime);
            let replace_sender = find_replace_sender.clone();
            let replace_requests = find_replace_requests.clone();
            let replace_all = button("Replace All").action(move || {
                let path = active_path.get();
                let query = find_query.get();
                if query.is_empty() {
                    find_status.set("Enter a search term".into());
                    return;
                }
                // See the `close` handler above for why this can't be a
                // direct `match x.borrow_mut()...` — the arms re-borrow
                // `replace_session` (and `schedule_evaluation` below
                // borrows it again internally).
                let result = replace_session.borrow_mut().dispatch(AppCommand::ReplaceAll {
                    path: path.clone(),
                    query,
                    replacement: find_replacement.get(),
                });
                match result {
                    Ok(_) => {
                        let source = replace_session
                            .borrow()
                            .workspace
                            .document(&path)
                            .expect("target document is open")
                            .text();
                        replace_programmatic.set(true);
                        replace_document.edit_single(
                            Selection::region(0, replace_document.text().len()),
                            &source,
                            EditType::Other,
                        );
                        find_status.set("Replaced".into());
                        // A real content change (unlike a tab rebind), so
                        // it must reevaluate — mirrors Undo/Redo above.
                        evaluation_status.set("Waiting for evaluation…".into());
                        if let Err(error) = schedule_evaluation(
                            &replace_session,
                            &replace_runtime,
                            &replace_sender,
                            &replace_requests,
                        ) {
                            evaluation_status.set(error);
                        }
                    }
                    Err(error) => find_status.set(error.to_string()),
                }
            })
            .variant(ButtonVariant::Primary);
            h_stack((
                text_input(find_query).style(|style| style.width(160.0)),
                text_input(find_replacement).style(|style| style.width(160.0)),
                replace_all,
                label(move || find_status.get()),
            ))
            .style(|style| style.gap(theme::space::SM).padding(theme::space::SM).items_center())
            .into_any()
        },
    );

    let goto_visible = RwSignal::new(false);
    let goto_line_text = RwSignal::new(String::new());
    let goto_status = RwSignal::new(String::new());
    let goto_toggle = button(label(move || {
        if goto_visible.get() {
            "Hide Go to Line".to_string()
        } else {
            "Go to Line".to_string()
        }
    }))
    .action(move || goto_visible.update(|visible| *visible = !*visible))
    .variant(ButtonVariant::Ghost);
    let goto_session = Rc::clone(&session);
    let goto_row = dyn_container(
        move || goto_visible.get(),
        move |visible| {
            if !visible {
                return empty().into_any();
            }
            let go_session = Rc::clone(&goto_session);
            let go = button("Go").action(move || {
                let path = active_path.get();
                let Ok(line) = goto_line_text.get().trim().parse::<usize>() else {
                    goto_status.set("Enter a line number".into());
                    return;
                };
                // See the `close` handler above for why this can't be a
                // direct `match x.borrow_mut()...` — the `Ok` arm
                // re-borrows `go_session`.
                let result = go_session.borrow_mut().dispatch(AppCommand::GoToLine {
                    path: path.clone(),
                    one_based_line: line,
                });
                match result {
                    Ok(_) => {
                        let byte = go_session
                            .borrow()
                            .workspace
                            .document(&path)
                            .expect("target document is open")
                            .cursors()
                            .first()
                            .map_or(0, |cursor| cursor.anchor);
                        editor_cursor.update(|cursor| {
                            cursor.mode = CursorMode::Insert(Selection::region(byte, byte));
                        });
                        goto_status.set(String::new());
                    }
                    Err(error) => goto_status.set(error.to_string()),
                }
            })
            .variant(ButtonVariant::Primary);
            h_stack((
                text_input(goto_line_text).style(|style| style.width(80.0)),
                go,
                label(move || goto_status.get()),
            ))
            .style(|style| style.gap(theme::space::SM).padding(theme::space::SM).items_center())
            .into_any()
        },
    );

    // Grouped into clusters (Document / Run / Find) separated by hairline
    // dividers rather than one undifferentiated row — the toolbar's own
    // grid structure, and what makes `evaluate` (the header's one
    // `Primary`-accented button) actually read as the primary action
    // instead of being lost among a dozen equally-weighted siblings.
    let document_group = h_stack((save, undo, redo, reload, compare, keep_editor, force_save))
        .style(|style| style.gap(theme::space::SM).items_center());
    let run_group =
        h_stack((evaluate, retry_worker)).style(|style| style.gap(theme::space::SM).items_center());
    let find_group = h_stack((shortcuts_toggle, start_rename, find_replace_toggle, goto_toggle))
        .style(|style| style.gap(theme::space::SM).items_center());
    let header = h_stack((
        label(move || format!("Machinewright · {}", active_path.get().display())),
        label(move || if dirty.get() { " • Modified" } else { "" }),
        toolbar_divider(),
        document_group,
        toolbar_divider(),
        run_group,
        toolbar_divider(),
        find_group,
    ))
    .style(|style| style.gap(theme::space::MD).padding(theme::space::MD).items_center());
    // On its own row, full-width, rather than at the end of the button
    // toolbar: with enough buttons the toolbar overflows a normal window
    // width, and this is the one piece of text that tells you whether the
    // evaluation you just triggered actually succeeded — it must never be
    // the part that gets clipped off-screen.
    let status_row = v_stack((
        label(move || save_status.get()),
        label(move || evaluation_status.get()),
    ))
    .style(|style| style.padding_horiz(theme::space::MD).padding_bottom(theme::space::SM));

    let graph_scene = Rc::clone(&current_scene);
    let graph_snapshot = Rc::clone(&current_snapshot);
    let graph_viewport_state = Rc::clone(&viewport_state);
    let graph_viewport_requests = viewport_requests.clone();
    let graph_session = Rc::clone(&session);
    let graph_programmatic = Rc::clone(&programmatic_edit);
    let graph_root = project.root.clone();
    let graph_editor_cursor = editor_cursor;
    // Virtualized for the same reason as `workspace_tree` — a large
    // assembly's dependency graph can have far more nodes than are ever
    // visible in the scrolled panel at once.
    const GRAPH_ROW_HEIGHT: f64 = 24.0;
    // `virtual_list`, for the same reason as `workspace_tree` above: it
    // keeps the graph virtualized while adding arrow-key/Home/End
    // navigation and a real selection index that `on_select` reacts to
    // uniformly for both clicks and keyboard movement.
    let graph = virtual_list(
        VirtualDirection::Vertical,
        VirtualItemSize::Fixed(Box::new(|| GRAPH_ROW_HEIGHT)),
        move || graph_nodes.get(),
        |row: &GraphRow| row.node_id.clone(),
        move |row: GraphRow| {
            let label_text = format!("{}{}", "  ".repeat(row.depth), row.label);
            let node_id = row.node_id.clone();
            // Highlighted from the shared `selected_set`, not the widget's
            // own internal selection index — that index isn't resynced
            // when `graph_nodes` is replaced by a re-evaluation, so it can
            // point at a stale row until the user clicks again.
            label(move || label_text.clone()).style(move |style| {
                let style = style.height(GRAPH_ROW_HEIGHT);
                if selected_set.get().contains(&node_id) {
                    style.background(theme::accent_tint())
                } else {
                    style
                }
            })
        },
    )
    .on_select(move |index| {
        let Some(index) = index else {
            return;
        };
        let Some(selected_id) =
            graph_nodes.with_untracked(|rows| rows.get(index).map(|row| row.node_id.clone()))
        else {
            return;
        };
        selected.set(Some(selected_id.clone()));
        let command = reduce_graph_intent(GraphIntent::NodeClicked {
            node_id: selected_id.clone(),
        });
        let _ = graph_session.borrow_mut().dispatch(command);
        let selection = graph_session.borrow().selection.clone();
        selected_set.set(selection.graph_node_ids.iter().cloned().collect());
        if selection.stale_source {
            source_location.set("Source mapping is stale · open evaluated revision".into());
        } else if let Some(span) = &selection.source_span {
            let target = graph_root.join(&span.path);
            if graph_session
                .borrow_mut()
                .dispatch(AppCommand::OpenDocument(target.clone()))
                .is_ok()
            {
                let target = target.canonicalize().unwrap_or(target);
                let source = graph_session
                    .borrow()
                    .workspace
                    .document(&target)
                    .expect("mapped document is open")
                    .text();
                active_path.set(target);
                open_tabs.set(graph_session.borrow().workspace.tabs().to_vec());
                graph_programmatic.set(true);
                graph_navigation_document.edit_single(
                    Selection::region(0, graph_navigation_document.text().len()),
                    &source,
                    EditType::Other,
                );
                if span.end_byte <= source.len() as u64 {
                    graph_editor_cursor.update(|cursor| {
                        cursor.mode = CursorMode::Insert(Selection::region(
                            span.start_byte as usize,
                            span.end_byte as usize,
                        ));
                    });
                }
            }
        }
        let mut state = graph_viewport_state.borrow_mut();
        state.selected = Some(PickTarget {
            graph_node_id: selected_id.clone(),
            primitive: None,
        });
        state.selected_nodes = selection.graph_node_ids.iter().cloned().collect();
        let _ = graph_viewport_requests.try_send(ViewportRequest {
            scene: graph_scene.borrow().clone(),
            state: state.clone(),
            width: 800,
            height: 600,
        });
        if let Some(snapshot) = graph_snapshot.borrow().as_ref() {
            if !selection.stale_source {
                source_location.set(source_for_node(snapshot, &selected_id));
            }
            if let Some(node) = snapshot.graph().nodes.get(&selected_id) {
                node_details.set(format!(
                    "{} · {} · {}",
                    node.kind, node.definition_id, node.parameters
                ));
            }
        }
    });
    let graph = scroll(graph).style(|style| style.height_full().width_full());

    let revision_session = Rc::clone(&session);
    let revision_sources = Rc::clone(&current_source_blobs);
    let revision_document = Rc::clone(&document);
    let revision_programmatic = Rc::clone(&programmatic_edit);
    let open_evaluated_revision = button("Open Evaluated Revision").action(move || {
        let selection = revision_session.borrow().selection.clone();
        let Some(span) = selection.source_span else {
            source_location.set("Selection has no evaluated source mapping".into());
            return;
        };
        let Some(path) = revision_sources.borrow().get(&span.source_digest).cloned() else {
            source_location.set("Evaluated source is not present in the cache".into());
            return;
        };
        match std::fs::read_to_string(path) {
            Ok(source) => {
                let display_path = PathBuf::from(format!(
                    "{} @ {}",
                    span.path,
                    span.source_digest.trim_start_matches("sha256:")
                ));
                let _ = revision_session
                    .borrow_mut()
                    .dispatch(AppCommand::OpenEvaluatedRevision {
                        display_path: display_path.clone(),
                        source: source.clone(),
                    });
                active_path.set(display_path);
                open_tabs.set(revision_session.borrow().workspace.tabs().to_vec());
                revision_programmatic.set(true);
                revision_document.edit_single(
                    Selection::region(0, revision_document.text().len()),
                    &source,
                    EditType::Other,
                );
                evaluated_revision_text.set(Some(source));
                source_location.set("Showing cached evaluated revision (read only)".into());
            }
            Err(error) => source_location.set(format!("Cannot open evaluated revision: {error}")),
        }
    })
    .variant(ButtonVariant::Secondary);

    let workspace_panel = v_stack((label(|| "Workspace"), workspace_tree));
    let diff_panel = v_stack((
        label(|| "Editor / disk diff"),
        scroll(dyn_stack(
            move || diff_lines.get(),
            Clone::clone,
            |line| label(move || line.clone()),
        ))
        .style(|style| style.max_height(180.0).width_full()),
    ));
    // The former single un-scrolled `sidebar` column, split into the
    // Right dock's two tabs: Graph (file tree, graph view, selection
    // inspector) and Diagnostics (evaluated-revision diff, language/
    // syntax/evaluation diagnostics, worker status/log). Each panel is
    // built once and stays mounted — only its visibility (driven by
    // `workspace_layout`) changes when the user switches tabs or
    // collapses the zone.
    let graph_panel_workspace_layout = workspace_layout;
    let graph_panel = v_stack((
        workspace_panel,
        label(|| "Graph"),
        graph,
        label(move || format!("Source: {}", source_location.get())),
        label(move || node_details.get()),
        label(move || measurement_status.get()),
    ))
    .style(move |style| {
        let style = style.width_full().gap(theme::space::MD);
        if graph_panel_workspace_layout.get().is_visible(PanelId::Graph) {
            style
        } else {
            style.hide()
        }
    });

    let diagnostics_panel_workspace_layout = workspace_layout;
    let diagnostics_panel = v_stack((
        open_evaluated_revision,
        diff_panel,
        scroll(label(move || {
            evaluated_revision_text.get().unwrap_or_default()
        }))
        .style(|style| style.max_height(180.0).width_full()),
        label(move || language_status.get()),
        label(move || syntax_status.get()),
        scroll(dyn_stack(
            move || syntax_diagnostic_lines.get(),
            Clone::clone,
            |diagnostic| label(move || diagnostic.clone()),
        ))
        .style(|style| style.max_height(120.0).width_full()),
        scroll(dyn_stack(
            move || diagnostic_lines.get(),
            Clone::clone,
            |diagnostic| label(move || diagnostic.clone()),
        ))
        .style(|style| style.max_height(160.0).width_full()),
        v_stack((
            label(|| "Evaluation diagnostics"),
            scroll(dyn_stack(
                move || evaluation_diagnostic_lines.get(),
                Clone::clone,
                |diagnostic| label(move || diagnostic.clone()),
            ))
            .style(|style| style.max_height(160.0).width_full()),
        )),
        v_stack((
            label(move || format!("Worker: {status}")),
            label(|| "Worker log"),
            scroll(dyn_stack(
                move || worker_log_lines.get(),
                Clone::clone,
                |line| label(move || line.clone()),
            ))
            .style(|style| style.max_height(140.0).width_full()),
        )),
    ))
    .style(move |style| {
        let style = style.width_full().gap(theme::space::MD);
        if diagnostics_panel_workspace_layout
            .get()
            .is_visible(PanelId::Diagnostics)
        {
            style
        } else {
            style.hide()
        }
    });

    let sidebar = dock_zone_shell(
        workspace_layout,
        Dock::Right,
        v_stack((graph_panel, diagnostics_panel))
            .style(|style| style.width_full().padding(theme::space::MD).gap(theme::space::MD)),
        320.0,
        false,
    )
    .style(|style| style.background(theme::surface()));

    let viewport_scene = Rc::clone(&current_scene);
    let viewport_snapshot = Rc::clone(&current_snapshot);
    let pick_viewport_state = Rc::clone(&viewport_state);
    let pick_viewport_requests = viewport_requests.clone();
    let pick_session = Rc::clone(&session);
    let pick_programmatic = Rc::clone(&programmatic_edit);
    let pick_root = project.root.clone();
    let pick_editor_cursor = editor_cursor;
    let viewport_control = |text: &'static str, command: ViewportCommand| {
        let state = Rc::clone(&viewport_state);
        let scene = Rc::clone(&current_scene);
        let requests = viewport_requests.clone();
        button(text)
            .action(move || {
                let scene = scene.borrow();
                let mut state = state.borrow_mut();
                state.apply(command, &scene);
                let _ = requests.try_send(ViewportRequest {
                    scene: scene.clone(),
                    state: state.clone(),
                    width: 800,
                    height: 600,
                });
            })
            .variant(ButtonVariant::Icon)
    };
    let fit = viewport_control("Fit", ViewportCommand::Fit);
    let orbit_left = viewport_control(
        "Orbit",
        ViewportCommand::Orbit {
            yaw: -0.2,
            pitch: 0.0,
        },
    );
    let zoom_in = viewport_control("Zoom +", ViewportCommand::Zoom { factor: 0.8 });
    let zoom_out = viewport_control("Zoom −", ViewportCommand::Zoom { factor: 1.25 });
    let front = viewport_control("Front", ViewportCommand::SetAxisView(AxisView::Front));
    let right = viewport_control("Right", ViewportCommand::SetAxisView(AxisView::Right));
    let top = viewport_control("Top", ViewportCommand::SetAxisView(AxisView::Top));
    let projection = viewport_control("Perspective / Ortho", ViewportCommand::ToggleProjection);
    let hide = viewport_control("Hide selected", ViewportCommand::ToggleHideSelected);
    // Isolate and Section are real persistent modes (unlike the one-shot
    // camera commands `viewport_control` is mostly used for), so they get
    // an explicit active-state indicator instead of relying on hover —
    // this replaces what used to be an unexplained, easily-mistaken-for-a-
    // hover-glitch grey box with a deliberate "this mode is currently on"
    // signal, the same `accent_tint()` treatment the active dock tab uses.
    // `viewport_frame` (updated on every rendered frame, which every
    // viewport command triggers) is used purely as a reactivity trigger —
    // `viewport_state` itself is a plain `RefCell`, not a signal.
    let isolate_toggle_state = Rc::clone(&viewport_state);
    let isolate = viewport_control("Isolate", ViewportCommand::ToggleIsolateSelected).style(move |style| {
        viewport_frame.get();
        if isolate_toggle_state.borrow().isolated.is_some() {
            style.background(theme::accent_tint()).color(theme::ink())
        } else {
            style
        }
    });
    let section_toggle_state = Rc::clone(&viewport_state);
    let section = viewport_control("Section", ViewportCommand::ToggleSection).style(move |style| {
        viewport_frame.get();
        if section_toggle_state.borrow().section_plane.is_some() {
            style.background(theme::accent_tint()).color(theme::ink())
        } else {
            style
        }
    });
    let measure_toggle_state = Rc::clone(&viewport_state);
    let measure_toggle_scene = Rc::clone(&current_scene);
    let measure_toggle_requests = viewport_requests.clone();
    let measure_toggle = button("Measure").action(move || {
        let scene = measure_toggle_scene.borrow();
        let mut state = measure_toggle_state.borrow_mut();
        state.apply(ViewportCommand::ToggleMeasureMode, &scene);
        measurement_status.set(if state.measuring {
            "Measurement · choose first point".into()
        } else {
            "Measurement off".into()
        });
        let _ = measure_toggle_requests.try_send(ViewportRequest {
            scene: scene.clone(),
            state: state.clone(),
            width: 800,
            height: 600,
        });
    })
    .variant(ButtonVariant::Ghost);
    let measure_toggle_active_state = Rc::clone(&viewport_state);
    let measure_toggle = measure_toggle.style(move |style| {
        measurement_status.get();
        if measure_toggle_active_state.borrow().measuring {
            style.background(theme::accent_tint()).color(theme::ink())
        } else {
            style
        }
    });
    let cancel_measure_state = Rc::clone(&viewport_state);
    let cancel_measure_scene = Rc::clone(&current_scene);
    let cancel_measure_requests = viewport_requests.clone();
    let cancel_measurement = button("Cancel measurement").action(move || {
        let scene = cancel_measure_scene.borrow();
        let mut state = cancel_measure_state.borrow_mut();
        state.apply(ViewportCommand::CancelMeasurement, &scene);
        if state.measuring {
            measurement_status.set("Measurement · choose first point".into());
        }
        let _ = cancel_measure_requests.try_send(ViewportRequest {
            scene: scene.clone(),
            state: state.clone(),
            width: 800,
            height: 600,
        });
    })
    .variant(ButtonVariant::Destructive);
    let viewport = img(Vec::new);
    let viewport_id = viewport.id();
    create_effect(move |_| {
        let frame = viewport_frame.get();
        viewport_id.update_state(floem::peniko::Image::new(
            floem::peniko::Blob::new(frame.rgba),
            floem::peniko::Format::Rgba8,
            frame.width,
            frame.height,
        ));
        // `Img::update` (floem) only calls `request_layout()`, which is a
        // no-op for paint purposes once the image's dimensions stop
        // changing (always 800x600 here after the first frame) — a
        // content-only update (new pixels, same size) would otherwise
        // never get scheduled for an actual repaint, leaving the viewport
        // showing stale or blank content indefinitely once something else
        // happens to redraw around it.
        viewport_id.request_paint();
    });
    // Drag-to-orbit (primary button), drag-to-pan (secondary button), and
    // scroll-to-zoom. Floem's synthesized `Click` event fires on any
    // press-and-release pair regardless of movement in between (it has no
    // built-in drag threshold), so the pick handler below shares this same
    // state and skips itself once a gesture has moved far enough to be a
    // drag rather than a click.
    let viewport_drag = Rc::new(Cell::new(ViewportDragState::default()));
    let drag_down_state = Rc::clone(&viewport_drag);
    let drag_move_state = Rc::clone(&viewport_drag);
    let drag_click_state = Rc::clone(&viewport_drag);
    let root_drag_state = Rc::clone(&viewport_drag);
    let drag_move_viewport_state = Rc::clone(&viewport_state);
    let drag_move_scene = Rc::clone(&current_scene);
    let drag_move_requests = viewport_requests.clone();
    let wheel_viewport_state = Rc::clone(&viewport_state);
    let wheel_scene = Rc::clone(&current_scene);
    let wheel_requests = viewport_requests.clone();
    let viewport = viewport
        .on_event(EventListener::PointerDown, move |event| {
            let Event::PointerDown(pointer) = event else {
                return EventPropagation::Continue;
            };
            drag_down_state.set(ViewportDragState {
                button: Some(pointer.button),
                last_pos: pointer.pos,
                total_movement: 0.0,
            });
            EventPropagation::Continue
        })
        .on_event(EventListener::PointerMove, move |event| {
            let Event::PointerMove(pointer) = event else {
                return EventPropagation::Continue;
            };
            let mut drag = drag_move_state.get();
            let Some(button) = drag.button else {
                return EventPropagation::Continue;
            };
            let delta_x = pointer.pos.x - drag.last_pos.x;
            let delta_y = pointer.pos.y - drag.last_pos.y;
            drag.total_movement += delta_x.hypot(delta_y);
            drag.last_pos = pointer.pos;
            drag_move_state.set(drag);
            if delta_x == 0.0 && delta_y == 0.0 {
                return EventPropagation::Continue;
            }
            let mut state = drag_move_viewport_state.borrow_mut();
            let scene = drag_move_scene.borrow();
            match button {
                PointerButton::Primary => {
                    state.apply(orbit_drag_command(delta_x, delta_y), &scene);
                }
                PointerButton::Secondary => {
                    let visible_height = state.camera.visible_height_at_target();
                    state.apply(
                        pan_drag_command(delta_x, delta_y, visible_height, VIEWPORT_HEIGHT_PX),
                        &scene,
                    );
                }
                _ => {
                    return EventPropagation::Continue;
                }
            }
            let _ = drag_move_requests.try_send(ViewportRequest {
                scene: scene.clone(),
                state: state.clone(),
                width: VIEWPORT_WIDTH_PX as u32,
                height: VIEWPORT_HEIGHT_PX as u32,
            });
            EventPropagation::Continue
        })
        .on_event(EventListener::PointerWheel, move |event| {
            let Event::PointerWheel(wheel) = event else {
                return EventPropagation::Continue;
            };
            let mut state = wheel_viewport_state.borrow_mut();
            let scene = wheel_scene.borrow();
            state.apply(wheel_zoom_command(wheel.delta.y), &scene);
            let _ = wheel_requests.try_send(ViewportRequest {
                scene: scene.clone(),
                state: state.clone(),
                width: VIEWPORT_WIDTH_PX as u32,
                height: VIEWPORT_HEIGHT_PX as u32,
            });
            EventPropagation::Stop
        })
        .on_click_stop(move |event| {
            // Always terminate the gesture on release — regardless of
            // whether it turns out to have been a click or a drag — so a
            // subsequent bare hover-only `PointerMove` never continues
            // orbiting/panning the camera from a stale press.
            let drag = drag_click_state.get();
            drag_click_state.set(ViewportDragState::default());
            if drag.total_movement > CLICK_MOVEMENT_THRESHOLD {
                return;
            }
            let Event::PointerUp(pointer) = event else {
                return;
            };
            let rect = viewport_id.get_content_rect();
            if rect.width() <= 0.0 || rect.height() <= 0.0 {
                return;
            }
            let Some(hit) = viewport_scene.borrow().pick(
                &pick_viewport_state.borrow(),
                (pointer.pos.x - rect.x0) * 800.0 / rect.width(),
                (pointer.pos.y - rect.y0) * 600.0 / rect.height(),
                800.0,
                600.0,
            ) else {
                return;
            };
            // Measure mode and node selection never share a click: while
            // measuring, a click only advances the measurement state
            // machine, so it can't also jump the editor to an unrelated
            // node's source out from under the person lining up a
            // measurement.
            if pick_viewport_state.borrow().measuring {
                let mut state = pick_viewport_state.borrow_mut();
                let measurement = state.measure(hit.position).cloned();
                let _ = pick_viewport_requests.try_send(ViewportRequest {
                    scene: viewport_scene.borrow().clone(),
                    state: state.clone(),
                    width: 800,
                    height: 600,
                });
                drop(state);
                measurement_status.set(measurement.map_or_else(
                    || "Measurement · choose second point".into(),
                    |measurement| format!("Distance · {:.3}", measurement.distance),
                ));
                return;
            }
            let node_id = hit.target.graph_node_id.clone();
            selected.set(Some(node_id.clone()));
            let _ = pick_session
                .borrow_mut()
                .dispatch(AppCommand::SelectNode(node_id.clone()));
            let selection = pick_session.borrow().selection.clone();
            selected_set.set(selection.graph_node_ids.iter().cloned().collect());
            if selection.stale_source {
                source_location.set("Source mapping is stale · open evaluated revision".into());
            } else if let Some(span) = &selection.source_span {
                let target = pick_root.join(&span.path);
                if pick_session
                    .borrow_mut()
                    .dispatch(AppCommand::OpenDocument(target.clone()))
                    .is_ok()
                {
                    let target = target.canonicalize().unwrap_or(target);
                    let source = pick_session
                        .borrow()
                        .workspace
                        .document(&target)
                        .expect("mapped document is open")
                        .text();
                    active_path.set(target);
                    open_tabs.set(pick_session.borrow().workspace.tabs().to_vec());
                    pick_programmatic.set(true);
                    pick_navigation_document.edit_single(
                        Selection::region(0, pick_navigation_document.text().len()),
                        &source,
                        EditType::Other,
                    );
                    if span.end_byte <= source.len() as u64 {
                        pick_editor_cursor.update(|cursor| {
                            cursor.mode = CursorMode::Insert(Selection::region(
                                span.start_byte as usize,
                                span.end_byte as usize,
                            ));
                        });
                    }
                }
            }
            let mut state = pick_viewport_state.borrow_mut();
            state.selected = Some(hit.target);
            state.selected_nodes = selection.graph_node_ids.iter().cloned().collect();
            let _ = pick_viewport_requests.try_send(ViewportRequest {
                scene: viewport_scene.borrow().clone(),
                state: state.clone(),
                width: 800,
                height: 600,
            });
            if let Some(snapshot) = viewport_snapshot.borrow().as_ref() {
                if !selection.stale_source {
                    source_location.set(source_for_node(snapshot, &node_id));
                }
                if let Some(node) = snapshot.graph().nodes.get(&node_id) {
                    node_details.set(format!(
                        "{} · {} · {}",
                        node.kind, node.definition_id, node.parameters
                    ));
                }
            }
        })
        .style(|style| style.width_full().height_full().flex_grow(1.0));

    // Same grouped-cluster grid as the header toolbar: camera vs. view-axis
    // vs. visibility vs. measurement read as distinct segments instead of
    // 13 equally-weighted buttons in two undifferentiated rows.
    let camera_group =
        h_stack((fit, orbit_left, zoom_in, zoom_out)).style(|style| style.gap(theme::space::XS));
    let view_group =
        h_stack((front, right, top, projection)).style(|style| style.gap(theme::space::XS));
    let selection_group =
        h_stack((hide, isolate, section)).style(|style| style.gap(theme::space::XS));
    let measurement_group = h_stack((measure_toggle, cancel_measurement))
        .style(|style| style.gap(theme::space::XS));
    let viewport_panel = v_stack((
        h_stack((camera_group, toolbar_divider(), view_group))
            .style(|style| style.gap(theme::space::XS).items_center()),
        h_stack((selection_group, toolbar_divider(), measurement_group))
            .style(|style| style.gap(theme::space::XS).items_center()),
        viewport,
    ))
    .style(|style| style.width_full().height_full().flex_grow(1.0));

    // Behavior Lab: typed-input controls and the cancellable-sweep panel
    // (RFD-19 M3). Both dispatch through the same `ProjectSession`/
    // `EvaluationRuntime` seam ordinary source edits use; the sweep panel
    // additionally reuses the live viewport to display a clicked point's
    // geometry, via `AppCommand::InspectSnapshot` (never touching the live
    // session's own snapshot/selection).
    let behavior_lab_worker_executable = EnvironmentSpec::resolve(&project.root)
        .map(|spec| spec.worker_executable)
        .unwrap_or_else(|_| project.root.join(".venv/bin/machinewright-worker"));
    let controls_panel_workspace_layout = workspace_layout;
    let controls_panel = controls::controls_panel(
        Rc::clone(&session),
        Arc::clone(&evaluation_runtime),
        worker_sender.clone(),
        requests.clone(),
        evaluation_status,
        behavior_lab_worker_executable,
    )
    .style(move |style| {
        let style = style.width_full();
        if controls_panel_workspace_layout
            .get()
            .is_visible(PanelId::Controls)
        {
            style
        } else {
            style.hide()
        }
    });
    let sweep_panel_workspace_layout = workspace_layout;
    let sweep_panel = sweep::sweep_panel(
        Rc::clone(&session),
        evaluation_status,
        Rc::clone(&viewport_state),
        Rc::clone(&current_scene),
        viewport_requests.clone(),
    )
    .style(move |style| {
        let style = style.width_full();
        if sweep_panel_workspace_layout.get().is_visible(PanelId::Sweep) {
            style
        } else {
            style.hide()
        }
    });
    // Controls and Sweep are tabs of one Bottom dock zone (like the
    // graph/diagnostics split above) rather than a fixed side-by-side row
    // — only one is visible at a time, so the zone needs roughly half the
    // width a side-by-side layout would, and it's independently
    // collapsible/scrollable like every other dock zone instead of a
    // one-off fixed-height row.
    let behavior_lab = dock_zone_shell(
        workspace_layout,
        Dock::Bottom,
        v_stack((controls_panel, sweep_panel)).style(|style| style.width_full()),
        360.0,
        true,
    );

    // Keyboard shortcuts mirroring the Save/Undo/Redo/Evaluate buttons above,
    // attached to the root view so they work regardless of which child has
    // focus (as long as no more specific handler, e.g. the text editor's own
    // key handling, consumes the event first).
    let key_save_session = Rc::clone(&session);
    let key_save_language_requests = language_requests.clone();
    let key_history_session = Rc::clone(&session);
    let key_history_document = Rc::clone(&document);
    let key_history_programmatic = Rc::clone(&programmatic_edit);
    let key_evaluate_session = Rc::clone(&session);
    let key_evaluate_runtime = Arc::clone(&evaluation_runtime);
    let key_evaluate_sender = worker_sender.clone();
    let key_evaluate_requests = requests.clone();
    let key_viewport_state = Rc::clone(&viewport_state);
    let key_viewport_scene = Rc::clone(&current_scene);
    let key_viewport_requests = viewport_requests.clone();
    let key_palette_project_files = project_files;

    // Resolves a confirmed palette command into real work: an
    // `open-file:<relative path>` id reuses the exact same
    // `open_file_into_session` the file tree itself calls (no duplicated
    // open-document logic); `open-project-new-window` prompts a native
    // folder picker and spawns a fully independent second process rooted
    // there, mirroring the existing Trust-and-Run restart idiom.
    let palette_open_root = project.root.clone();
    let palette_open_session = Rc::clone(&session);
    let palette_open_document = Rc::clone(&document);
    let palette_open_programmatic = Rc::clone(&programmatic_edit);
    let on_palette_confirm = move |id: PaletteCommandId| {
        if id.0 == "open-project-new-window" {
            if let Some(chosen) = rfd::FileDialog::new().pick_folder() {
                spawn_project_window(&chosen);
            }
            return;
        }
        if let Some(relative) = id.0.strip_prefix("open-file:") {
            let target = palette_open_root.join(relative);
            open_file_into_session(
                &target,
                &palette_open_session,
                active_path,
                open_tabs,
                &palette_open_document,
                &palette_open_programmatic,
                editor_cursor,
                dirty,
                save_status,
            );
        }
    };
    let palette_overlay = command_palette_overlay(command_palette, command_palette_query, on_palette_confirm);

    // Wraps the whole app in a scroll region as a defense-in-depth safety
    // net on top of `launch_sized`'s explicit window size: even if a user
    // resizes the OS window smaller than the content needs, everything
    // stays reachable by scrolling instead of silently clipped below the
    // window bounds (the bug that prompted this — see RFD-19 M3's
    // workspace-layout design notes).
    let root = scroll(
        v_stack((
        header,
        status_row,
        shortcuts_panel,
        v_stack((rename_row, find_replace_row, goto_row)),
        tab_strip,
        h_stack((
            h_stack((
                editor.style(|style| style.width_pct(60.0)),
                viewport_panel.style(|style| style.width_pct(40.0)),
            ))
            .style(|style| style.flex_grow(1.0).height_full()),
            // Fixed width (set inside `dock_zone_shell`), not a percentage
            // of the row like `editor`/`viewport_panel` — a dock zone's
            // size is independent of how much space the center area gets.
            sidebar,
        ))
        .style(|style| style.flex_grow(1.0).width_full()),
        behavior_lab,
    ))
    .style(|style| style.width_full().height_full())
    .keyboard_navigable()
    .on_event(EventListener::KeyDown, move |event| {
        let Event::KeyDown(key_event) = event else {
            return EventPropagation::Continue;
        };
        // Checked first, ahead of every other shortcut, so the palette can
        // be summoned regardless of which panel currently has focus.
        if matches_chord(key_event, "p", PRIMARY_MODIFIER) {
            let commands = build_palette_commands(&key_palette_project_files.get());
            open_palette(command_palette, command_palette_query, commands);
            return EventPropagation::Stop;
        }
        if matches_chord(key_event, "o", PRIMARY_MODIFIER) {
            if let Some(chosen) = rfd::FileDialog::new().pick_folder() {
                spawn_project_window(&chosen);
            }
            return EventPropagation::Stop;
        }
        if matches_chord(key_event, "s", PRIMARY_MODIFIER) {
            match key_save_session
                .borrow_mut()
                .dispatch(AppCommand::SaveDocument {
                    path: active_path.get(),
                    force: false,
                }) {
                Ok(_) => {
                    dirty.set(false);
                    save_status.set("Saved".into());
                    let _ =
                        key_save_language_requests.send(LanguageRequest::Saved(active_path.get()));
                }
                Err(error) => save_status.set(error.to_string()),
            }
            return EventPropagation::Stop;
        }
        if matches_chord(key_event, "z", PRIMARY_MODIFIER | Modifiers::SHIFT)
            || matches_chord(key_event, "z", PRIMARY_MODIFIER)
        {
            let redo = matches_chord(key_event, "z", PRIMARY_MODIFIER | Modifiers::SHIFT);
            let command = if redo {
                AppCommand::Redo(active_path.get())
            } else {
                AppCommand::Undo(active_path.get())
            };
            if key_history_session.borrow_mut().dispatch(command).is_ok() {
                let source = key_history_session
                    .borrow()
                    .workspace
                    .document(&active_path.get())
                    .expect("history document remains open")
                    .text();
                key_history_programmatic.set(true);
                key_history_document.edit_single(
                    Selection::region(0, key_history_document.text().len()),
                    &source,
                    EditType::Other,
                );
                evaluation_status.set("Waiting for evaluation…".into());
                if let Err(error) = schedule_evaluation(
                    &key_evaluate_session,
                    &key_evaluate_runtime,
                    &key_evaluate_sender,
                    &key_evaluate_requests,
                ) {
                    evaluation_status.set(error);
                }
            }
            return EventPropagation::Stop;
        }
        if matches_named(key_event, NamedKey::Enter, PRIMARY_MODIFIER) {
            evaluation_status.set("Waiting for evaluation…".into());
            if let Err(error) = schedule_evaluation(
                &key_evaluate_session,
                &key_evaluate_runtime,
                &key_evaluate_sender,
                &key_evaluate_requests,
            ) {
                evaluation_status.set(error);
            }
            return EventPropagation::Stop;
        }
        if matches_chord(key_event, "g", PRIMARY_MODIFIER) {
            goto_visible.update(|visible| *visible = !*visible);
            return EventPropagation::Stop;
        }
        // Camera/measurement shortcuts, mirroring the viewport buttons
        // above. Alt-gated (unlike Save/Undo/Redo/Evaluate, which mirror
        // the platform's own convention) since a bare letter or digit would
        // otherwise collide with typing in the source editor.
        let apply_viewport_command = |command: ViewportCommand| {
            let scene = key_viewport_scene.borrow();
            let mut state = key_viewport_state.borrow_mut();
            state.apply(command, &scene);
            let _ = key_viewport_requests.try_send(ViewportRequest {
                scene: scene.clone(),
                state: state.clone(),
                width: VIEWPORT_WIDTH_PX as u32,
                height: VIEWPORT_HEIGHT_PX as u32,
            });
        };
        if matches_named(key_event, NamedKey::Escape, Modifiers::empty())
            && key_viewport_state.borrow().measuring
        {
            apply_viewport_command(ViewportCommand::CancelMeasurement);
            measurement_status.set("Measurement · choose first point".into());
            return EventPropagation::Stop;
        }
        if matches_chord(key_event, "f", Modifiers::ALT) {
            apply_viewport_command(ViewportCommand::Fit);
            return EventPropagation::Stop;
        }
        if matches_named(key_event, NamedKey::ArrowLeft, Modifiers::ALT) {
            apply_viewport_command(ViewportCommand::Orbit {
                yaw: -0.2,
                pitch: 0.0,
            });
            return EventPropagation::Stop;
        }
        if matches_named(key_event, NamedKey::ArrowRight, Modifiers::ALT) {
            apply_viewport_command(ViewportCommand::Orbit {
                yaw: 0.2,
                pitch: 0.0,
            });
            return EventPropagation::Stop;
        }
        if matches_named(key_event, NamedKey::ArrowUp, Modifiers::ALT) {
            apply_viewport_command(ViewportCommand::Orbit {
                yaw: 0.0,
                pitch: -0.2,
            });
            return EventPropagation::Stop;
        }
        if matches_named(key_event, NamedKey::ArrowDown, Modifiers::ALT) {
            apply_viewport_command(ViewportCommand::Orbit {
                yaw: 0.0,
                pitch: 0.2,
            });
            return EventPropagation::Stop;
        }
        if matches_chord(key_event, "=", Modifiers::ALT)
            || matches_chord(key_event, "+", Modifiers::ALT)
        {
            apply_viewport_command(ViewportCommand::Zoom { factor: 0.8 });
            return EventPropagation::Stop;
        }
        if matches_chord(key_event, "-", Modifiers::ALT) {
            apply_viewport_command(ViewportCommand::Zoom { factor: 1.25 });
            return EventPropagation::Stop;
        }
        if matches_chord(key_event, "1", Modifiers::ALT) {
            apply_viewport_command(ViewportCommand::SetAxisView(AxisView::Front));
            return EventPropagation::Stop;
        }
        if matches_chord(key_event, "2", Modifiers::ALT) {
            apply_viewport_command(ViewportCommand::SetAxisView(AxisView::Right));
            return EventPropagation::Stop;
        }
        if matches_chord(key_event, "3", Modifiers::ALT) {
            apply_viewport_command(ViewportCommand::SetAxisView(AxisView::Top));
            return EventPropagation::Stop;
        }
        if matches_chord(key_event, "p", Modifiers::ALT) {
            apply_viewport_command(ViewportCommand::ToggleProjection);
            return EventPropagation::Stop;
        }
        if matches_chord(key_event, "h", Modifiers::ALT) {
            apply_viewport_command(ViewportCommand::ToggleHideSelected);
            return EventPropagation::Stop;
        }
        if matches_chord(key_event, "i", Modifiers::ALT) {
            apply_viewport_command(ViewportCommand::ToggleIsolateSelected);
            return EventPropagation::Stop;
        }
        if matches_chord(key_event, "x", Modifiers::ALT) {
            apply_viewport_command(ViewportCommand::ToggleSection);
            return EventPropagation::Stop;
        }
        if matches_chord(key_event, "m", Modifiers::ALT) {
            apply_viewport_command(ViewportCommand::ToggleMeasureMode);
            let measuring = key_viewport_state.borrow().measuring;
            measurement_status.set(if measuring {
                "Measurement · choose first point".into()
            } else {
                "Measurement off".into()
            });
            return EventPropagation::Stop;
        }
        EventPropagation::Continue
    })
    // A fallback for a drag that ends outside the viewport's own bounds:
    // normal hit-testing only delivers `PointerUp` to whatever is under the
    // cursor at release time, which may not be the viewport, so its own
    // `on_click_stop` handler never runs and never resets the drag state.
    // This root-level listener still sees the event as it bubbles up
    // (unless a more specific handler already stopped it, which the
    // viewport's own handler does for the common in-bounds case — this is
    // only a backstop for the rest), and unconditionally clears it. Reset
    // is idempotent, so double-firing for an in-bounds release is harmless.
    .on_event(EventListener::PointerUp, move |_| {
        root_drag_state.set(ViewportDragState::default());
        EventPropagation::Continue
    }),
    )
    .style(|style| style.width_full().height_full());

    // The palette floats over everything else via absolute positioning
    // (`command_palette_overlay`'s own styling) — wrapping it alongside the
    // existing root is purely additive: the previous root keeps 100% of
    // its own styling/handlers, and taffy resolves the overlay's `inset`
    // against this container's content box regardless of the root's own
    // (default, static) position. Deliberately `v_stack`, not the bare
    // `stack()` a first pass used here: `stack()`'s direction is `None`,
    // which taffy/flexbox defaults to `Row` — that put `root` (the only
    // normal-flow child) into a row-direction flex container instead of
    // the column layout its own internal structure assumes, and was the
    // root cause of the bottom dock going missing again after this overlay
    // was added. `palette_overlay` is `.absolute()`-positioned regardless
    // of direction, so `v_stack` doesn't change anything about it.
    v_stack((root, palette_overlay)).style(|style| style.width_full().height_full())
}

/// Opens a window at an explicit size, always resizable. Every `launch`
/// site in this file used to go through floem's bare `launch()` helper,
/// which passes `WindowConfig::default()` — no size hint at all, so the OS
/// picks whatever default it likes and anything added to the bottom of the
/// root view (like the dock zones below) can end up entirely below the
/// visible window with no way to reach it. `resizable` is already floem's
/// default; what was missing was ever asking for a size worth resizing
/// from.
fn launch_sized<V: IntoView + 'static>(
    width: f64,
    height: f64,
    title: &str,
    app_view: impl FnOnce() -> V + 'static,
) {
    let config = WindowConfig::default()
        .size(Size::new(width, height))
        .resizable(true)
        .title(title);
    Application::new()
        .window(move |_| app_view(), Some(config))
        .run();
}

fn main() {
    let path = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("../examples/reference_project.py"));
    let path = path.canonicalize().unwrap_or(path);
    let project = match PortableProject::discover(&path) {
        Ok(project) => project,
        Err(error) => {
            let message = format!(
                "Could not open a Machinewright project at {}: {error}. The path must be inside a project containing machinewright.toml.",
                path.display()
            );
            launch_sized(640.0, 400.0, "Machinewright", move || {
                startup_error_app(path, String::new(), message)
            });
            return;
        }
    };
    let source = match std::fs::read_to_string(&path) {
        Ok(source) => source,
        Err(error) => {
            let message = format!("Failed to read {}: {error}.", path.display());
            launch_sized(640.0, 400.0, "Machinewright", move || {
                startup_error_app(path, String::new(), message)
            });
            return;
        }
    };
    let data_root = dirs::data_local_dir()
        .unwrap_or_else(|| std::env::temp_dir().join("machinewright-data"))
        .join("machinewright");
    let trust_path = data_root.join("trust.json");
    let trusted = TrustStore::load(&trust_path)
        .and_then(|store| store.is_trusted(&project.root))
        .unwrap_or(false);
    if !trusted {
        let project_root = project.root.clone();
        launch_sized(640.0, 400.0, "Machinewright", move || {
            untrusted_app(path, source, project_root, trust_path)
        });
        return;
    }
    let mut session = match ProjectSession::open(&project.root) {
        Ok(session) => session,
        Err(error) => {
            let message = format!(
                "Failed to open the project workspace at {}: {error}.",
                project.root.display()
            );
            launch_sized(640.0, 400.0, "Machinewright", move || {
                startup_error_app(path, source, message)
            });
            return;
        }
    };
    let preferences_key = format!(
        "{:x}",
        Sha256::digest(project.root.to_string_lossy().as_bytes())
    );
    let preferences_path = data_root
        .join("workspaces")
        .join(format!("{preferences_key}.json"));
    let preferences = WorkspacePreferences::load(&preferences_path).unwrap_or_default();
    let _ = preferences.restore(&mut session.workspace);
    if let Err(error) = session.dispatch(AppCommand::OpenDocument(path.clone())) {
        let message = format!(
            "Failed to open {} in the workspace: {error}.",
            path.display()
        );
        launch_sized(640.0, 400.0, "Machinewright", move || {
            startup_error_app(path, source, message)
        });
        return;
    }
    let session = Rc::new(RefCell::new(session));
    // Cache restoration and worker startup are independent: a missing or
    // slow environment must not block a healthy cache from being shown (see
    // R5 in docs/m2-implementation-review-2026-09-10.md). `start_worker`
    // resolves the environment itself and never fails — a connection
    // failure surfaces as a disconnected status with a working Retry inside
    // the normal workspace instead of a separate error screen.
    let cache_root = std::env::var_os("MACHINEWRIGHT_CACHE")
        .map(PathBuf::from)
        .or_else(|| dirs::cache_dir().map(|path| path.join("machinewright")))
        .unwrap_or_else(|| std::env::temp_dir().join("machinewright-cache"));
    let project_name: String = project
        .project_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '_'
            }
        })
        .collect();
    let root_digest = format!(
        "{:x}",
        Sha256::digest(project.root.to_string_lossy().as_bytes())
    );
    let project_key = format!("{project_name}_{}", &root_digest[..16]);
    let store = SnapshotStore::new(cache_root);
    let restored = store
        .restore(&project_key)
        .ok()
        .flatten()
        .map(|(record, lease)| (record, Arc::new(lease)));
    let log_path = data_root
        .join("logs")
        .join(format!("{project_key}-worker.log"));
    let runtime = start_worker(project.root.clone(), project_key, store, log_path);
    let language_runtime = start_language(&project.root);
    launch_sized(1440.0, 960.0, "Machinewright", move || {
        app(
            path,
            project,
            session,
            runtime,
            language_runtime,
            restored,
            preferences_path,
            trust_path,
        )
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diagnostics(path: &str, revision: u64) -> LanguageRequest {
        LanguageRequest::Diagnostics {
            revision,
            path: PathBuf::from(path),
            source: String::new(),
        }
    }

    #[test]
    fn coalesce_language_requests_keeps_only_the_latest_diagnostics_per_path() {
        let batch = vec![diagnostics("a.py", 1), diagnostics("a.py", 2), diagnostics("a.py", 3)];
        assert_eq!(coalesce_language_requests(batch), vec![diagnostics("a.py", 3)]);
    }

    #[test]
    fn coalesce_language_requests_preserves_order_of_everything_else() {
        let batch = vec![
            diagnostics("a.py", 1),
            LanguageRequest::Saved(PathBuf::from("a.py")),
            diagnostics("a.py", 2),
            LanguageRequest::Close(PathBuf::from("b.py")),
            diagnostics("b.py", 1),
        ];
        assert_eq!(
            coalesce_language_requests(batch),
            vec![
                diagnostics("a.py", 1),
                LanguageRequest::Saved(PathBuf::from("a.py")),
                diagnostics("a.py", 2),
                LanguageRequest::Close(PathBuf::from("b.py")),
                diagnostics("b.py", 1),
            ]
        );
    }

    #[test]
    fn source_provenance_mismatch_is_none_when_digests_agree() {
        let sources = BTreeMap::from([(PathBuf::from("a.py"), b"value = 1\n".to_vec())]);
        let digest = format!("sha256:{:x}", Sha256::digest(b"value = 1\n"));
        let evaluated = BTreeMap::from([("a.py".to_string(), digest)]);
        assert_eq!(source_provenance_mismatch(&evaluated, &sources), None);
    }

    #[test]
    fn source_provenance_mismatch_detects_a_diverged_file() {
        // Simulates an external edit landing between Rust's own read of the
        // project tree and the worker materializing its overlay: the bytes
        // captured for caching no longer match what was actually evaluated.
        let sources = BTreeMap::from([(PathBuf::from("a.py"), b"value = 1\n".to_vec())]);
        let evaluated = BTreeMap::from([(
            "a.py".to_string(),
            format!("sha256:{:x}", Sha256::digest(b"value = 2\n")),
        )]);
        let mismatch = source_provenance_mismatch(&evaluated, &sources);
        assert!(mismatch.is_some_and(|message| message.contains("a.py")));
    }

    #[test]
    fn source_provenance_mismatch_ignores_paths_missing_from_either_side() {
        let sources = BTreeMap::new();
        let evaluated = BTreeMap::from([("only-on-worker.py".to_string(), "sha256:x".to_string())]);
        assert_eq!(source_provenance_mismatch(&evaluated, &sources), None);
    }
}
