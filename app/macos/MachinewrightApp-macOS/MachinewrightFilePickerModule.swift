import Foundation
import React
import AppKit

/// Native "Open Project" directory picker (RFD-19 M2: `workspace/Project.ts`'s
/// `openProject` needs a real entry point instead of every spike's hardcoded
/// `REPO_ROOT` constant). `MachinewrightApp.entitlements` already grants
/// `com.apple.security.files.user-selected.read-only`, matching this
/// module's use of `NSOpenPanel` (App Sandbox is off for this app overall —
/// see the entitlements file's comment — but a user-driven open panel is the
/// right UX regardless of sandboxing).
@objc(MachinewrightFilePickerModule)
class MachinewrightFilePickerModule: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { false }

  /// Resolves to the chosen directory's absolute path, or `null` if the user
  /// cancelled. `NSOpenPanel` must run on the main thread — this method
  /// dispatches onto it explicitly rather than declaring
  /// `requiresMainQueueSetup`, which would serialize every call to this
  /// module (not just this one method) onto the main queue.
  @objc(pickProjectDirectory:rejecter:)
  func pickProjectDirectory(
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      let panel = NSOpenPanel()
      panel.canChooseDirectories = true
      panel.canChooseFiles = false
      panel.allowsMultipleSelection = false
      panel.prompt = "Open Project"
      panel.message = "Select a Machinewright project directory (containing machinewright.toml)"
      let response = panel.runModal()
      if response == .OK, let url = panel.url {
        resolve(url.path)
      } else {
        resolve(NSNull())
      }
    }
  }

  /// Opens a single project source file into the workspace (M2's
  /// `workspace/DocumentStore` needs a way to add a document beyond the one
  /// its worker/template evaluation already touches). `startDirectory` seeds
  /// the panel's initial location — typically the open project's root —
  /// rather than restricting selection to it; matching `NSOpenPanel`'s
  /// ordinary behavior elsewhere in the app (no server-enforced path
  /// containment, same as `readTextFile`'s existing unrestricted access).
  @objc(pickFile:resolver:rejecter:)
  func pickFile(
    _ startDirectory: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      let panel = NSOpenPanel()
      panel.canChooseDirectories = false
      panel.canChooseFiles = true
      panel.allowsMultipleSelection = false
      panel.directoryURL = URL(fileURLWithPath: startDirectory)
      panel.prompt = "Open File"
      let response = panel.runModal()
      if response == .OK, let url = panel.url {
        resolve(url.path)
      } else {
        resolve(NSNull())
      }
    }
  }

  /// Folder chooser for exports: unlike `pickProjectDirectory` it can create a
  /// new folder and is labelled for the export being made.
  @objc(pickDirectory:message:startDirectory:resolver:rejecter:)
  func pickDirectory(
    _ prompt: String,
    message: String,
    startDirectory: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      let panel = NSOpenPanel()
      panel.canChooseDirectories = true
      panel.canChooseFiles = false
      panel.canCreateDirectories = true
      panel.allowsMultipleSelection = false
      panel.prompt = prompt
      panel.message = message
      if !startDirectory.isEmpty {
        panel.directoryURL = URL(fileURLWithPath: startDirectory)
      }
      if panel.runModal() == .OK, let url = panel.url {
        resolve(url.path)
      } else {
        resolve(NSNull())
      }
    }
  }

  /// Save panel for a single exported file. The panel itself asks before
  /// replacing an existing file, so callers may overwrite what it returns.
  @objc(pickSaveFile:startDirectory:resolver:rejecter:)
  func pickSaveFile(
    _ suggestedName: String,
    startDirectory: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      let panel = NSSavePanel()
      panel.canCreateDirectories = true
      panel.nameFieldStringValue = suggestedName
      panel.prompt = "Export"
      if !startDirectory.isEmpty {
        panel.directoryURL = URL(fileURLWithPath: startDirectory)
      }
      if panel.runModal() == .OK, let url = panel.url {
        resolve(url.path)
      } else {
        resolve(NSNull())
      }
    }
  }

  /// Selects `path` in a Finder window.
  @objc(revealInFinder:resolver:rejecter:)
  func revealInFinder(
    _ path: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
      resolve(nil)
    }
  }
}
