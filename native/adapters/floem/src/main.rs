use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, HashSet},
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
    IntoView,
    event::Event,
    launch,
    peniko::Color,
    prelude::*,
    quit_app,
    reactive::{RwSignal, SignalGet, SignalUpdate, create_effect},
    views::{button, dyn_stack, h_stack, img, label, scroll, text_editor, v_stack},
};
use floem_editor_core::{cursor::CursorMode, editor::EditType, selection::Selection};
use machinewright_app::{
    AppCommand, EvaluationPort, EvaluationRequest, LanguagePort, PortableProject, ProjectSession,
    WorkerCapabilities,
};
use machinewright_cache::{CacheLease, SnapshotImport, SnapshotRecord, SnapshotStore};
use machinewright_editor::PythonSyntax;
use machinewright_evaluator::{
    ResourcePolicy, SupervisorAction, WorkerMonitor, WorkerProcess, WorkerSender, WorkerSupervisor,
    force_kill,
};
use machinewright_language::TyLanguageServer;
use machinewright_model::ProjectSnapshot;
use machinewright_protocol::v1::{CancelEvaluation, WorkerRequest, worker_request};
use machinewright_render::{
    AxisView, OffscreenRenderer, PickTarget, Projection, Scene, ViewportState,
};
use machinewright_workspace::{
    Cursor as WorkspaceCursor, DiffKind, DiskChange, EnvironmentSpec, ProjectWatcher, TrustStore,
    WorkspacePreferences,
};
use sha2::{Digest, Sha256};

#[derive(Clone)]
struct EvaluationResult {
    generation: u64,
    artifact_root: PathBuf,
    result: Result<ProjectSnapshot, String>,
    lease: Option<Arc<CacheLease>>,
    source_blobs: BTreeMap<String, PathBuf>,
}

#[derive(Clone)]
struct LatestEvaluationSender {
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
struct SharedWorkerSender {
    inner: Arc<Mutex<WorkerSender>>,
    cancel_requested: Arc<Mutex<Option<(u64, Instant)>>>,
}

impl SharedWorkerSender {
    fn new(sender: WorkerSender) -> Self {
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
            *slot = sender;
        }
    }
}

enum LanguageRequest {
    Diagnostics {
        revision: u64,
        path: PathBuf,
        source: String,
    },
    Saved(PathBuf),
    WatchedFiles(Vec<PathBuf>),
}

#[derive(Clone)]
struct LanguageResult {
    revision: u64,
    result: Result<Vec<machinewright_app::EditorDiagnostic>, String>,
}

type WorkerRuntime = (
    WorkerCapabilities,
    bool,
    SharedWorkerSender,
    LatestEvaluationSender,
    crossbeam_channel::Receiver<EvaluationResult>,
    crossbeam_channel::Receiver<Vec<String>>,
    crossbeam_channel::Receiver<String>,
    crossbeam_channel::Sender<()>,
    Arc<AtomicU64>,
);

type LanguageRuntime = (
    crossbeam_channel::Sender<LanguageRequest>,
    crossbeam_channel::Receiver<LanguageResult>,
);

#[derive(Clone)]
struct ViewportRequest {
    scene: Scene,
    state: ViewportState,
    width: u32,
    height: u32,
}

#[derive(Clone)]
struct LatestViewportSender {
    pending: Arc<Mutex<Option<(u64, ViewportRequest)>>>,
    wake: crossbeam_channel::Sender<()>,
    revision: Arc<AtomicU64>,
}

