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
