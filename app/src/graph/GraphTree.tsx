/**
 * The minimal graph-node view RFD-19's M2 bullet "synchronized source,
 * graph, and 3D selection" calls for — a flat, indented list, not a
 * node-link diagram (full graph visualization/layout is M3 scope). Renders
 * itself purely as a function of the shared `Selection` (model/Selection.ts)
 * and writes to it on press; it never owns a competing "which row is
 * selected" index of its own (the direct fix this whole app follows for
 * findings R3/R7 — see Selection.ts's doc comment).
 *
 * Composed entirely from design-system primitives per RFD-19's "Enforcing
 * the design language" — no raw react-native visual primitives, and no
 * `style` overrides (Text/Stack/Panel deliberately don't expose one);
 * indentation uses Stack's token-derived `indentLevel` prop, selection uses
 * Text's existing `tone="selection"`.
 */
import { useMemo } from "react";
import { ScrollView } from "react-native";
import { Panel, Stack, Text } from "../design-system/native";
import { buildGraphIndex, traverseDepthFirstWithDepth, type GraphIndex } from "./GraphIndex";
import type { ResolvedHardwareGraph } from "../model/generated/EvaluationSnapshot";
import { selectionOfNode, type Selection } from "../model/Selection";

export interface GraphTreeProps {
  readonly graph: ResolvedHardwareGraph | null;
  readonly selection: Selection;
  readonly onSelectNode: (selection: Selection) => void;
}

function nodeLabel(nodeId: string, index: GraphIndex): string {
  const node = index.byId.get(nodeId);
  if (!node) return nodeId;
  return `${node.definition_id} (${nodeId})`;
}

export function GraphTree({ graph, selection, onSelectNode }: GraphTreeProps) {
  const entries = useMemo(() => {
    if (!graph) return null;
    const index = buildGraphIndex(graph);
    return { index, rows: traverseDepthFirstWithDepth(index) };
  }, [graph]);

  if (!entries) {
    return (
      <Panel surface="panel" flex={1} bordered>
        <Text variant="body" tone="secondary">
          No graph yet — evaluate a project to see its nodes here.
        </Text>
      </Panel>
    );
  }

  return (
    <Panel surface="panel" flex={1} bordered>
      <ScrollView>
        <Stack gap="xs">
          {entries.rows.map(({ nodeId, depth }) => {
            const isSelected = selection.nodeIds.includes(nodeId);
            return (
              <Stack key={nodeId} direction="row" indentLevel={depth}>
                <Text
                  variant="mono"
                  tone={isSelected ? "selection" : "primary"}
                  onPress={() => onSelectNode(selectionOfNode(nodeId))}
                >
                  {nodeLabel(nodeId, entries.index)}
                </Text>
              </Stack>
            );
          })}
        </Stack>
      </ScrollView>
    </Panel>
  );
}
