# Machinewright IDE: M2 implementation review

Reviewed: 2026-09-10, approximately 19:59 MDT. Baseline: `0a2c103471da4063b0c9627cbca37842faffc43c` **plus the current uncommitted native changes and benchmark files**. Another implementation session was active; these findings describe the inspected working tree, not just HEAD. Line references are to that working tree and may move.

Scope: [RFD-19](../../smart-actuator/RFDs/RFD-19.md), through M2, including its September 9 remaining-work amendment. The objective is a reliable authoring foundation that M3 can extend. This review does not require completing the behavior laboratory, publication, Fabricate release integration, or evidence features now.

## Assessment

The architectural direction is sound, but the integrated authoring loop is not ready to call M2 complete. In particular, repeated overlay evaluation fails in the same Python worker. Several other failures arise because application behavior is still coordinated in the Floem adapter instead of through one tested application state transition.

The graphics code is reusable in part: camera mathematics and navigation commands do not depend on Floem or Python, and retained GPU buffers and BVH picking are implemented. The next improvement should be to share immutable geometry and separate scene preparation, viewport interaction, and rendering. A new general-purpose graphics framework would be unnecessary scope.

### What is already working or substantially established

- Native Rust/Floem shell, independently usable Python Core, and a process/protocol boundary.
- Framework-neutral app, workspace, editor, language, model, evaluator, cache, analysis, and render crates. Floem imports stay in its adapter.
- Session-owned documents and history, source overlays, guarded saves, external-change handling, and read-only evaluated-source tabs.
- Immutable snapshots, generation checks, cache corruption handling, cache promotion locking, and leases.
- GPU depth/clipping rendering, retained mesh buffers, BVH picking, camera commands, component placement, and virtualized workspace/graph lists.
- Worker resource policy, process sampling, log rotation, and restart machinery now have implementation and unit coverage. Their integrated recovery behavior still needs correction.

The adapter README's September 9 outstanding-work list is partly stale: retained buffers, BVH picking, virtualization, and process monitoring should not be reported as wholly absent.

### Validation performed

| Check | Result and limitation |
| --- | --- |
| `cargo test --locked --manifest-path native/Cargo.toml --workspace --exclude machinewright-floem` | 73 tests passed; four GPU tests initially ignored. Does not exercise the adapter's event wiring. |
| `cargo test --locked --manifest-path native/Cargo.toml -p machinewright-render gpu_ -- --ignored` | All four GPU tests passed on this Mac. Covers retention, eviction, depth, selection, and clipping correctness; not interactive latency. |
| `.venv/bin/python -m pytest -q tests/test_rfd19_evaluation.py` | Six tests passed. Existing worker evaluation test submits only one evaluation. |
| Two sequential calls to the real Python worker evaluation implementation, same worker, ordinary reference-project overlays | Generation 1 completed; generation 2 failed with `unknown machine template machinewright.reference.simple@1.0.0`. See R1. |

The reproduction invoked `Worker._evaluate` with real reference-project evaluation and framed events captured in memory; it did not launch Floem or validate OS transport. Other findings below are source-traced defects or architectural findings, with proposed regression scenarios. No interactive GUI, packaging, IME, accessibility, or performance acceptance is claimed. Only this review document was added; implementation files were not edited.

## Findings and actionable items

P1 means a correctness or availability issue in a central M2 workflow. P2 means an important integration, organization, or acceptance gap. These are recommended priorities, not a demand to finish later milestones.

### R1 — P1: repeated unsaved evaluation breaks the long-lived worker

**Evidence:** [worker.py](../src/machinewright/worker.py), lines 94–137 and 185–189; [evaluation.py](../src/machinewright/evaluation.py), lines 281–304.

`_materialize_overlay` imports the project from a new temporary root. On the next evaluation, `_clear_modules` checks modules against the original project root, so it leaves modules loaded from the previous temporary root in `sys.modules`. It nevertheless clears the template registry. `load_declared_templates` then imports the already-loaded module, whose decorators do not run again. The second evaluation cannot find its template. The previous temporary directory has also been deleted.

**Reproduced:** use one `Worker(EventWriter(BytesIO()))`, call `_evaluate` twice with generations 1 and 2, template `machinewright.reference.simple@1.0.0`, `examples/inputs/reference.json`, and an overlay containing the current `examples/reference_project.py`. The first completes and the second reports the error above. Even an unchanged overlay triggers it.

