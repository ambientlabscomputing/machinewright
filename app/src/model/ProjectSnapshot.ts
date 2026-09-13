/**
 * The RFD-19 "Immutable application snapshot" type, literally:
 *
 *   type ProjectSnapshot = Readonly<{ generation, graphDigest,
 *   artifactManifestDigest, graph, sourceMap, geometry, diagnostics,
 *   observables, evidence }>
 *
 * built from the generated `EvaluationSnapshot` (the worker's own output
 * contract) plus resolved geometry (cache-backed mesh URLs, see
 * cache/CacheClient) and normalized diagnostics (see model/Diagnostics).
 * `evidence` is a typed empty stub for M2 — evidence-aware engineering is
 * M5 scope.
 */
import type {
  EvaluationSnapshot,
  Observable,
  ResolvedHardwareGraph,
  SourceMapping,
} from "./generated/EvaluationSnapshot";
import type { MeshRefLite } from "../cache/ArtifactManifest";
import type { StructuredDiagnostic } from "./Diagnostics";

/** M5-owned; kept as a typed empty stub so ProjectSnapshot's shape matches the RFD sketch without pulling evidence features forward. */
export interface EvidenceIndex {
  readonly items: readonly never[];
}

export const EMPTY_EVIDENCE_INDEX: EvidenceIndex = { items: [] };

export interface ProjectSnapshot {
  readonly generation: bigint;
  readonly graphDigest: string;
  readonly artifactManifestDigest: string;
  readonly graph: ResolvedHardwareGraph;
  readonly sourceMap: readonly SourceMapping[];
  readonly geometry: readonly MeshRefLite[];
  readonly diagnostics: readonly StructuredDiagnostic[];
  readonly observables: readonly Observable[];
  readonly evidence: EvidenceIndex;
}

export interface BuildProjectSnapshotArgs {
  readonly generation: bigint;
  readonly raw: EvaluationSnapshot;
  readonly geometry: readonly MeshRefLite[];
  readonly diagnostics: readonly StructuredDiagnostic[];
}

export function buildProjectSnapshot(args: BuildProjectSnapshotArgs): ProjectSnapshot {
  return {
    generation: args.generation,
    graphDigest: args.raw.graph_digest,
    artifactManifestDigest: args.raw.artifact_manifest_digest,
    graph: args.raw.graph,
    sourceMap: args.raw.source_mappings ?? [],
    geometry: args.geometry,
    diagnostics: args.diagnostics,
    observables: args.raw.observables ?? [],
    evidence: EMPTY_EVIDENCE_INDEX,
  };
}
