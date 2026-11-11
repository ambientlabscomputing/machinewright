import Foundation
import React

/// Native macOS service for a Python language server (RFD-19 "Editor
/// architecture": a bundled Python LSP server, spawned the same way the
/// worker is spawned — see MachinewrightWorkerModule, which this module
/// deliberately mirrors). The framing differs: LSP's base protocol uses
/// textual `Content-Length: N\r\n\r\n<utf-8 json>` headers, not
/// Machinewright's binary 4-byte length-prefixed protobuf frames — this is
/// LSP's own wire format, unrelated to and unchanged by anything in this
/// project.
///
/// The LSP client's *policy* (initialize handshake, textDocument
/// lifecycle, mapping diagnostics through the offset conversions in
/// src/editor/offsets.ts) lives in TypeScript (src/editor/LspClient.ts,
/// per RFD-19's ownership table: "LSP client behavior" is TypeScript-
/// application-owned) — this module only owns the subprocess and its
/// framing, exactly like the worker module owns the worker subprocess.
@objc(MachinewrightLspModule)
class MachinewrightLspModule: RCTEventEmitter {
  private var process: Process?
  private var stdinPipe: Pipe?
  private var stdoutPipe: Pipe?
  private var stdoutBuffer = Data()
  private var hasListeners = false

  override static func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String] {
    return ["MachinewrightLspMessage", "MachinewrightLspExit"]
  }

  override func startObserving() { hasListeners = true }
  override func stopObserving() { hasListeners = false }

  @objc(spawn:args:resolver:rejecter:)
  func spawn(
    _ executablePath: String,
    args: [String],
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    if process != nil {
      reject("lsp_already_running", "A language server process is already running", nil)
      return
    }

    let task = Process()
    task.executableURL = URL(fileURLWithPath: executablePath)
    task.arguments = args

    let stdin = Pipe()
    let stdout = Pipe()
    task.standardInput = stdin
    task.standardOutput = stdout
    task.standardError = FileHandle.standardError

    task.terminationHandler = { [weak self] finishedTask in
      guard let self, self.process === finishedTask else { return }
      self.stdoutPipe?.fileHandleForReading.readabilityHandler = nil
      self.process = nil
      self.stdinPipe = nil
      self.stdoutPipe = nil
      self.stdoutBuffer.removeAll()
      if self.hasListeners {
        self.sendEvent(
          withName: "MachinewrightLspExit",
          body: ["exitCode": finishedTask.terminationStatus]
        )
      }
    }

    stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let chunk = handle.availableData
      guard let self, !chunk.isEmpty else { return }
      self.consumeStdout(chunk)
    }

    do {
      try task.run()
    } catch {
      reject("spawn_failed", "Failed to launch language server: \(error.localizedDescription)", error)
      return
    }

    self.process = task
    self.stdinPipe = stdin
    self.stdoutPipe = stdout
    resolve(nil)
  }

  /// Parses LSP base-protocol framing: `Content-Length: N\r\n\r\n` followed
  /// by exactly N UTF-8 bytes of JSON. Emits every complete message found
  /// so far; leaves a partial trailing message buffered for the next chunk.
  private func consumeStdout(_ chunk: Data) {
    stdoutBuffer.append(chunk)
    let headerTerminator = Data("\r\n\r\n".utf8)

    while true {
      guard let headerEnd = stdoutBuffer.range(of: headerTerminator) else { break }
      let headerData = stdoutBuffer.subdata(in: 0..<headerEnd.lowerBound)
      guard let headerText = String(data: headerData, encoding: .utf8) else {
        // Unparseable header — drop the buffer rather than spin forever.
        stdoutBuffer.removeAll()
        return
      }
      guard let contentLength = Self.parseContentLength(headerText) else {
        stdoutBuffer.removeAll()
        return
      }

      let bodyStart = headerEnd.upperBound
      let bodyEnd = bodyStart + contentLength
      if stdoutBuffer.count < bodyEnd { break } // full message not received yet

      let body = stdoutBuffer.subdata(in: bodyStart..<bodyEnd)
      stdoutBuffer.removeSubrange(0..<bodyEnd)

      if hasListeners, let json = String(data: body, encoding: .utf8) {
        sendEvent(withName: "MachinewrightLspMessage", body: ["json": json])
      }
    }
  }

  private static func parseContentLength(_ header: String) -> Int? {
    for line in header.split(separator: "\r\n") {
      let parts = line.split(separator: ":", maxSplits: 1)
      guard parts.count == 2, parts[0].trimmingCharacters(in: .whitespaces) == "Content-Length" else {
        continue
      }
      return Int(parts[1].trimmingCharacters(in: .whitespaces))
    }
    return nil
  }

  @objc(send:resolver:rejecter:)
  func send(
    _ json: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let stdin = stdinPipe else {
      reject("lsp_not_running", "No language server process is running", nil)
      return
    }
    let body = Data(json.utf8)
    let header = "Content-Length: \(body.count)\r\n\r\n"
    var frame = Data(header.utf8)
    frame.append(body)
    do {
      try stdin.fileHandleForWriting.write(contentsOf: frame)
      resolve(nil)
    } catch {
      reject("lsp_write_failed", error.localizedDescription, error)
    }
  }

  @objc(stop:rejecter:)
  func stop(
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let task = process else {
      resolve(nil)
      return
    }
    stdoutPipe?.fileHandleForReading.readabilityHandler = nil
    process = nil
    stdinPipe = nil
    stdoutPipe = nil
    stdoutBuffer.removeAll()
    task.terminate()
    resolve(nil)
  }
}
