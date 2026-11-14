/**
 * TS wrapper around `MachinewrightFilePickerModule` (native macOS module) —
 * the real "Open Project" entry point `workspace/OpenProjectFlow.ts` uses,
 * replacing every spike's hardcoded `REPO_ROOT` constant (RFD-19 M2:
 * "project/workspace shell").
 */
import { NativeModules } from "react-native";

interface MachinewrightFilePickerNativeModule {
  pickProjectDirectory(): Promise<string | null>;
  pickFile(startDirectory: string): Promise<string | null>;
  pickDirectory(prompt: string, message: string, startDirectory: string): Promise<string | null>;
  pickSaveFile(suggestedName: string, startDirectory: string): Promise<string | null>;
  revealInFinder(path: string): Promise<void>;
}

function nativeModule(): MachinewrightFilePickerNativeModule {
  const native = NativeModules.MachinewrightFilePickerModule as
    | MachinewrightFilePickerNativeModule
    | undefined;
  if (!native) {
    throw new Error(
      "MachinewrightFilePickerModule native module is not linked — check macos/ target membership",
    );
  }
  return native;
}

/** Resolves to the chosen directory's absolute path, or `null` if the user cancelled. */
export function pickProjectDirectory(): Promise<string | null> {
  return nativeModule().pickProjectDirectory();
}

/** Resolves to the chosen file's absolute path, or `null` if the user cancelled. `startDirectory` seeds the panel's initial location. */
export function pickFile(startDirectory: string): Promise<string | null> {
  return nativeModule().pickFile(startDirectory);
}

/** Folder chooser for exports (can create a new folder). `null` if the user cancelled. */
export function pickDirectory(prompt: string, message: string, startDirectory = ""): Promise<string | null> {
  return nativeModule().pickDirectory(prompt, message, startDirectory);
}

/** Save panel for one exported file; it confirms replacement itself. `null` if the user cancelled. */
export function pickSaveFile(suggestedName: string, startDirectory = ""): Promise<string | null> {
  return nativeModule().pickSaveFile(suggestedName, startDirectory);
}

/** Selects `path` in a Finder window. */
export function revealInFinder(path: string): Promise<void> {
  return nativeModule().revealInFinder(path);
}