impl LatestViewportSender {
    fn try_send(&self, request: ViewportRequest) -> Result<(), ()> {
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

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct GraphRow {
    node_id: String,
    label: String,
    depth: usize,
}

fn graph_rows(snapshot: &ProjectSnapshot) -> Vec<GraphRow> {
    fn append(
        snapshot: &ProjectSnapshot,
        node_id: &str,
        depth: usize,
        rows: &mut Vec<GraphRow>,
        visited: &mut HashSet<String>,
    ) {
        if !visited.insert(node_id.to_owned()) {
            return;
        }
        let Some(node) = snapshot.graph().nodes.get(node_id) else {
            return;
        };
        rows.push(GraphRow {
            node_id: node_id.into(),
            label: format!("{} · {}", node.instance_key, node.kind),
            depth,
        });
        if let Some(children) = snapshot.graph().children.get(node_id) {
            for child in children {
                append(snapshot, child, depth + 1, rows, visited);
            }
        }
    }
    let mut rows = Vec::new();
    let mut visited = HashSet::new();
    for root in snapshot.graph().roots() {
        append(snapshot, &root.node_id, 0, &mut rows, &mut visited);
    }
    for node_id in snapshot.graph().nodes.keys() {
        append(snapshot, node_id, 0, &mut rows, &mut visited);
    }
    rows
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
        let mut server = TyLanguageServer::spawn(executable, &root);
        while let Ok(request) = request_rx.recv() {
            match request {
                LanguageRequest::Diagnostics {
                    revision,
                    path,
                    source,
                } => {
                    let result = match server.as_mut() {
                        Ok(server) => server
                            .diagnostics(&path, &source)
                            .map_err(|error| error.to_string()),
                        Err(error) => Err(error.to_string()),
                    };
                    if result_tx.send(LanguageResult { revision, result }).is_err() {
                        break;
                    }
                }
                LanguageRequest::Saved(path) => {
                    if let Ok(server) = server.as_mut() {
                        let _ = server.did_save(&path);
                    }
                }
                LanguageRequest::WatchedFiles(paths) => {
                    if let Ok(server) = server.as_mut() {
                        let _ = server.watched_files(&paths);
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
fn spawn_worker(
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
fn evaluate_supervised(
    worker: &mut WorkerProcess,
    request: &EvaluationRequest,
    supervisor: &Arc<Mutex<WorkerSupervisor>>,
    cancel_requested: &Arc<Mutex<Option<(u64, Instant)>>>,
    logs: &machinewright_evaluator::WorkerLog,
) -> Result<ProjectSnapshot, String> {
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
    let result = worker.evaluate(request).map_err(|error| error.to_string());
    running.store(false, Ordering::SeqCst);
    let _ = monitor_handle.join();
    result
}

fn start_worker(
    environment: EnvironmentSpec,
    project_key: String,
    store: SnapshotStore,
    log_path: PathBuf,
) -> Result<WorkerRuntime, String> {
    let (mut worker, capabilities) = spawn_worker(&environment)?;
    let developer_override = environment.developer_override;
    if let Err(error) = worker
        .logs()
        .enable_file_sink(log_path.clone(), 8 * 1024 * 1024)
    {
        worker.logs().push(format!(
            "failed to enable worker log file at {}: {error}",
            log_path.display()
        ));
    }
    let sender = SharedWorkerSender::new(worker.sender());
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
    // Tracks the most recently *requested* generation, set by `schedule_evaluation`
    // as soon as a new evaluation is scheduled — not just the one currently
    // running. The eval loop consults it before committing to the durable
    // snapshot cache, so a superseded generation is never written as "last
    // valid" ahead of being discarded by the UI.
    let latest = Arc::new(AtomicU64::new(0));
    let current_logs = Arc::new(Mutex::new(worker.logs()));
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
    let eval_latest = Arc::clone(&latest);
    std::thread::spawn(move || {
        let supervisor = Arc::new(Mutex::new(WorkerSupervisor::new(ResourcePolicy::default())));
        let thread_started = Instant::now();
        let mut recovery_required = false;
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
                    recovery_required = false;
                    let _ = health_tx.send(String::new());
                    continue;
                }
            }
            let Some(request) = pending.lock().ok().and_then(|mut slot| slot.take()) else {
                continue;
            };
            let generation = request.generation;
            let artifact_root = request.output_directory.clone();
            if recovery_required {
                let _ = result_tx.send(EvaluationResult {
                    generation,
                    artifact_root,
                    result: Err("worker recovery required — use Retry Worker to continue".into()),
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
                .unwrap_or_else(|_| worker.logs());
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
                &mut worker,
                &request,
                &supervisor,
                &eval_sender.cancel_requested,
                &worker_logs,
            )
            .and_then(|_snapshot| {
                if generation != eval_latest.load(Ordering::SeqCst) {
                    return Err(format!(
                        "evaluation for generation {generation} superseded before it could be cached"
                    ));
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
                        lease = Some(Arc::new(cache_lease));
                        source_blobs = record.source_blobs;
                        result_artifact_root = record.artifact_root;
                        record.snapshot
                    })
                    .map_err(|error| error.to_string())
            });
            let result = match result {
                Ok(snapshot) => Ok(snapshot),
                Err(error) => {
                    let crashed = matches!(worker.try_wait(), Ok(Some(_)) | Err(_));
                    if crashed {
                        let action = supervisor
                            .lock()
                            .map(|mut guard| guard.record_exit(thread_started.elapsed()))
                            .unwrap_or(SupervisorAction::RecoveryRequired);
                        match action {
                            SupervisorAction::RecoveryRequired => {
                                recovery_required = true;
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
                                match spawn_worker(&environment) {
                                    Ok((new_worker, _capabilities)) => {
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
                                        worker = new_worker;
                                    }
                                    Err(spawn_error) => {
                                        recovery_required = true;
                                        worker_logs
                                            .push(format!("worker respawn failed: {spawn_error}"));
                                        let _ = health_tx.send(format!(
                                            "Worker respawn failed ({spawn_error}) — use Retry Worker to continue."
                                        ));
                                    }
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
        let _ = worker.shutdown();
    });
    Ok((
        capabilities,
        developer_override,
        sender,
        request_tx,
        result_rx,
        log_rx,
        health_rx,
        retry_tx,
        latest,
    ))
}

fn schedule_evaluation(
    session: &Rc<RefCell<ProjectSession>>,
    latest: &Arc<AtomicU64>,
    sent: &Arc<AtomicU64>,
    sender: &SharedWorkerSender,
    requests: &LatestEvaluationSender,
) -> Result<u64, String> {
    let generation = session.borrow_mut().begin_evaluation();
    latest.store(generation, Ordering::SeqCst);
    let session_id = session.borrow().session_id.clone();
    let running = sent.load(Ordering::SeqCst);
    if running > 0 {
        sender.send_cancel(session_id, running)?;
    }
    let output = std::env::temp_dir()
        .join("machinewright-native")
        .join(std::process::id().to_string())
        .join(format!("generation-{generation}"));
    let request = session
        .borrow()
        .evaluation_request(output)
        .map_err(|error| error.to_string())?;
    let requests = requests.clone();
    let latest = Arc::clone(latest);
    let sent = Arc::clone(sent);
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        if latest.load(Ordering::SeqCst) == generation {
            sent.store(generation, Ordering::SeqCst);
            let _ = requests.send(request);
        }
    });
    Ok(generation)
}

fn source_for_node(snapshot: &ProjectSnapshot, node_id: &str) -> String {
    snapshot.source_for_node(node_id).map_or_else(
        || "No source mapping".into(),
        |span| format!("{}:{}", span.path, span.start_line),
    )
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
    });
    v_stack((
        h_stack((
            label(move || format!("Machinewright · {} · Browse only", path.display())),
            trust,
            label(move || status.get()),
        ))
        .style(|style| style.gap(12.0).padding(10.0).items_center()),
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
            .style(|style| style.padding(12.0).background(Color::rgb8(255, 232, 232))),
        text_editor(source)
            .disabled(|| true)
            .style(|style| style.width_full().height_full().flex_grow(1.0)),
    ))
    .style(|style| style.width_full().height_full().gap(8.0).padding(10.0))
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
        latest,
    ) = runtime;
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
    });
    let (preferences_tx, preferences_rx) = crossbeam_channel::bounded::<WorkspacePreferences>(1);
    std::thread::spawn(move || {
        while let Ok(mut preferences) = preferences_rx.recv() {
            while let Ok(newer) = preferences_rx.try_recv() {
                preferences = newer;
            }
            let _ = preferences.save(&preferences_path);
        }
    });
    let status = format!(
        "connected · protocol {}{}",
        capabilities.protocol_version,
        if developer_override {
            " · developer worker override"
        } else {
            ""
        }
    );
    let dirty = RwSignal::new(false);
    let active_path = RwSignal::new(path.clone());
    let open_tabs = RwSignal::new(session.borrow().workspace.tabs().to_vec());
    let project_files = RwSignal::new(session.borrow().workspace.files().to_vec());
    let save_status = RwSignal::new(String::new());
    let evaluation_status = RwSignal::new("Waiting for edits".to_string());
    let language_status = RwSignal::new("ty starting…".to_string());
    let syntax_status = RwSignal::new("syntax · ready".to_string());
    let syntax_diagnostic_lines = RwSignal::new(Vec::<String>::new());
    let diagnostic_lines = RwSignal::new(Vec::<String>::new());
    let graph_nodes = RwSignal::new(Vec::<GraphRow>::new());
    let selected = RwSignal::new(None::<String>);
    let source_location = RwSignal::new("No selection".to_string());
    let node_details = RwSignal::new("Select a component to inspect it".to_string());
    let measurement_status = RwSignal::new("Measurement · choose first point".to_string());
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
    let sent = Arc::new(AtomicU64::new(0));
    let language_revision = Arc::new(AtomicU64::new(0));
    let worker_log_signal = create_signal_from_channel(worker_logs);
    create_effect(move |_| {
        if let Some(lines) = worker_log_signal.get() {
            worker_log_lines.set(lines);
        }
    });
    let (viewport_requests, viewport_results) = start_viewport();
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
            Err(error) => evaluation_status.set(format!("Viewport unavailable: {error}")),
        }
    });

    if let Some((record, lease)) = restored {
        match Scene::load(&record.snapshot, &record.artifact_root) {
            Ok(scene) => {
                graph_nodes.set(graph_rows(&record.snapshot));
                let mut state = viewport_state.borrow_mut();
                scene.fit_camera(&mut state.camera);
                let _ = viewport_requests.try_send(ViewportRequest {
                    scene: scene.clone(),
                    state: state.clone(),
                    width: 800,
                    height: 600,
                });
                let _ = session
                    .borrow_mut()
                    .dispatch(AppCommand::RestoreSnapshot(record.snapshot.clone()));
                *current_scene.borrow_mut() = scene;
                *current_snapshot.borrow_mut() = Some(record.snapshot);
                *current_cache_lease.borrow_mut() = Some(lease);
                *current_source_blobs.borrow_mut() = record.source_blobs;
                evaluation_status
                    .set("Restored last valid snapshot · checking current source…".into());
            }
            Err(error) => evaluation_status.set(format!("Cached snapshot rejected: {error}")),
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
    let result_scene = Rc::clone(&current_scene);
    let result_cache_lease = Rc::clone(&current_cache_lease);
    let result_source_blobs = Rc::clone(&current_source_blobs);
    let result_latest = Arc::clone(&latest);
    let result_sent = Arc::clone(&sent);
    let result_viewport_state = Rc::clone(&viewport_state);
    let result_viewport_requests = viewport_requests.clone();
    let result_session = Rc::clone(&session);
    create_effect(move |_| {
        let Some(event) = result_signal.get() else {
            return;
        };
        if event.generation != result_latest.load(Ordering::SeqCst) {
            return;
        }
        result_sent.store(0, Ordering::SeqCst);
        match event.result {
            Ok(snapshot) => match Scene::load(&snapshot, &event.artifact_root) {
                Ok(scene) => {
                    let nodes = graph_rows(&snapshot);
                    let mut state = result_viewport_state.borrow_mut();
                    scene.fit_camera(&mut state.camera);
                    state.selected = selected.get().map(|graph_node_id| PickTarget {
                        graph_node_id,
                        primitive: None,
                    });
                    let _ = result_viewport_requests.try_send(ViewportRequest {
                        scene: scene.clone(),
                        state: state.clone(),
                        width: 800,
                        height: 600,
                    });
                    graph_nodes.set(nodes);
                    let _ = result_session
                        .borrow_mut()
                        .dispatch(AppCommand::InstallSnapshot(snapshot.clone()));
                    *result_scene.borrow_mut() = scene;
                    *result_snapshot.borrow_mut() = Some(snapshot);
                    *result_cache_lease.borrow_mut() = event.lease;
                    *result_source_blobs.borrow_mut() = event.source_blobs;
                    evaluation_status.set(format!("Generation {} ready", event.generation));
                }
                Err(error) => evaluation_status.set(format!("Mesh error: {error}")),
            },
            Err(error) => evaluation_status.set(format!("Evaluation failed: {error}")),
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
            let _ = preferences_tx.try_send(WorkspacePreferences::capture(&session.workspace));
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
        let mut state = cursor_viewport_state.borrow_mut();
        state.selected = selection.graph_node_id.map(|graph_node_id| PickTarget {
            graph_node_id,
            primitive: selection.primitive,
        });
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
    let (file_event_tx, file_event_rx) = crossbeam_channel::unbounded();
    let watch_root = project.root.clone();
    std::thread::spawn(move || match ProjectWatcher::watch(&watch_root) {
        Ok(watcher) => loop {
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
        if watcher_session
            .borrow_mut()
            .workspace
            .refresh_files()
            .unwrap_or(false)
        {
            project_files.set(watcher_session.borrow().workspace.files().to_vec());
        }
        let watcher_path = active_path.get();
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
    let edit_latest = Arc::clone(&latest);
    let edit_sent = Arc::clone(&sent);
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
            if !update_programmatic_edit.replace(false)
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
            evaluation_status.set("Waiting for evaluation…".into());
            if let Err(error) = schedule_evaluation(
                &edit_session,
                &edit_latest,
                &edit_sent,
                &edit_sender,
                &edit_requests,
            ) {
                evaluation_status.set(error);
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
    });

    let keep_session = Rc::clone(&session);
    let keep_editor = button("Keep Editor Version").action(move || {
        match keep_session
            .borrow_mut()
            .dispatch(AppCommand::AcknowledgeEditorVersion(active_path.get()))
        {
            Ok(_) => save_status.set("Editor version retained; use Force Save to overwrite the acknowledged disk revision".into()),
            Err(error) => save_status.set(error.to_string()),
        }
    });

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
    });

    let reload_session = Rc::clone(&session);
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
            }
            Err(error) => save_status.set(error.to_string()),
        }
    });

    let history_control = |label_text: &'static str, command: fn(PathBuf) -> AppCommand| {
        let history_session = Rc::clone(&session);
        let history_document = Rc::clone(&document);
        let history_programmatic = Rc::clone(&programmatic_edit);
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
        })
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
    });