**Action:** track and unload project modules from the actual materialized evaluation root, remove temporary import paths, and make registry repopulation consistent with module reloading. Preserve shared Core imports. Do not use a fresh worker per edit as the permanent workaround.

**Done when:** one OS worker successfully processes success → changed overlay → syntax error → corrected overlay → success, including an edited imported helper module; results and source mappings reflect the new bytes. This is the first prerequisite for both M2 authoring and M3 repeated evaluations.

### R2 — P1: undo, redo, and disk reload bypass reevaluation

**Evidence:** [Floem main.rs](../native/adapters/floem/src/main.rs), lines 1309–1372, 1429–1475, and 2404–2428.

The single `programmatic_edit` flag suppresses evaluation for all programmatic buffer changes. That is appropriate for rebinding a tab, but the same flag is set for Undo, Redo, Reload from Disk, and watcher-driven reloads. These change the authoritative source. After a successful evaluation of B, undoing to A can leave B's geometry displayed with the previous ready status. A source mutation during an outstanding evaluation also fails to supersede that generation.

**Action:** drive invalidation/debounce from session `DocumentChanged` events, not from whether the editor callback came from typing. Treat display rebinding separately from semantic source changes. External changes to project dependencies must invalidate the result even when the file is not active.

**Done when:** typing, undo, redo, reload, and external helper-file edits each advance the evaluation revision as appropriate; switching tabs does not. Old completions are rejected after each source-changing action.

### R3 — P1: the declared source correspondence does not reach the UI correctly

**Evidence:** [evaluation.py](../src/machinewright/evaluation.py), lines 161–200; [model lib.rs](../native/crates/machinewright-model/src/lib.rs), lines 243–296; [app lib.rs](../native/crates/machinewright-app/src/lib.rs), lines 306–311; [Floem main.rs](../native/adapters/floem/src/main.rs), lines 1118–1158 and 1900–1985.

There are three concrete breaks in the correspondence path:

- Python emits the whole-template mapping before narrower node hints. `source_for_node` returns the first matching mapping, so component selection navigates to the whole template even when a specific node span is available.
- Source selection retains multiple `graph_node_ids` in the model, but the adapter/render selection uses only `graph_node_id`. An expression owning multiple parts highlights just the primary item. The graph list also has its own selection index rather than a selection derived from the shared node set.
- Stale-source checking only checks already-open documents. When a mapped file was changed externally but has not been opened, navigation checks freshness before opening it and can apply old offsets to its new contents.

**Action:** define deterministic mapping precedence (node definition/call-site first, broader template fallback); carry a selected node set plus a primary navigation target into both graph and viewport; validate the target document digest before navigating, including newly opened files.

**Done when:** two instances from one source mapping both highlight; clicking either component finds its specific source; changed unopened sources offer the evaluated revision instead of navigating blindly. No face-level identity work is necessary for this M2 fix.

### R4 — P1: Retry Worker clears the error without recovering the worker

**Evidence:** [Floem main.rs](../native/adapters/floem/src/main.rs), lines 537–546, 630–680, and 876–884.

After restart exhaustion or a failed respawn, the retry handler resets the supervisor and clears health text, then continues waiting. It neither spawns a replacement nor schedules the failed/latest evaluation. The old process remains unusable. A later evaluation can be sacrificed just to discover that the worker is still dead and trigger a respawn.

**Action:** make retry an explicit recovery operation: resolve/validate the environment, spawn and negotiate a new worker, replace its sender, then enqueue the latest valid request. Clear the recovery state only after successful connection. Keep cancellation/write failures from preventing replacement scheduling.

**Done when:** deliberately exhaust restarts, restore a working environment, and press Retry once; the latest source evaluates without another edit or extra Evaluate click, while the old snapshot remains interactive.

### R5 — P1: cached inspection depends on successful worker startup

**Evidence:** [Floem main.rs](../native/adapters/floem/src/main.rs), lines 2620–2675; `EnvironmentSpec::resolve`, cache restore, and `start_worker` all precede the normal `launch` path.

