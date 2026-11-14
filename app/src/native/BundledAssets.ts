/**
 * TS wrapper around `MachinewrightAssetsModule` (native macOS module) —
 * resolves a bundled WebView surface's relative path to a `file://` URL,
 * so surfaces load from the app bundle instead of a development server
 * (RFD-19 hard requirement #2).
 */
import { NativeModules } from "react-native";

export interface DirectoryEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly path: string;
}

interface MachinewrightAssetsNativeModule {
  bundledAssetURL(relativePath: string): Promise<string>;
  readTextFile(path: string): Promise<string>;
  meshFileURL(path: string, expectedDigest: string): Promise<string>;
  digestFile(path: string): Promise<string>;
  writeTextFileAtomically(path: string, contents: string): Promise<void>;
  copyFile(source: string, destination: string): Promise<void>;
  listDirectory(path: string): Promise<DirectoryEntry[]>;
  listFilesRecursive(root: string, ignoredNames: readonly string[], limit: number): Promise<string[]>;
  searchInFiles(
    root: string,
    query: string,
    caseSensitive: boolean,
    ignoredNames: readonly string[],
    maxResults: number,
  ): Promise<TextMatch[]>;
}

/** One occurrence of a global-find query. `line` is 1-based; `column`/`length` are UTF-16 offsets within the line. */
export interface TextMatch {
  /** Project-root-relative POSIX path. */
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly length: number;
  /** The matching line, truncated to ~240 characters. */
  readonly text: string;
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

/**
 * The `workspace/EnvironmentDigest.ts` `DigestPort` production
 * implementation — the same SHA-256 the module already trusts for mesh
 * digest validation above, exposed for an arbitrary file (e.g.
 * `environment_lock`).
 */
export function digestFile(path: string): Promise<string> {
  return nativeModule().digestFile(path);
}

/**
 * The `cache/AcceptedPointer.ts` `PersistedAcceptedPointerPort` write
 * primitive — writes via a temp file and an atomic rename so a reader can
 * never observe a half-written "last accepted" pointer file.
 */
export function writeTextFileAtomically(path: string, contents: string): Promise<void> {
  return nativeModule().writeTextFileAtomically(path, contents);
}

/** Copies a file, replacing any existing destination (via a temp file, so a failure never leaves a truncated copy). */
export function copyFile(source: string, destination: string): Promise<void> {
  return nativeModule().copyFile(source, destination);
}

/**
 * A single-level directory listing (directories first, then files, both
 * case-insensitive) — what `app/FileExplorer.tsx`'s lazily-expanding tree
 * requests each time the user expands one more directory, never a
 * recursive upfront walk of the whole project.
 */
export function listDirectory(path: string): Promise<readonly DirectoryEntry[]> {
  return nativeModule().listDirectory(path);
}

/** Directories that quick-open and global find never descend into. */
export const DEFAULT_IGNORED_DIRECTORIES: readonly string[] = [
  ".git",
  ".venv",
  "node_modules",
  "__pycache__",
  ".machinewright",
  ".mypy_cache",
  ".ruff_cache",
  ".pytest_cache",
  ".DS_Store",
  "dist",
  "build",
];

/** Every regular file under `root` as root-relative POSIX paths (capped at `limit`). */
export function listFilesRecursive(
  root: string,
  limit = 20000,
  ignoredNames: readonly string[] = DEFAULT_IGNORED_DIRECTORIES,
): Promise<string[]> {
  return nativeModule().listFilesRecursive(root, ignoredNames, limit);
}

/** Plain-text search over the project's files, off the JS thread. */
export function searchInFiles(
  root: string,
  query: string,
  options: { readonly caseSensitive: boolean; readonly maxResults?: number },
  ignoredNames: readonly string[] = DEFAULT_IGNORED_DIRECTORIES,
): Promise<TextMatch[]> {
  return nativeModule().searchInFiles(root, query, options.caseSensitive, ignoredNames, options.maxResults ?? 500);
}