    let evaluate_session = Rc::clone(&session);
    let evaluate_latest = Arc::clone(&latest);
    let evaluate_sent = Arc::clone(&sent);
    let evaluate_sender = worker_sender.clone();
    let evaluate_requests = requests.clone();
    let evaluate = button("Evaluate").action(move || {
        evaluation_status.set("Waiting for evaluation…".into());
        if let Err(error) = schedule_evaluation(
            &evaluate_session,
            &evaluate_latest,
            &evaluate_sent,
            &evaluate_sender,
            &evaluate_requests,
        ) {
            evaluation_status.set(error);
        }
    });

    evaluation_status.set("Waiting for initial evaluation…".into());
    if let Err(error) = schedule_evaluation(&session, &latest, &sent, &worker_sender, &requests) {
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
    let workspace_tree = scroll(dyn_stack(
        move || project_files.get(),
        Clone::clone,
        move |relative| {
            let display = relative.to_string_lossy().into_owned();
            let target = file_root.join(&relative);
            let session = Rc::clone(&file_session);
            let document = Rc::clone(&file_document);
            let programmatic = Rc::clone(&file_programmatic);
            button(label(move || display.clone())).action(move || {
                if let Err(error) = session
                    .borrow_mut()
                    .dispatch(AppCommand::OpenDocument(target.clone()))
                {
                    save_status.set(error.to_string());
                    return;
                }
                let canonical = target.canonicalize().unwrap_or_else(|_| target.clone());
                let (source, cursors) = {
                    let session = session.borrow();
                    let opened = session
                        .workspace
                        .document(&canonical)
                        .expect("opened document exists");
                    (opened.text(), opened.cursors().to_vec())
                };
                active_path.set(canonical);
                open_tabs.set(session.borrow().workspace.tabs().to_vec());
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
                    session
                        .borrow()
                        .workspace
                        .document(&active_path.get())
                        .is_some_and(|document| document.is_dirty()),
                );
            })
        },
    ))
    .style(|style| style.width_full().max_height(220.0));

