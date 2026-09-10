use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
};

use machinewright_app::{EditorDiagnostic, LanguageCapabilities, LanguagePort, PortError};
use serde_json::{Value, json};
use url::Url;

const MAX_LSP_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

pub struct TyLanguageServer {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    versions: HashMap<PathBuf, i64>,
    next_id: u64,
    capabilities: LanguageCapabilities,
}

impl TyLanguageServer {
    pub fn spawn(executable: impl AsRef<std::ffi::OsStr>, root: &Path) -> Result<Self, PortError> {
        let root = root.canonicalize().map_err(|error| {
            PortError::new(format!(
                "cannot resolve project root {}: {error}",
                root.display()
            ))
        })?;
        let executable = PathBuf::from(executable.as_ref());
        let executable = if executable.is_relative() && executable.components().count() > 1 {
            executable.canonicalize().map_err(|error| {
                PortError::new(format!(
                    "cannot resolve ty executable {}: {error}",
                    executable.display()
                ))
            })?
        } else {
            executable
        };
        let mut child = Command::new(executable)
            .arg("server")
            .current_dir(&root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| PortError::new(format!("failed to launch ty server: {error}")))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| PortError::new("ty server stdin is unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| PortError::new("ty server stdout is unavailable"))?;
        let mut server = Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            versions: HashMap::new(),
            next_id: 1,
            capabilities: LanguageCapabilities::default(),
        };
        let root_uri = file_uri(&root)?;
        let id = server.request(
            "initialize",
            json!({
                "processId": std::process::id(),
                "rootUri": root_uri,
                "workspaceFolders": [{ "uri": root_uri, "name": "machinewright" }],
                "capabilities": {
                    "textDocument": {
                        "publishDiagnostics": {
                            "relatedInformation": true,
                            "versionSupport": true
                        },
                        "completion": {},
                        "hover": {},
                        "definition": {},
                        "references": {},
                        "documentSymbol": {},
                        "codeAction": {}
                    },
                    "workspace": {
                        "configuration": true,
                        "didChangeWatchedFiles": { "dynamicRegistration": true }
                    }
                },
                "clientInfo": { "name": "machinewright", "version": env!("CARGO_PKG_VERSION") }
            }),
        )?;
        let initialize = server.wait_for_response(id)?;
        server.capabilities = parse_capabilities(&initialize["capabilities"]);
        server.notify("initialized", json!({}))?;
        Ok(server)
    }

    fn write_message(&mut self, message: &Value) -> Result<(), PortError> {
        let body =
            serde_json::to_vec(message).map_err(|error| PortError::new(error.to_string()))?;
        write!(self.stdin, "Content-Length: {}\r\n\r\n", body.len())
            .and_then(|_| self.stdin.write_all(&body))
            .and_then(|_| self.stdin.flush())
            .map_err(|error| PortError::new(format!("failed writing to ty server: {error}")))
    }

    fn request(&mut self, method: &str, params: Value) -> Result<u64, PortError> {
        let id = self.next_id;
        self.next_id += 1;
        self.write_message(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))?;
        Ok(id)
    }

    fn notify(&mut self, method: &str, params: Value) -> Result<(), PortError> {
        self.write_message(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
    }

    fn read_message(&mut self) -> Result<Value, PortError> {
        let mut content_length = None;
        loop {
            let mut header = String::new();
            let read = self
                .stdout
                .read_line(&mut header)
                .map_err(|error| PortError::new(format!("failed reading ty server: {error}")))?;
            if read == 0 {
                return Err(PortError::new("ty server closed its output"));
            }
            if header == "\r\n" || header == "\n" {
                break;
            }
            if let Some(value) = header.strip_prefix("Content-Length:") {
                content_length = Some(
                    value
                        .trim()
                        .parse::<usize>()
                        .map_err(|error| PortError::new(format!("invalid LSP header: {error}")))?,
                );
            }
        }
        let length = content_length.ok_or_else(|| PortError::new("missing LSP content length"))?;
        if length > MAX_LSP_MESSAGE_BYTES {
            return Err(PortError::new(format!(
                "ty server message exceeds the {} byte limit",
                MAX_LSP_MESSAGE_BYTES
            )));
        }
        let mut body = vec![0; length];
        self.stdout
            .read_exact(&mut body)
            .map_err(|error| PortError::new(format!("failed reading ty response: {error}")))?;
        serde_json::from_slice(&body).map_err(|error| PortError::new(error.to_string()))
    }

    fn wait_for_response(&mut self, id: u64) -> Result<Value, PortError> {
        loop {
            let message = self.read_message()?;
            self.answer_server_request(&message)?;
            if message.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(error) = message.get("error") {
                    return Err(PortError::new(format!("ty server error: {error}")));
                }
                return Ok(message.get("result").cloned().unwrap_or(Value::Null));
            }
        }
    }

    fn answer_server_request(&mut self, message: &Value) -> Result<(), PortError> {
        let Some(id) = message.get("id") else {
            return Ok(());
        };
        if message.get("method").is_none() {
            return Ok(());
        }
        let result = match message.get("method").and_then(Value::as_str) {
            Some("workspace/configuration") => {
                let count = message["params"]["items"].as_array().map_or(0, Vec::len);
                Value::Array(vec![Value::Null; count])
            }
            _ => Value::Null,
        };
        self.write_message(&json!({"jsonrpc": "2.0", "id": id, "result": result}))
    }
}

