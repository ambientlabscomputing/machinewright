import { describe, expect, it } from "vitest";
import { buildGraphIndex, traverseDepthFirst, traverseDepthFirstWithDepth } from "../../src/graph/GraphIndex";
import type { AssemblyNode, ResolvedHardwareGraph } from "../../src/model/generated/EvaluationSnapshot";

function assemblyNode(nodeId: string): AssemblyNode {
  return {
    definition_id: `def.${nodeId}`,
    definition_revision: "1.0.0",
    instance_key: nodeId,
    node_id: nodeId,
    parameter_digest: `digest-${nodeId}`,
    transform: {},
  };
}

function makeGraph(): ResolvedHardwareGraph {
  return {
    root_id: "root",
    nodes: [assemblyNode("root"), assemblyNode("x_axis"), assemblyNode("y_axis"), assemblyNode("x_motor")],
    containment: [
      { edge_id: "e1", parent_node_id: "root", child_node_id: "x_axis" },
      { edge_id: "e2", parent_node_id: "root", child_node_id: "y_axis" },
      { edge_id: "e3", parent_node_id: "x_axis", child_node_id: "x_motor" },
    ],
  };
}

describe("GraphIndex", () => {
  it("indexes every node by id", () => {
    const index = buildGraphIndex(makeGraph());
    expect(index.byId.size).toBe(4);
    expect(index.byId.get("x_motor")).toMatchObject({ node_id: "x_motor" });
  });

  it("builds a parent -> children map from containment edges", () => {
    const index = buildGraphIndex(makeGraph());
    expect(index.children.get("root")).toEqual(["x_axis", "y_axis"]);
    expect(index.children.get("x_axis")).toEqual(["x_motor"]);
    expect(index.children.get("y_axis")).toBeUndefined();
  });

  it("carries the graph's root_id through unchanged", () => {
    const index = buildGraphIndex(makeGraph());
    expect(index.rootId).toBe("root");
  });

  it("traverseDepthFirst visits every node reachable from the root exactly once", () => {
    const index = buildGraphIndex(makeGraph());
    const order = traverseDepthFirst(index);
    expect(order).toEqual(["root", "x_axis", "x_motor", "y_axis"]);
  });

  it("traverseDepthFirst tolerates a malformed cyclic containment graph without looping forever", () => {
    const graph: ResolvedHardwareGraph = {
      root_id: "a",
      nodes: [assemblyNode("a"), assemblyNode("b")],
      containment: [
        { edge_id: "e1", parent_node_id: "a", child_node_id: "b" },
        { edge_id: "e2", parent_node_id: "b", child_node_id: "a" }, // cycle
      ],
    };
    const index = buildGraphIndex(graph);
    const order = traverseDepthFirst(index);
    expect(order).toEqual(["a", "b"]);
  });

  it("traverseDepthFirstWithDepth annotates each node with its depth below the root, for GraphTree's indentation", () => {
    const index = buildGraphIndex(makeGraph());
    const entries = traverseDepthFirstWithDepth(index);
    expect(entries).toEqual([
      { nodeId: "root", depth: 0 },
      { nodeId: "x_axis", depth: 1 },
      { nodeId: "x_motor", depth: 2 },
      { nodeId: "y_axis", depth: 1 },
    ]);
  });

  it("returns an empty index for a graph with no containment edges", () => {
    const graph: ResolvedHardwareGraph = { root_id: "solo", nodes: [assemblyNode("solo")] };
    const index = buildGraphIndex(graph);
    expect(traverseDepthFirst(index)).toEqual(["solo"]);
  });
});