A missing environment routes to `startup_error_app` before cache restoration. Failed worker negotiation also routes to that source-only error screen even if a snapshot was restored. A slow/hung initial handshake delays the application window. Consequently, a healthy cache does not provide the required last-known-good inspection experience when the evaluator is unavailable.

**Action:** launch the workspace with a disconnected evaluator state, restore/prepare cached inspection asynchronously, and connect the worker independently with a timeout. Keep recovery controls in the normal workspace.

**Done when:** after one successful run, make the interpreter unavailable and reopen the project. Graph, geometry, and evaluated source remain inspectable, with a clear unavailable/stale status and working retry.

### R6 — P1: viewport drag state never ends on release

**Evidence:** [Floem main.rs](../native/adapters/floem/src/main.rs), lines 2171–2243. PointerDown stores `button: Some(...)`; PointerMove uses that stored value; the click/PointerUp path never resets it. No release/cancel handler clears the state.

After a click or drag, subsequent pointer movement can continue orbiting or panning without a held button. The movement threshold suppresses picks after a drag but does not terminate the gesture.

**Action:** add a framework-neutral gesture controller with explicit press/move/release/cancel transitions. Have Floem translate pointer events and manage capture. Always terminate on release/cancellation, including release outside the viewport; preserve the completed gesture's click-vs-drag result separately.

**Done when:** click → release → hover never changes the camera; drag outside → release → reenter does not resume dragging. This also makes navigation reusable by another viewport host.

### R7 — P2: snapshot installation has multiple owners and resets the user's camera

**Evidence:** [Floem main.rs](../native/adapters/floem/src/main.rs), lines 905–934 and 1044–1067; [app lib.rs](../native/crates/machinewright-app/src/lib.rs), `ProjectSession::remap_selection` and `InstallSnapshot`.

The adapter owns `current_snapshot`, `current_scene`, `selected`, node details, source-location text, cache lease, and status alongside overlapping session state. It prepares viewport selection from the adapter's old `selected` value before the session remaps selection, ignores the dispatch result, and does not derive the remaining panels from the remapped selection. The session's tests for removed/remapped nodes therefore do not establish UI correctness.

Every successful evaluation also calls `fit_camera`, overwriting an inspection angle/zoom even for a minor source edit. M3 point-to-point comparison will inherit these problems.

**Action:** introduce one accepted presentation update containing the snapshot identity, prepared scene handle, retained lease, diagnostics, and reconciled selection. Derive adapter signals from it. Keep the camera as explicit view state; fit on first load or user command, with a defined fallback when bounds make the existing view unusable.

**Done when:** snapshot replacement updates every panel consistently, removed selections clear everywhere, surviving selections remap, and ordinary reevaluation preserves camera orientation/zoom.

### R8 — P2: retained GPU buffers still have expensive scene ownership around them

**Evidence:** [render lib.rs](../native/crates/machinewright-render/src/lib.rs), lines 277–314, 489–501, 749–756, and 1272–1317; [Floem main.rs](../native/adapters/floem/src/main.rs), lines 166–172, 1044–1054, and 2199–2219.

`Scene` owns `Mesh` values containing vertex, normal, index, and BVH vectors. `scene.clone()` therefore deep-copies geometry on UI camera/selection events. `Scene::load` does filesystem reads, decoding, placement, and BVH construction inside the foreground result callback. The renderer then hashes every vertex and index on every draw to recover a GPU cache key. It discards the authoritative mesh digest already available in the snapshot.

Placement is baked into each mesh's CPU vertices, so repeated instances and placement-only changes lose the opportunity to share local-space geometry and GPU buffers. These are structural costs; this review did not measure whether a specific frame budget is exceeded.

**Action:** first prepare scenes off-thread and send `Arc<Scene>`/shared immutable meshes across the render boundary. Retain a validated resource identity computed once. Separate instance placement from mesh resources, allowing shared geometry and per-instance transforms; transform picking rays into mesh-local space. The latter can be a follow-up within this boundary cleanup, not a prerequisite for shipping the first shared-scene change.

**Done when:** camera/selection requests clone handles, unchanged geometry is not redecoded or rehashed, and repeated instances can share one mesh resource. Measure foreground callback time and render latency at both 100k and 1M triangles after the change.

### R9 — P2: structured evaluation diagnostics are discarded at the Rust boundary

