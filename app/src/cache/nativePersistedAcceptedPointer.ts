/**
 * Production `PersistedAcceptedPointerPort`, wired to the native
 * atomic-write primitive added to `MachinewrightAssetsModule` in Phase 2 of
 * the M2 plan (`native/BundledAssets.writeTextFileAtomically`) and the
 * existing `readTextFile`. Stores one JSON pointer file per project at a
 * fixed, project-relative cache path.
 *
 * `generation` is a wire uint64 (bigint) and must never pass through
 * `JSON.stringify`/`JSON.parse` directly (see protocol/surfaces/version.ts's
 * `generationToWire`/`generationFromWire` — this is that same boundary,
 * applied to the on-disk pointer file instead of a WebView message).
 */
import { readTextFile, writeTextFileAtomically } from "../native/BundledAssets";
import { generationFromWire, generationToWire } from "../protocol/surfaces/version";
import type { AcceptedRevision, PersistedAcceptedPointerPort } from "./AcceptedPointer";

const POINTER_RELATIVE_PATH = ".machinewright/accepted-pointer.json";

interface PointerFileShape {
  readonly generation: string;
  readonly graphDigest: string;
  readonly artifactManifestDigest: string;
}

function pointerPath(projectRoot: string): string {
  return `${projectRoot.replace(/\/+$/, "")}/${POINTER_RELATIVE_PATH}`;
}

export const nativePersistedAcceptedPointer: PersistedAcceptedPointerPort = {
  async writeAtomically(projectRoot: string, revision: AcceptedRevision): Promise<void> {
    const shape: PointerFileShape = {
      generation: generationToWire(revision.generation),
      graphDigest: revision.graphDigest,
      artifactManifestDigest: revision.artifactManifestDigest,
    };
    await writeTextFileAtomically(pointerPath(projectRoot), JSON.stringify(shape));
  },

  async read(projectRoot: string): Promise<AcceptedRevision | null> {
    let raw: string;
    try {
      raw = await readTextFile(pointerPath(projectRoot));
    } catch {
      return null; // no pointer written yet for this project
    }
    const parsed = JSON.parse(raw) as PointerFileShape;
    return {
      generation: generationFromWire(parsed.generation),
      graphDigest: parsed.graphDigest,
      artifactManifestDigest: parsed.artifactManifestDigest,
    };
  },
};
