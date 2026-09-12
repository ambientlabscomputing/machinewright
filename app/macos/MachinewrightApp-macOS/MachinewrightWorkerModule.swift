import Foundation
import React

/// Native macOS service (RFD-19 "Target process architecture" — native
/// services own "Python worker ... process startup, monitoring, and
/// termination" and "Local IPC transport ... to WebViews"; here: to the JS
/// evaluation coordinator).
///
/// Owns the `machinewright-worker` subprocess's stdio pipes directly and
/// exposes an async bridge for the length-delimited protobuf framing the
/// Python worker already speaks (`src/machinewright/worker.py`:
/// `read_request`/`EventWriter`, a 4-byte little-endian length prefix
/// followed by the serialized message) — no protocol change, just a second
/// (native) consumer of the same wire format already exercised by the
/// TS/Node contract test in app/tests/protocol.
///
/// Frame payloads cross the JS bridge base64-encoded: these are worker
/// protocol messages (small — capability reports, evaluation requests,
/// diagnostics), not mesh geometry, so base64's overhead is immaterial here.
/// This is a distinct concern from RFD-19's WebView-bridge guidance against
/// base64 meshes, which is about the (much larger) viewport surface.
@objc(MachinewrightWorkerModule)
class MachinewrightWorkerModule: RCTEventEmitter {
  private var process: Process?
  private var stdinPipe: Pipe?
  private var stdoutPipe: Pipe?
  private var stdoutBuffer = Data()
  private var hasListeners = false

  override static func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String] {
    return ["MachinewrightWorkerFrame", "MachinewrightWorkerExit"]
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
      reject("worker_already_running", "A worker process is already running", nil)
      return
    }

    let task = Process()
    task.executableURL = URL(fileURLWithPath: executablePath)
    task.arguments = args

    let stdin = Pipe()
    let stdout = Pipe()
    task.standardInput = stdin
    task.standardOutput = stdout
    // Inherit stderr to the parent's stderr (Xcode/console log) rather than
    // piping it — worker.py writes only diagnostic/log text there, never
    // protocol frames, and this keeps failures visible during the spike.
    task.standardError = FileHandle.standardError

    task.terminationHandler = { [weak self] finishedTask in
      guard let self else { return }
      self.stdoutPipe?.fileHandleForReading.readabilityHandler = nil
      self.process = nil
      self.stdinPipe = nil
      self.stdoutPipe = nil
      if self.hasListeners {
        self.sendEvent(
          withName: "MachinewrightWorkerExit",
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
      reject("spawn_failed", "Failed to launch worker: \(error.localizedDescription)", error)
      return
    }

    self.process = task
    self.stdinPipe = stdin
    self.stdoutPipe = stdout
    resolve(nil)
  }

  /// Appends newly read stdout bytes and emits every complete length-
  /// delimited frame found so far, mirroring app/src/protocol/worker/
  /// framing.ts's FrameDecoder exactly (4-byte little-endian length prefix).
  private func consumeStdout(_ chunk: Data) {
    stdoutBuffer.append(chunk)
    while stdoutBuffer.count >= 4 {
      let size = stdoutBuffer.withUnsafeBytes { raw -> UInt32 in
        raw.load(fromByteOffset: 0, as: UInt32.self).littleEndian
      }
      let total = 4 + Int(size)
      if stdoutBuffer.count < total { break }
      let payload = stdoutBuffer.subdata(in: 4..<total)
      stdoutBuffer.removeSubrange(0..<total)
      if hasListeners {
        sendEvent(
          withName: "MachinewrightWorkerFrame",
          body: ["base64Payload": payload.base64EncodedString()]
        )
      }
    }
  }

  @objc(send:resolver:rejecter:)
  func send(
    _ base64Payload: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let stdin = stdinPipe else {
      reject("worker_not_running", "No worker process is running", nil)
      return
    }
    guard let payload = Data(base64Encoded: base64Payload) else {
      reject("invalid_payload", "base64Payload did not decode", nil)
      return
    }
    var length = UInt32(payload.count).littleEndian
    var frame = Data(bytes: &length, count: 4)
    frame.append(payload)
    stdin.fileHandleForWriting.write(frame)
    resolve(nil)
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
    task.terminate()
    resolve(nil)
  }
}