**Evidence:** [worker.py](../src/machinewright/worker.py), lines 224–249; [evaluator lib.rs](../native/crates/machinewright-evaluator/src/lib.rs), lines 440–480; [Floem main.rs](../native/adapters/floem/src/main.rs), lines 986–1022 and 1043–1072.

Python emits failure code, traceback, and `diagnostics_json`; `WorkerProcess::evaluate` reduces these to `PortError(failed.message)` and discards progress. The adapter displays the failure string. Successful snapshot diagnostics are also not fed into the visible diagnostics panel, whose contents come from the language server. Hardware validation and compatibility diagnostics cannot be inspected through their structured identities/context.

**Action:** carry typed evaluation events and failures through the evaluator/application boundary, including session/generation, stable diagnostic identity, source/node references, and traceback details. Keep language diagnostics and evaluation diagnostics distinguishable in the UI. Completion routing should also validate the event's session and generation rather than accepting the first terminal event.

**Done when:** a hardware validation failure exposes actionable diagnostics linked to source/graph while retaining the last valid geometry. A successful result with warnings keeps those warnings visible. This supplies M3 constraint displays with a usable foundation.

### R10 — P2: the LSP message limit does not bound a silent server

**Evidence:** [language lib.rs](../native/crates/machinewright-language/src/lib.rs), lines 129–163 and 230–268; [Floem main.rs](../native/adapters/floem/src/main.rs), lines 303–370.

The diagnostics loop limits the number of messages but blocks in `read_line`/`read_exact`. A server that publishes nothing can block indefinitely before consuming even one message. The single service thread then cannot process later document updates; its unbounded request queue retains successive full source strings. Respawn-on-error never activates while the read is stuck.

**Action:** separate transport reading from document command dispatch, use an elapsed deadline/cancellable wait, and treat publishDiagnostics as asynchronous notifications. Coalesce superseded document versions while preserving open/change/save/close ordering. Wire the existing `did_close` port on tab closure; the adapter currently has no close request variant.

**Done when:** a fake server that accepts a document but stays silent cannot stall future updates or grow the queue without bound, and closing a document sends its lifecycle notification. A complete completion/hover UI is separate scope from fixing transport availability.

### R11 — P2: cache publication and source capture are not one accepted revision

**Evidence:** [Floem main.rs](../native/adapters/floem/src/main.rs), lines 570–623; [cache lib.rs](../native/crates/machinewright-cache/src/lib.rs), lines 200–285; [worker.py](../src/machinewright/worker.py), lines 94–116.

The latest-generation check happens before cache import, but import stages artifacts and then waits for a store lock before unconditionally replacing the last-valid pointer. A newer edit during that interval can leave a superseded result in the durable pointer even though the UI rejects it.

Separately, Rust reads project files before Python independently copies the project tree. An external edit between those operations can associate the result with different cached source bytes. Cache import hashes supplied sources but does not verify them against snapshot source mappings. “Read immediately before” narrows this race without establishing correspondence.

**Action:** stage artifacts independently, then publish last-valid under an acceptance/revision protocol shared with the coordinator; a stale result may remain an immutable cache entry without becoming the accepted pointer. Evaluate an immutable captured source tree, or have the worker return exact evaluated source blobs/read-set and validate their digests before publication.

**Done when:** a test pauses import before pointer promotion, schedules a newer revision, and proves the old import cannot become last-valid. Another changes an unopened source during evaluation and proves cached evaluated source matches the snapshot mapping exactly.

### R12 — P2: input and service ownership need small changes before M3

**Evidence:** [app lib.rs](../native/crates/machinewright-app/src/lib.rs), lines 60–125; [Floem main.rs](../native/adapters/floem/src/main.rs), `start_worker`, `start_language`, and `schedule_evaluation` (lines 294–742).

The project selects the first template and input configuration, and every request rereads input JSON and the environment lock from disk. Editing an open input JSON file therefore does not change `inputs_json` until saved, even though that file may also be included as an overlay. M3 controls have no session-owned input revision to update. Request construction also performs disk I/O synchronously from the editor's scheduling path.

Most worker supervision, debounce, cancellation, cache acceptance, and service queues live in the Floem executable. The headless smoke bypasses that orchestration and cannot validate it. Merely keeping Floem types out of the other crates does not make these behaviors reusable.

