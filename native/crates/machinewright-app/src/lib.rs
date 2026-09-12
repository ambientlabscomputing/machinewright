use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use machinewright_model::{ProjectSnapshot, SelectionState};
use machinewright_workspace::{ProjectWorkspace, WorkspaceError, digest};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use thiserror::Error;

pub mod runtime;
pub use runtime::{EvaluationRuntime, InputIdentity, RuntimeCommand};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerCapabilities {
    pub protocol_version: u32,
    pub capabilities: Vec<String>,
    pub python_version: String,
    pub interpreter: PathBuf,
    pub machinewright_version: String,
    pub cad_backend_version: String,
    pub transports: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvaluationRequest {
    pub session_id: String,
    pub generation: u64,
    pub project_root: PathBuf,
    pub template_id: String,
    pub template_version: String,
    pub inputs_json: Vec<u8>,
    pub output_directory: PathBuf,
    pub overlays: Vec<(PathBuf, Vec<u8>)>,
    pub environment_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AsyncTag {
    pub session_id: String,
    pub document_revision: Option<u64>,
    pub evaluation_generation: Option<u64>,
    pub view_revision: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct PortableProject {
    pub root: PathBuf,
    pub project_id: String,
    pub template_id: String,
    pub template_version: String,
    pub input_path: PathBuf,
    pub environment_lock: PathBuf,
}

#[derive(Deserialize)]
struct ProjectDocument {
    project_id: String,
    templates: Vec<ProjectTemplate>,
    input_configurations: Vec<PathBuf>,
    environment_lock: PathBuf,
}

#[derive(Deserialize)]
struct ProjectTemplate {
    id: String,
    version: String,
}

impl PortableProject {
    pub fn discover(start: &Path) -> Result<Self, PortError> {
        let start = if start.is_file() {
            start.parent().unwrap_or(start)
        } else {
            start
        };
        let root = start
            .ancestors()
            .find(|candidate| candidate.join("machinewright.toml").is_file())
            .ok_or_else(|| PortError::new("no machinewright.toml found"))?
            .to_path_buf();
        let source = std::fs::read_to_string(root.join("machinewright.toml"))
            .map_err(|error| PortError::new(error.to_string()))?;
        let document: ProjectDocument =
            toml::from_str(&source).map_err(|error| PortError::new(error.to_string()))?;
        let template = document
            .templates
            .first()
            .ok_or_else(|| PortError::new("project declares no templates"))?;
        let input = document
            .input_configurations
            .first()
            .ok_or_else(|| PortError::new("project declares no input configuration"))?;
        Ok(Self {
            root: root.clone(),
            project_id: document.project_id,
            template_id: template.id.clone(),
            template_version: template.version.clone(),
            input_path: root.join(input),
            environment_lock: root.join(document.environment_lock),
        })
    }

    /// Captures this project's current input/environment identity in one
    /// read, rather than the piecemeal re-reads `session_evaluation_request`
    /// does on every call. Not yet wired into that method (which stays as
    /// today's always-fresh-read behavior); this is the seam a future
    /// input-selection UI (M3) needs — two captures for the same
    /// `input_path` compare unequal once the file (or the environment lock)
    /// changes on disk.
    pub fn input_identity(&self) -> Result<InputIdentity, PortError> {
        let input_bytes =
            std::fs::read(&self.input_path).map_err(|error| PortError::new(error.to_string()))?;
        let environment_bytes = std::fs::read(&self.environment_lock)
            .map_err(|error| PortError::new(error.to_string()))?;
        Ok(InputIdentity {
            template_id: self.template_id.clone(),
            template_version: self.template_version.clone(),
            input_path: self.input_path.clone(),
            input_digest: format!("sha256:{:x}", Sha256::digest(input_bytes)),
            environment_digest: format!("sha256:{:x}", Sha256::digest(environment_bytes)),
        })
    }

    pub fn session_evaluation_request(
        &self,
        session_id: &str,
        generation: u64,
        workspace: &ProjectWorkspace,
        output_directory: PathBuf,
        input_override: Option<&[u8]>,
    ) -> Result<EvaluationRequest, PortError> {
        let inputs_json = match input_override {
            Some(bytes) => bytes.to_vec(),
            None => std::fs::read(&self.input_path)
                .map_err(|error| PortError::new(error.to_string()))?,
        };
        let environment_digest = format!(
            "sha256:{:x}",
            Sha256::digest(
                std::fs::read(&self.environment_lock)
                    .map_err(|error| PortError::new(error.to_string()))?
            )
        );
        Ok(EvaluationRequest {
            session_id: session_id.into(),
            generation,
            project_root: self.root.clone(),
            template_id: self.template_id.clone(),
            template_version: self.template_version.clone(),
            inputs_json,
            output_directory,
            overlays: workspace.evaluation_sources(),
            environment_digest,
        })
    }
}

/// A successful evaluation plus the digest of every project file the
/// worker actually read while producing it (relative path, posix-style →
/// `sha256:...`) — lets a caller that independently reads the project tree
/// for caching detect a concurrent external edit that diverged from what
/// was actually evaluated, without the wire protocol carrying full bytes
/// for files the caller can already read itself.
#[derive(Debug, Clone)]
pub struct EvaluationOutcome {
    pub snapshot: ProjectSnapshot,
    pub evaluated_source_digests: BTreeMap<String, String>,
}

pub trait EvaluationPort {
    fn connect(&mut self) -> Result<WorkerCapabilities, PortError>;
    fn evaluate(&mut self, request: &EvaluationRequest) -> Result<EvaluationOutcome, PortError>;
    fn cancel(&mut self, session_id: &str, generation: u64) -> Result<(), PortError>;
}

pub trait LanguagePort {
    fn capabilities(&self) -> LanguageCapabilities {
        LanguageCapabilities::default()
    }
    fn diagnostics(
        &mut self,
        path: &Path,
        source: &str,
    ) -> Result<Vec<EditorDiagnostic>, PortError>;
    fn did_save(&mut self, _path: &Path) -> Result<(), PortError> {
        Ok(())
    }
    fn did_close(&mut self, _path: &Path) -> Result<(), PortError> {
        Ok(())
    }
    fn watched_files(&mut self, _paths: &[PathBuf]) -> Result<(), PortError> {
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LanguageCapabilities {
    pub diagnostics: bool,
    pub completion: bool,
    pub hover: bool,
    pub definition: bool,
    pub references: bool,
    pub document_symbols: bool,
    pub code_actions: bool,
    pub watched_files: bool,
}

pub trait ViewportPort {
    fn show_snapshot(&mut self, snapshot: &ProjectSnapshot) -> Result<(), PortError>;
    fn select_node(&mut self, node_id: Option<&str>);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorDiagnostic {
    pub message: String,
    pub start_byte: usize,
    pub end_byte: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EvaluationStatus {
    Idle,
    Running(u64),
    Failed { generation: u64, message: String },
}

#[derive(Debug, Clone)]
pub enum AppCommand {
    OpenDocument(PathBuf),
    OpenEvaluatedRevision {
        display_path: PathBuf,
        source: String,
    },
    CloseDocument(PathBuf),
    ReplaceDocument {
        path: PathBuf,
        source: String,
    },
    ReplaceSelections {
        path: PathBuf,
        insertion: String,
    },
    ReplaceAll {
        path: PathBuf,
        query: String,
        replacement: String,
    },
    GoToLine {
        path: PathBuf,
        one_based_line: usize,
    },
    SetActiveDocument(PathBuf),
    AcknowledgeEditorVersion(PathBuf),
    SaveDocument {
        path: PathBuf,
        force: bool,
    },
    Undo(PathBuf),
    Redo(PathBuf),
    SelectNode(String),
    SelectSource {
        relative_path: String,
        byte: u64,
    },
    InstallSnapshot(ProjectSnapshot),
    RestoreSnapshot(ProjectSnapshot),
    /// Renames or moves an open document on disk and reconciles it in the
    /// workspace (document map, tabs, active pointer). For a rename already
    /// performed externally (detected by the file watcher), reconcile
    /// directly via `ProjectWorkspace::rename_document` instead — this
    /// command performs the filesystem rename itself.
    RenameDocument {
        from: PathBuf,
        to: PathBuf,
    },
    /// Substitutes `bytes` (a full, canonically-serialized inputs document)
    /// for the on-disk input file in every subsequent `evaluation_request`,
    /// until cleared. Does not touch disk — a Behavior Lab control changing
    /// a slider does not rewrite the project's input file.
    SetInputOverride(Vec<u8>),
    /// Reverts to reading the on-disk input file.
    ClearInputOverride,
    /// Starts (or switches) browsing `snapshot` without touching the live
    /// `snapshot`/`selection` — e.g. clicking a sweep point.
    InspectSnapshot(ProjectSnapshot),
    /// Stops browsing an inspected snapshot; the live snapshot/selection
    /// are unaffected since they were never touched.
    ReturnToLive,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppEvent {
    DocumentOpened(PathBuf),
    DocumentChanged { path: PathBuf, revision: u64 },
    DocumentSaved(PathBuf),
    DocumentClosed(PathBuf),
    ActiveDocumentChanged(PathBuf),
    ConflictAcknowledged(PathBuf),
    SelectionChanged,
    SnapshotInstalled(u64),
    DocumentRenamed { from: PathBuf, to: PathBuf },
    InputOverrideChanged,
    InspectionChanged,
}

#[derive(Debug)]
pub struct ProjectSession {
    pub session_id: String,
    pub project: PortableProject,
    pub workspace: ProjectWorkspace,
    pub snapshot: Option<ProjectSnapshot>,
    pub selection: SelectionState,
    pub evaluation: EvaluationStatus,
    pub diagnostics: Vec<EditorDiagnostic>,
    pub generation: u64,
    pub view_revision: u64,
    /// A control-driven substitute for the on-disk input file, set by
    /// `AppCommand::SetInputOverride` (e.g. a Behavior Lab slider) and
    /// consumed by `evaluation_request` in place of rereading
    /// `PortableProject::input_path` from disk. Cleared by
    /// `AppCommand::ClearInputOverride` to revert to the file.
    pub input_override: Option<Vec<u8>>,
    /// A snapshot being browsed (e.g. a clicked sweep point), distinct from
    /// `snapshot` (the live authored result). Set by
    /// `AppCommand::InspectSnapshot`, cleared by `AppCommand::ReturnToLive`.
    /// Never touches `snapshot`/`selection`, so browsing sweep points can
    /// never clobber the live editing session.
    pub inspected: Option<ProjectSnapshot>,
}

impl ProjectSession {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, PortError> {
        let root = root.into();
        let project = PortableProject::discover(&root)?;
        let workspace = ProjectWorkspace::open(&project.root).map_err(PortError::from)?;
        Ok(Self {
            session_id: format!("session-{}", std::process::id()),
            project,
            workspace,
            snapshot: None,
            selection: SelectionState::default(),
            evaluation: EvaluationStatus::Idle,
            diagnostics: Vec::new(),
            generation: 0,
            view_revision: 0,
            input_override: None,
            inspected: None,
        })
    }

    pub fn begin_evaluation(&mut self) -> u64 {
        self.generation += 1;
        self.evaluation = EvaluationStatus::Running(self.generation);
        self.generation
    }

    pub fn evaluation_request(&self, output: PathBuf) -> Result<EvaluationRequest, PortError> {
        self.project.session_evaluation_request(
            &self.session_id,
            self.generation,
            &self.workspace,
            output,
            self.input_override.as_deref(),
        )
    }

    pub fn accepts(&self, tag: &AsyncTag) -> bool {
        tag.session_id == self.session_id
            && tag
                .evaluation_generation
                .is_none_or(|value| value == self.generation)
            && tag
                .view_revision
                .is_none_or(|value| value == self.view_revision)
    }

    fn apply_stale_source(&self, selection: &mut SelectionState) {
        selection.stale_source = selection.source_span.as_ref().is_some_and(|span| {
            let full_path = self.workspace.root().join(&span.path);
            match self.workspace.document(&full_path) {
                Some(document) => document.content_digest() != span.source_digest,
                // The mapped file isn't open — an unopened file with no
                // in-memory buffer to check was previously always reported
                // fresh, silently trusting offsets against content that may
                // have changed on disk since the snapshot was produced.
                // Fail safe (treat unreadable/missing as stale) rather than
                // defaulting to fresh.
                None => std::fs::read(&full_path)
                    .map(|bytes| digest(&bytes) != span.source_digest)
                    .unwrap_or(true),
            }
        });
    }

    /// Recomputes the current selection against a newly installed or
    /// restored snapshot: if the previously selected node still exists
    /// there, the selection (and its source span) is remapped onto it
    /// instead of being unconditionally dropped, so an edit or worker
    /// restart that keeps the node around doesn't silently deselect it.
    fn remap_selection(&self, snapshot: &ProjectSnapshot) -> SelectionState {
        let generation = snapshot.evaluation().generation;
        // Check every node the previous selection owned, not just the
        // primary: if the primary was removed but a sibling from the same
        // source mapping survives, remap onto that sibling instead of
        // dropping the selection entirely.
        let surviving = self
            .selection
            .graph_node_ids
            .iter()
            .find(|node_id| snapshot.graph().nodes.contains_key(node_id.as_str()));
        let mut selection = surviving.map_or_else(
            || SelectionState {
                generation,
                ..SelectionState::default()
            },
            |node_id| snapshot.selection_for_node(node_id),
        );
        self.apply_stale_source(&mut selection);
        selection
    }

    pub fn dispatch(&mut self, command: AppCommand) -> Result<Vec<AppEvent>, PortError> {
        let event = match command {
            AppCommand::OpenDocument(path) => {
                self.workspace
                    .open_document(&path)
                    .map_err(PortError::from)?;
                AppEvent::DocumentOpened(
                    path.canonicalize()
                        .map_err(|error| PortError::new(error.to_string()))?,
                )
            }
            AppCommand::OpenEvaluatedRevision {
                display_path,
                source,
            } => {
                self.workspace
                    .open_evaluated_revision(display_path.clone(), source);
                AppEvent::DocumentOpened(display_path)
            }
            AppCommand::CloseDocument(path) => {
                self.workspace
                    .close_document(&path)
                    .map_err(PortError::from)?;
                AppEvent::DocumentClosed(path)
            }
            AppCommand::ReplaceDocument { path, source } => {
                let document = self
                    .workspace
                    .document_mut(&path)
                    .ok_or_else(|| PortError::new("document is not open"))?;
                document.replace(source).map_err(PortError::from)?;
                AppEvent::DocumentChanged {
                    path,
                    revision: document.revision(),
                }
            }
            AppCommand::ReplaceSelections { path, insertion } => {
                let document = self
                    .workspace
                    .document_mut(&path)
                    .ok_or_else(|| PortError::new("document is not open"))?;
                document
                    .replace_selections(&insertion)
                    .map_err(PortError::from)?;
                AppEvent::DocumentChanged {
                    path,
                    revision: document.revision(),
                }
            }
            AppCommand::ReplaceAll {
                path,
                query,
                replacement,
            } => {
                let document = self
                    .workspace
                    .document_mut(&path)
                    .ok_or_else(|| PortError::new("document is not open"))?;
                document
                    .replace_all(&query, &replacement)
                    .map_err(PortError::from)?;
                AppEvent::DocumentChanged {
                    path,
                    revision: document.revision(),
                }
            }
            AppCommand::GoToLine {
                path,
                one_based_line,
            } => {
                self.workspace
                    .document_mut(&path)
                    .ok_or_else(|| PortError::new("document is not open"))?
                    .go_to_line(one_based_line)
                    .map_err(PortError::from)?;
                AppEvent::SelectionChanged
            }
            AppCommand::SetActiveDocument(path) => {
                self.workspace.set_active(&path).map_err(PortError::from)?;
                AppEvent::ActiveDocumentChanged(path)
            }
            AppCommand::AcknowledgeEditorVersion(path) => {
                self.workspace
                    .document_mut(&path)
                    .ok_or_else(|| PortError::new("document is not open"))?
                    .acknowledge_editor_version()
                    .map_err(PortError::from)?;
                AppEvent::ConflictAcknowledged(path)
            }
            AppCommand::SaveDocument { path, force } => {
                self.workspace
                    .document_mut(&path)
                    .ok_or_else(|| PortError::new("document is not open"))?
                    .save(force)
                    .map_err(PortError::from)?;
                AppEvent::DocumentSaved(path)
            }
            AppCommand::Undo(path) => {
                let document = self
                    .workspace
                    .document_mut(&path)
                    .ok_or_else(|| PortError::new("document is not open"))?;
                document.undo();
                AppEvent::DocumentChanged {
                    path,
                    revision: document.revision(),
                }
            }
            AppCommand::Redo(path) => {
                let document = self
                    .workspace
                    .document_mut(&path)
                    .ok_or_else(|| PortError::new("document is not open"))?;
                document.redo();
                AppEvent::DocumentChanged {
                    path,
                    revision: document.revision(),
                }
            }
            AppCommand::SelectNode(node_id) => {
                let mut selection = self
                    .snapshot
                    .as_ref()
                    .map_or_else(SelectionState::default, |snapshot| {
                        snapshot.selection_for_node(&node_id)
                    });
                self.apply_stale_source(&mut selection);
                self.selection = selection;
                AppEvent::SelectionChanged
            }
            AppCommand::SelectSource {
                relative_path,
                byte,
            } => {
                let mut selection = self
                    .snapshot
                    .as_ref()
                    .map_or_else(SelectionState::default, |snapshot| {
                        snapshot.selection_for_source(&relative_path, byte)
                    });
                self.apply_stale_source(&mut selection);
                self.selection = selection;
                AppEvent::SelectionChanged
            }
            AppCommand::InstallSnapshot(snapshot) => {
                let generation = snapshot.evaluation().generation;
                if generation != self.generation {
                    return Ok(Vec::new());
                }
                self.selection = self.remap_selection(&snapshot);
                self.snapshot = Some(snapshot);
                AppEvent::SnapshotInstalled(generation)
            }
            AppCommand::RestoreSnapshot(snapshot) => {
                let generation = snapshot.evaluation().generation;
                self.selection = self.remap_selection(&snapshot);
                self.snapshot = Some(snapshot);
                AppEvent::SnapshotInstalled(generation)
            }
            AppCommand::RenameDocument { from, to } => {
                let root = self.workspace.root().to_path_buf();
                let target_parent = to.parent().unwrap_or(&root);
                let canonical_parent = target_parent
                    .canonicalize()
                    .map_err(|error| PortError::new(error.to_string()))?;
                if !canonical_parent.starts_with(&root) {
                    return Err(PortError::new("rename target escapes the project"));
                }
                std::fs::rename(&from, &to).map_err(|error| PortError::new(error.to_string()))?;
                let to = to
                    .canonicalize()
                    .map_err(|error| PortError::new(error.to_string()))?;
                self.workspace.rename_document(&from, &to);
                AppEvent::DocumentRenamed { from, to }
            }
            AppCommand::SetInputOverride(bytes) => {
                self.input_override = Some(bytes);
                AppEvent::InputOverrideChanged
            }
            AppCommand::ClearInputOverride => {
                self.input_override = None;
                AppEvent::InputOverrideChanged
            }
            AppCommand::InspectSnapshot(snapshot) => {
                self.inspected = Some(snapshot);
                AppEvent::InspectionChanged
            }
            AppCommand::ReturnToLive => {
                self.inspected = None;
                AppEvent::InspectionChanged
            }
        };
        Ok(vec![event])
    }

    /// Installs (or restores) `snapshot` and returns the one bundle an
    /// adapter needs to update every dependent view atomically: the
    /// snapshot's generation and the selection already remapped against it.
    /// Supersedes calling `dispatch(InstallSnapshot(..))`/
    /// `dispatch(RestoreSnapshot(..))` directly from adapter code that then
    /// separately derives UI state from a selection signal captured before
    /// the remap ran — `Ok(None)` means the snapshot was superseded by a
    /// newer generation and nothing should be applied.
    pub fn accept_snapshot(
        &mut self,
        snapshot: ProjectSnapshot,
        restore: bool,
    ) -> Result<Option<PresentationUpdate>, PortError> {
        let command = if restore {
            AppCommand::RestoreSnapshot(snapshot)
        } else {
            AppCommand::InstallSnapshot(snapshot)
        };
        let events = self.dispatch(command)?;
        let Some(AppEvent::SnapshotInstalled(generation)) = events.into_iter().next() else {
            return Ok(None);
        };
        Ok(Some(PresentationUpdate {
            snapshot: self
                .snapshot
                .clone()
                .expect("SnapshotInstalled implies self.snapshot is set"),
            generation,
            selection: self.selection.clone(),
        }))
    }
}

/// Bundles everything one accepted evaluation/restore result changes, so an
/// adapter applies it atomically instead of writing several independent
/// caches that can disagree about which generation/selection is current.
/// Produced by `ProjectSession::accept_snapshot`.
#[derive(Debug, Clone)]
pub struct PresentationUpdate {
    pub snapshot: ProjectSnapshot,
    pub generation: u64,
    pub selection: SelectionState,
}

#[derive(Debug, Clone, Error, Default)]
#[error("{message}")]
pub struct PortError {
    pub message: String,
    /// Present only for a structured evaluation failure (see
    /// `PortError::evaluation_failed`) — the worker's stable diagnostic
    /// code, traceback, and pre-formatted diagnostics report. `None` for
    /// every other kind of port error (transport, cancellation, I/O, ...).
    pub code: Option<String>,
    pub traceback: Option<String>,
    pub diagnostics_json: Option<Vec<u8>>,
}

impl PortError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            ..Self::default()
        }
    }

    pub fn evaluation_failed(
        code: impl Into<String>,
        message: impl Into<String>,
        traceback: impl Into<String>,
        diagnostics_json: Vec<u8>,
    ) -> Self {
        Self {
            message: message.into(),
            code: Some(code.into()),
            traceback: Some(traceback.into()),
            diagnostics_json: Some(diagnostics_json),
        }
    }
}

impl From<WorkspaceError> for PortError {
    fn from(error: WorkspaceError) -> Self {
        Self::new(error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn project() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("machinewright.toml"),
            "project_id='test'\nenvironment_lock='uv.lock'\ninput_configurations=['inputs.json']\n[[templates]]\nid='test.template'\nversion='1'\nentrypoint='design:build'\n",
        )
        .unwrap();
        std::fs::write(root.path().join("uv.lock"), "lock").unwrap();
        std::fs::write(root.path().join("inputs.json"), "{}").unwrap();
        let first = root.path().join("first.py");
        let second = root.path().join("second.py");
        std::fs::write(&first, "value = 1\n").unwrap();
        std::fs::write(&second, "value = 2\n").unwrap();
        (root, first, second)
    }

    #[test]
    fn evaluation_captures_all_open_documents_from_the_same_revision() {
        let (_root, first, second) = project();
        let mut session = ProjectSession::open(&first).unwrap();
        session
            .dispatch(AppCommand::OpenDocument(first.clone()))
            .unwrap();
        session
            .dispatch(AppCommand::OpenDocument(second.clone()))
            .unwrap();
        session
            .dispatch(AppCommand::ReplaceDocument {
                path: first.canonicalize().unwrap(),
                source: "value = 10\n".into(),
            })
            .unwrap();
        session.begin_evaluation();
        let request = session.evaluation_request(PathBuf::from("output")).unwrap();
        assert_eq!(request.overlays.len(), 2);
        assert_eq!(request.generation, 1);
        assert_eq!(request.session_id, session.session_id);
    }

    #[test]
    fn obsolete_async_tags_are_rejected() {
        let (_root, first, _) = project();
        let mut session = ProjectSession::open(first).unwrap();
        session.begin_evaluation();
        let current = AsyncTag {
            session_id: session.session_id.clone(),
            document_revision: None,
            evaluation_generation: Some(1),
            view_revision: Some(0),
        };
        assert!(session.accepts(&current));
        session.begin_evaluation();
        assert!(!session.accepts(&current));
    }

    #[test]
    fn rename_document_moves_the_file_and_reconciles_the_open_tab() {
        let (root, first, _) = project();
        let mut session = ProjectSession::open(&first).unwrap();
        session
            .dispatch(AppCommand::OpenDocument(first.clone()))
            .unwrap();
        let first = first.canonicalize().unwrap();
        let renamed = root.path().join("renamed_first.py");
        let events = session
            .dispatch(AppCommand::RenameDocument {
                from: first.clone(),
                to: renamed.clone(),
            })
            .unwrap();
        assert!(!first.exists());
        assert!(renamed.exists());
        let renamed = renamed.canonicalize().unwrap();
        assert_eq!(
            events,
            vec![AppEvent::DocumentRenamed {
                from: first.clone(),
                to: renamed.clone(),
            }]
        );
        assert!(session.workspace.document(&renamed).is_some());
        assert!(session.workspace.document(&first).is_none());
    }

    #[test]
    fn rename_document_rejects_a_target_outside_the_project() {
        let (root, first, _) = project();
        let mut session = ProjectSession::open(&first).unwrap();
        session
            .dispatch(AppCommand::OpenDocument(first.clone()))
            .unwrap();
        let first = first.canonicalize().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let escape_target = outside.path().join("escaped.py");
        let result = session.dispatch(AppCommand::RenameDocument {
            from: first.clone(),
            to: escape_target,
        });
        assert!(result.is_err());
        // The file must not have moved.
        assert!(first.exists());
        let _ = root;
    }

    fn snapshot(root: &Path, generation: u64, node_ids: &[&str]) -> ProjectSnapshot {
        let nodes: Vec<_> = node_ids
            .iter()
            .map(|id| {
                json!({
                    "node_id": id, "instance_key": id, "kind": "component",
                    "definition_id": "test.part", "parameters": {}
                })
            })
            .collect();
        let document = json!({
            "schema_version": "1.0",
            "generation": generation,
            "graph_digest": "sha256:graph",
            "artifact_manifest_digest": "sha256:manifest",
            "graph": {"nodes": nodes, "containment": []},
            "source_mappings": [], "dependencies": [], "diagnostics": [],
            "meshes": [], "observables": [], "evidence_requirements": [],
            "control_configuration": {}, "provenance": {}
        });
        let path = root.join(format!("snapshot-{generation}.json"));
        std::fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
        ProjectSnapshot::load(&path).unwrap()
    }

    /// Like `snapshot`, but every node shares one source mapping — the
    /// shape produced when several instances come from the same call site
    /// — so selecting any one of them should highlight/select all of them.
    fn snapshot_with_shared_mapping(
        root: &Path,
        generation: u64,
        node_ids: &[&str],
    ) -> ProjectSnapshot {
        let nodes: Vec<_> = node_ids
            .iter()
            .map(|id| {
                json!({
                    "node_id": id, "instance_key": id, "kind": "component",
                    "definition_id": "test.part", "parameters": {}
                })
            })
            .collect();
        let document = json!({
            "schema_version": "1.0",
            "generation": generation,
            "graph_digest": "sha256:graph",
            "artifact_manifest_digest": "sha256:manifest",
            "graph": {"nodes": nodes, "containment": []},
            "source_mappings": [{
                "source_id": "definition:test.part",
                "node_ids": node_ids,
                "span": {
                    "path": "shared.py",
                    "source_digest": "sha256:shared",
                    "start_byte": 0, "end_byte": 1,
                    "start_line": 1, "end_line": 1,
                },
            }],
            "dependencies": [], "diagnostics": [],
            "meshes": [], "observables": [], "evidence_requirements": [],
            "control_configuration": {}, "provenance": {}
        });
        let path = root.join(format!("shared-snapshot-{generation}.json"));
        std::fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
        ProjectSnapshot::load(&path).unwrap()
    }

    #[test]
    fn select_node_highlights_every_node_owned_by_the_same_source_mapping() {
        let (root, first, _) = project();
        let mut session = ProjectSession::open(&first).unwrap();
        session.begin_evaluation();
        session
            .dispatch(AppCommand::InstallSnapshot(snapshot_with_shared_mapping(
                root.path(),
                1,
                &["a", "b"],
            )))
            .unwrap();
        session
            .dispatch(AppCommand::SelectNode("a".into()))
            .unwrap();
        assert_eq!(session.selection.graph_node_id.as_deref(), Some("a"));
        let mut owned = session.selection.graph_node_ids.clone();
        owned.sort();
        assert_eq!(owned, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn remap_selection_lands_on_a_surviving_sibling_when_the_primary_node_is_removed() {
        let (root, first, _) = project();
        let mut session = ProjectSession::open(&first).unwrap();
        session.begin_evaluation();
        session
            .dispatch(AppCommand::InstallSnapshot(snapshot_with_shared_mapping(
                root.path(),
                1,
                &["a", "b"],
            )))
            .unwrap();
        session
            .dispatch(AppCommand::SelectNode("a".into()))
            .unwrap();

        session.begin_evaluation();
        // "a" is gone, but "b" (owned by the same previous selection) is
        // still present: the selection should remap onto it rather than
        // being dropped just because the specific clicked node vanished.
        session
            .dispatch(AppCommand::InstallSnapshot(snapshot_with_shared_mapping(
                root.path(),
                2,
                &["b"],
            )))
            .unwrap();
        assert_eq!(session.selection.graph_node_id.as_deref(), Some("b"));
        assert_eq!(session.selection.graph_node_ids, vec!["b".to_string()]);
    }

    #[test]
    fn select_node_flags_stale_source_for_an_externally_changed_unopened_file() {
        let (root, first, second) = project();
        let mut session = ProjectSession::open(&first).unwrap();
        session.begin_evaluation();
        let document = json!({
            "schema_version": "1.0",
            "generation": 1,
            "graph_digest": "sha256:graph",
            "artifact_manifest_digest": "sha256:manifest",
            "graph": {
                "nodes": [json!({
                    "node_id": "a", "instance_key": "a", "kind": "component",
                    "definition_id": "test.part", "parameters": {}
                })],
                "containment": [],
            },
            "source_mappings": [{
                "source_id": "node:a",
                "node_ids": ["a"],
                "span": {
                    "path": "second.py",
                    "source_digest": "sha256:mismatch",
                    "start_byte": 0, "end_byte": 1,
                    "start_line": 1, "end_line": 1,
                },
            }],
            "dependencies": [], "diagnostics": [],
            "meshes": [], "observables": [], "evidence_requirements": [],
            "control_configuration": {}, "provenance": {}
        });
        let snapshot_path = root.path().join("stale-snapshot.json");
        std::fs::write(&snapshot_path, serde_json::to_vec(&document).unwrap()).unwrap();
        session
            .dispatch(AppCommand::InstallSnapshot(
                ProjectSnapshot::load(&snapshot_path).unwrap(),
            ))
            .unwrap();
        // `second` is never opened — apply_stale_source must fall back to a
        // disk-digest check rather than defaulting to "fresh" just because
        // there's no in-memory document to compare against.
        session
            .dispatch(AppCommand::SelectNode("a".into()))
            .unwrap();
        assert!(session.selection.stale_source);
        assert!(second.is_file());
    }

    #[test]
    fn install_snapshot_remaps_selection_when_the_selected_node_still_exists() {
        let (root, first, _) = project();
        let mut session = ProjectSession::open(&first).unwrap();
        session.begin_evaluation();
        session
            .dispatch(AppCommand::InstallSnapshot(snapshot(
                root.path(),
                1,
                &["root/part"],
            )))
            .unwrap();
        session
            .dispatch(AppCommand::SelectNode("root/part".into()))
            .unwrap();
        assert_eq!(
            session.selection.graph_node_id.as_deref(),
            Some("root/part")
        );

        session.begin_evaluation();
        session
            .dispatch(AppCommand::InstallSnapshot(snapshot(
                root.path(),
                2,
                &["root/part", "root/other"],
            )))
            .unwrap();
        assert_eq!(
            session.selection.graph_node_id.as_deref(),
            Some("root/part")
        );
        assert_eq!(session.selection.generation, 2);
    }

    #[test]
    fn install_snapshot_clears_selection_when_the_selected_node_is_gone() {
        let (root, first, _) = project();
        let mut session = ProjectSession::open(&first).unwrap();
        session.begin_evaluation();
        session
            .dispatch(AppCommand::InstallSnapshot(snapshot(
                root.path(),
                1,
                &["root/part"],
            )))
            .unwrap();
        session
            .dispatch(AppCommand::SelectNode("root/part".into()))
            .unwrap();
        assert!(session.selection.graph_node_id.is_some());

        session.begin_evaluation();
        session
            .dispatch(AppCommand::InstallSnapshot(snapshot(
                root.path(),
                2,
                &["root/other"],
            )))
            .unwrap();
        assert_eq!(session.selection.graph_node_id, None);
        assert_eq!(session.selection.generation, 2);
    }

    #[test]
    fn install_snapshot_leaves_selection_at_default_when_nothing_was_selected() {
        let (root, first, _) = project();
        let mut session = ProjectSession::open(&first).unwrap();
        session.begin_evaluation();
        session
            .dispatch(AppCommand::InstallSnapshot(snapshot(
                root.path(),
                1,
                &["root/part"],
            )))
            .unwrap();
        assert_eq!(session.selection.graph_node_id, None);
        assert_eq!(session.selection.generation, 1);
    }

    #[test]
    fn restore_snapshot_also_remaps_selection_onto_the_restored_snapshot() {
        let (root, first, _) = project();
        let mut session = ProjectSession::open(&first).unwrap();
        session.begin_evaluation();
        session
            .dispatch(AppCommand::InstallSnapshot(snapshot(
                root.path(),
                1,
                &["root/part"],
            )))
            .unwrap();
        session
            .dispatch(AppCommand::SelectNode("root/part".into()))
            .unwrap();

        session
            .dispatch(AppCommand::RestoreSnapshot(snapshot(
                root.path(),
                1,
                &["root/part"],
            )))
            .unwrap();
        assert_eq!(
            session.selection.graph_node_id.as_deref(),
            Some("root/part")
        );
    }

    #[test]
    fn set_input_override_changes_the_request_without_touching_the_input_file_on_disk() {
        let (_root, first, _) = project();
        let mut session = ProjectSession::open(&first).unwrap();
        let on_disk_before = std::fs::read(&session.project.input_path).unwrap();

        session
            .dispatch(AppCommand::SetInputOverride(b"{\"payload_kg\": 42}".to_vec()))
            .unwrap();
        let request = session.evaluation_request(PathBuf::from("/out")).unwrap();
        assert_eq!(request.inputs_json, b"{\"payload_kg\": 42}");
        assert_eq!(std::fs::read(&session.project.input_path).unwrap(), on_disk_before);
    }

    #[test]
    fn clear_input_override_reverts_to_reading_the_input_file() {
        let (_root, first, _) = project();
        let mut session = ProjectSession::open(&first).unwrap();
        let on_disk = std::fs::read(&session.project.input_path).unwrap();

        session
            .dispatch(AppCommand::SetInputOverride(b"{\"overridden\": true}".to_vec()))
            .unwrap();
        session.dispatch(AppCommand::ClearInputOverride).unwrap();
        let request = session.evaluation_request(PathBuf::from("/out")).unwrap();
        assert_eq!(request.inputs_json, on_disk);
    }

    #[test]
    fn inspect_snapshot_leaves_the_live_snapshot_and_selection_untouched() {
        let (root, first, _) = project();
        let mut session = ProjectSession::open(&first).unwrap();
        session.begin_evaluation();
        session
            .dispatch(AppCommand::InstallSnapshot(snapshot(
                root.path(),
                1,
                &["root/part"],
            )))
            .unwrap();
        session
            .dispatch(AppCommand::SelectNode("root/part".into()))
            .unwrap();
        let live_selection = session.selection.clone();

        session
            .dispatch(AppCommand::InspectSnapshot(snapshot(
                root.path(),
                7,
                &["root/other"],
            )))
            .unwrap();
        assert_eq!(
            session.inspected.as_ref().unwrap().evaluation().generation,
            7
        );
        assert_eq!(session.snapshot.as_ref().unwrap().evaluation().generation, 1);
        assert_eq!(session.selection, live_selection);

        session.dispatch(AppCommand::ReturnToLive).unwrap();
        assert!(session.inspected.is_none());
        assert_eq!(session.snapshot.as_ref().unwrap().evaluation().generation, 1);
        assert_eq!(session.selection, live_selection);
    }
}
