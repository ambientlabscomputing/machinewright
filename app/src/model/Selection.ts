/**
 * Shared selection state (RFD-19 B.5: selection sync across editor/graph/
 * viewport). This is the concrete fix for the deleted Rust UI's review
 * findings R3 and R7: selection lives in exactly one place, as a *set* of
 * node ids plus a primary, never a scalar and never duplicated as
 * independent local state per surface (R3: "Source selection retains
 * multiple graph_node_ids in the model, but the adapter/render selection
 * uses only graph_node_id... The graph list also has its own selection
 * index rather than a selection derived from the shared node set"; R7:
 * scattered per-adapter state instead of one accepted value).
 *
 * Every surface (editor, viewport, and — once it exists — the graph view)
 * renders itself as a *function of* this value; none of them own a
 * competing copy of "what's selected."
 */
export interface Selection {
  readonly nodeIds: readonly string[];
  readonly primaryNodeId: string | null;
}

export const EMPTY_SELECTION: Selection = { nodeIds: [], primaryNodeId: null };

/** A single resolved node is the common case (a viewport pick, one cursor position). */
export function selectionOfNode(nodeId: string): Selection {
  return { nodeIds: [nodeId], primaryNodeId: nodeId };
}

export function selectionOfNodes(nodeIds: readonly string[]): Selection {
  return { nodeIds, primaryNodeId: nodeIds[0] ?? null };
}

export function isEmptySelection(selection: Selection): boolean {
  return selection.nodeIds.length === 0;
}
