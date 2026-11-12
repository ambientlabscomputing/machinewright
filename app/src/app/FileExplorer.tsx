/**
 * A VS Code-style project file tree: directories load their children
 * lazily (only when expanded, via the native single-level `listDirectory`
 * primitive), not as one upfront recursive walk. Selecting a file notifies
 * `onOpenFile`; the caller (`app/AppShell.tsx`) owns what "opening" a file
 * actually means (adding it to `workspace/DocumentStore` and making it the
 * active document) — this component only knows about the directory
 * structure, never about documents/buffers.
 *
 * Composed entirely from design-system primitives (RFD-19 "Enforcing the
 * design language").
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView } from "react-native";
import { Panel, Stack, Text } from "../design-system/native";
import { listDirectory, type DirectoryEntry } from "../native/BundledAssets";
import { affectedDirectories, mergeListing } from "../workspace/treeMerge";

interface TreeNode {
  readonly entry: DirectoryEntry;
  readonly expanded: boolean;
  /** `null` until the directory has been expanded at least once. */
  readonly children: readonly TreeNode[] | null;
}

function updateNodeAtPath(
  nodes: readonly TreeNode[],
  targetPath: string,
  update: (node: TreeNode) => TreeNode,
): readonly TreeNode[] {
  return nodes.map((node) => {
    if (node.entry.path === targetPath) return update(node);
    if (node.children) return { ...node, children: updateNodeAtPath(node.children, targetPath, update) };
    return node;
  });
}

export interface FileExplorerProps {
  readonly rootPath: string;
  readonly activeFilePath: string | null;
  readonly onOpenFile: (path: string) => void;
  /** A batch of on-disk changes (root-relative paths); each new object triggers a refresh of the affected listings. */
  readonly change?: { readonly paths: readonly string[] } | null;
}

const makeNode = (entry: DirectoryEntry): TreeNode => ({ entry, expanded: false, children: null });

function expandedDirectoryPaths(nodes: readonly TreeNode[] | null): string[] {
  const paths: string[] = [];
  for (const node of nodes ?? []) {
    if (node.entry.isDirectory && node.expanded) {
      paths.push(node.entry.path, ...expandedDirectoryPaths(node.children));
    }
  }
  return paths;
}

export function FileExplorer({ rootPath, activeFilePath, onOpenFile, change }: FileExplorerProps) {
  const [roots, setRoots] = useState<readonly TreeNode[] | null>(null);
  const rootsRef = useRef(roots);
  rootsRef.current = roots;

  // Live updates: re-list only the directories a change touched (the root
  // and any *expanded* folder), keeping every folder's expansion state.
  useEffect(() => {
    if (!change || rootsRef.current === null) return;
    const dirty = affectedDirectories(rootPath, change.paths);
    const normalizedRoot = rootPath.replace(/\/+$/, "");
    const targets = [normalizedRoot, ...expandedDirectoryPaths(rootsRef.current)].filter((path) => dirty.has(path));
    for (const target of targets) {
      listDirectory(target)
        .then((entries) => {
          setRoots((current) => {
            if (current === null) return current;
            if (target === normalizedRoot) return mergeListing(current, entries, makeNode);
            return updateNodeAtPath(current, target, (node) => ({
              ...node,
              children: mergeListing(node.children, entries, makeNode),
            }));
          });
        })
        .catch(() => {
          // The directory vanished (deleted/renamed); its parent's own change event removes the row.
        });
    }
  }, [change, rootPath]);

  useEffect(() => {
    setRoots(null);
    let cancelled = false;
    listDirectory(rootPath)
      .then((entries) => {
        if (!cancelled) setRoots(entries.map((entry) => ({ entry, expanded: false, children: null })));
      })
      .catch(() => {
        if (!cancelled) setRoots([]);
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath]);

  const toggleDirectory = useCallback(
    (node: TreeNode) => {
      if (!node.expanded && node.children === null) {
        // First expansion: fetch this directory's children lazily.
        listDirectory(node.entry.path)
          .then((entries) => {
            setRoots((current) =>
              current === null
                ? current
                : updateNodeAtPath(current, node.entry.path, (target) => ({
                    ...target,
                    expanded: true,
                    children: entries.map((entry) => ({ entry, expanded: false, children: null })),
                  })),
            );
          })
          .catch(() => {
            setRoots((current) =>
              current === null
                ? current
                : updateNodeAtPath(current, node.entry.path, (target) => ({ ...target, expanded: true, children: [] })),
            );
          });
        return;
      }
      setRoots((current) =>
        current === null
          ? current
          : updateNodeAtPath(current, node.entry.path, (target) => ({ ...target, expanded: !target.expanded })),
      );
    },
    [],
  );

  const renderNode = useCallback(
    (node: TreeNode, depth: number): React.ReactNode => {
      const isActive = !node.entry.isDirectory && node.entry.path === activeFilePath;
      return (
        <Stack key={node.entry.path} gap="none">
          <Stack direction="row" indentLevel={depth}>
            <Text
              variant="label"
              tone={isActive ? "selection" : "primary"}
              onPress={() => (node.entry.isDirectory ? toggleDirectory(node) : onOpenFile(node.entry.path))}
            >
              {node.entry.isDirectory ? (node.expanded ? "▾ " : "▸ ") : "  "}
              {node.entry.name}
            </Text>
          </Stack>
          {node.entry.isDirectory && node.expanded && node.children
            ? node.children.map((child) => renderNode(child, depth + 1))
            : null}
        </Stack>
      );
    },
    [activeFilePath, onOpenFile, toggleDirectory],
  );

  return (
    <Panel surface="panel" flex={1} bordered>
      <ScrollView>
        {roots === null ? (
          <Text tone="secondary">Loading…</Text>
        ) : (
          <Stack gap="xs">{roots.map((node) => renderNode(node, 0))}</Stack>
        )}
      </ScrollView>
    </Panel>
  );
}
