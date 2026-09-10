use std::path::PathBuf;

use machinewright_app::LanguagePort;
use machinewright_language::TyLanguageServer;

fn main() {
    let root = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .expect("usage: language_smoke PROJECT_ROOT SOURCE_FILE"),
    );
    let path = PathBuf::from(
        std::env::args_os()
            .nth(2)
            .expect("usage: language_smoke PROJECT_ROOT SOURCE_FILE"),
    );
    let executable = std::env::var_os("MACHINEWRIGHT_TY").unwrap_or_else(|| "ty".into());
    let mut server = TyLanguageServer::spawn(executable, &root).expect("start ty server");
    let diagnostics = server
        .diagnostics(&path, "def incomplete(\n")
        .expect("request diagnostics");
    assert!(!diagnostics.is_empty(), "ty returned no syntax diagnostics");
    println!(
        "diagnostics={} first={}",
        diagnostics.len(),
        diagnostics[0].message.replace('\n', " ")
    );
}
