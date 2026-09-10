use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use fs4::FileExt;
use machinewright_model::ProjectSnapshot;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

static WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone)]
pub struct ArtifactCache {
    root: PathBuf,
}

impl ArtifactCache {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn path(&self, digest: &str) -> Result<PathBuf, CacheError> {
        Ok(self.root.join(parse_digest(digest)?))
    }

    pub fn put(&self, bytes: &[u8]) -> Result<String, CacheError> {
        fs::create_dir_all(&self.root)?;
        let digest = hex_digest(bytes);
        let target = self.root.join(&digest);
        if target.exists() {
            self.verify_path(&target, &format!("sha256:{digest}"))?;
            return Ok(format!("sha256:{digest}"));
        }
        let temporary = self.root.join(format!(
            ".{digest}.tmp-{}-{}",
            std::process::id(),
            WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let mut file = fs::File::create(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        match fs::rename(&temporary, &target) {
            Ok(()) => {}
            Err(error) if target.exists() => {
                let _ = fs::remove_file(&temporary);
            }
            Err(error) => return Err(error.into()),
        }
        Ok(format!("sha256:{digest}"))
    }

    pub fn read(&self, digest: &str) -> Result<Vec<u8>, CacheError> {
        let path = self.path(digest)?;
        let bytes = fs::read(&path)?;
        if hex_digest(&bytes) != parse_digest(digest)? {
            return Err(CacheError::DigestMismatch(path));
        }
        Ok(bytes)
    }

    pub fn quarantine(&self, digest: &str) -> Result<PathBuf, CacheError> {
        let path = self.path(digest)?;
        let quarantine = self.root.join("quarantine");
        fs::create_dir_all(&quarantine)?;
        let target = quarantine.join(format!(
            "{}-{}",
            parse_digest(digest)?,
            WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::rename(path, &target)?;
        Ok(target)
    }

    fn verify_path(&self, path: &Path, digest: &str) -> Result<(), CacheError> {
        let bytes = fs::read(path)?;
        if hex_digest(&bytes) != parse_digest(digest)? {
            return Err(CacheError::DigestMismatch(path.to_owned()));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LastValidReference {
    snapshot_key: String,
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    requested_generation: u64,
    #[serde(default)]
    environment_digest: String,
    artifact_digests: Vec<String>,
    #[serde(default)]
    sources: BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct SnapshotRecord {
    pub snapshot: ProjectSnapshot,
    pub session_id: String,
    pub requested_generation: u64,
    pub environment_digest: String,
    pub artifact_root: PathBuf,
    pub source_blobs: BTreeMap<String, PathBuf>,
    pub source_paths: BTreeMap<String, String>,
    pub cache_hit: bool,
}

pub struct SnapshotImport<'a> {
    pub project_key: &'a str,
    pub session_id: &'a str,
    pub generation: u64,
    pub environment_digest: &'a str,
    pub snapshot_path: &'a Path,
    pub artifact_root: &'a Path,
    pub sources: &'a BTreeMap<PathBuf, Vec<u8>>,
}

#[derive(Debug, Clone)]
pub struct SnapshotStore {
    root: PathBuf,
    objects: ArtifactCache,
    active: Arc<Mutex<BTreeMap<String, usize>>>,
}

pub struct CacheLease {
    active: Arc<Mutex<BTreeMap<String, usize>>>,
    digests: Vec<String>,
}

struct StagingDirectory {
    path: PathBuf,
    promoted: bool,
}

impl StagingDirectory {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            promoted: false,
        }
    }
}

impl Drop for StagingDirectory {
    fn drop(&mut self) {
        if !self.promoted {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

/// An OS-level advisory lock (`flock` on Unix, `LockFileEx` on Windows) held
/// on a file under the cache root. The lock is released automatically when
/// the underlying file handle closes, i.e. when this guard drops.
struct StoreLock {
    // Kept alive only so the OS advisory lock releases when this guard
    // drops; never read otherwise.
    _file: fs::File,
}

impl SnapshotStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        let snapshots = root.join("snapshots");
        if let Ok(entries) = fs::read_dir(&snapshots) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().starts_with('.')
                    && entry.file_name().to_string_lossy().contains(".tmp-")
                {
                    let _ = fs::remove_dir_all(entry.path());
                }
            }
        }
        Self {
            objects: ArtifactCache::new(root.join("objects")),
            root,
            active: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }

    pub fn import(
        &self,
        request: SnapshotImport<'_>,
    ) -> Result<(SnapshotRecord, CacheLease), CacheError> {
        let SnapshotImport {
            project_key,
            session_id,
            generation,
            environment_digest,
            snapshot_path,
            artifact_root,
            sources,
        } = request;
        let snapshot_bytes = fs::read(snapshot_path)?;
        let snapshot = ProjectSnapshot::load(snapshot_path)?;
        if snapshot.evaluation().generation != generation {
            return Err(CacheError::GenerationMismatch {
                expected: generation,
                actual: snapshot.evaluation().generation,
            });
        }
        let snapshot_key = hex_digest(&snapshot_bytes);
        let snapshot_root = self.root.join("snapshots").join(&snapshot_key);
        let temporary = self.root.join("snapshots").join(format!(
            ".{snapshot_key}.tmp-{}-{}",
            std::process::id(),
            WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let mut staging = StagingDirectory::new(temporary);
        fs::create_dir_all(staging.path.join("meshes"))?;
        durable_write(
            &staging.path.join("evaluation-snapshot.json"),
            &snapshot_bytes,
        )?;
        let mut artifact_digests = Vec::new();
        for reference in &snapshot.evaluation().meshes {
            let relative = safe_relative(&reference.name)?;
            let bytes = fs::read(artifact_root.join(relative))?;
            if bytes.len() as u64 != reference.byte_size
                || hex_digest(&bytes) != parse_digest(&reference.digest)?
            {
                return Err(CacheError::ArtifactMismatch(reference.name.clone()));
            }
            let digest = self.objects.put(&bytes)?;
            artifact_digests.push(digest.clone());
            link_or_copy(&self.objects.path(&digest)?, &staging.path.join(relative))?;
        }
        let mut source_paths = BTreeMap::new();
        for (relative_path, bytes) in sources {
            let _ = safe_relative(&relative_path.to_string_lossy())?;
            let stored = self.objects.put(bytes)?;
            source_paths.insert(stored.clone(), self.objects.path(&stored)?);
            artifact_digests.push(stored);
        }
        let source_index = sources
            .iter()
            .map(|(path, bytes)| {
                (
                    path.to_string_lossy().replace('\\', "/"),
                    format!("sha256:{}", hex_digest(bytes)),
                )
            })
            .collect::<BTreeMap<_, _>>();
        artifact_digests.sort();
        artifact_digests.dedup();
        {
            // Promoting the staged snapshot directory and writing the
            // last-valid pointer must be serialized across processes, not
            // just threads within this one: two Machinewright instances (or
            // an instance and a CLI invocation) sharing a cache root could
            // otherwise interleave these steps and leave a pointer
            // referencing a half-promoted or superseded snapshot.
            let _lock = self.lock_store()?;
            if !snapshot_root.exists() {
                fs::rename(&staging.path, &snapshot_root)?;
                staging.promoted = true;
            }
            self.write_last(
                project_key,
                &LastValidReference {
                    snapshot_key,
                    session_id: session_id.into(),
                    requested_generation: generation,
                    environment_digest: environment_digest.into(),
                    artifact_digests: artifact_digests.clone(),
                    sources: source_index.clone(),
                },
            )?;
        }
        let record = SnapshotRecord {
            snapshot,
            session_id: session_id.into(),
            requested_generation: generation,
            environment_digest: environment_digest.into(),
            artifact_root: snapshot_root,
            source_blobs: source_paths,
            source_paths: source_index,
            cache_hit: false,
        };
        Ok((record, self.lease(artifact_digests)))
    }

    /// Restores the last-valid snapshot for `project_key`, if one exists and
    /// is intact. Any corruption encountered along the way (an unreadable
    /// pointer file, a digest mismatch on a referenced object, or a
    /// corrupted snapshot/mesh copy) is quarantined so that the *next* call
    /// self-heals to `Ok(None)` instead of repeating the same failure on
    /// every future launch — the cache falls back to "no cached snapshot"
    /// rather than staying permanently poisoned by unusable data on disk.
    /// The triggering error is still returned to this caller so the failure
    /// is observable, matching how object-level corruption already behaved.
    pub fn restore(
        &self,
        project_key: &str,
    ) -> Result<Option<(SnapshotRecord, CacheLease)>, CacheError> {
        let path = self.last_path(project_key)?;
        if !path.is_file() {
            return Ok(None);
        }
        let reference: LastValidReference = match fs::read(&path)
            .map_err(CacheError::from)
            .and_then(|bytes| serde_json::from_slice(&bytes).map_err(CacheError::from))
        {
            Ok(reference) => reference,
            Err(error) => {
                self.quarantine_pointer(&path);
                return Err(error);
            }
        };
        let snapshot_root = self.root.join("snapshots").join(&reference.snapshot_key);
        match self.restore_reference(&reference, &snapshot_root) {
            Ok((record, lease)) => Ok(Some((record, lease))),
            Err(error) => {
                self.quarantine_pointer(&path);
                self.quarantine_snapshot_root(&snapshot_root);
                Err(error)
            }
        }
    }

    fn restore_reference(
        &self,
        reference: &LastValidReference,
        snapshot_root: &Path,
    ) -> Result<(SnapshotRecord, CacheLease), CacheError> {
        for digest in &reference.artifact_digests {
            if let Err(error) = self.objects.read(digest) {
                if matches!(error, CacheError::DigestMismatch(_)) {
                    let _ = self.objects.quarantine(digest);
                }
                return Err(error);
            }
        }
        let snapshot_path = snapshot_root.join("evaluation-snapshot.json");
        let snapshot_bytes = fs::read(&snapshot_path)?;
        if hex_digest(&snapshot_bytes) != reference.snapshot_key {
            return Err(CacheError::SnapshotMismatch(snapshot_path));
        }
        let snapshot = ProjectSnapshot::load(&snapshot_path)?;
        for mesh in &snapshot.evaluation().meshes {
            let path = snapshot_root.join(safe_relative(&mesh.name)?);
            let bytes = fs::read(&path)?;
            if bytes.len() as u64 != mesh.byte_size
                || hex_digest(&bytes) != parse_digest(&mesh.digest)?
            {
                return Err(CacheError::ArtifactMismatch(mesh.name.clone()));
            }
        }
        let source_blobs = reference
            .sources
            .values()
            .filter_map(|digest| {
                let path = self.objects.path(digest).ok()?;
                Some((digest.clone(), path))
            })
            .collect();
        let record = SnapshotRecord {
            snapshot,
            session_id: reference.session_id.clone(),
            requested_generation: reference.requested_generation,
            environment_digest: reference.environment_digest.clone(),
            artifact_root: snapshot_root.to_path_buf(),
            source_blobs,
            source_paths: reference.sources.clone(),
            cache_hit: true,
        };
        Ok((record, self.lease(reference.artifact_digests.clone())))
    }

    /// Moves a corrupted or unreadable last-valid pointer file aside into a
    /// quarantine directory kept outside `projects/`, so `protected_digests`
    /// (which reads every file directly under `projects/` as a pointer)
    /// never sees it again and a later restore attempt cleanly finds no
    /// pointer at all.
    fn quarantine_pointer(&self, path: &Path) {
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            return;
        };
        let quarantine_dir = self.root.join("quarantine").join("projects");
        if fs::create_dir_all(&quarantine_dir).is_err() {
            return;
        }
        let target = quarantine_dir.join(format!(
            "{name}-{}",
            WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::rename(path, target);
    }

    /// Moves a snapshot directory that failed validation aside, so its
    /// corrupted contents don't linger on disk indefinitely once nothing
    /// references them.
    fn quarantine_snapshot_root(&self, snapshot_root: &Path) {
        let Some(name) = snapshot_root.file_name().and_then(|name| name.to_str()) else {
            return;
        };
        if !snapshot_root.exists() {
            return;
        }
        let quarantine_dir = self.root.join("quarantine").join("snapshots");
        if fs::create_dir_all(&quarantine_dir).is_err() {
            return;
        }
        let target = quarantine_dir.join(format!(
            "{name}-{}",
            WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::rename(snapshot_root, target);
    }

    pub fn evict_to_limit(&self, limit_bytes: u64) -> Result<u64, CacheError> {
        // Held for the whole scan-and-delete pass so it can never interleave
        // with another process's import promote step (which holds the same
        // lock): otherwise eviction could delete an object moments before a
        // concurrent import's pointer write makes it "protected."
        let _lock = self.lock_store()?;
        let protected = self.protected_digests()?;
        let object_root = self.root.join("objects");
        if !object_root.is_dir() {
            return Ok(0);
        }
        let mut entries = fs::read_dir(&object_root)?
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let metadata = entry.metadata().ok()?;
                if !metadata.is_file() {
                    return None;
                }
                Some((entry.path(), metadata.len(), metadata.modified().ok()))
            })
            .collect::<Vec<_>>();
        let mut total = entries.iter().map(|(_, size, _)| size).sum::<u64>();
        entries.sort_by_key(|(_, _, modified)| *modified);
        let mut removed = 0;
        for (path, size, _) in entries {
            if total <= limit_bytes {
                break;
            }
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let digest = format!("sha256:{name}");
            if protected.contains(&digest) {
                continue;
            }
            if fs::remove_file(path).is_ok() {
                total = total.saturating_sub(size);
                removed += size;
            }
        }
        Ok(removed)
    }

    /// Acquires the cache root's cross-process advisory lock, blocking until
    /// it is available. Guards the import promote step and eviction so two
    /// OS processes (two Machinewright instances, or an instance and a CLI
    /// invocation) sharing the same cache root never interleave writes to
    /// the last-valid pointer or run eviction concurrently with a promote.
    /// The lock is released when the returned guard drops.
    fn lock_store(&self) -> Result<StoreLock, CacheError> {
        fs::create_dir_all(&self.root)?;
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(self.root.join(".cache.lock"))?;
        // Explicit UFCS: the workspace's declared MSRV predates
        // `std::fs::File::lock`, so this must resolve to fs4's flock/
        // LockFileEx-backed implementation rather than any inherent method a
        // newer local toolchain happens to also provide.
        FileExt::lock(&file)?;
        Ok(StoreLock { _file: file })
    }

    fn lease(&self, digests: Vec<String>) -> CacheLease {
        if let Ok(mut active) = self.active.lock() {
            for digest in &digests {
                *active.entry(digest.clone()).or_default() += 1;
            }
        }
        CacheLease {
            active: Arc::clone(&self.active),
            digests,
        }
    }

    fn write_last(
        &self,
        project_key: &str,
        reference: &LastValidReference,
    ) -> Result<(), CacheError> {
        let path = self.last_path(project_key)?;
        let parent = path.parent().expect("last-valid reference has parent");
        fs::create_dir_all(parent)?;
        let temporary = path.with_extension(format!(
            "tmp-{}",
            WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        durable_write(&temporary, &serde_json::to_vec(reference)?)?;
        fs::rename(temporary, &path)?;
        if let Ok(directory) = fs::File::open(parent) {
            let _ = directory.sync_all();
        }
        Ok(())
    }

    fn last_path(&self, project_key: &str) -> Result<PathBuf, CacheError> {
        if project_key.is_empty()
            || !project_key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(CacheError::InvalidProjectKey);
        }
        Ok(self
            .root
            .join("projects")
            .join(format!("{project_key}.json")))
    }

    fn protected_digests(&self) -> Result<BTreeSet<String>, CacheError> {
        let mut protected = self
            .active
            .lock()
            .map_err(|_| CacheError::Poisoned)?
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>();
        let projects = self.root.join("projects");
        if projects.is_dir() {
            for entry in fs::read_dir(projects)? {
                let entry = entry?;
                if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
                    continue;
                }
                let Ok(bytes) = fs::read(entry.path()) else {
                    continue;
                };
                let Ok(reference) = serde_json::from_slice::<LastValidReference>(&bytes) else {
                    continue;
                };
                protected.extend(reference.artifact_digests);
            }
        }
        Ok(protected)
    }
}

impl Drop for CacheLease {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active.lock() {
            for digest in &self.digests {
                if let Some(count) = active.get_mut(digest) {
                    *count -= 1;
                    if *count == 0 {
                        active.remove(digest);
                    }
                }
            }
        }
    }
}

fn safe_relative(name: &str) -> Result<&Path, CacheError> {
    let path = Path::new(name);
    if path.is_absolute() || path.components().any(|part| part.as_os_str() == "..") {
        Err(CacheError::InvalidArtifactPath(name.into()))
    } else {
        Ok(path)
    }
}

fn link_or_copy(source: &Path, target: &Path) -> Result<(), CacheError> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    if fs::hard_link(source, target).is_err() {
        fs::copy(source, target)?;
    }
    Ok(())
}

fn durable_write(path: &Path, bytes: &[u8]) -> Result<(), CacheError> {
    let mut file = fs::File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn hex_digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn parse_digest(digest: &str) -> Result<&str, CacheError> {
    let value = digest
        .strip_prefix("sha256:")
        .ok_or(CacheError::InvalidDigest)?;
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(CacheError::InvalidDigest);
    }
    Ok(value)
}

#[derive(Debug, Error)]
pub enum CacheError {
    #[error("artifact cache I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid SHA-256 digest")]
    InvalidDigest,
    #[error("artifact digest mismatch at {0}")]
    DigestMismatch(PathBuf),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Snapshot(#[from] machinewright_model::SnapshotError),
    #[error("snapshot generation mismatch: expected {expected}, got {actual}")]
    GenerationMismatch { expected: u64, actual: u64 },
    #[error("artifact does not match its snapshot reference: {0}")]
    ArtifactMismatch(String),
    #[error("source blob does not match its digest: {0}")]
    SourceMismatch(String),
    #[error("cached snapshot digest mismatch at {0}")]
    SnapshotMismatch(PathBuf),
    #[error("invalid artifact path: {0}")]
    InvalidArtifactPath(String),
    #[error("invalid project cache key")]
    InvalidProjectKey,
    #[error("cache lease table is unavailable")]
    Poisoned,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(root: &Path, generation: u64) -> (PathBuf, PathBuf, String) {
        let artifact_root = root.join("evaluation");
        fs::create_dir_all(artifact_root.join("meshes")).unwrap();
        let mesh = b"mesh bytes";
        let mesh_digest = format!("sha256:{}", hex_digest(mesh));
        fs::write(artifact_root.join("meshes/part.mwm"), mesh).unwrap();
        let snapshot = json!({
            "schema_version": "1.0",
            "generation": generation,
            "graph_digest": "sha256:graph",
            "artifact_manifest_digest": "sha256:manifest",
            "graph": {"nodes": [{
                "node_id": "root/part", "instance_key": "part", "kind": "component",
                "definition_id": "test.part", "parameters": {}
            }], "containment": []},
            "source_mappings": [], "dependencies": [], "diagnostics": [],
            "meshes": [{
                "encoding": "mwm1", "graph_node_id": "root/part", "digest": mesh_digest,
                "name": "meshes/part.mwm", "byte_size": mesh.len(),
                "vertex_count": 0, "triangle_count": 0
            }],
            "observables": [], "evidence_requirements": [],
            "control_configuration": {}, "provenance": {}
        });
        let snapshot_path = artifact_root.join("evaluation-snapshot.json");
        fs::write(&snapshot_path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
        (snapshot_path, artifact_root, mesh_digest)
    }

    #[test]
    fn rejects_corruption() {
        let root = tempfile::tempdir().unwrap();
        let cache = ArtifactCache::new(root.path());
        let digest = cache.put(b"mesh").unwrap();
        fs::write(cache.path(&digest).unwrap(), b"wrong").unwrap();
        assert!(matches!(
            cache.read(&digest),
            Err(CacheError::DigestMismatch(_))
        ));
    }

    #[test]
    fn imports_and_restores_sources_separately_from_artifacts() {
        let root = tempfile::tempdir().unwrap();
        let (snapshot, artifacts, _) = fixture(root.path(), 7);
        let store = SnapshotStore::new(root.path().join("cache"));
        let source = b"value = 7\n".to_vec();
        let source_digest = format!("sha256:{}", hex_digest(&source));
        let sources = BTreeMap::from([(PathBuf::from("design.py"), source)]);
        let (_, lease) = store
            .import(SnapshotImport {
                project_key: "project",
                session_id: "session",
                generation: 7,
                environment_digest: "sha256:environment",
                snapshot_path: &snapshot,
                artifact_root: &artifacts,
                sources: &sources,
            })
            .unwrap();
        drop(lease);

        let (record, _lease) = store.restore("project").unwrap().unwrap();
        assert!(record.cache_hit);
        assert_eq!(record.snapshot.evaluation().generation, 7);
        assert_eq!(record.session_id, "session");
        assert_eq!(record.source_paths["design.py"], source_digest);
        assert_eq!(
            record.source_blobs.keys().collect::<Vec<_>>(),
            vec![&source_digest]
        );
    }

    #[test]
    fn rejects_a_corrupted_snapshot_copy() {
        let root = tempfile::tempdir().unwrap();
        let (snapshot, artifacts, _) = fixture(root.path(), 3);
        let store = SnapshotStore::new(root.path().join("cache"));
        let (record, lease) = store
            .import(SnapshotImport {
                project_key: "project",
                session_id: "session",
                generation: 3,
                environment_digest: "sha256:environment",
                snapshot_path: &snapshot,
                artifact_root: &artifacts,
                sources: &BTreeMap::new(),
            })
            .unwrap();
        drop(lease);
        fs::write(record.artifact_root.join("evaluation-snapshot.json"), b"{}").unwrap();
        assert!(matches!(
            store.restore("project"),
            Err(CacheError::SnapshotMismatch(_))
        ));
    }

    #[test]
    fn corrupted_snapshot_self_heals_on_the_next_restore() {
        let root = tempfile::tempdir().unwrap();
        let (snapshot, artifacts, _) = fixture(root.path(), 3);
        let cache_root = root.path().join("cache");
        let store = SnapshotStore::new(&cache_root);
        let (record, lease) = store
            .import(SnapshotImport {
                project_key: "project",
                session_id: "session",
                generation: 3,
                environment_digest: "sha256:environment",
                snapshot_path: &snapshot,
                artifact_root: &artifacts,
                sources: &BTreeMap::new(),
            })
            .unwrap();
        drop(lease);
        fs::write(record.artifact_root.join("evaluation-snapshot.json"), b"{}").unwrap();
        assert!(matches!(
            store.restore("project"),
            Err(CacheError::SnapshotMismatch(_))
        ));
        // The corrupt pointer and snapshot directory were quarantined, not
        // left in place to fail the same way forever.
        assert!(!record.artifact_root.exists());
        assert!(!cache_root.join("projects/project.json").exists());
        assert!(
            fs::read_dir(cache_root.join("quarantine/projects"))
                .unwrap()
                .count()
                > 0
        );
        assert!(
            fs::read_dir(cache_root.join("quarantine/snapshots"))
                .unwrap()
                .count()
                > 0
        );
        // A subsequent restore cleanly finds no pointer at all, instead of
        // repeating the same corruption error on every future launch.
        assert!(store.restore("project").unwrap().is_none());
    }

    #[test]
    fn corrupted_pointer_file_self_heals_on_the_next_restore() {
        let root = tempfile::tempdir().unwrap();
        let cache_root = root.path().join("cache");
        let store = SnapshotStore::new(&cache_root);
        let pointer_path = cache_root.join("projects/project.json");
        fs::create_dir_all(pointer_path.parent().unwrap()).unwrap();
        fs::write(&pointer_path, b"not json").unwrap();
        assert!(matches!(store.restore("project"), Err(CacheError::Json(_))));
        assert!(!pointer_path.exists());
        assert!(store.restore("project").unwrap().is_none());
    }

    #[test]
    fn last_valid_objects_are_protected_from_eviction() {
        let root = tempfile::tempdir().unwrap();
        let (snapshot, artifacts, mesh_digest) = fixture(root.path(), 1);
        let store = SnapshotStore::new(root.path().join("cache"));
        let (_, lease) = store
            .import(SnapshotImport {
                project_key: "project",
                session_id: "session",
                generation: 1,
                environment_digest: "sha256:environment",
                snapshot_path: &snapshot,
                artifact_root: &artifacts,
                sources: &BTreeMap::new(),
            })
            .unwrap();
        drop(lease);
        let disposable = store.objects.put(b"discard me").unwrap();
        assert!(store.evict_to_limit(0).unwrap() > 0);
        assert!(store.objects.path(&mesh_digest).unwrap().is_file());
        assert!(!store.objects.path(&disposable).unwrap().is_file());
    }

    #[test]
    fn import_promote_step_blocks_behind_a_lock_held_by_another_handle() {
        let root = tempfile::tempdir().unwrap();
        let (snapshot, artifacts, _) = fixture(root.path(), 5);
        let store = SnapshotStore::new(root.path().join("cache"));

        // A separate `File` handle on the same lock path stands in for
        // another OS process sharing this cache root — `flock`/`LockFileEx`
        // exclude by open file description, not by process, so this
        // exercises the same mutual exclusion a second process would hit.
        let other_process_lock = store.lock_store().unwrap();

        let importing_store = store.clone();
        let handle = std::thread::spawn(move || {
            importing_store.import(SnapshotImport {
                project_key: "project",
                session_id: "session",
                generation: 5,
                environment_digest: "sha256:environment",
                snapshot_path: &snapshot,
                artifact_root: &artifacts,
                sources: &BTreeMap::new(),
            })
        });

        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(
            !handle.is_finished(),
            "import should block on the promote step while another handle holds the lock"
        );

        drop(other_process_lock);
        let (record, _lease) = handle
            .join()
            .expect("import thread should not panic")
            .unwrap();
        assert_eq!(record.snapshot.evaluation().generation, 5);
    }

    #[test]
    fn failed_import_removes_staging_directory() {
        let root = tempfile::tempdir().unwrap();
        let (snapshot, artifacts, _) = fixture(root.path(), 9);
        fs::write(artifacts.join("meshes/part.mwm"), b"corrupt").unwrap();
        let cache_root = root.path().join("cache");
        let store = SnapshotStore::new(&cache_root);
        assert!(matches!(
            store.import(SnapshotImport {
                project_key: "project",
                session_id: "session",
                generation: 9,
                environment_digest: "sha256:environment",
                snapshot_path: &snapshot,
                artifact_root: &artifacts,
                sources: &BTreeMap::new(),
            }),
            Err(CacheError::ArtifactMismatch(_))
        ));
        let staged = fs::read_dir(cache_root.join("snapshots"))
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().starts_with('.'))
            .count();
        assert_eq!(staged, 0);
    }
}
