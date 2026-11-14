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

  /// Copies `source` to `destination`, replacing any existing file (callers
  /// obtain `destination` from a save panel, which has already confirmed the
  /// replacement). Goes through a temp file so a failed copy never leaves a
  /// truncated export behind.
  @objc(copyFile:destination:resolver:rejecter:)
  func copyFile(
    _ source: String,
    destination: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let sourceURL = URL(fileURLWithPath: source)
    let targetURL = URL(fileURLWithPath: destination)
    let directory = targetURL.deletingLastPathComponent()
    do {
      guard FileManager.default.fileExists(atPath: sourceURL.path) else {
        reject("copy_failed", "Source file does not exist: \(source)", nil)
        return
      }
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let tempURL = directory.appendingPathComponent(".\(targetURL.lastPathComponent).tmp-\(UUID().uuidString)")
      defer { try? FileManager.default.removeItem(at: tempURL) }
      try FileManager.default.copyItem(at: sourceURL, to: tempURL)
      if FileManager.default.fileExists(atPath: targetURL.path) {
        _ = try FileManager.default.replaceItemAt(targetURL, withItemAt: tempURL)
      } else {
        try FileManager.default.moveItem(at: tempURL, to: targetURL)
      }
      resolve(nil)
    } catch {
      reject("copy_failed", "Failed to copy \(source) to \(destination): \(error.localizedDescription)", error)
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

  /// Every regular file under `root` as root-relative POSIX paths, skipping
  /// any directory whose *name* is in `ignoredNames` (e.g. `.git`, `.venv`,
  /// `node_modules`). Backs quick-open (Cmd+P); capped at `limit` entries so
  /// a pathological tree cannot stall the bridge.
  @objc(listFilesRecursive:ignoredNames:limit:resolver:rejecter:)
  func listFilesRecursive(
    _ root: String,
    ignoredNames: [String],
    limit: NSNumber,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let maxCount = limit.intValue
    DispatchQueue.global(qos: .userInitiated).async {
      var paths: [String] = []
      MachinewrightAssetsModule.walkFiles(root: root, ignoredNames: Set(ignoredNames)) { relativePath, _ in
        paths.append(relativePath)
        return paths.count < maxCount
      }
      resolve(paths)
    }
  }

  /// Plain-text search across the project (Cmd+Shift+F). Skips ignored
  /// directories, files over 1 MB, and anything that looks binary (a NUL in
  /// the first 8 KB). `column`/`length` are UTF-16 offsets within the line.
  @objc(searchInFiles:query:caseSensitive:ignoredNames:maxResults:resolver:rejecter:)
  func searchInFiles(
    _ root: String,
    query: String,
    caseSensitive: Bool,
    ignoredNames: [String],
    maxResults: NSNumber,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let maxCount = maxResults.intValue
    DispatchQueue.global(qos: .userInitiated).async {
      var results: [[String: Any]] = []
      if query.isEmpty { resolve(results); return }
      let options: String.CompareOptions = caseSensitive ? [] : [.caseInsensitive]
      MachinewrightAssetsModule.walkFiles(root: root, ignoredNames: Set(ignoredNames)) { relativePath, url in
        guard let values = try? url.resourceValues(forKeys: [.fileSizeKey]),
              (values.fileSize ?? 0) <= 1_000_000,
              let data = try? Data(contentsOf: url, options: .mappedIfSafe),
              !data.prefix(8000).contains(0),
              let text = String(data: data, encoding: .utf8)
        else { return true }
        var lineNumber = 0
        var keepGoing = true
        text.enumerateLines { line, stop in
          lineNumber += 1
          var searchRange = line.startIndex..<line.endIndex
          var perLine = 0
          while perLine < 5, let found = line.range(of: query, options: options, range: searchRange) {
            let column = line.utf16.distance(from: line.utf16.startIndex, to: found.lowerBound)
            let length = line.utf16.distance(from: found.lowerBound, to: found.upperBound)
            let trimmed = line.count > 240 ? String(line.prefix(240)) : line
            results.append([
              "path": relativePath, "line": lineNumber, "column": column, "length": length, "text": trimmed,
            ])
            perLine += 1
            if results.count >= maxCount { keepGoing = false; stop = true; return }
            searchRange = found.upperBound..<line.endIndex
          }
        }
        return keepGoing
      }
      resolve(results)
    }
  }

  /// Depth-first walk calling `visit(relativePath, url)` per regular file
  /// until it returns false. Resolves symlinks in `root` once so relative
  /// paths are well defined.
  private static func walkFiles(
    root: String,
    ignoredNames: Set<String>,
    visit: (String, URL) -> Bool
  ) {
    let rootURL = URL(fileURLWithPath: root).resolvingSymlinksInPath()
    let prefix = rootURL.path.hasSuffix("/") ? rootURL.path : rootURL.path + "/"
    guard let enumerator = FileManager.default.enumerator(
      at: rootURL,
      includingPropertiesForKeys: [.isDirectoryKey, .isRegularFileKey],
      options: []
    ) else { return }
    for case let url as URL in enumerator {
      guard let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey]) else { continue }
      if values.isDirectory == true {
        if ignoredNames.contains(url.lastPathComponent) { enumerator.skipDescendants() }
        continue
      }
      guard values.isRegularFile == true, url.path.hasPrefix(prefix) else { continue }
      if !visit(String(url.path.dropFirst(prefix.count)), url) { return }
    }
  }

  private static func sha256Hex(data: Data) -> String {
    "sha256:" + SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
}
