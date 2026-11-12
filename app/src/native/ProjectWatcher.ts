/**
 * TS wrapper around `MachinewrightWatcherModule`: FSEvents-backed change
 * notifications for the open project, so file listings stay current when
 * files change outside the app (terminal, git, other editors).
 */
import { NativeEventEmitter, NativeModules } from "react-native";
import { DEFAULT_IGNORED_DIRECTORIES } from "./BundledAssets";

interface MachinewrightWatcherNativeModule {
  watch(root: string): void;
  unwatch(): void;
}

/** True if any directory segment of `relativePath` is one the app never lists (.git, .venv, …). */
export function isIgnoredPath(relativePath: string, ignored: readonly string[] = DEFAULT_IGNORED_DIRECTORIES): boolean {
  const segments = relativePath.split("/");
  // The last segment may be an ignored *directory itself* changing (e.g. `.venv`), which also counts.
  return segments.some((segment) => ignored.includes(segment));
}

/**
 * Watches `root` and calls `onChange` with the root-relative paths that
 * changed (ignored directories filtered out). Returns a stop function.
 */
export function watchProject(root: string, onChange: (relativePaths: readonly string[]) => void): () => void {
  const native = NativeModules.MachinewrightWatcherModule as MachinewrightWatcherNativeModule | undefined;
  if (!native) {
    throw new Error("MachinewrightWatcherModule native module is not linked — check macos/ target membership");
  }
  const emitter = new NativeEventEmitter(NativeModules.MachinewrightWatcherModule);
  const subscription = emitter.addListener("MachinewrightFsChange", (event: { paths: string[] }) => {
    const relevant = event.paths.filter((path) => !isIgnoredPath(path));
    if (relevant.length > 0) onChange(relevant);
  });
  native.watch(root);
  return () => {
    subscription.remove();
    native.unwatch();
  };
}
