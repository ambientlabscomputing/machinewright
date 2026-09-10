# Native application adapters

Floem is the production UI adapter for Machinewright. Application behavior and
state live in framework-neutral crates; Floem translates native UI events into
those ports and renders their state.

The boundary is deliberate:

- `machinewright-app` owns authoring state and defines evaluation, language,
  and viewport ports.
- `machinewright-language` owns the JSON-RPC client for the pinned `ty` server,
  including unsaved document updates and UTF-16-to-UTF-8 diagnostic ranges.
- `machinewright-evaluator`, `machinewright-model`, `machinewright-analysis`,
  and `machinewright-render` implement reusable domain and infrastructure
  behavior without importing Floem.
- `machinewright-floem` is the composition root and the only crate that imports
  the UI framework.

GPUI is not an active adapter or workspace dependency. If a future decision
replaces Floem, implement the same application ports in a new adapter and keep
the application and domain crates unchanged.

## Decision record

Floem 0.2.0 was selected on 2026-09-07 by project direction. The earlier
parallel Floem/GPUI comparison was stopped. GPUI 0.2.2 was proven buildable on
the primary Mac after installing Xcode Metal Toolchain 17F109, but it is not
part of the product or CI dependency graph.

## M2 integration checkpoint — 2026-09-09

The adapter uses shared document commands, atomic saves, project file watching,
trust and declared worker resolution, snapshot-cache import/restoration, Python
syntax diagnostics, and an offscreen wgpu renderer. The renderer presents raw
RGBA frames to Floem, performs depth testing and fragment-level section clipping,
and supports component ray picking. Picking coordinates are mapped from the
displayed image bounds. Source navigation checks the current document path and
retains a visible warning for stale mappings.

Workspace preferences store tab paths and cursors outside the checkout. Stored
cursors are applied to the Floem editor at startup. Evaluation generation and
all dirty open-buffer overlays now come from `ProjectSession`; the legacy
single-buffer and duplicate application-state implementations have been removed.
The headless authoring smoke follows the same session command path.

Safe-save validation now rechecks disk bytes immediately before every save,
preserves UTF-8 BOM, LF/CRLF mode, and file permissions, and coalesces overlapping
multicursor ranges. **Keep Editor Version** records the exact observed disk
revision; a separate **Force Save** performs the overwrite and rejects any newer
disk change. These behaviors have focused workspace tests.

The Floem adapter now presents a refreshable project tree and visible tabs backed
by session documents. Switching tabs restores source and cursor state; closing a
dirty tab is rejected; evaluated revisions open as disabled read-only tabs. The
current shared editor view is rebound to the selected session document, so the
session remains the sole owner of tab contents and undo history.

Editor/disk comparison runs off the UI thread and displays equal, editor-only,
and disk-only lines. Its exact LCS path is bounded for large files to avoid
quadratic memory growth.

Tree-sitter accepts validated incremental edits and delimiter matching excludes
strings and comments. The workspace core provides Unicode-safe find/replace and
go-to-line transactions. Graph and viewport correspondence can open a mapped
file in another tab before selecting its source range.

Snapshot cache records now retain project-relative source-to-digest mappings,
session ID, requested generation, and environment digest. Cache project keys
include the canonical checkout identity. Startup restore uses a distinct session
command, preserving strict generation rejection for live worker completions.
Missing environments and worker negotiation errors render an actionable,
read-only project view instead of terminating the application with a panic.

Evaluation and viewport queues use bounded latest-value delivery: document and
protocol ordering stays explicit while superseded pending evaluations and frames
are overwritten. Rendered frames carry revisions and stale frames are rejected
before presentation. Evaluation requests include the exact bytes of every open
editable document, including clean buffers, so cache source records do not reread
those files after evaluation. Worker processes are reaped when their owner exits.

Cache snapshot and reference writes are synced before promotion. Validation
failures remove staging directories, and startup removes staging remnants from
interrupted imports. Graph row construction detects cycles and still exposes
disconnected nodes.

Verified on the primary Mac: Rust workspace unit tests, strict Clippy, Floem
build, and the explicitly invoked GPU regression below. The GPU test checks
draw-order-independent depth, changed selection pixels, clipping through a
triangle, row-padding removal, and empty-scene readback.

```sh
cd native
cargo test -p machinewright-render gpu_depth -- --ignored
```

M2 acceptance is still pending. In particular:

- Consolidate snapshot, scene, diagnostics, and presentation signals still held
  by the adapter into ProjectSession; complete find/replace, go-to-line, command
  palette, shortcut, and external rename handling.
- Integrate actual process monitoring, forced replacement, recovery policy,
  rotating logs, Unix sockets, and Windows named pipes.
- Complete capability-gated asynchronous LSP requests and lifecycle handling.
- Complete cache session validation, all evaluated source capture, durable
  transactions, and tested concurrency/eviction behavior.
- Replace per-frame CPU vertex transforms and buffer uploads with retained GPU
  buffers, add BVH picking and virtualized graph inspection, and validate frame
  ordering, interaction, accessibility, and platform performance budgets.

Three render targets currently rotate on a dedicated thread, but readback waits
on that thread. This is not yet a measured asynchronous three-frame pipeline.
The fixed 800×600 render size and triangle-by-triangle picking also remain below
the planned viewport acceptance requirements. A successful application launch
does not establish interactive or performance acceptance.
