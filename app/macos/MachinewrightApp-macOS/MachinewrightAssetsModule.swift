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
    let actualDigest = "sha256:" + SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
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
}
