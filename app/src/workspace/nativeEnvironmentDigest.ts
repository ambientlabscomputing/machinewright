/**
 * Production `DigestPort` for `EnvironmentDigest.ts`, wired to the native
 * SHA-256 primitive added to `MachinewrightAssetsModule` in Phase 2 of the
 * M2 plan — see `native/BundledAssets.digestFile`. Kept as a one-line
 * adapter so `EnvironmentDigest.ts` itself stays framework-neutral and
 * testable with a fake port (see Phase 1).
 */
import { digestFile } from "../native/BundledAssets";
import type { DigestPort } from "./EnvironmentDigest";

export const nativeDigestPort: DigestPort = {
  digestFile,
};
