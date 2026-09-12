use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    sync::mpsc::{self, Receiver},
    time::{Duration, Instant},
};

use lapce_xi_rope::Rope;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

static SAVE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const DEFAULT_IGNORES: &[&str] = &[
    ".git",
    ".venv",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    "__pycache__",
    "target",
    "dist",
    "build",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectFileEvent {
    pub paths: Vec<PathBuf>,
    /// Set when this event is (or completes) a detected rename/move, giving
    /// the old and new paths in that order. `notify` reports a rename as
    /// either a single event with both paths (typically macOS/FSEvents) or a
    /// `From` event followed later by a `To` event linked by a tracker id
    /// (typically Linux/inotify) — `ProjectWatcher` reassembles both forms.
    pub rename: Option<(PathBuf, PathBuf)>,
}

/// How long a `From` half of a rename is held while waiting for its matching
/// `To` event before being treated as an ordinary (non-rename) change.
const RENAME_PAIR_TIMEOUT: Duration = Duration::from_secs(2);

pub struct ProjectWatcher {
    _watcher: RecommendedWatcher,
    receiver: Receiver<Result<notify::Event, notify::Error>>,
    pending_renames: HashMap<usize, (PathBuf, Instant)>,
}

/// How many undo/redo steps to persist per document. Each step holds a
/// full-text snapshot, so this is capped well below `Document`'s in-memory
/// 1000-entry limit to keep the preferences file (rewritten on every cursor
/// move) a bounded size.
const PERSISTED_HISTORY_DEPTH: usize = 20;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkspacePreferences {
    pub tabs: Vec<PathBuf>,
    pub active: Option<PathBuf>,
    pub cursors: BTreeMap<PathBuf, Vec<Cursor>>,
    #[serde(default)]
    pub history: BTreeMap<PathBuf, DocumentHistory>,
    pub left_panel_width: f64,
    pub right_panel_width: f64,
    /// Dock-zone collapsed/active-tab state (RFD-19 M3's workspace-layout
    /// model, `machinewright_ui::workspace::WorkspaceLayout`). Stored as
    /// plain strings (a panel's stable title, e.g. "Graph") rather than
    /// that crate's `PanelId` type, so this crate doesn't need to depend
    /// on `machinewright-ui` just to persist a preference — the adapter
    /// translates both ways.
    #[serde(default)]
    pub right_dock_collapsed: bool,
    #[serde(default)]
    pub right_dock_active: Option<String>,
    #[serde(default)]
    pub bottom_dock_collapsed: bool,
    #[serde(default)]
    pub bottom_dock_active: Option<String>,
}

impl WorkspacePreferences {
    pub fn load(path: &Path) -> Result<Self, WorkspaceError> {
        if !path.is_file() {
            return Ok(Self::default());
        }
        serde_json::from_slice(&fs::read(path)?)
            .map_err(|error| WorkspaceError::Preferences(error.to_string()))
    }

    pub fn capture(workspace: &ProjectWorkspace) -> Self {
        Self {
            tabs: workspace.tabs.clone(),
            active: workspace.active.clone(),
            cursors: workspace
                .documents
                .iter()
                .map(|(path, document)| (path.clone(), document.cursors.clone()))
                .collect(),
            // Unsaved buffer content is never restored across restarts (only
            // cursors and, now, history are), so persisting history for a
            // dirty document would restore an undo stack whose "current"
            // entry doesn't match the disk content `open_document` reads
            // back. Restricting to clean documents keeps the restored stack
            // consistent with the text it will actually reopen against.
            history: workspace
                .documents
                .iter()
                .filter(|(_, document)| !document.is_dirty())
                .map(|(path, document)| {
                    let (undo, redo) = document.history_snapshot(PERSISTED_HISTORY_DEPTH);
                    (path.clone(), DocumentHistory { undo, redo })
                })
                .collect(),
            left_panel_width: 300.0,
            right_panel_width: 300.0,
            // Not this crate's concern (see the field docs) — the caller
            // overwrites these from its own dock-layout state after
            // `capture` returns, same as it always did for the panel
            // widths above.
            ..Self::default()
        }
    }

    pub fn save(&self, path: &Path) -> Result<(), WorkspaceError> {
        atomic_write(
            path,
            &serde_json::to_vec_pretty(self)
                .map_err(|error| WorkspaceError::Preferences(error.to_string()))?,
        )
    }

    pub fn restore(&self, workspace: &mut ProjectWorkspace) -> Result<(), WorkspaceError> {
        for path in &self.tabs {
            if path.is_file() && path.starts_with(workspace.root()) {
                workspace.open_document(path)?;
                if let Some(cursors) = self.cursors.get(path) {
                    workspace
                        .document_mut(path)
                        .expect("restored tab is open")
                        .set_cursors(cursors.clone())?;
                }
                if let Some(history) = self.history.get(path) {
                    workspace
                        .document_mut(path)
                        .expect("restored tab is open")
                        .restore_history(history.undo.clone(), history.redo.clone());
                }
            }
        }
        if let Some(active) = &self.active
            && workspace.documents.contains_key(active)
        {
            workspace.active = Some(active.clone());
        }
        Ok(())
    }
}

impl ProjectWatcher {
    pub fn watch(root: &Path) -> Result<Self, WorkspaceError> {
        let (sender, receiver) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = sender.send(event);
        })
        .map_err(|error| WorkspaceError::Watch(error.to_string()))?;
        watcher
            .watch(root, RecursiveMode::Recursive)
            .map_err(|error| WorkspaceError::Watch(error.to_string()))?;
        Ok(Self {
            _watcher: watcher,
            receiver,
            pending_renames: HashMap::new(),
        })
    }

    pub fn recv_timeout(
        &mut self,
        timeout: Duration,
    ) -> Result<Option<ProjectFileEvent>, WorkspaceError> {
        self.pending_renames
            .retain(|_, (_, seen)| seen.elapsed() < RENAME_PAIR_TIMEOUT);
        match self.receiver.recv_timeout(timeout) {
            Ok(Ok(event)) => Ok(Some(self.classify(event))),
            Ok(Err(error)) => Err(WorkspaceError::Watch(error.to_string())),
            Err(mpsc::RecvTimeoutError::Timeout) => Ok(None),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err(WorkspaceError::Watch("file watcher stopped".into()))
            }
        }
    }

    fn classify(&mut self, event: notify::Event) -> ProjectFileEvent {
        use notify::event::{ModifyKind, RenameMode};
        let rename = match event.kind {
            notify::EventKind::Modify(ModifyKind::Name(RenameMode::Both))
                if event.paths.len() == 2 =>
            {
                Some((event.paths[0].clone(), event.paths[1].clone()))
            }
            notify::EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
                if let (Some(tracker), Some(path)) = (event.tracker(), event.paths.first()) {
                    self.pending_renames
                        .insert(tracker, (path.clone(), Instant::now()));
                }
                None
            }
            notify::EventKind::Modify(ModifyKind::Name(RenameMode::To)) => event
                .tracker()
                .and_then(|tracker| self.pending_renames.remove(&tracker))
                .zip(event.paths.first().cloned())
                .map(|((from, _), to)| (from, to)),
            _ => None,
        };
        ProjectFileEvent {
            paths: event.paths,
            rename,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cursor {
    pub anchor: usize,
    pub head: usize,
}

impl Cursor {
    pub fn caret(byte: usize) -> Self {
        Self {
            anchor: byte,
            head: byte,
        }
    }

    pub fn range(&self) -> std::ops::Range<usize> {
        self.anchor.min(self.head)..self.anchor.max(self.head)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LineEnding {
    Lf,
    CrLf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiskFingerprint {
    pub digest: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiskConflict {
    Modified { disk_digest: String },
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiskChange {
    Unchanged,
    Reloaded,
    Conflict(DiskConflict),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiffKind {
    Equal,
    EditorOnly,
    DiskOnly,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffLine {
    pub kind: DiffKind,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvironmentSpec {
    pub lock_path: PathBuf,
    pub lock_digest: String,
    pub worker_executable: PathBuf,
    pub developer_override: bool,
}

impl EnvironmentSpec {
    pub fn resolve(project_root: &Path) -> Result<Self, WorkspaceError> {
        #[derive(Deserialize)]
        struct Manifest {
            environment_lock: PathBuf,
        }
        let root = project_root.canonicalize()?;
        let manifest_path = root.join("machinewright.toml");
        let manifest: Manifest = toml::from_str(&fs::read_to_string(&manifest_path)?)
            .map_err(|error| WorkspaceError::Manifest(error.to_string()))?;
        let lock_path = root.join(manifest.environment_lock).canonicalize()?;
        if !lock_path.starts_with(&root) {
            return Err(WorkspaceError::PathEscape(lock_path));
        }
        let override_path = std::env::var_os("MACHINEWRIGHT_WORKER").map(PathBuf::from);
        let worker_executable = override_path.clone().unwrap_or_else(|| {
            if cfg!(windows) {
                root.join(".venv/Scripts/machinewright-worker.exe")
            } else {
                root.join(".venv/bin/machinewright-worker")
            }
        });
        if !worker_executable.is_file() {
            return Err(WorkspaceError::MissingWorker(worker_executable));
        }
        Ok(Self {
            lock_digest: digest(&fs::read(&lock_path)?),
            lock_path,
            worker_executable,
            developer_override: override_path.is_some(),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TrustRecord {
    canonical_root: PathBuf,
    manifest_digest: String,
    lock_digest: String,
}

#[derive(Debug)]
pub struct TrustStore {
    path: PathBuf,
    records: BTreeMap<PathBuf, TrustRecord>,
}

impl TrustStore {
    pub fn load(path: impl Into<PathBuf>) -> Result<Self, WorkspaceError> {
        let path = path.into();
        let records = if path.is_file() {
            serde_json::from_slice::<Vec<TrustRecord>>(&fs::read(&path)?)
                .map_err(|error| WorkspaceError::Preferences(error.to_string()))?
                .into_iter()
                .map(|record| (record.canonical_root.clone(), record))
                .collect()
        } else {
            BTreeMap::new()
        };
        Ok(Self { path, records })
    }

    pub fn is_trusted(&self, project_root: &Path) -> Result<bool, WorkspaceError> {
        let current = trust_record(project_root)?;
        Ok(self
            .records
            .get(&current.canonical_root)
            .is_some_and(|saved| {
                saved.manifest_digest == current.manifest_digest
                    && saved.lock_digest == current.lock_digest
            }))
    }

    pub fn trust(&mut self, project_root: &Path) -> Result<(), WorkspaceError> {
        let record = trust_record(project_root)?;
        self.records.insert(record.canonical_root.clone(), record);
        let values = self.records.values().collect::<Vec<_>>();
        let bytes = serde_json::to_vec_pretty(&values)
            .map_err(|error| WorkspaceError::Preferences(error.to_string()))?;
        atomic_write(&self.path, &bytes)
    }
}

fn trust_record(project_root: &Path) -> Result<TrustRecord, WorkspaceError> {
    #[derive(Deserialize)]
    struct Manifest {
        environment_lock: PathBuf,
    }
    let canonical_root = project_root.canonicalize()?;
    let manifest_path = canonical_root.join("machinewright.toml");
    let manifest_bytes = fs::read(&manifest_path)?;
    let manifest_text = std::str::from_utf8(&manifest_bytes)
        .map_err(|_| WorkspaceError::NonUtf8(manifest_path.clone()))?;
    let manifest: Manifest = toml::from_str(manifest_text)
        .map_err(|error| WorkspaceError::Manifest(error.to_string()))?;
    Ok(TrustRecord {
        canonical_root: canonical_root.clone(),
        manifest_digest: digest(&manifest_bytes),
        lock_digest: digest(&fs::read(canonical_root.join(manifest.environment_lock))?),
    })
}

/// A single serialized undo/redo step, for persisting a bounded slice of a
/// document's history across app restarts. Full-text, mirroring the
/// in-memory `DocumentVersion` representation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedEdit {
    pub text: String,
    pub cursors: Vec<Cursor>,
}

/// A document's persisted undo/redo history, capped well below the
/// in-memory limit since each step holds a full-text snapshot.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DocumentHistory {
    #[serde(default)]
    pub undo: Vec<PersistedEdit>,
    #[serde(default)]
    pub redo: Vec<PersistedEdit>,
}

#[derive(Debug, Clone)]
struct DocumentVersion {
    text: Rope,
    cursors: Vec<Cursor>,
}

#[derive(Debug, Clone)]
pub struct Document {
    path: PathBuf,
    text: Rope,
    saved_digest: String,
    revision: u64,
    line_ending: LineEnding,
    utf8_bom: bool,
    disk_fingerprint: DiskFingerprint,
    acknowledged_conflict: Option<DiskFingerprint>,
    cursors: Vec<Cursor>,
    undo: Vec<DocumentVersion>,
    redo: Vec<DocumentVersion>,
    conflict: Option<DiskConflict>,
    read_only: bool,
}

impl Document {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, WorkspaceError> {
        let path = path.into();
        let bytes = fs::read(&path)?;
        let utf8_bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
        let content = if utf8_bom { &bytes[3..] } else { &bytes };
        let source = String::from_utf8(content.to_vec())
            .map_err(|_| WorkspaceError::NonUtf8(path.clone()))?;
        let line_ending = if source.contains("\r\n") {
            LineEnding::CrLf
        } else {
            LineEnding::Lf
        };
        let normalized = source.replace("\r\n", "\n");
        let mut document = Self::from_source(path, normalized, line_ending, false);
        document.utf8_bom = utf8_bom;
        document.disk_fingerprint = DiskFingerprint {
            digest: Some(digest(&bytes)),
        };
        Ok(document)
    }

    pub fn evaluated_revision(path: impl Into<PathBuf>, source: String) -> Self {
        Self::from_source(path.into(), source, LineEnding::Lf, true)
    }

    fn from_source(
        path: PathBuf,
        source: String,
        line_ending: LineEnding,
        read_only: bool,
    ) -> Self {
        Self {
            path,
            text: Rope::from(source.clone()),
            saved_digest: digest(source.as_bytes()),
            revision: 0,
            line_ending,
            utf8_bom: false,
            disk_fingerprint: DiskFingerprint { digest: None },
            acknowledged_conflict: None,
            cursors: vec![Cursor::caret(0)],
            undo: Vec::new(),
            redo: Vec::new(),
            conflict: None,
            read_only,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn text(&self) -> String {
        self.text.to_string()
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn cursors(&self) -> &[Cursor] {
        &self.cursors
    }
    pub fn conflict(&self) -> Option<&DiskConflict> {
        self.conflict.as_ref()
    }
    pub fn is_read_only(&self) -> bool {
        self.read_only
    }
    pub fn is_dirty(&self) -> bool {
        digest(self.text().as_bytes()) != self.saved_digest
    }
    pub fn content_digest(&self) -> String {
        digest(self.text().as_bytes())
    }

    pub fn set_cursors(&mut self, mut cursors: Vec<Cursor>) -> Result<(), WorkspaceError> {
        if cursors.is_empty() {
            cursors.push(Cursor::caret(0));
        }
        let len = self.text.len();
        if cursors
            .iter()
            .any(|cursor| cursor.anchor > len || cursor.head > len)
        {
            return Err(WorkspaceError::InvalidEdit);
        }
        self.cursors = cursors;
        Ok(())
    }

    pub fn replace(&mut self, source: impl Into<String>) -> Result<(), WorkspaceError> {
        self.require_writable()?;
        self.checkpoint();
        self.text = Rope::from(source.into());
        self.revision += 1;
        self.redo.clear();
        Ok(())
    }

    pub fn replace_selections(&mut self, insertion: &str) -> Result<(), WorkspaceError> {
        self.require_writable()?;
        let mut ranges = self.cursors.iter().map(Cursor::range).collect::<Vec<_>>();
        ranges.sort_by_key(|range| (range.start, range.end));
        let mut merged: Vec<std::ops::Range<usize>> = Vec::with_capacity(ranges.len());
        for range in ranges {
            if let Some(last) = merged.last_mut()
                && range.start <= last.end
            {
                last.end = last.end.max(range.end);
            } else {
                merged.push(range);
            }
        }
        let mut ranges = merged;
        ranges.reverse();
        let mut source = self.text();
        if ranges.iter().any(|range| {
            range.end > source.len()
                || !source.is_char_boundary(range.start)
                || !source.is_char_boundary(range.end)
        }) {
            return Err(WorkspaceError::InvalidEdit);
        }
        self.checkpoint();
        for range in &ranges {
            source.replace_range(range.clone(), insertion);
        }
        self.text = Rope::from(source);
        self.cursors = ranges
            .into_iter()
            .rev()
            .map(|range| Cursor::caret(range.start + insertion.len()))
            .collect();
        self.revision += 1;
        self.redo.clear();
        Ok(())
    }

    pub fn find(&self, query: &str) -> Vec<std::ops::Range<usize>> {
        if query.is_empty() {
            return Vec::new();
        }
        self.text()
            .match_indices(query)
            .map(|(start, value)| start..start + value.len())
            .collect()
    }

    pub fn replace_all(&mut self, query: &str, replacement: &str) -> Result<usize, WorkspaceError> {
        self.require_writable()?;
        let ranges = self.find(query);
        if ranges.is_empty() {
            return Ok(0);
        }
        self.checkpoint();
        let mut source = self.text();
        for range in ranges.iter().rev() {
            source.replace_range(range.clone(), replacement);
        }
        self.text = Rope::from(source);
        self.cursors = vec![Cursor::caret(ranges[0].start + replacement.len())];
        self.revision += 1;
        self.redo.clear();
        Ok(ranges.len())
    }

    pub fn go_to_line(&mut self, one_based_line: usize) -> Result<usize, WorkspaceError> {
        if one_based_line == 0 {
            return Err(WorkspaceError::InvalidLine(one_based_line));
        }
        let source = self.text();
        let byte = if one_based_line == 1 {
            0
        } else {
            source
                .match_indices('\n')
                .nth(one_based_line - 2)
                .map(|(byte, _)| byte + 1)
                .ok_or(WorkspaceError::InvalidLine(one_based_line))?
        };
        self.cursors = vec![Cursor::caret(byte)];
        Ok(byte)
    }

    pub fn undo(&mut self) -> bool {
        let Some(previous) = self.undo.pop() else {
            return false;
        };
        self.redo.push(self.version());
        self.text = previous.text;
        self.cursors = previous.cursors;
        self.revision += 1;
        true
    }

    pub fn redo(&mut self) -> bool {
        let Some(next) = self.redo.pop() else {
            return false;
        };
        self.undo.push(self.version());
        self.text = next.text;
        self.cursors = next.cursors;
        self.revision += 1;
        true
    }

    /// Returns the most recent `limit` undo and redo steps, oldest first,
    /// for persistence in `WorkspacePreferences`.
    pub fn history_snapshot(&self, limit: usize) -> (Vec<PersistedEdit>, Vec<PersistedEdit>) {
        fn persist(versions: &[DocumentVersion], limit: usize) -> Vec<PersistedEdit> {
            let start = versions.len().saturating_sub(limit);
            versions[start..]
                .iter()
                .map(|version| PersistedEdit {
                    text: version.text.to_string(),
                    cursors: version.cursors.clone(),
                })
                .collect()
        }
        (persist(&self.undo, limit), persist(&self.redo, limit))
    }

    /// Restores undo/redo history captured by `history_snapshot`, replacing
    /// any history accumulated since the document was opened.
    pub fn restore_history(&mut self, undo: Vec<PersistedEdit>, redo: Vec<PersistedEdit>) {
        fn to_versions(edits: Vec<PersistedEdit>) -> Vec<DocumentVersion> {
            edits
                .into_iter()
                .map(|edit| DocumentVersion {
                    text: Rope::from(edit.text),
                    cursors: edit.cursors,
                })
                .collect()
        }
        self.undo = to_versions(undo);
        self.redo = to_versions(redo);
    }

    pub fn save(&mut self, force: bool) -> Result<(), WorkspaceError> {
        self.require_writable()?;
        let current = disk_fingerprint(&self.path)?;
        if current != self.disk_fingerprint && self.conflict.is_none() {
            self.conflict = Some(match &current.digest {
                Some(disk_digest) => DiskConflict::Modified {
                    disk_digest: disk_digest.clone(),
                },
                None => DiskConflict::Deleted,
            });
        }
        if self.conflict.is_some()
            && (!force || self.acknowledged_conflict.as_ref() != Some(&current))
        {
            return Err(WorkspaceError::SaveConflict(self.path.clone()));
        }
        let normalized = self.text();
        let serialized = match self.line_ending {
            LineEnding::Lf => normalized.clone(),
            LineEnding::CrLf => normalized.replace('\n', "\r\n"),
        };
        let mut bytes = Vec::with_capacity(serialized.len() + usize::from(self.utf8_bom) * 3);
        if self.utf8_bom {
            bytes.extend_from_slice(&[0xef, 0xbb, 0xbf]);
        }
        bytes.extend_from_slice(serialized.as_bytes());
        atomic_write(&self.path, &bytes)?;
        self.saved_digest = digest(normalized.as_bytes());
        self.disk_fingerprint = DiskFingerprint {
            digest: Some(digest(&bytes)),
        };
        self.conflict = None;
        self.acknowledged_conflict = None;
        Ok(())
    }

    pub fn acknowledge_editor_version(&mut self) -> Result<(), WorkspaceError> {
        if self.conflict.is_none() {
            return Err(WorkspaceError::NoConflict(self.path.clone()));
        }
        self.acknowledged_conflict = Some(disk_fingerprint(&self.path)?);
        Ok(())
    }

    pub fn diff_against_disk(&self) -> Result<Vec<DiffLine>, WorkspaceError> {
        let bytes = fs::read(&self.path)?;
        let content = if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
            &bytes[3..]
        } else {
            &bytes
        };
        let disk = std::str::from_utf8(content)
            .map_err(|_| WorkspaceError::NonUtf8(self.path.clone()))?
            .replace("\r\n", "\n");
        Ok(line_diff(&self.text(), &disk))
    }

    pub fn reconcile_disk(&mut self) -> Result<DiskChange, WorkspaceError> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.conflict = Some(DiskConflict::Deleted);
                self.disk_fingerprint = DiskFingerprint { digest: None };
                self.acknowledged_conflict = None;
                return Ok(DiskChange::Conflict(DiskConflict::Deleted));
            }
            Err(error) => return Err(error.into()),
        };
        let fingerprint = DiskFingerprint {
            digest: Some(digest(&bytes)),
        };
        if fingerprint == self.disk_fingerprint {
            return Ok(DiskChange::Unchanged);
        }
        let content = if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
            &bytes[3..]
        } else {
            &bytes
        };
        let disk = String::from_utf8(content.to_vec())
            .map_err(|_| WorkspaceError::NonUtf8(self.path.clone()))?
            .replace("\r\n", "\n");
        let disk_digest = digest(disk.as_bytes());
        if self.is_dirty() {
            let conflict = DiskConflict::Modified { disk_digest };
            self.conflict = Some(conflict.clone());
            self.acknowledged_conflict = None;
            return Ok(DiskChange::Conflict(conflict));
        }
        self.text = Rope::from(disk);
        self.saved_digest = disk_digest;
        self.disk_fingerprint = fingerprint;
        self.utf8_bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
        self.revision += 1;
        self.clamp_cursors();
        Ok(DiskChange::Reloaded)
    }

    pub fn reload_discarding_edits(&mut self) -> Result<(), WorkspaceError> {
        let replacement = Self::open(self.path.clone())?;
        let cursors = self.cursors.clone();
        *self = replacement;
        self.cursors = cursors;
        self.clamp_cursors();
        Ok(())
    }

    fn checkpoint(&mut self) {
        self.undo.push(self.version());
        if self.undo.len() > 1_000 {
            self.undo.remove(0);
        }
    }
    fn version(&self) -> DocumentVersion {
        DocumentVersion {
            text: self.text.clone(),
            cursors: self.cursors.clone(),
        }
    }
    fn clamp_cursors(&mut self) {
        let len = self.text.len();
        for cursor in &mut self.cursors {
            cursor.anchor = cursor.anchor.min(len);
            cursor.head = cursor.head.min(len);
        }
    }
    fn require_writable(&self) -> Result<(), WorkspaceError> {
        if self.read_only {
            Err(WorkspaceError::ReadOnly(self.path.clone()))
        } else {
            Ok(())
        }
    }
}

#[derive(Debug)]
pub struct ProjectWorkspace {
    root: PathBuf,
    files: Vec<PathBuf>,
    documents: BTreeMap<PathBuf, Document>,
    tabs: Vec<PathBuf>,
    active: Option<PathBuf>,
}

impl ProjectWorkspace {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, WorkspaceError> {
        let root = root.into().canonicalize()?;
        let mut files = Vec::new();
        collect_files(&root, &root, &mut files)?;
        files.sort();
        Ok(Self {
            root,
            files,
            documents: BTreeMap::new(),
            tabs: Vec::new(),
            active: None,
        })
    }
    pub fn refresh_files(&mut self) -> Result<bool, WorkspaceError> {
        let mut files = Vec::new();
        collect_files(&self.root, &self.root, &mut files)?;
        files.sort();
        let changed = files != self.files;
        self.files = files;
        Ok(changed)
    }
    pub fn files(&self) -> &[PathBuf] {
        &self.files
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn tabs(&self) -> &[PathBuf] {
        &self.tabs
    }
    pub fn active(&self) -> Option<&Path> {
        self.active.as_deref()
    }
    pub fn document(&self, path: &Path) -> Option<&Document> {
        self.documents.get(path)
    }
    pub fn document_mut(&mut self, path: &Path) -> Option<&mut Document> {
        self.documents.get_mut(path)
    }
    pub fn set_active(&mut self, path: &Path) -> Result<(), WorkspaceError> {
        if !self.documents.contains_key(path) {
            return Err(WorkspaceError::DocumentNotOpen(path.to_owned()));
        }
        self.active = Some(path.to_owned());
        Ok(())
    }
    pub fn open_document(&mut self, path: &Path) -> Result<&Document, WorkspaceError> {
        let path = path.canonicalize()?;
        if !path.starts_with(&self.root) {
            return Err(WorkspaceError::PathEscape(path));
        }
        if !self.documents.contains_key(&path) {
            self.documents.insert(path.clone(), Document::open(&path)?);
            self.tabs.push(path.clone());
        }
        self.active = Some(path.clone());
        Ok(&self.documents[&path])
    }
    pub fn open_evaluated_revision(&mut self, display_path: PathBuf, source: String) -> &Document {
        self.documents
            .entry(display_path.clone())
            .or_insert_with(|| Document::evaluated_revision(display_path.clone(), source));
        if !self.tabs.contains(&display_path) {
            self.tabs.push(display_path.clone());
        }
        self.active = Some(display_path.clone());
        &self.documents[&display_path]
    }
    /// Reconciles a detected (or explicit) rename/move for an open document,
    /// across *all* open tabs, not just the active one — remapping the
    /// document's map key, its own recorded path, the tab list, and the
    /// active-tab pointer if needed. Returns `false` (a no-op) if `from`
    /// isn't an open document, which is the common case for most rename
    /// events in the project tree.
    pub fn rename_document(&mut self, from: &Path, to: &Path) -> bool {
        let Some(mut document) = self.documents.remove(from) else {
            return false;
        };
        let to = to.canonicalize().unwrap_or_else(|_| to.to_owned());
        document.path = to.clone();
        self.documents.insert(to.clone(), document);
        for tab in &mut self.tabs {
            if tab == from {
                *tab = to.clone();
            }
        }
        if self.active.as_deref() == Some(from) {
            self.active = Some(to);
        }
        true
    }

    pub fn close_document(&mut self, path: &Path) -> Result<(), WorkspaceError> {
        if self.documents.get(path).is_some_and(Document::is_dirty) {
            return Err(WorkspaceError::Unsaved(path.to_owned()));
        }
        self.documents.remove(path);
        self.tabs.retain(|tab| tab != path);
        if self.active.as_deref() == Some(path) {
            self.active = self.tabs.last().cloned();
        }
        Ok(())
    }
    pub fn overlays(&self) -> Vec<(PathBuf, Vec<u8>)> {
        self.documents
            .values()
            .filter(|document| document.is_dirty() && !document.is_read_only())
            .filter_map(|document| {
                document
                    .path
                    .strip_prefix(&self.root)
                    .ok()
                    .map(|relative| (relative.to_owned(), document.text().into_bytes()))
            })
            .collect()
    }
    pub fn evaluation_sources(&self) -> Vec<(PathBuf, Vec<u8>)> {
        self.documents
            .values()
            .filter(|document| !document.is_read_only())
            .filter_map(|document| {
                document
                    .path
                    .strip_prefix(&self.root)
                    .ok()
                    .map(|relative| (relative.to_owned(), document.text().into_bytes()))
            })
            .collect()
    }
}

#[derive(Debug, Clone)]
pub struct SourceOverlay {
    root: PathBuf,
    buffers: BTreeMap<PathBuf, Vec<u8>>,
}
impl SourceOverlay {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            buffers: BTreeMap::new(),
        }
    }
    pub fn set(
        &mut self,
        relative: impl AsRef<Path>,
        content: Vec<u8>,
    ) -> Result<(), WorkspaceError> {
        let relative = relative.as_ref();
        if relative.is_absolute() || relative.components().any(|part| part.as_os_str() == "..") {
            return Err(WorkspaceError::PathEscape(relative.to_owned()));
        }
        self.buffers.insert(relative.to_owned(), content);
        Ok(())
    }
    pub fn is_stale(&self, relative: &Path, expected: &[u8]) -> Result<bool, WorkspaceError> {
        if let Some(buffer) = self.buffers.get(relative) {
            return Ok(buffer != expected);
        }
        Ok(fs::read(self.root.join(relative))? != expected)
    }
    pub fn buffers(&self) -> impl Iterator<Item = (&Path, &[u8])> {
        self.buffers
            .iter()
            .map(|(path, bytes)| (path.as_path(), bytes.as_slice()))
    }
}

/// Reads every non-ignored file under `root` and returns its content keyed
/// by path relative to `root`. Used to capture the full set of on-disk files
/// an evaluation reads — not just the open/dirty documents `evaluation_sources`
/// covers — so a cached snapshot can be restored without depending on live
/// project state that may have since changed or been deleted.
pub fn read_all_project_files(root: &Path) -> Result<Vec<(PathBuf, Vec<u8>)>, WorkspaceError> {
    let mut relative_paths = Vec::new();
    collect_files(root, root, &mut relative_paths)?;
    relative_paths
        .into_iter()
        .map(|relative| {
            let bytes = fs::read(root.join(&relative))?;
            Ok((relative, bytes))
        })
        .collect()
}

/// True if `path` (which need not exist) sits under `root` outside every
/// ignored directory (`.git`, `.venv`, `__pycache__`, build output, etc.) —
/// the same filter `read_all_project_files`/`refresh_files` apply when
/// listing project files, exposed so callers reacting to raw filesystem
/// watch events (which are otherwise unfiltered) can apply the same
/// relevance test without duplicating the ignore list.
pub fn is_relevant_project_path(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    !relative.components().any(|component| {
        DEFAULT_IGNORES.contains(&component.as_os_str().to_string_lossy().as_ref())
    })
}

fn collect_files(
    root: &Path,
    directory: &Path,
    output: &mut Vec<PathBuf>,
) -> Result<(), WorkspaceError> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if DEFAULT_IGNORES.contains(&name.as_ref()) {
            continue;
        }
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            collect_files(root, &path, output)?;
        } else if kind.is_file() {
            output.push(path.strip_prefix(root).unwrap_or(&path).to_owned());
        }
    }
    Ok(())
}

fn line_diff(editor: &str, disk: &str) -> Vec<DiffLine> {
    let left = editor.lines().collect::<Vec<_>>();
    let right = disk.lines().collect::<Vec<_>>();
    if left.len().saturating_mul(right.len()) > 4_000_000 {
        let mut output = Vec::new();
        for index in 0..left.len().max(right.len()) {
            match (left.get(index), right.get(index)) {
                (Some(left), Some(right)) if left == right => output.push(DiffLine {
                    kind: DiffKind::Equal,
                    text: (*left).into(),
                }),
                (Some(left), Some(right)) => {
                    output.push(DiffLine {
                        kind: DiffKind::EditorOnly,
                        text: (*left).into(),
                    });
                    output.push(DiffLine {
                        kind: DiffKind::DiskOnly,
                        text: (*right).into(),
                    });
                }
                (Some(line), None) => output.push(DiffLine {
                    kind: DiffKind::EditorOnly,
                    text: (*line).into(),
                }),
                (None, Some(line)) => output.push(DiffLine {
                    kind: DiffKind::DiskOnly,
                    text: (*line).into(),
                }),
                (None, None) => {}
            }
        }
        return output;
    }
    let mut lengths = vec![vec![0usize; right.len() + 1]; left.len() + 1];
    for i in (0..left.len()).rev() {
        for j in (0..right.len()).rev() {
            lengths[i][j] = if left[i] == right[j] {
                lengths[i + 1][j + 1] + 1
            } else {
                lengths[i + 1][j].max(lengths[i][j + 1])
            };
        }
    }
    let (mut i, mut j) = (0, 0);
    let mut output = Vec::new();
    while i < left.len() || j < right.len() {
        if i < left.len() && j < right.len() && left[i] == right[j] {
            output.push(DiffLine {
                kind: DiffKind::Equal,
                text: left[i].into(),
            });
            i += 1;
            j += 1;
        } else if j == right.len() || (i < left.len() && lengths[i + 1][j] >= lengths[i][j + 1]) {
            output.push(DiffLine {
                kind: DiffKind::EditorOnly,
                text: left[i].into(),
            });
            i += 1;
        } else {
            output.push(DiffLine {
                kind: DiffKind::DiskOnly,
                text: right[j].into(),
            });
            j += 1;
        }
    }
    output
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), WorkspaceError> {
    let parent = path
        .parent()
        .ok_or_else(|| WorkspaceError::InvalidPath(path.to_owned()))?;
    fs::create_dir_all(parent)?;
    let sequence = SAVE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(
        ".{}.machinewright-save-{}-{sequence}",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    let result = (|| {
        let permissions = fs::metadata(path)
            .ok()
            .map(|metadata| metadata.permissions());
        let mut file = File::create(&temporary)?;
        if let Some(permissions) = permissions {
            file.set_permissions(permissions)?;
        }
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn disk_fingerprint(path: &Path) -> Result<DiskFingerprint, WorkspaceError> {
    match fs::read(path) {
        Ok(bytes) => Ok(DiskFingerprint {
            digest: Some(digest(&bytes)),
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(DiskFingerprint { digest: None })
        }
        Err(error) => Err(error.into()),
    }
}

/// The digest scheme `Document::content_digest`/`saved_digest` and every
/// `SourceSpan::source_digest` produced by the evaluator use — exposed so
/// callers can validate a source span against a file that isn't open.
pub fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("source path escapes the project: {0}")]
    PathEscape(PathBuf),
    #[error("file is not valid UTF-8: {0}")]
    NonUtf8(PathBuf),
    #[error("document is read-only: {0}")]
    ReadOnly(PathBuf),
    #[error("document changed on disk; explicit conflict resolution is required: {0}")]
    SaveConflict(PathBuf),
    #[error("document has no disk conflict to acknowledge: {0}")]
    NoConflict(PathBuf),
    #[error("document has unsaved changes: {0}")]
    Unsaved(PathBuf),
    #[error("document is not open: {0}")]
    DocumentNotOpen(PathBuf),
    #[error("invalid text edit")]
    InvalidEdit,
    #[error("line {0} is outside the document")]
    InvalidLine(usize),
    #[error("invalid path: {0}")]
    InvalidPath(PathBuf),
    #[error("invalid machinewright.toml: {0}")]
    Manifest(String),
    #[error("invalid application preferences: {0}")]
    Preferences(String),
    #[error("declared environment does not contain a worker executable: {0}")]
    MissingWorker(PathBuf),
    #[error("project file watcher failed: {0}")]
    Watch(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn multicursor_edit_undo_and_redo_preserve_unicode() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("design.py");
        fs::write(&path, "a = '😀'\nb = 2\n").unwrap();
        let mut document = Document::open(&path).unwrap();
        document
            .set_cursors(vec![Cursor::caret(0), Cursor::caret(11)])
            .unwrap();
        document.replace_selections("# ").unwrap();
        assert_eq!(document.text(), "# a = '😀'\n# b = 2\n");
        assert!(document.undo());
        assert_eq!(document.text(), "a = '😀'\nb = 2\n");
        assert!(document.redo());
    }
    #[test]
    fn dirty_external_change_requires_force_save() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("design.py");
        fs::write(&path, "value = 1\n").unwrap();
        let mut document = Document::open(&path).unwrap();
        document.replace("value = 2\n").unwrap();
        fs::write(&path, "value = 3\n").unwrap();
        assert!(matches!(
            document.reconcile_disk().unwrap(),
            DiskChange::Conflict(_)
        ));
        assert!(matches!(
            document.save(false),
            Err(WorkspaceError::SaveConflict(_))
        ));
        document.acknowledge_editor_version().unwrap();
        document.save(true).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), "value = 2\n");
    }

    #[test]
    fn force_save_rejects_a_second_unacknowledged_disk_change() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("design.py");
        fs::write(&path, "value = 1\n").unwrap();
        let mut document = Document::open(&path).unwrap();
        document.replace("value = 2\n").unwrap();
        fs::write(&path, "value = 3\n").unwrap();
        document.reconcile_disk().unwrap();
        document.acknowledge_editor_version().unwrap();
        fs::write(&path, "value = 4\n").unwrap();
        assert!(matches!(
            document.save(true),
            Err(WorkspaceError::SaveConflict(_))
        ));
    }

    #[test]
    fn preserves_utf8_bom_crlf_and_permissions() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("design.py");
        fs::write(&path, b"\xef\xbb\xbfvalue = 1\r\n").unwrap();
        let mut document = Document::open(&path).unwrap();
        document.replace("value = 2\n").unwrap();
        document.save(false).unwrap();
        assert_eq!(fs::read(path).unwrap(), b"\xef\xbb\xbfvalue = 2\r\n");
    }

    #[test]
    fn overlapping_multicursors_apply_one_edit() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("design.py");
        fs::write(&path, "abcdef").unwrap();
        let mut document = Document::open(&path).unwrap();
        document
            .set_cursors(vec![
                Cursor { anchor: 1, head: 4 },
                Cursor { anchor: 3, head: 5 },
            ])
            .unwrap();
        document.replace_selections("X").unwrap();
        assert_eq!(document.text(), "aXf");
        assert_eq!(document.cursors(), &[Cursor::caret(2)]);
    }

    #[test]
    fn disk_diff_is_read_only_and_preserves_both_versions() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("design.py");
        fs::write(&path, "same\ndisk\n").unwrap();
        let mut document = Document::open(&path).unwrap();
        document.replace("same\neditor\n").unwrap();
        let diff = document.diff_against_disk().unwrap();
        assert_eq!(diff[0].kind, DiffKind::Equal);
        assert!(
            diff.iter()
                .any(|line| line.kind == DiffKind::EditorOnly && line.text == "editor")
        );
        assert!(
            diff.iter()
                .any(|line| line.kind == DiffKind::DiskOnly && line.text == "disk")
        );
        assert_eq!(document.text(), "same\neditor\n");
    }

    #[test]
    fn find_replace_and_go_to_line_are_unicode_safe_and_undoable() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("design.py");
        fs::write(&path, "name = '😀'\nname = '😀'\n").unwrap();
        let mut document = Document::open(&path).unwrap();
        assert_eq!(document.find("😀").len(), 2);
        assert_eq!(document.replace_all("😀", "motor").unwrap(), 2);
        assert_eq!(document.go_to_line(2).unwrap(), 15);
        assert!(document.undo());
        assert!(document.text().contains("😀"));
    }
    #[test]
    fn evaluated_revision_is_a_read_only_tab() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("machinewright.toml"), "project_id='x'").unwrap();
        let mut workspace = ProjectWorkspace::open(root.path()).unwrap();
        let display = PathBuf::from("model.py @ abc");
        let document = workspace.open_evaluated_revision(display.clone(), "value = 1\n".into());
        assert!(document.is_read_only());
        assert_eq!(workspace.active(), Some(display.as_path()));
        assert!(matches!(
            workspace
                .document_mut(&display)
                .unwrap()
                .replace("value = 2\n"),
            Err(WorkspaceError::ReadOnly(_))
        ));
    }
    #[test]
    fn preferences_restore_tabs_and_cursors_outside_project() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("machinewright.toml"), "project_id='x'").unwrap();
        let source = root.path().join("model.py");
        fs::write(&source, "value = 1\n").unwrap();
        let source = source.canonicalize().unwrap();
        let mut workspace = ProjectWorkspace::open(root.path()).unwrap();
        workspace.open_document(&source).unwrap();
        workspace
            .document_mut(&source)
            .unwrap()
            .set_cursors(vec![Cursor::caret(5)])
            .unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let preferences_path = app_data.path().join("preferences.json");
        WorkspacePreferences::capture(&workspace)
            .save(&preferences_path)
            .unwrap();
        let mut restored = ProjectWorkspace::open(root.path()).unwrap();
        WorkspacePreferences::load(&preferences_path)
            .unwrap()
            .restore(&mut restored)
            .unwrap();
        assert_eq!(restored.tabs(), std::slice::from_ref(&source));
        assert_eq!(
            restored.document(&source).unwrap().cursors()[0],
            Cursor::caret(5)
        );
    }
    #[test]
    fn preferences_restore_undo_and_redo_history_for_saved_documents() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("machinewright.toml"), "project_id='x'").unwrap();
        let source = root.path().join("model.py");
        fs::write(&source, "value = 1\n").unwrap();
        let source = source.canonicalize().unwrap();
        let mut workspace = ProjectWorkspace::open(root.path()).unwrap();
        workspace.open_document(&source).unwrap();
        workspace
            .document_mut(&source)
            .unwrap()
            .replace("value = 2\n")
            .unwrap();
        workspace
            .document_mut(&source)
            .unwrap()
            .replace("value = 3\n")
            .unwrap();
        workspace
            .document_mut(&source)
            .unwrap()
            .save(false)
            .unwrap();

        let app_data = tempfile::tempdir().unwrap();
        let preferences_path = app_data.path().join("preferences.json");
        WorkspacePreferences::capture(&workspace)
            .save(&preferences_path)
            .unwrap();

        let mut restored = ProjectWorkspace::open(root.path()).unwrap();
        WorkspacePreferences::load(&preferences_path)
            .unwrap()
            .restore(&mut restored)
            .unwrap();

        assert_eq!(restored.document(&source).unwrap().text(), "value = 3\n");
        assert!(restored.document_mut(&source).unwrap().undo());
        assert_eq!(restored.document(&source).unwrap().text(), "value = 2\n");
        assert!(restored.document_mut(&source).unwrap().undo());
        assert_eq!(restored.document(&source).unwrap().text(), "value = 1\n");
    }
    #[test]
    fn preferences_do_not_persist_history_for_unsaved_documents() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("machinewright.toml"), "project_id='x'").unwrap();
        let source = root.path().join("model.py");
        fs::write(&source, "value = 1\n").unwrap();
        let source = source.canonicalize().unwrap();
        let mut workspace = ProjectWorkspace::open(root.path()).unwrap();
        workspace.open_document(&source).unwrap();
        workspace
            .document_mut(&source)
            .unwrap()
            .replace("value = 2\n")
            .unwrap();
        // Never saved: the document remains dirty, so its history is not
        // persisted (it wouldn't be consistent with the disk content the
        // next launch reopens).
        let preferences = WorkspacePreferences::capture(&workspace);
        assert!(!preferences.history.contains_key(&source));
    }
    #[test]
    fn rename_document_reconciles_a_background_tab_not_just_the_active_one() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("machinewright.toml"), "project_id='x'").unwrap();
        let first = root.path().join("first.py");
        let second = root.path().join("second.py");
        fs::write(&first, "value = 1\n").unwrap();
        fs::write(&second, "value = 2\n").unwrap();
        let mut workspace = ProjectWorkspace::open(root.path()).unwrap();
        workspace.open_document(&first).unwrap();
        let first = first.canonicalize().unwrap();
        workspace.open_document(&second).unwrap();
        let second = second.canonicalize().unwrap();
        // `second` is active (opened last); rename the *background* tab.
        assert_eq!(workspace.active(), Some(second.as_path()));

        let renamed_first = root.path().join("renamed_first.py");
        fs::rename(&first, &renamed_first).unwrap();
        assert!(workspace.rename_document(&first, &renamed_first));

        let renamed_first = renamed_first.canonicalize().unwrap();
        assert!(workspace.document(&first).is_none());
        assert!(workspace.document(&renamed_first).is_some());
        assert_eq!(
            workspace.document(&renamed_first).unwrap().path(),
            renamed_first
        );
        assert_eq!(workspace.tabs(), &[renamed_first.clone(), second.clone()]);
        // The background tab's rename must not steal focus from the tab
        // that was actually active.
        assert_eq!(workspace.active(), Some(second.as_path()));
    }
    #[test]
    fn rename_document_updates_the_active_pointer_when_the_active_tab_moves() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("machinewright.toml"), "project_id='x'").unwrap();
        let source = root.path().join("model.py");
        fs::write(&source, "value = 1\n").unwrap();
        let mut workspace = ProjectWorkspace::open(root.path()).unwrap();
        workspace.open_document(&source).unwrap();
        let source = source.canonicalize().unwrap();

        let renamed = root.path().join("renamed.py");
        fs::rename(&source, &renamed).unwrap();
        assert!(workspace.rename_document(&source, &renamed));
        let renamed = renamed.canonicalize().unwrap();
        assert_eq!(workspace.active(), Some(renamed.as_path()));
    }
    #[test]
    fn rename_document_is_a_no_op_for_a_path_that_is_not_open() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("machinewright.toml"), "project_id='x'").unwrap();
        let mut workspace = ProjectWorkspace::open(root.path()).unwrap();
        assert!(!workspace.rename_document(
            &root.path().join("untracked.py"),
            &root.path().join("also_untracked.py")
        ));
    }
    #[test]
    fn project_tree_ignores_environment_and_build_outputs() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("machinewright.toml"), "project_id='x'").unwrap();
        fs::create_dir(root.path().join(".venv")).unwrap();
        fs::write(root.path().join(".venv/hidden.py"), "").unwrap();
        fs::create_dir(root.path().join("src")).unwrap();
        fs::write(root.path().join("src/model.py"), "").unwrap();
        let workspace = ProjectWorkspace::open(root.path()).unwrap();
        assert_eq!(
            workspace.files(),
            &[
                PathBuf::from("machinewright.toml"),
                PathBuf::from("src/model.py")
            ]
        );
    }

    #[test]
    fn read_all_project_files_captures_unopened_sources_and_ignores_build_outputs() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("machinewright.toml"), "project_id='x'").unwrap();
        fs::create_dir(root.path().join("src")).unwrap();
        fs::write(root.path().join("src/model.py"), "value = 1\n").unwrap();
        fs::create_dir(root.path().join(".venv")).unwrap();
        fs::write(root.path().join(".venv/hidden.py"), "").unwrap();
        let mut files = read_all_project_files(root.path()).unwrap();
        files.sort();
        assert_eq!(
            files,
            vec![
                (
                    PathBuf::from("machinewright.toml"),
                    b"project_id='x'".to_vec()
                ),
                (PathBuf::from("src/model.py"), b"value = 1\n".to_vec()),
            ]
        );
    }

    #[test]
    fn manifest_or_lock_change_revokes_trust_but_source_change_does_not() {
        let root = tempfile::tempdir().unwrap();
        fs::write(
            root.path().join("machinewright.toml"),
            "project_id='x'\nenvironment_lock='uv.lock'\n",
        )
        .unwrap();
        fs::write(root.path().join("uv.lock"), "lock-v1").unwrap();
        fs::write(root.path().join("model.py"), "value = 1\n").unwrap();
        let preferences = root.path().join("preferences/trust.json");
        let mut trust = TrustStore::load(&preferences).unwrap();
        assert!(!trust.is_trusted(root.path()).unwrap());
        trust.trust(root.path()).unwrap();
        assert!(trust.is_trusted(root.path()).unwrap());
        fs::write(root.path().join("model.py"), "value = 2\n").unwrap();
        assert!(trust.is_trusted(root.path()).unwrap());
        fs::write(root.path().join("uv.lock"), "lock-v2").unwrap();
        assert!(!trust.is_trusted(root.path()).unwrap());
    }
}
