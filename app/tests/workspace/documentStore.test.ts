/**
 * R2 regression coverage: undo/redo/reload must notify identically to
 * ordinary typing (all are authoritative source changes), while a
 * display-only tab switch must never reach `DocumentStore` at all — see
 * DocumentStore.ts's doc comment for the full finding this guards against.
 */
import { describe, expect, it, vi } from "vitest";
import { DocumentStore, type DocumentChangeEvent, type DocumentStoreOptions } from "../../src/workspace/DocumentStore";

function makeStore(initialContent = "x = 1\n", writeFile: DocumentStoreOptions["writeFile"] = async () => {}): DocumentStore {
  return new DocumentStore({ projectRoot: "/project", readFile: async () => initialContent, writeFile });
}

describe("DocumentStore", () => {
  it("opens a document with version 0 and not dirty", async () => {
    const store = makeStore("x = 1\n");
    const document = await store.open("/project/main.py");
    expect(document).toMatchObject({ documentVersion: 0, dirty: false, bufferContent: "x = 1\n" });
  });

  it.each(["typing", "paste", "undo", "redo", "reload"] as const)(
    "R2: origin '%s' bumps documentVersion, marks dirty, and notifies identically to any other origin",
    async (origin) => {
      const store = makeStore("x = 1\n");
      await store.open("/project/main.py");
      const events: DocumentChangeEvent[] = [];
      store.onChange((event) => events.push(event));

      const updated = store.applyChange("/project/main.py", "x = 2\n", origin);

      expect(updated.documentVersion).toBe(1);
      expect(updated.dirty).toBe(true);
      expect(updated.bufferContent).toBe("x = 2\n");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ origin, document: { documentVersion: 1, dirty: true } });
    },
  );

  it("R2: a display-only tab switch (no applyChange call) never notifies listeners", async () => {
    const store = makeStore("x = 1\n");
    await store.open("/project/main.py");
    await store.open("/project/other.py"); // "switching tabs" opens/reads a second document
    const events: DocumentChangeEvent[] = [];
    store.onChange((event) => events.push(event));

    // Simulate a host that merely changes which document is displayed —
    // it must not call applyChange for that alone.
    store.get("/project/main.py");
    store.get("/project/other.py");

    expect(events).toHaveLength(0);
  });

  it("writes the buffer and clears dirty without notifying document change listeners", async () => {
    let diskContent = "x = 1\n";
    const write = vi.fn(async (_path: string, content: string) => { diskContent = content; });
    const store = new DocumentStore({ projectRoot: "/project", readFile: async () => diskContent, writeFile: write });
    await store.open("/project/main.py");
    store.applyChange("/project/main.py", "x = 2\n", "typing");
    const events: DocumentChangeEvent[] = [];
    store.onChange((event) => events.push(event));

    await store.save("/project/main.py");

    expect(write).toHaveBeenCalledWith("/project/main.py", "x = 2\n");

    expect(store.get("/project/main.py")).toMatchObject({ dirty: false, savedContent: "x = 2\n" });
    expect(events).toHaveLength(0);

    store.close("/project/main.py");
    const reopened = await store.open("/project/main.py");
    expect(reopened).toMatchObject({ dirty: false, bufferContent: "x = 2\n" });
  });

  it("serializes writes and leaves edits made during a save dirty", async () => {
    let finishFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => { finishFirst = resolve; });
    let finishSecond!: () => void;
    const secondWrite = new Promise<void>((resolve) => { finishSecond = resolve; });
    const write = vi.fn(async () => {}).mockReturnValueOnce(firstWrite).mockReturnValueOnce(secondWrite);
    const store = makeStore("original", write);
    const path = "/project/main.py";
    await store.open(path);
    store.applyChange(path, "first", "typing");
    const firstSave = store.save(path);
    store.applyChange(path, "second", "typing");
    const secondSave = store.save(path);
    await Promise.resolve();
    expect(write.mock.calls).toEqual([[path, "first"]]);

    finishFirst();
    await firstSave;
    expect(store.get(path)).toMatchObject({ dirty: true, savedContent: "first", bufferContent: "second" });
    expect(write.mock.calls).toEqual([[path, "first"], [path, "second"]]);

    finishSecond();
    await secondSave;
    expect(store.get(path)).toMatchObject({ dirty: false, savedContent: "second" });
  });

  it("preserves unsaved text after a write failure and lets the user retry", async () => {
    const write = vi.fn(async () => {}).mockRejectedValueOnce(new Error("permission denied"));
    const store = makeStore("original", write);
    const path = "/project/main.py";
    await store.open(path);
    store.applyChange(path, "edited", "typing");

    await expect(store.save(path)).rejects.toThrow("permission denied");
    expect(store.get(path)).toMatchObject({ dirty: true, savedContent: "original", bufferContent: "edited" });

    await store.save(path);
    expect(store.get(path)).toMatchObject({ dirty: false, savedContent: "edited" });
  });

  it("listOpen returns every currently open document", async () => {
    const store = makeStore("x = 1\n");
    await store.open("/project/a.py");
    await store.open("/project/b.py");
    expect(store.listOpen().map((d) => d.path).sort()).toEqual(["/project/a.py", "/project/b.py"]);
  });

  it("overlaysForEvaluation includes only dirty documents, as UTF-8 bytes", async () => {
    const store = makeStore("x = 1\n");
    await store.open("/project/clean.py");
    await store.open("/project/dirty.py");
    store.applyChange("/project/dirty.py", "x = 2\n", "typing");

    await store.open("/project-other/main.py");
    store.applyChange("/project-other/main.py", "x = 3\n", "typing");

    const overlays = store.overlaysForEvaluation();
    expect(overlays).toHaveLength(1);
    expect(overlays[0]?.relativePath).toBe("dirty.py");
    expect(new TextDecoder().decode(overlays[0]!.content)).toBe("x = 2\n");
  });

  it("dirty becomes false again if a change round-trips back to the saved content", async () => {
    const store = makeStore("x = 1\n");
    await store.open("/project/main.py");
    store.applyChange("/project/main.py", "x = 2\n", "typing");
    const backToOriginal = store.applyChange("/project/main.py", "x = 1\n", "undo");
    expect(backToOriginal.dirty).toBe(false);
    expect(store.overlaysForEvaluation()).toHaveLength(0);
  });
});
