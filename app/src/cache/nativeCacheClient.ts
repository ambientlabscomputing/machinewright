/**
 * Production `CacheClient` factory, wired to the native
 * `MachinewrightAssetsModule.meshFileURL` digest-validated resolver that
 * already exists from M1. This is the one place production code builds a
 * `CacheClient` — `evaluator/SnapshotInstaller` and any UI surface needing
 * mesh URLs should go through this instance rather than each constructing
 * their own path-joining/resolver glue inline, as today's spikes do.
 */
import { getMeshFileURL } from "../native/BundledAssets";
import { CacheClient } from "./CacheClient";

function posixJoin(directory: string, name: string): string {
  return `${directory.replace(/\/+$/, "")}/${name}`;
}

export function createNativeCacheClient(): CacheClient {
  return new CacheClient({
    resolver: { getMeshFileURL },
    joinPath: posixJoin,
  });
}