impl LanguagePort for TyLanguageServer {
    fn capabilities(&self) -> LanguageCapabilities {
        self.capabilities
    }

    fn diagnostics(
        &mut self,
        path: &Path,
        source: &str,
    ) -> Result<Vec<EditorDiagnostic>, PortError> {
        let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        let uri = file_uri(&path)?;
        let version = self.versions.entry(path.clone()).or_insert(0);
        *version += 1;
        let version = *version;
        if version == 1 {
            self.notify(
                "textDocument/didOpen",
                json!({
                    "textDocument": {
                        "uri": uri,
                        "languageId": "python",
                        "version": version,
                        "text": source,
                    }
                }),
            )?;
        } else {
            self.notify(
                "textDocument/didChange",
                json!({
                    "textDocument": { "uri": uri, "version": version },
                    "contentChanges": [{ "text": source }],
                }),
            )?;
        }

        loop {
            let message = self.read_message()?;
            self.answer_server_request(&message)?;
            if message.get("method").and_then(Value::as_str)
                != Some("textDocument/publishDiagnostics")
            {
                continue;
            }
            let params = &message["params"];
            if params.get("uri").and_then(Value::as_str) != Some(uri.as_str()) {
                continue;
            }
            if params
                .get("version")
                .and_then(Value::as_i64)
                .is_some_and(|v| v != version)
            {
                continue;
            }
            return Ok(parse_diagnostics(params, source));
        }
    }

    fn did_save(&mut self, path: &Path) -> Result<(), PortError> {
        self.notify(
            "textDocument/didSave",
            json!({"textDocument": {"uri": file_uri(path)?}}),
        )
    }

    fn did_close(&mut self, path: &Path) -> Result<(), PortError> {
        self.versions.remove(path);
        self.notify(
            "textDocument/didClose",
            json!({"textDocument": {"uri": file_uri(path)?}}),
        )
    }

    fn watched_files(&mut self, paths: &[PathBuf]) -> Result<(), PortError> {
        self.notify(
            "workspace/didChangeWatchedFiles",
            json!({
                "changes": paths.iter().filter_map(|path| file_uri(path).ok()).map(|uri| {
                    json!({"uri": uri, "type": 2})
                }).collect::<Vec<_>>()
            }),
        )
    }
}

impl Drop for TyLanguageServer {
    fn drop(&mut self) {
        let shutdown = self.request("shutdown", Value::Null);
        if let Ok(id) = shutdown {
            let _ = self.wait_for_response(id);
        }
        let _ = self.notify("exit", Value::Null);
        let _ = self.child.wait();
    }
}

fn file_uri(path: &Path) -> Result<String, PortError> {
    Url::from_file_path(path)
        .map(String::from)
        .map_err(|()| PortError::new(format!("cannot convert {} to a file URI", path.display())))
}

fn capability(value: &Value, name: &str) -> bool {
    value
        .get(name)
        .is_some_and(|item| !item.is_null() && item != false)
}

fn parse_capabilities(value: &Value) -> LanguageCapabilities {
    LanguageCapabilities {
        diagnostics: true,
        completion: capability(value, "completionProvider"),
        hover: capability(value, "hoverProvider"),
        definition: capability(value, "definitionProvider"),
        references: capability(value, "referencesProvider"),
        document_symbols: capability(value, "documentSymbolProvider"),
        code_actions: capability(value, "codeActionProvider"),
        watched_files: true,
    }
}

fn parse_diagnostics(params: &Value, source: &str) -> Vec<EditorDiagnostic> {
    params
        .get("diagnostics")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|diagnostic| {
            let range = diagnostic.get("range")?;
            let start = byte_offset(source, &range["start"])?;
            let end = byte_offset(source, &range["end"])?;
            Some(EditorDiagnostic {
                message: diagnostic.get("message")?.as_str()?.to_owned(),
                start_byte: start,
                end_byte: end,
            })
        })
        .collect()
}

fn byte_offset(source: &str, position: &Value) -> Option<usize> {
    let line = usize::try_from(position.get("line")?.as_u64()?).ok()?;
    let utf16_column = usize::try_from(position.get("character")?.as_u64()?).ok()?;
    let line_start = source
        .split_inclusive('\n')
        .take(line)
        .map(str::len)
        .sum::<usize>();
    let line_source = source.get(line_start..)?.split('\n').next()?;
    let mut units = 0;
    for (byte, ch) in line_source.char_indices() {
        if units >= utf16_column {
            return Some(line_start + byte);
        }
        units += ch.len_utf16();
    }
    (units == utf16_column).then_some(line_start + line_source.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_utf16_lsp_positions_to_utf8_bytes() {
        let source = "a😀b\nsecond";
        assert_eq!(
            byte_offset(source, &json!({"line": 0, "character": 3})),
            Some(5)
        );
        assert_eq!(
            byte_offset(source, &json!({"line": 1, "character": 3})),
            Some(10)
        );
    }

    #[test]
    fn parses_publish_diagnostics() {
        let diagnostics = parse_diagnostics(
            &json!({
                "diagnostics": [{
                    "message": "unknown name",
                    "range": {
                        "start": {"line": 0, "character": 0},
                        "end": {"line": 0, "character": 4}
                    }
                }]
            }),
            "name\n",
        );
        assert_eq!(diagnostics[0].message, "unknown name");
        assert_eq!((diagnostics[0].start_byte, diagnostics[0].end_byte), (0, 4));
    }
}
