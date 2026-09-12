/**
 * Resolves between a byte-offset position in an open document and the
 * graph node(s) it defines, using `EvaluationSnapshot.source_mappings` —
 * the join table between code, graph, and (via MeshReference.graph_node_id)
 * geometry that RFD-19's "Source, graph, and geometry correspondence"
 * section calls for.
 *
 * This is the direct fix for the deleted Rust UI's review finding R3
 * ("Python emits the whole-template mapping before narrower node hints...
 * source_for_node returns the first matching mapping, so component
 * selection navigates to the whole template even when a specific node
 * span is available"). That emission-order bug was already fixed at the
 * Python layer (src/machinewright/evaluation.py's `_source_mappings`
 * emits node-definition/call-site spans before the broad whole-template
 * fallback) — the functions here must respect that ordering rather than
 * re-introducing the bug by, say, picking the largest or first-added
 * mapping: both take the *first* array match, deliberately, matching the
 * already-narrowest-first data.
 */
import type { EvaluationSnapshot } from "./generated/EvaluationSnapshot";

export interface ResolvedSpan {
  readonly path: string;
  readonly startByte: number;
  readonly endByte: number;
}

/**
 * Node id(s) defined at `byteOffset` in `path`, narrowest mapping first
 * (empty if nothing in this file maps to that position — e.g. the offset
 * falls in unmapped boilerplate, or `path` isn't a file any mapping
 * references at all).
 */
export function resolveNodeIdsAtOffset(
  snapshot: EvaluationSnapshot,
  path: string,
  byteOffset: number,
): readonly string[] {
  for (const mapping of snapshot.source_mappings ?? []) {
    if (mapping.span.path !== path) continue;
    if (byteOffset >= mapping.span.start_byte && byteOffset <= mapping.span.end_byte) {
      return mapping.node_ids;
    }
  }
  return [];
}

/**
 * The narrowest source span defining `nodeId` (null if the snapshot has
 * no mapping for it at all — e.g. a synthetic/root node with no direct
 * source correspondence).
 */
export function resolveSpanForNodeId(
  snapshot: EvaluationSnapshot,
  nodeId: string,
): ResolvedSpan | null {
  for (const mapping of snapshot.source_mappings ?? []) {
    if (mapping.node_ids.includes(nodeId)) {
      return {
        path: mapping.span.path,
        startByte: mapping.span.start_byte,
        endByte: mapping.span.end_byte,
      };
    }
  }
  return null;
}
