/**
 * The content-addressed artifact manifest for one evaluation's mesh output —
 * the join between `EvaluationSnapshot.meshes` (MeshReference, keyed by
 * `graph_node_id` and content digest) and the scoped local resource URLs the
 * viewport WebView actually loads (see native/BundledAssets.getMeshFileURL).
 */
import type { MeshReference } from "../model/generated/EvaluationSnapshot";
import type { MeshRefLite } from "../protocol/surfaces/viewport";

export interface ArtifactManifest {
  readonly artifactManifestDigest: string;
  readonly meshes: readonly MeshReference[];
}

export type { MeshRefLite };
