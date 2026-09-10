use std::env;

use machinewright_evaluator::WorkerProcess;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = env::args_os().skip(1);
    let executable = arguments
        .next()
        .ok_or("usage: worker_smoke <worker executable> [arguments...]")?;
    let mut worker = WorkerProcess::spawn(executable, arguments)?;
    let report = worker.negotiate(vec!["evaluation.v1".into()])?;
    println!(
        "protocol={} python={} capabilities={}",
        report.protocol_version,
        report.python_version,
        report.capabilities.join(",")
    );
    worker.shutdown()?;
    Ok(())
}
