/**
 * Computes the digest sent as `EvaluateProject.environment_digest`, so the
 * worker's own environment verification (src/machinewright/worker.py's
 * `_verify_environment`) actually runs. Today's spike screens always send
 * this field empty, silently skipping that check.
 *
 * Digesting is delegated to an injected port rather than done in pure TS:
 * production wiring (Phase 2) uses the native module's SHA-256 primitive —
 * the same one `MachinewrightAssetsModule.meshFileURL` already uses to
 * validate mesh content — so there is exactly one digest implementation in
 * the app, not a second one reimplemented in JS. Tests supply a fake.
 */

export interface DigestPort {
  digestFile(path: string): Promise<string>;
}

export async function computeEnvironmentDigest(
  projectRoot: string,
  environmentLockRelativePath: string,
  ports: { readonly digest: DigestPort; readonly joinPath: (root: string, ...segments: string[]) => string },
): Promise<string> {
  const path = ports.joinPath(projectRoot, environmentLockRelativePath);
  return ports.digest.digestFile(path);
}