    let tab_session = Rc::clone(&session);
    let tab_document = Rc::clone(&document);
    let tab_programmatic = Rc::clone(&programmatic_edit);
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
            let open = button(label(move || label_text.clone())).action(move || {
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
            let close = button("×").action(move || {
                match close_session
                    .borrow_mut()
                    .dispatch(AppCommand::CloseDocument(target.clone()))
                {
                    Ok(_) => {
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
    let header = h_stack((
        label(move || format!("Machinewright · {}", active_path.get().display())),
        label(move || if dirty.get() { " • Modified" } else { "" }),
        save,
        undo,
        redo,
        compare,
        reload,
        keep_editor,
        force_save,
        evaluate,
        retry_worker,
        label(move || save_status.get()),
        label(move || evaluation_status.get()),
    ))
    .style(|style| style.gap(12.0).padding(10.0).items_center());

    let graph_scene = Rc::clone(&current_scene);
    let graph_snapshot = Rc::clone(&current_snapshot);
    let graph_viewport_state = Rc::clone(&viewport_state);
    let graph_viewport_requests = viewport_requests.clone();
    let graph_session = Rc::clone(&session);
    let graph_programmatic = Rc::clone(&programmatic_edit);
    let graph_root = project.root.clone();
    let graph_editor_cursor = editor_cursor;
    let graph = scroll(dyn_stack(
        move || graph_nodes.get(),
        |row| row.node_id.clone(),
        move |row| {
            let label_text = format!("{}{}", "  ".repeat(row.depth), row.label);
            let selected_id = row.node_id.clone();
            let scene = Rc::clone(&graph_scene);
            let snapshot = Rc::clone(&graph_snapshot);
            let viewport_state = Rc::clone(&graph_viewport_state);
            let viewport_requests = graph_viewport_requests.clone();
            let session = Rc::clone(&graph_session);
            let navigation_document = Rc::clone(&graph_navigation_document);
            let programmatic = Rc::clone(&graph_programmatic);
            let root = graph_root.clone();
            button(label(move || label_text.clone())).action(move || {
                selected.set(Some(selected_id.clone()));
                let _ = session
                    .borrow_mut()
                    .dispatch(AppCommand::SelectNode(selected_id.clone()));
                let selection = session.borrow().selection.clone();
                if selection.stale_source {
                    source_location.set("Source mapping is stale · open evaluated revision".into());
                } else if let Some(span) = &selection.source_span {
                    let target = root.join(&span.path);
                    if session
                        .borrow_mut()
                        .dispatch(AppCommand::OpenDocument(target.clone()))
                        .is_ok()
                    {
                        let target = target.canonicalize().unwrap_or(target);
                        let source = session
                            .borrow()
                            .workspace
                            .document(&target)
                            .expect("mapped document is open")
                            .text();
                        active_path.set(target);
                        open_tabs.set(session.borrow().workspace.tabs().to_vec());
                        programmatic.set(true);
                        navigation_document.edit_single(
                            Selection::region(0, navigation_document.text().len()),
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
                let mut state = viewport_state.borrow_mut();
                state.selected = Some(PickTarget {
                    graph_node_id: selected_id.clone(),
                    primitive: None,
                });
                let _ = viewport_requests.try_send(ViewportRequest {
                    scene: scene.borrow().clone(),
                    state: state.clone(),
                    width: 800,
                    height: 600,
                });
                if let Some(snapshot) = snapshot.borrow().as_ref() {
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
            })
        },
    ))
    .style(|style| style.height_full().width_full());

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
    });

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
    let sidebar = v_stack((
        workspace_panel,
        label(|| "Graph"),
        graph,
        label(move || format!("Source: {}", source_location.get())),
        label(move || node_details.get()),
        label(move || measurement_status.get()),
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
        label(move || format!("Worker: {status}")),
        label(|| "Worker log"),
        scroll(dyn_stack(
            move || worker_log_lines.get(),
            Clone::clone,
            |line| label(move || line.clone()),
        ))
        .style(|style| style.max_height(140.0).width_full()),
    ))
    .style(|style| {
        style
            .width(300.0)
            .height_full()
            .gap(10.0)
            .padding(12.0)
            .background(Color::rgb8(238, 241, 246))
    });

    let viewport_scene = Rc::clone(&current_scene);
    let viewport_snapshot = Rc::clone(&current_snapshot);
    let pick_viewport_state = Rc::clone(&viewport_state);
    let pick_viewport_requests = viewport_requests.clone();
    let pick_session = Rc::clone(&session);
    let pick_programmatic = Rc::clone(&programmatic_edit);
    let pick_root = project.root.clone();
    let pick_editor_cursor = editor_cursor;
    let viewport_control = |text: &'static str, action: fn(&mut ViewportState, &Scene)| {
        let state = Rc::clone(&viewport_state);
        let scene = Rc::clone(&current_scene);
        let requests = viewport_requests.clone();
        button(text).action(move || {
            let scene = scene.borrow();
            let mut state = state.borrow_mut();
            action(&mut state, &scene);
            let _ = requests.try_send(ViewportRequest {
                scene: scene.clone(),
                state: state.clone(),
                width: 800,
                height: 600,
            });
        })
    };
    let fit = viewport_control("Fit", |state, scene| scene.fit_camera(&mut state.camera));
    let orbit_left = viewport_control("Orbit", |state, _| state.camera.orbit(-0.2, 0.0));
    let zoom_in = viewport_control("Zoom +", |state, _| state.camera.zoom(0.8));
    let zoom_out = viewport_control("Zoom −", |state, _| state.camera.zoom(1.25));
    let front = viewport_control("Front", |state, _| {
        state.camera.set_axis_view(AxisView::Front)
    });
    let right = viewport_control("Right", |state, _| {
        state.camera.set_axis_view(AxisView::Right)
    });
    let top = viewport_control("Top", |state, _| state.camera.set_axis_view(AxisView::Top));
    let projection = viewport_control("Perspective / Ortho", |state, _| {
        state.camera.projection = match state.camera.projection {
            Projection::Perspective => Projection::Orthographic,
            Projection::Orthographic => Projection::Perspective,
        }
    });
    let hide = viewport_control("Hide selected", |state, _| {
        if let Some(id) = state
            .selected
            .as_ref()
            .map(|target| target.graph_node_id.clone())
        {
            state.toggle_visibility(&id);
        }
    });
    let isolate = viewport_control("Isolate", |state, _| {
        let selected = state
            .selected
            .as_ref()
            .map(|target| target.graph_node_id.clone());
        state.isolate(if state.isolated == selected {
            None
        } else {
            selected
        });
    });
    let section = viewport_control("Section", |state, _| {
        state.section_plane = state
            .section_plane
            .is_none()
            .then_some([1.0, 0.0, 0.0, 0.0]);
    });
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
    });
    let viewport = viewport
        .on_click_stop(move |event| {
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
            let node_id = hit.target.graph_node_id.clone();
            selected.set(Some(node_id.clone()));
            let _ = pick_session
                .borrow_mut()
                .dispatch(AppCommand::SelectNode(node_id.clone()));
            let selection = pick_session.borrow().selection.clone();
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
            let measurement = state.measure(hit.position).cloned();
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
            measurement_status.set(measurement.map_or_else(
                || "Measurement · choose second point".into(),
                |measurement| format!("Distance · {:.3}", measurement.distance),
            ));
        })
        .style(|style| style.width_full().height_full().flex_grow(1.0));

    let viewport_panel = v_stack((
        h_stack((
            fit, orbit_left, zoom_in, zoom_out, front, right, top, projection,
        ))
        .style(|style| style.gap(6.0)),
        h_stack((hide, isolate, section)).style(|style| style.gap(6.0)),
        viewport,
    ))
    .style(|style| style.width_full().height_full().flex_grow(1.0));

    v_stack((
        header,
        tab_strip,
        h_stack((
            editor.style(|style| style.width_pct(48.0)),
            viewport_panel.style(|style| style.width_pct(32.0)),
            sidebar.style(|style| style.width_pct(20.0)),
        ))
        .style(|style| style.flex_grow(1.0).width_full()),
    ))
    .style(|style| style.width_full().height_full())
}

fn main() {
    let path = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("../examples/reference_project.py"));
    let path = path.canonicalize().unwrap_or(path);
    let project = PortableProject::discover(&path).unwrap_or_else(|error| panic!("{error}"));
    let source = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("failed to open {}: {error}", path.display()));
    let data_root = dirs::data_local_dir()
        .unwrap_or_else(|| std::env::temp_dir().join("machinewright-data"))
        .join("machinewright");
    let trust_path = data_root.join("trust.json");
    let trusted = TrustStore::load(&trust_path)
        .and_then(|store| store.is_trusted(&project.root))
        .unwrap_or(false);
    if !trusted {
        let project_root = project.root.clone();
        launch(move || untrusted_app(path, source, project_root, trust_path));
        return;
    }
    let mut session = ProjectSession::open(&project.root).unwrap_or_else(|error| panic!("{error}"));
    let preferences_key = format!(
        "{:x}",
        Sha256::digest(project.root.to_string_lossy().as_bytes())
    );
    let preferences_path = data_root
        .join("workspaces")
        .join(format!("{preferences_key}.json"));
    let preferences = WorkspacePreferences::load(&preferences_path).unwrap_or_default();
    let _ = preferences.restore(&mut session.workspace);
    session
        .dispatch(AppCommand::OpenDocument(path.clone()))
        .unwrap_or_else(|error| panic!("{error}"));
    let session = Rc::new(RefCell::new(session));
    let environment = match EnvironmentSpec::resolve(&project.root) {
        Ok(environment) => environment,
        Err(error) => {
            let message = format!(
                "Project environment verification failed: {error}. Run `uv sync --frozen --offline` in {} or set MACHINEWRIGHT_WORKER explicitly for development.",
                project.root.display()
            );
            launch(move || startup_error_app(path, source, message));
            return;
        }
    };
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
    let runtime = match start_worker(environment, project_key, store, log_path) {
        Ok(runtime) => runtime,
        Err(error) => {
            let message = format!(
                "Worker startup failed: {error}. Verify the declared environment and worker protocol, then retry the application."
            );
            launch(move || startup_error_app(path, source, message));
            return;
        }
    };
    let language_runtime = start_language(&project.root);
    launch(move || {
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
