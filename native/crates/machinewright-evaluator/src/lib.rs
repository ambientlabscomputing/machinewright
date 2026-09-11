use std::{
    collections::VecDeque,
    ffi::OsStr,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Arc, Mutex},
    time::Duration,
};

use machinewright_app::{
    EvaluationOutcome, EvaluationPort, EvaluationRequest, PortError, WorkerCapabilities,
};
use machinewright_model::{ProjectSnapshot, SnapshotError};
use machinewright_protocol::{
    FrameError, PROTOCOL_VERSION,
    v1::{
        CancelEvaluation, CapabilityReport, EvaluateProject, Hello, Shutdown, SourceOverlay,
        WorkerEvent, WorkerRequest, worker_event, worker_request,
    },
};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EvaluationState {
    Idle,
    Running { generation: u64 },
    Failed { generation: u64, message: String },
    RecoveryRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResourcePolicy {
    pub evaluation_timeout: Duration,
    pub cancellation_grace: Duration,
    pub memory_limit_bytes: u64,
    pub restart_limit: usize,
    pub restart_window: Duration,
}

impl Default for ResourcePolicy {
    fn default() -> Self {
        Self {
            evaluation_timeout: Duration::from_secs(300),
            cancellation_grace: Duration::from_secs(2),
            memory_limit_bytes: 8 * 1024 * 1024 * 1024,
            restart_limit: 3,
            restart_window: Duration::from_secs(60),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ResourceSample {
    pub elapsed: Duration,
    pub resident_bytes: u64,
    pub cpu_percent: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminationReason {
    CancellationGraceExpired,
    EvaluationTimeout,
    MemoryLimit,
    OsTermination,
    NativeCrash,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupervisorAction {
    Continue,
    Terminate(TerminationReason),
    RecoveryRequired,
}

#[derive(Debug)]
pub struct WorkerSupervisor {
    policy: ResourcePolicy,
    restart_times: VecDeque<Duration>,
    cancellation_requested_at: Option<Duration>,
    latest_sample: Option<ResourceSample>,
}

impl WorkerSupervisor {
    pub fn new(policy: ResourcePolicy) -> Self {
        Self {
            policy,
            restart_times: VecDeque::new(),
            cancellation_requested_at: None,
            latest_sample: None,
        }
    }

    pub fn request_cancellation(&mut self, elapsed: Duration) {
        self.cancellation_requested_at = Some(elapsed);
    }

    pub fn observe(&mut self, sample: ResourceSample) -> SupervisorAction {
        self.latest_sample = Some(sample);
        if sample.resident_bytes > self.policy.memory_limit_bytes {
            return SupervisorAction::Terminate(TerminationReason::MemoryLimit);
        }
        if sample.elapsed > self.policy.evaluation_timeout {
            return SupervisorAction::Terminate(TerminationReason::EvaluationTimeout);
        }
        if self.cancellation_requested_at.is_some_and(|requested| {
            sample.elapsed.saturating_sub(requested) > self.policy.cancellation_grace
        }) {
            return SupervisorAction::Terminate(TerminationReason::CancellationGraceExpired);
        }
        SupervisorAction::Continue
    }

    pub fn record_exit(&mut self, now: Duration) -> SupervisorAction {
        while self
            .restart_times
            .front()
            .is_some_and(|time| now.saturating_sub(*time) >= self.policy.restart_window)
        {
            self.restart_times.pop_front();
        }
        if self.restart_times.len() >= self.policy.restart_limit {
            return SupervisorAction::RecoveryRequired;
        }
        self.restart_times.push_back(now);
        SupervisorAction::Terminate(TerminationReason::NativeCrash)
    }

    pub fn retry_explicitly(&mut self) {
        self.restart_times.clear();
        self.cancellation_requested_at = None;
    }
    pub fn latest_sample(&self) -> Option<ResourceSample> {
        self.latest_sample
    }

    /// Resets the per-evaluation observation state (cancellation grace, last
    /// sample) while preserving restart-rate bookkeeping, which must survive
    /// across evaluations to bound how often the worker is allowed to crash.
    pub fn begin_evaluation(&mut self) {
        self.cancellation_requested_at = None;
        self.latest_sample = None;
    }
}

/// Samples OS-reported resource usage for a worker process by PID, without
/// needing the `Child` handle. This lets a supervisor thread observe a
/// worker process concurrently with another thread that is blocked reading
/// its stdout, and force-terminate it out of band via [`force_kill`].
pub struct WorkerMonitor {
    system: sysinfo::System,
}

impl Default for WorkerMonitor {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkerMonitor {
    pub fn new() -> Self {
        Self {
            system: sysinfo::System::new(),
        }
    }

    pub fn sample(&mut self, pid: u32, elapsed: Duration) -> Option<ResourceSample> {
        let pid = sysinfo::Pid::from_u32(pid);
        self.system
            .refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
        let process = self.system.process(pid)?;
        Some(ResourceSample {
            elapsed,
            resident_bytes: process.memory(),
            cpu_percent: process.cpu_usage(),
        })
    }
}

/// Forcefully terminates a process by PID, independent of any `Child`
/// handle. Used to enforce memory/timeout/cancellation-grace limits on a
/// worker whose evaluation call is blocking another thread.
pub fn force_kill(pid: u32) -> bool {
    let pid = sysinfo::Pid::from_u32(pid);
    let mut system = sysinfo::System::new();
    system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
    system.process(pid).is_some_and(|process| process.kill())
}

#[derive(Debug)]
pub struct EvaluationCoordinator {
    session_id: String,
    latest_requested: u64,
    last_valid: Option<ProjectSnapshot>,
    state: EvaluationState,
    restart_times_ms: VecDeque<u64>,
}

pub struct WorkerProcess {
    child: Child,
    sender: WorkerSender,
    stdout: ChildStdout,
    logs: WorkerLog,
}

#[derive(Debug)]
struct RotatingFileSink {
    path: PathBuf,
    max_bytes: u64,
}

impl RotatingFileSink {
    fn append(&self, line: &str) {
        if let Ok(metadata) = std::fs::metadata(&self.path)
            && metadata.len() > self.max_bytes
        {
            let _ = std::fs::rename(&self.path, self.path.with_extension("log.1"));
        }
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
        {
            let _ = writeln!(file, "{line}");
        }
    }
}

#[derive(Debug, Clone)]
pub struct WorkerLog {
    lines: Arc<Mutex<VecDeque<String>>>,
    capacity: usize,
    file_sink: Arc<Mutex<Option<RotatingFileSink>>>,
}

impl WorkerLog {
    pub fn new(capacity: usize) -> Self {
        Self {
            lines: Arc::new(Mutex::new(VecDeque::new())),
            capacity: capacity.max(1),
            file_sink: Arc::new(Mutex::new(None)),
        }
    }

    /// Attaches a size-rotated file sink (rotating a single `.log.1`
    /// backup) so worker output survives past the in-memory ring buffer and
    /// can be inspected after a crash. Safe to call again after a worker
    /// respawn creates a fresh `WorkerLog`; writes append to the same file.
    pub fn enable_file_sink(
        &self,
        path: impl Into<PathBuf>,
        max_bytes: u64,
    ) -> std::io::Result<()> {
        let path = path.into();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if let Ok(mut slot) = self.file_sink.lock() {
            *slot = Some(RotatingFileSink { path, max_bytes });
        }
        Ok(())
    }

    pub fn push(&self, line: String) {
        if let Ok(mut lines) = self.lines.lock() {
            lines.push_back(line.clone());
            while lines.len() > self.capacity {
                lines.pop_front();
            }
        }
        if let Ok(sink) = self.file_sink.lock()
            && let Some(sink) = sink.as_ref()
        {
            sink.append(&line);
        }
    }

    pub fn search(&self, query: &str) -> Vec<String> {
        self.lines.lock().map_or_else(
            |_| Vec::new(),
            |lines| {
                lines
                    .iter()
                    .filter(|line| query.is_empty() || line.contains(query))
                    .cloned()
                    .collect()
            },
        )
    }
}

#[derive(Clone)]
pub struct WorkerSender(Arc<Mutex<ChildStdin>>);

impl WorkerSender {
    pub fn send(&self, request: &WorkerRequest) -> Result<(), WorkerError> {
        let mut writer = self
            .0
            .lock()
            .map_err(|_| WorkerError::PoisonedWorkerInput)?;
        machinewright_protocol::write_request(&mut *writer, request)?;
        Ok(())
    }
}

impl WorkerProcess {
    pub fn spawn(
        executable: impl AsRef<OsStr>,
        args: impl IntoIterator<Item = impl AsRef<OsStr>>,
    ) -> Result<Self, WorkerError> {
        let mut child = Command::new(executable)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or(WorkerError::MissingPipe("stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or(WorkerError::MissingPipe("stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or(WorkerError::MissingPipe("stderr"))?;
        let logs = WorkerLog::new(2_000);
        let stderr_logs = logs.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                match line {
                    Ok(line) => stderr_logs.push(line),
                    Err(error) => {
                        stderr_logs.push(format!("worker stderr read failed: {error}"));
                        break;
                    }
                }
            }
        });
        Ok(Self {
            child,
            sender: WorkerSender(Arc::new(Mutex::new(stdin))),
            stdout,
            logs,
        })
    }

    pub fn negotiate(
        &mut self,
        capabilities: Vec<String>,
    ) -> Result<CapabilityReport, WorkerError> {
        self.send(WorkerRequest {
            request: Some(worker_request::Request::Hello(Hello {
                protocol_version: PROTOCOL_VERSION,
                capabilities,
            })),
        })?;
        let event = self.next_event()?;
        match event.event {
            Some(machinewright_protocol::v1::worker_event::Event::Capabilities(report))
                if report.protocol_version == PROTOCOL_VERSION =>
            {
                Ok(report)
            }
            Some(machinewright_protocol::v1::worker_event::Event::Capabilities(report)) => {
                Err(WorkerError::ProtocolVersion(report.protocol_version))
            }
            _ => Err(WorkerError::UnexpectedEvent),
        }
    }

    pub fn send(&mut self, request: WorkerRequest) -> Result<(), WorkerError> {
        self.sender.send(&request)
    }

    pub fn sender(&self) -> WorkerSender {
        self.sender.clone()
    }

    pub fn logs(&self) -> WorkerLog {
        self.logs.clone()
    }

    pub fn process_id(&self) -> u32 {
        self.child.id()
    }

    pub fn try_wait(&mut self) -> Result<Option<std::process::ExitStatus>, WorkerError> {
        self.child.try_wait().map_err(WorkerError::from)
    }

    pub fn terminate_and_reap(&mut self) -> Result<std::process::ExitStatus, WorkerError> {
        if let Some(status) = self.child.try_wait()? {
            return Ok(status);
        }
        self.child.kill()?;
        self.child.wait().map_err(WorkerError::from)
    }

    pub fn next_event(&mut self) -> Result<WorkerEvent, WorkerError> {
        Ok(machinewright_protocol::read_event(&mut self.stdout)?)
    }

    pub fn shutdown(mut self) -> Result<(), WorkerError> {
        self.send(WorkerRequest {
            request: Some(worker_request::Request::Shutdown(Shutdown {})),
        })?;
        let status = self.child.wait()?;
        if status.success() {
            Ok(())
        } else {
            Err(WorkerError::Exit(status.code()))
        }
    }
}

impl Drop for WorkerProcess {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

impl EvaluationPort for WorkerProcess {
    fn connect(&mut self) -> Result<WorkerCapabilities, PortError> {
        self.negotiate(vec!["evaluation.v1".into()])
            .map(|report| WorkerCapabilities {
                protocol_version: report.protocol_version,
                capabilities: report.capabilities,
                python_version: report.python_version,
                interpreter: report.interpreter.into(),
                machinewright_version: report.machinewright_version,
                cad_backend_version: report.cad_backend_version,
                transports: report.transports,
            })
            .map_err(|error| PortError::new(error.to_string()))
    }

    fn evaluate(&mut self, request: &EvaluationRequest) -> Result<EvaluationOutcome, PortError> {
        self.send(WorkerRequest {
            request: Some(worker_request::Request::Evaluate(EvaluateProject {
                session_id: request.session_id.clone(),
                generation: request.generation,
                project_root: request.project_root.to_string_lossy().into_owned(),
                template_id: request.template_id.clone(),
                template_version: request.template_version.clone(),
                inputs_json: request.inputs_json.clone(),
                output_directory: request.output_directory.to_string_lossy().into_owned(),
                overlays: request
                    .overlays
                    .iter()
                    .map(|(path, content)| SourceOverlay {
                        relative_path: path.to_string_lossy().into_owned(),
                        content: content.clone(),
                    })
                    .collect(),
                environment_digest: request.environment_digest.clone(),
            })),
        })
        .map_err(|error| PortError::new(error.to_string()))?;
        loop {
            let event = self
                .next_event()
                .map_err(|error| PortError::new(error.to_string()))?;
            // A stray terminal event for a superseded/earlier request (the
            // worker is a single long-lived stream shared across calls)
            // must not be accepted as this call's result — keep waiting for
            // the one that actually matches what was just sent.
            let matches_request = |session_id: &str, generation: u64| {
                session_id == request.session_id && generation == request.generation
            };
            match event.event {
                Some(worker_event::Event::Completed(completed))
                    if matches_request(&completed.session_id, completed.generation) =>
                {
                    let snapshot = ProjectSnapshot::load(completed.snapshot_path.as_ref())
                        .map_err(|error| PortError::new(error.to_string()))?;
                    let evaluated_source_digests = completed
                        .evaluated_sources
                        .into_iter()
                        .map(|item| (item.relative_path, item.digest))
                        .collect();
                    return Ok(EvaluationOutcome {
                        snapshot,
                        evaluated_source_digests,
                    });
                }
                Some(worker_event::Event::Failed(failed))
                    if matches_request(&failed.session_id, failed.generation) =>
                {
                    return Err(PortError::evaluation_failed(
                        failed.code,
                        failed.message,
                        failed.traceback,
                        failed.diagnostics_json,
                    ));
                }
                Some(worker_event::Event::Cancelled(cancelled))
                    if matches_request(&cancelled.session_id, cancelled.generation) =>
                {
                    return Err(PortError::new("evaluation cancelled"));
                }
                _ => {}
            }
        }
    }

    fn cancel(&mut self, session_id: &str, generation: u64) -> Result<(), PortError> {
        self.send(WorkerRequest {
            request: Some(worker_request::Request::Cancel(CancelEvaluation {
                session_id: session_id.into(),
                generation,
            })),
        })
        .map_err(|error| PortError::new(error.to_string()))
    }
}

impl EvaluationCoordinator {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            latest_requested: 0,
            last_valid: None,
            state: EvaluationState::Idle,
            restart_times_ms: VecDeque::new(),
        }
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }
    pub fn state(&self) -> &EvaluationState {
        &self.state
    }
    pub fn last_valid(&self) -> Option<&ProjectSnapshot> {
        self.last_valid.as_ref()
    }

    pub fn begin(&mut self) -> u64 {
        self.latest_requested += 1;
        self.state = EvaluationState::Running {
            generation: self.latest_requested,
        };
        self.latest_requested
    }

    pub fn accept(&mut self, generation: u64, path: &Path) -> Result<bool, CoordinatorError> {
        if generation != self.latest_requested {
            return Ok(false);
        }
        let snapshot = ProjectSnapshot::load(path)?;
        if snapshot.evaluation().generation != generation {
            return Err(CoordinatorError::GenerationMismatch {
                expected: generation,
                actual: snapshot.evaluation().generation,
            });
        }
        self.last_valid = Some(snapshot);
        self.state = EvaluationState::Idle;
        Ok(true)
    }

    pub fn fail(&mut self, generation: u64, message: impl Into<String>) {
        if generation == self.latest_requested {
            self.state = EvaluationState::Failed {
                generation,
                message: message.into(),
            };
        }
    }

    pub fn may_restart(&mut self, now_ms: u64) -> bool {
        while self
            .restart_times_ms
            .front()
            .is_some_and(|time| now_ms.saturating_sub(*time) >= 60_000)
        {
            self.restart_times_ms.pop_front();
        }
        if self.restart_times_ms.len() >= 3 {
            self.state = EvaluationState::RecoveryRequired;
            return false;
        }
        self.restart_times_ms.push_back(now_ms);
        true
    }
}

#[derive(Debug, Error)]
pub enum CoordinatorError {
    #[error(transparent)]
    Snapshot(#[from] SnapshotError),
    #[error("snapshot generation mismatch: expected {expected}, got {actual}")]
    GenerationMismatch { expected: u64, actual: u64 },
}

#[derive(Debug, Error)]
pub enum WorkerError {
    #[error("worker process I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Frame(#[from] FrameError),
    #[error("worker process did not expose {0}")]
    MissingPipe(&'static str),
    #[error("worker input lock was poisoned")]
    PoisonedWorkerInput,
    #[error("worker negotiated protocol {0}, expected {PROTOCOL_VERSION}")]
    ProtocolVersion(u32),
    #[error("worker returned an unexpected negotiation event")]
    UnexpectedEvent,
    #[error("worker exited unsuccessfully with status {0:?}")]
    Exit(Option<i32>),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_restart_attempts() {
        let mut coordinator = EvaluationCoordinator::new("project");
        assert!(coordinator.may_restart(0));
        assert!(coordinator.may_restart(1));
        assert!(coordinator.may_restart(2));
        assert!(!coordinator.may_restart(3));
        assert!(coordinator.may_restart(60_000));
    }

    #[test]
    fn supervisor_enforces_memory_timeout_and_cancellation_grace() {
        let mut supervisor = WorkerSupervisor::new(ResourcePolicy::default());
        assert_eq!(
            supervisor.observe(ResourceSample {
                elapsed: Duration::from_secs(1),
                resident_bytes: 1,
                cpu_percent: 50.0
            }),
            SupervisorAction::Continue
        );
        supervisor.request_cancellation(Duration::from_secs(1));
        assert_eq!(
            supervisor.observe(ResourceSample {
                elapsed: Duration::from_millis(3001),
                resident_bytes: 1,
                cpu_percent: 50.0
            }),
            SupervisorAction::Terminate(TerminationReason::CancellationGraceExpired)
        );
        assert_eq!(
            supervisor.observe(ResourceSample {
                elapsed: Duration::from_secs(301),
                resident_bytes: 1,
                cpu_percent: 50.0
            }),
            SupervisorAction::Terminate(TerminationReason::EvaluationTimeout)
        );
        assert_eq!(
            supervisor.observe(ResourceSample {
                elapsed: Duration::from_secs(1),
                resident_bytes: 9 * 1024 * 1024 * 1024,
                cpu_percent: 50.0
            }),
            SupervisorAction::Terminate(TerminationReason::MemoryLimit)
        );
    }

    #[test]
    fn worker_log_is_bounded_and_searchable() {
        let log = WorkerLog::new(2);
        log.push("first".into());
        log.push("cad warning".into());
        log.push("python failure".into());
        assert_eq!(log.search(""), vec!["cad warning", "python failure"]);
        assert_eq!(log.search("python"), vec!["python failure"]);
    }

    #[test]
    fn worker_log_file_sink_appends_and_rotates() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("worker.log");
        let log = WorkerLog::new(10);
        log.enable_file_sink(&path, 5).unwrap();
        log.push("first line".into());
        log.push("second line".into());
        assert!(path.exists());
        assert!(path.with_extension("log.1").exists());
    }

    #[test]
    fn begin_evaluation_preserves_restart_bookkeeping() {
        let mut supervisor = WorkerSupervisor::new(ResourcePolicy::default());
        supervisor.request_cancellation(Duration::from_secs(1));
        assert!(matches!(
            supervisor.record_exit(Duration::from_secs(0)),
            SupervisorAction::Terminate(TerminationReason::NativeCrash)
        ));
        supervisor.begin_evaluation();
        assert_eq!(supervisor.latest_sample(), None);
        // Restart bookkeeping must survive `begin_evaluation`, otherwise the
        // restart-rate limit could never trip.
        assert!(matches!(
            supervisor.record_exit(Duration::from_secs(1)),
            SupervisorAction::Terminate(TerminationReason::NativeCrash)
        ));
        assert!(matches!(
            supervisor.record_exit(Duration::from_secs(2)),
            SupervisorAction::Terminate(TerminationReason::NativeCrash)
        ));
        assert!(matches!(
            supervisor.record_exit(Duration::from_secs(3)),
            SupervisorAction::RecoveryRequired
        ));
    }

    #[test]
    fn monitor_samples_the_current_process() {
        let pid = sysinfo::get_current_pid().expect("current pid is available");
        let mut monitor = WorkerMonitor::new();
        let sample = monitor.sample(pid.as_u32(), Duration::from_secs(1));
        assert!(sample.is_some());
    }
}
