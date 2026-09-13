/**
 * R2 regression coverage: undo/redo/reload must notify identically to
 * ordinary typing (all are authoritative source changes), while a
 * display-only tab switch must never reach `DocumentStore` at all — see
 * DocumentStore.ts's doc comment for the full finding this guards against.
 */
import { describe, expect, it } from "vitest";
import { DocumentStore, type DocumentChangeEvent } from "../../src/workspace/DocumentStore";

function makeStore(initialContent = "x = 1\n"): DocumentStore {
  return new DocumentStore({ readFile: async () => initialContent });
}

describe("DocumentStore", () => {
  it("opens a document with version 0 and not dirty", async () => {
    const store = makeStore("x = 1\n");
    const document = await store.open("main.py");
    expect(document).toMatchObject({ documentVersion: 0, dirty: false, bufferContent: "x = 1\n" });
  });

  it.each(["typing", "paste", "undo", "redo", "reload"] as const)(
    "R2: origin '%s' bumps documentVersion, marks dirty, and notifies identically to any other origin",
    async (origin) => {
      const store = makeStore("x = 1\n");
      await store.open("main.py");
      const events: DocumentChangeEvent[] = [];
      store.onChange((event) => events.push(event));

      const updated = store.applyChange("main.py", "x = 2\n", origin);

      expect(updated.documentVersion).toBe(1);
      expect(updated.dirty).toBe(true);
      expect(updated.bufferContent).toBe("x = 2\n");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ origin, document: { documentVersion: 1, dirty: true } });
    },
  );

  it("R2: a display-only tab switch (no applyChange call) never notifies listeners", async () => {
    const store = makeStore("x = 1\n");
    await store.open("main.py");
    await store.open("other.py"); // "switching tabs" opens/reads a second document
    const events: DocumentChangeEvent[] = [];
    store.onChange((event) => events.push(event));

    // Simulate a host that merely changes which document is displayed —
    // it must not call applyChange for that alone.
    store.get("main.py");
    store.get("other.py");

    expect(events).toHaveLength(0);
  });

  it("marking a document saved clears dirty without notifying (saving is not a content change)", async () => {
    const store = makeStore("x = 1\n");
    await store.open("main.py");
    store.applyChange("main.py", "x = 2\n", "typing");
    const events: DocumentChangeEvent[] = [];
    store.onChange((event) => events.push(event));

    store.markSaved("main.py");

    expect(store.get("main.py")).toMatchObject({ dirty: false, savedContent: "x = 2\n" });
    expect(events).toHaveLength(0);
  });

  it("listOpen returns every currently open document", async () => {
    const store = makeStore("x = 1\n");
    await store.open("a.py");
    await store.open("b.py");
    expect(store.listOpen().map((d) => d.path).sort()).toEqual(["a.py", "b.py"]);
  });

  it("overlaysForEvaluation includes only dirty documents, as UTF-8 bytes", async () => {
    const store = makeStore("x = 1\n");
    await store.open("clean.py");
    await store.open("dirty.py");
    store.applyChange("dirty.py", "x = 2\n", "typing");

    const overlays = store.overlaysForEvaluation();
    expect(overlays).toHaveLength(1);
    expect(overlays[0]?.relativePath).toBe("dirty.py");
    expect(new TextDecoder().decode(overlays[0]!.content)).toBe("x = 2\n");
  });

  it("dirty becomes false again if a change round-trips back to the saved content", async () => {
    const store = makeStore("x = 1\n");
    await store.open("main.py");
    store.applyChange("main.py", "x = 2\n", "typing");
    const backToOriginal = store.applyChange("main.py", "x = 1\n", "undo");
    expect(backToOriginal.dirty).toBe(false);
    expect(store.overlaysForEvaluation()).toHaveLength(0);
  });
});
