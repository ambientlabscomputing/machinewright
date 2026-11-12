import { describe, expect, it, vi } from "vitest";
import { canonicalChord, formatChord } from "../../src/commands/chords";
import { fuzzyMatch, rankByFuzzy } from "../../src/commands/fuzzy";
import { rankFiles } from "../../src/commands/fileIndex";
import { CommandRegistry } from "../../src/commands/registry";
import { affectedDirectories, mergeListing } from "../../src/workspace/treeMerge";
import { matchByteRange, validateNewFilePath } from "../../src/commands/textPosition";

describe("chords", () => {
  it("canonicalizes spelling and modifier order", () => {
    expect(canonicalChord("shift+cmd+p")).toBe("Cmd+Shift+P");
    expect(canonicalChord("Command+Option+k")).toBe("Cmd+Alt+K");
    expect(canonicalChord("esc")).toBe("Escape");
    expect(canonicalChord("Cmd+Return")).toBe("Cmd+Enter");
  });
  it("rejects malformed chords", () => {
    expect(() => canonicalChord("Cmd+")).toThrow();
    expect(() => canonicalChord("Cmd+A+B")).toThrow();
  });
  it("formats with macOS glyph ordering", () => {
    expect(formatChord("Cmd+Shift+P")).toBe("⇧⌘P");
    expect(formatChord("Cmd+O")).toBe("⌘O");
    expect(formatChord("Escape")).toBe("⎋");
  });
});

describe("fuzzyMatch", () => {
  it("matches subsequences case-insensitively and rejects non-matches", () => {
    expect(fuzzyMatch("opj", "Open Project")).not.toBeNull();
    expect(fuzzyMatch("xyz", "Open Project")).toBeNull();
    expect(fuzzyMatch("", "anything")?.indices).toEqual([]);
  });
  it("reports matched indices", () => {
    expect(fuzzyMatch("np", "New Project")?.indices).toEqual([0, 4]);
  });
  it("prefers word starts and consecutive runs", () => {
    const ranked = rankByFuzzy(["Toggle Terminal", "Open Project", "Quit Pro Jig"], "pro", (s) => s);
    expect(ranked[0]?.item).toBe("Open Project");
  });
  it("keeps input order for equal scores", () => {
    const ranked = rankByFuzzy(["aa", "ab"], "", (s) => s);
    expect(ranked.map((r) => r.item)).toEqual(["aa", "ab"]);
  });
});

describe("rankFiles", () => {
  const files = ["src/analysis/pp.ts", "App.tsx", "src/app/AppShell.tsx", "README.md"];
  it("prefers file-name matches over scattered path matches", () => {
    expect(rankFiles(files, "app")[0]?.path).toBe("App.tsx");
  });
  it("returns everything for an empty query, capped by limit", () => {
    expect(rankFiles(files, "").length).toBe(4);
    expect(rankFiles(files, "", 2).length).toBe(2);
  });
  it("reports base-name highlight indices", () => {
    expect(rankFiles(files, "shell")[0]?.nameIndices.length).toBe(5);
  });
});

describe("CommandRegistry", () => {
  it("runs commands by chord and id, honoring enabled", async () => {
    const run = vi.fn();
    const blocked = vi.fn();
    const registry = new CommandRegistry([
      { id: "a", title: "A", shortcut: "cmd+o", run },
      { id: "b", title: "B", shortcut: "Cmd+N", enabled: false, run: blocked },
    ]);
    expect(await registry.runChord("Cmd+O")).toBe(true);
    expect(await registry.runChord("Cmd+N")).toBe(false);
    expect(await registry.run("b")).toBe(false);
    expect(await registry.runChord("Cmd+Z")).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(blocked).not.toHaveBeenCalled();
    expect(registry.listEnabled().map((c) => c.id)).toEqual(["a"]);
    expect(registry.shortcutChords()).toEqual(["Cmd+O", "Cmd+N"]);
    expect(registry.enabledShortcutChords()).toEqual(["Cmd+O"]);
  });
  it("rejects duplicate ids and conflicting shortcuts", () => {
    const registry = new CommandRegistry([{ id: "a", title: "A", shortcut: "Cmd+O", run: () => {} }]);
    expect(() => registry.register({ id: "a", title: "A2", run: () => {} })).toThrow(/duplicate/);
    expect(() => registry.register({ id: "c", title: "C", shortcut: "cmd+o", run: () => {} })).toThrow(/bound to both/);
  });
});

describe("matchByteRange", () => {
  it("maps line/column to byte offsets", () => {
    expect(matchByteRange("ab\ncdef\n", 2, 1, 2)).toEqual({ startByte: 4, endByte: 6 });
    expect(matchByteRange("abc", 1, 0, 3)).toEqual({ startByte: 0, endByte: 3 });
  });
  it("counts multi-byte characters as UTF-8 bytes", () => {
    // "é" is 2 bytes in UTF-8, 1 UTF-16 unit; "😀" is 4 bytes, 2 units.
    expect(matchByteRange("é😀x", 1, 3, 1)).toEqual({ startByte: 6, endByte: 7 });
  });
  it("returns null past the last line", () => {
    expect(matchByteRange("a\nb", 5, 0, 1)).toBeNull();
  });
  it("clamps a range running past the text", () => {
    expect(matchByteRange("abc", 1, 2, 10)).toEqual({ startByte: 2, endByte: 3 });
  });
});

describe("validateNewFilePath", () => {
  it("accepts nested relative paths", () => {
    expect(validateNewFilePath("  parts/bracket.py ")).toBe("parts/bracket.py");
  });
  it("rejects empty, absolute, trailing-slash and escaping paths", () => {
    for (const bad of ["", "   ", "/etc/x", "~/x", "dir/", "../x", "a//b", "a/./b"]) {
      expect(() => validateNewFilePath(bad)).toThrow();
    }
  });
});

describe("treeMerge", () => {
  const node = (path: string, expanded = false, children: never[] | null = null) => ({ entry: { path }, expanded, children });
  it("keeps expansion state for surviving entries and adds/drops the rest", () => {
    const previous = [node("/r/a", true, []), node("/r/gone")];
    const merged = mergeListing(previous, [{ path: "/r/a" }, { path: "/r/new" }], (entry) => node(entry.path));
    expect(merged.map((n) => n.entry.path)).toEqual(["/r/a", "/r/new"]);
    expect(merged[0]?.expanded).toBe(true);
    expect(merged[1]?.expanded).toBe(false);
  });
  it("maps changed paths to the directories to re-list", () => {
    const dirs = affectedDirectories("/r/", ["parts", "a/b/c.py", "a/d.py"]);
    expect([...dirs].sort()).toEqual(["/r", "/r/a", "/r/a/b"]);
  });
});
