use std::path::PathBuf;

use machinewright_app::{AppCommand, EvaluationPort, ProjectSession};
use machinewright_evaluator::WorkerProcess;
use machinewright_render::Scene;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let source_path = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .ok_or("usage: authoring_smoke <source path> <worker executable>")?,
    )
    .canonicalize()?;
    let worker_path = std::env::args_os()
        .nth(2)
        .ok_or("usage: authoring_smoke <source path> <worker executable>")?;
    let project_root = machinewright_app::PortableProject::discover(&source_path)?.root;
    let mut session = ProjectSession::open(project_root)?;
    session.dispatch(AppCommand::OpenDocument(source_path.clone()))?;
    let output = std::env::temp_dir().join("machinewright-authoring-smoke");
    session.begin_evaluation();
    let request = session.evaluation_request(output.clone())?;
    let mut worker = WorkerProcess::spawn(worker_path, std::iter::empty::<&str>())?;
    let capabilities = worker.connect()?;
    let snapshot = worker.evaluate(&request)?;
    session.dispatch(AppCommand::InstallSnapshot(snapshot.clone()))?;
    let scene = Scene::load(&snapshot, &output)?;
    println!(
        "project={} protocol={} generation={} nodes={} meshes={} graph={}",
        session.project.project_id,
        capabilities.protocol_version,
        snapshot.evaluation().generation,
        snapshot
            .evaluation()
            .graph
            .get("nodes")
            .and_then(|nodes| nodes.as_array())
            .map_or(0, Vec::len),
        scene.meshes.len(),
        snapshot.evaluation().graph_digest,
    );
    worker.shutdown()?;
    Ok(())
}
