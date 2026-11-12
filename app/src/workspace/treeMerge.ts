/**
 * Pure helpers for keeping the file explorer in step with disk changes:
 * re-listing a directory must not collapse folders the user expanded.
 */

export interface TreeEntry {
  readonly path: string;
}

export interface TreeNodeLike<E extends TreeEntry> {
  readonly entry: E;
  readonly expanded: boolean;
  readonly children: readonly TreeNodeLike<E>[] | null;
}

/** Builds nodes for a fresh listing, reusing (and keeping the expansion/children of) any existing node with the same path. */
export function mergeListing<E extends TreeEntry, N extends TreeNodeLike<E>>(
  previous: readonly N[] | null,
  entries: readonly E[],
  makeNode: (entry: E) => N,
): N[] {
  const existing = new Map<string, N>((previous ?? []).map((node) => [node.entry.path, node]));
  return entries.map((entry) => {
    const kept = existing.get(entry.path);
    return kept ? ({ ...kept, entry } as N) : makeNode(entry);
  });
}

/** The set of directories whose listing a change to each root-relative path can affect: the path's parent (root = ""). */
export function affectedDirectories(rootPath: string, relativePaths: readonly string[]): Set<string> {
  const root = rootPath.replace(/\/+$/, "");
  const directories = new Set<string>();
  for (const relative of relativePaths) {
    const slash = relative.lastIndexOf("/");
    directories.add(slash < 0 ? root : `${root}/${relative.slice(0, slash)}`);
  }
  return directories;
}