**Action:** move service orchestration into a framework-neutral runtime module with injectable ports. Capture effective template/input/environment/source identity into an immutable evaluation request. If input files are editable, use their session contents; otherwise make their save/evaluate semantics explicit. Add a command for changing typed inputs later, without implementing the M3 controls now.

**Done when:** a fake port can exercise debounce, cancellation, retry, and stale-result acceptance without launching Floem; two input records for the same source can be requested and identified independently. Input file behavior is tested and unambiguous.

## Recommended organization change

Keep the existing workspace. Split responsibilities before adding more features to the approximately 2,700-line adapter and 2,200-line render module. Start with internal Rust modules; introduce new crates only where independent consumers or dependency isolation justify them.

| Boundary | Owns | Excludes |
| --- | --- | --- |
| Application session/runtime | Commands, source/input revisions, evaluator lifecycle, acceptance, shared selection, diagnostic state | Floem signals/widgets, GPU resources |
| Scene preparation | Snapshot/artifact mapping, validated resource identity, shared mesh data, instances, bounds and pick acceleration | Native event types, disk access during interaction |
| Viewport/camera | Camera math, navigation commands, gesture lifecycle, visibility/selection/measurement presentation | Project discovery, Python protocol, GPU readback |
| Render backend | GPU resources, draw submission, targets/readback | Source navigation, graph policy, evaluation scheduling |
| Floem adapter | Widgets, event translation, focus/capture, rendering application view state | A second application state machine |

For another graphics use case, the camera should be directly reusable; a scene consumer should supply stable object IDs, geometry, transforms, and view state without constructing a `ProjectSnapshot` or reading a Machinewright project. Keep the graph-node-to-object mapping at the Machinewright scene boundary. Avoid speculative plugin systems, generic scene frameworks, or a UI toolkit migration.

## M2 closure and M3 entry plan

1. **Repair the working loop:** R1, R2, R4, R5, and R6. Add a repeated-worker integration test and a small adapter/runtime scenario covering edit → undo → failure → recovery. These deliver more value than adding another viewport feature.
2. **Make inspection trustworthy:** R3, R7, R9, and R11. Install one coherent accepted result; preserve exact evaluated source and show meaningful diagnostics.
3. **Make the seam reusable:** R8, R10, and R12. Share geometry, move preparation/services off the foreground path, and define effective input identity before implementing M3 controls.
4. **Record acceptance evidence:** freeze actual platform/workload budgets and run the integrated paths. Update the RFD/adapter checkpoint to distinguish implemented, tested, and accepted.

The current [benchmarks](../native/benches/benches) are useful components, but worker restart measures supervisor decisions rather than a killed/replaced process, and the 100-point behavior benchmark measures synthetic session bookkeeping rather than evaluation/cancellation. The render benchmark omits the adapter's foreground scene cloning and preparation. These must not be substituted for the RFD's end-to-end workloads.

The [native CI workflow](../.github/workflows/native.yml) builds the adapter on three platforms and tests core crates; it does not establish packaged launch, interactive authoring, accessibility, IME, or frame-latency acceptance. The current [authoring smoke](../native/adapters/floem/src/bin/authoring_smoke.rs) evaluates once and does not use the production orchestration loop. Extend that coverage with the scenarios above and record supported-platform status explicitly.

The September 9 M2 amendment also names command palette/find/replace/go-to-line UI, capability-gated language operations, and production IPC transports. Find/replace and go-to-line exist as core commands but are not exposed in the inspected adapter; language capabilities are represented without corresponding interactive request commands. Decide and document their M2 closure scope. Stdio remains an acceptable bootstrap in the broader RFD, so switching transports should not precede fixing lifecycle correctness. Likewise, the fixed 800×600 viewport and synchronous render-thread readback need measured resize/DPI and latency acceptance, not an automatic rendering rewrite.

Do not block this cleanup on M3's plots, sensitivity analysis, candidate exploration, full sweep scheduling UI, M4 publication/Fabricate parity, M5 evidence, unrestricted graphical editing, or kernel-level face identity. The M3 entry goal is a dependable repeated-evaluation and inspection system with explicit input identity and reusable view state.
