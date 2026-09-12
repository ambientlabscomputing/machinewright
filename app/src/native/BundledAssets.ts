/**
 * TS wrapper around `MachinewrightAssetsModule` (native macOS module) —
 * resolves a bundled WebView surface's relative path to a `file://` URL,
 * so surfaces load from the app bundle instead of a development server
 * (RFD-19 hard requirement #2).
 */
import { NativeModules } from "react-native";

interface MachinewrightAssetsNativeModule {
  bundledAssetURL(relativePath: string): Promise<string>;
  readTextFile(path: string): Promise<string>;
  meshFileURL(path: string, expectedDigest: string): Promise<string>;
}

function nativeModule(): MachinewrightAssetsNativeModule {
  const native = NativeModules.MachinewrightAssetsModule as
    | MachinewrightAssetsNativeModule
    | undefined;
  if (!native) {
    throw new Error(
      "MachinewrightAssetsModule native module is not linked — check macos/ target membership",
    );
  }
  return native;
}

/** e.g. getBundledAssetURL("web/viewport/index.html") -> "file:///.../web/viewport/index.html" */
export function getBundledAssetURL(relativePath: string): Promise<string> {
  return nativeModule().bundledAssetURL(relativePath);
}

/** Reads an arbitrary project file's text content (unrestricted for this spike — see the native module's doc comment). */
export function readTextFile(path: string): Promise<string> {
  return nativeModule().readTextFile(path);
}

/**
 * Resolves a content-addressed mesh artifact to a `file://` URL, rejecting
 * if its actual SHA-256 digest doesn't match `expectedDigest`
 * (`MeshReference.digest` from the evaluation snapshot).
 */
export function getMeshFileURL(path: string, expectedDigest: string): Promise<string> {
  return nativeModule().meshFileURL(path, expectedDigest);
}
