use std::path::{Path, PathBuf};

use machinewright_model::{ProjectSnapshot, SelectionState};
use machinewright_workspace::{ProjectWorkspace, WorkspaceError};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use thiserror::Error;

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

    pub fn session_evaluation_request(
        &self,
        session_id: &str,
        generation: u64,
        workspace: &ProjectWorkspace,
        output_directory: PathBuf,
    ) -> Result<EvaluationRequest, PortError> {
        let inputs_json =
            std::fs::read(&self.input_path).map_err(|error| PortError::new(error.to_string()))?;
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

pub trait EvaluationPort {
    fn connect(&mut self) -> Result<WorkerCapabilities, PortError>;
    fn evaluate(&mut self, request: &EvaluationRequest) -> Result<ProjectSnapshot, PortError>;
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
                selection.stale_source = selection.source_span.as_ref().is_some_and(|span| {
                    self.workspace
                        .document(&self.workspace.root().join(&span.path))
                        .is_some_and(|document| document.content_digest() != span.source_digest)
                });
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
                selection.stale_source = selection.source_span.as_ref().is_some_and(|span| {
                    self.workspace
                        .document(&self.workspace.root().join(&span.path))
                        .is_some_and(|document| document.content_digest() != span.source_digest)
                });
                self.selection = selection;
                AppEvent::SelectionChanged
            }
            AppCommand::InstallSnapshot(snapshot) => {
                let generation = snapshot.evaluation().generation;
                if generation != self.generation {
                    return Ok(Vec::new());
                }
                self.selection = SelectionState {
                    generation,
                    ..SelectionState::default()
                };
                self.snapshot = Some(snapshot);
                AppEvent::SnapshotInstalled(generation)
            }
            AppCommand::RestoreSnapshot(snapshot) => {
                let generation = snapshot.evaluation().generation;
                self.selection = SelectionState {
                    generation,
                    ..SelectionState::default()
                };
                self.snapshot = Some(snapshot);
                AppEvent::SnapshotInstalled(generation)
            }
        };
        Ok(vec![event])
    }
}

#[derive(Debug, Error)]
#[error("{message}")]
pub struct PortError {
    pub message: String,
}

impl PortError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
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
}
