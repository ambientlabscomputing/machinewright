import Foundation
import React
import CryptoKit

/// Resolves bundled WebView surface content (RFD-19 hard requirement #2:
/// "the app works offline without a development server") to a `file://`
/// URL the JS side can hand to react-native-webview's `source` prop.
///
/// This module also owns the B.4 "scoped artifact access" service
/// (RFD-19: "native services expose scoped local resource URLs to the
/// viewport, which loads binary buffers into three.js") — `meshFileURL`
/// below, which digest-validates a mesh file from the content-addressed
/// evaluation-output cache before handing back a `file://` URL. Together
/// these cover the "native macOS services" layer's filesystem
/// responsibility (RFD-19 "Target process architecture": "asynchronous
/// file access ... and cache I/O") for the two kinds of local content the
/// WebView surfaces load: bundled app resources (`bundledAssetURL`) and
/// runtime evaluation artifacts (`meshFileURL`).
@objc(MachinewrightAssetsModule)
class MachinewrightAssetsModule: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc(bundledAssetURL:resolver:rejecter:)
  func bundledAssetURL(
    _ relativePath: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let resourceURL = Bundle.main.resourceURL else {
      reject("no_bundle_resources", "Main bundle has no resource URL", nil)
      return
    }
    let url = resourceURL.appendingPathComponent(relativePath).standardizedFileURL
    guard url.path.hasPrefix(resourceURL.standardizedFileURL.path) else {
      reject("path_escapes_bundle", "relativePath escapes the app bundle: \(relativePath)", nil)
      return
    }
    resolve(url.absoluteString)
  }

  /// Reads an arbitrary project file's text content — distinct from
  /// `bundledAssetURL` above (bundle-scoped, read-only app resources):
  /// this reads real project source from wherever the open project lives
  /// on disk, unrestricted for this spike. RFD-19's security section
  /// ("the application must make this explicit when opening code from an
  /// untrusted source") is a real, unaddressed gap here — a production
  /// workspace/ module needs an explicit trust boundary before this
  /// method (or its future write counterpart) is exposed beyond a spike.
  @objc(readTextFile:resolver:rejecter:)
  func readTextFile(
    _ path: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    do {
      let content = try String(contentsOfFile: path, encoding: .utf8)
      resolve(content)
    } catch {
      reject("read_failed", "Failed to read \(path): \(error.localizedDescription)", error)
    }
  }

  /// Resolves a mesh artifact to a `file://` URL only after verifying its
  /// SHA-256 content digest matches `MeshReference.digest` from the
  /// evaluation snapshot — the concrete "digest-validated scoped access"
  /// for the content-addressed cache (RFD-19 failure behavior: "Artifact
  /// corruption: reject digest mismatches and regenerate from source").
  /// `expectedDigest` is the snapshot's own `"sha256:<hex>"` string.
  @objc(meshFileURL:expectedDigest:resolver:rejecter:)
  func meshFileURL(
    _ path: String,
    expectedDigest: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let data = FileManager.default.contents(atPath: path) else {
      reject("read_failed", "Failed to read mesh file: \(path)", nil)
      return
    }
    let actualDigest = MachinewrightAssetsModule.sha256Hex(data: data)
    guard actualDigest == expectedDigest else {
      reject(
        "digest_mismatch",
        "Mesh file \(path) digest \(actualDigest) does not match expected \(expectedDigest)",
        nil
      )
      return
    }
    resolve(URL(fileURLWithPath: path).absoluteString)
  }

  /// The M2 `workspace/EnvironmentDigest.ts` `DigestPort`: computes a file's
  /// SHA-256 so `EvaluateProject.environment_digest` can actually be
  /// populated from `environment_lock`'s real content, using the same
  /// hashing this module already trusts for mesh validation above — one
  /// digest implementation in the app, not a second one reimplemented in JS.
  @objc(digestFile:resolver:rejecter:)
  func digestFile(
    _ path: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let data = FileManager.default.contents(atPath: path) else {
      reject("read_failed", "Failed to read file for digest: \(path)", nil)
      return
    }
    resolve(MachinewrightAssetsModule.sha256Hex(data: data))
  }

  /// The M2 `cache/AcceptedPointer.ts` `PersistedAcceptedPointerPort` write
  /// primitive: writes `contents` to a temp file beside `path` and then
  /// atomically replaces `path` with it (macOS's `replaceItemAt`, which is
  /// backed by `rename(2)` on APFS/HFS+), so a reader of `path` can never
  /// observe a half-written "last accepted" pointer file, including across
  /// an app crash mid-write.
  @objc(writeTextFileAtomically:contents:resolver:rejecter:)
  func writeTextFileAtomically(
    _ path: String,
    contents: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let targetURL = URL(fileURLWithPath: path)
    let directory = targetURL.deletingLastPathComponent()
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let tempURL = directory.appendingPathComponent(".\(targetURL.lastPathComponent).tmp-\(UUID().uuidString)")
      defer { try? FileManager.default.removeItem(at: tempURL) }
      try contents.write(to: tempURL, atomically: false, encoding: .utf8)
      if FileManager.default.fileExists(atPath: targetURL.path) {
        _ = try FileManager.default.replaceItemAt(targetURL, withItemAt: tempURL)
      } else {
        try FileManager.default.moveItem(at: tempURL, to: targetURL)
      }
      resolve(nil)
    } catch {
      reject("write_failed", "Failed to atomically write \(path): \(error.localizedDescription)", error)
    }
  }

  /// A single-level directory listing — the primitive `app/FileExplorer.tsx`
  /// (M2 workspace shell) needs for a VS Code-style lazily-expanding file
  /// tree. Deliberately non-recursive: the caller lists a directory only
  /// when the user expands it, rather than this module walking the whole
  /// project tree upfront. Directories sort before files; both sort
  /// case-insensitively, matching ordinary Finder/VS Code conventions.
  @objc(listDirectory:resolver:rejecter:)
  func listDirectory(
    _ path: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let url = URL(fileURLWithPath: path)
    do {
      let entryURLs = try FileManager.default.contentsOfDirectory(
        at: url,
        includingPropertiesForKeys: [.isDirectoryKey],
        options: []
      )
      let entries: [[String: Any]] = entryURLs.compactMap { entryURL in
        guard let isDirectory = try? entryURL.resourceValues(forKeys: [.isDirectoryKey]).isDirectory else {
          return nil
        }
        return ["name": entryURL.lastPathComponent, "isDirectory": isDirectory, "path": entryURL.path]
      }
      let sorted = entries.sorted { lhs, rhs in
        let lhsIsDirectory = (lhs["isDirectory"] as? Bool) ?? false
        let rhsIsDirectory = (rhs["isDirectory"] as? Bool) ?? false
        if lhsIsDirectory != rhsIsDirectory { return lhsIsDirectory }
        let lhsName = (lhs["name"] as? String) ?? ""
        let rhsName = (rhs["name"] as? String) ?? ""
        return lhsName.localizedStandardCompare(rhsName) == .orderedAscending
      }
      resolve(sorted)
    } catch {
      reject("list_failed", "Failed to list directory \(path): \(error.localizedDescription)", error)
    }
  }

  private static func sha256Hex(data: Data) -> String {
    "sha256:" + SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
}
