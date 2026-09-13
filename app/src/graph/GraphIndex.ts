/**
 * Minimal graph-node index derived fresh from each accepted evaluation
 * snapshot's `ResolvedHardwareGraph` — RFD-19's M2 bullet "synchronized
 * source, graph, and 3D selection" needs at least a node list/tree; full
 * node-link visualization is M3 scope (see the M2 plan's non-goals).
 *
 * `buildGraphIndex` is a pure function: it never mutates a graph in place
 * and is never itself a second owner of "the current graph" — callers
 * rebuild it from whatever `ProjectSnapshot` is currently accepted in
 * `model/SnapshotStore`, exactly once per accepted snapshot.
 */
import type {
  AssemblyNode,
  PartNode,
  ResolvedHardwareGraph,
} from "../model/generated/EvaluationSnapshot";

export type GraphNode = AssemblyNode | PartNode;

export interface GraphIndex {
  readonly rootId: string;
  readonly byId: ReadonlyMap<string, GraphNode>;
  /** parent node id -> ordered child node ids, per the graph's containment edges. */
  readonly children: ReadonlyMap<string, readonly string[]>;
}

export function buildGraphIndex(graph: ResolvedHardwareGraph): GraphIndex {
  const byId = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    byId.set(node.node_id, node);
  }

  const childrenBuilder = new Map<string, string[]>();
  for (const edge of graph.containment ?? []) {
    const existing = childrenBuilder.get(edge.parent_node_id);
    if (existing) existing.push(edge.child_node_id);
    else childrenBuilder.set(edge.parent_node_id, [edge.child_node_id]);
  }

  const children = new Map<string, readonly string[]>();
  for (const [parentId, childIds] of childrenBuilder) children.set(parentId, childIds);

  return { rootId: graph.root_id, byId, children };
}

/** Depth-first node ids starting at `rootId`, each id visited at most once (guards a malformed cyclic containment graph). */
export function traverseDepthFirst(index: GraphIndex, rootId: string = index.rootId): readonly string[] {
  return traverseDepthFirstWithDepth(index, rootId).map((entry) => entry.nodeId);
}

export interface GraphTreeEntry {
  readonly nodeId: string;
  readonly depth: number;
}

/** Same traversal as `traverseDepthFirst`, annotated with each node's depth below `rootId` — what `graph/GraphTree.tsx` uses for indentation. */
export function traverseDepthFirstWithDepth(index: GraphIndex, rootId: string = index.rootId): readonly GraphTreeEntry[] {
  const visited = new Set<string>();
  const order: GraphTreeEntry[] = [];
  const stack: GraphTreeEntry[] = [{ nodeId: rootId, depth: 0 }];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined || visited.has(entry.nodeId)) continue;
    visited.add(entry.nodeId);
    order.push(entry);
    const childIds = index.children.get(entry.nodeId) ?? [];
    for (let i = childIds.length - 1; i >= 0; i -= 1) {
      const childId = childIds[i];
      if (childId !== undefined) stack.push({ nodeId: childId, depth: entry.depth + 1 });
    }
  }
  return order;
}
