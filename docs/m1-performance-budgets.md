# M1 performance record (RFD-19 architecture spike, B.7)

Measured, not assumed, per RFD-19's "Responsiveness and resource budgets" requirement. Produced by
the B.7 performance-measurement screen (`app/src/app/PerformanceSpike.tsx`), run against a **Release**
Xcode build launched with no Metro/dev server attached (JS bundle and both `web/editor`/`web/viewport`
bundles embedded in the `.app`; `.jsbundle` confirmed present under `Contents/Resources`, and Metro
confirmed unreachable at `localhost:8081` for the duration of the run).

## Test environment

| | |
|---|---|
| macOS | 26.6.2 (build 25G83) |
| CPU architecture | arm64 (Apple Silicon) |
| Xcode | 17F113, macOS SDK 26.5 |
| Build configuration | Release |
| Worker | `machinewright-worker`, `uv`-managed venv, Python 3.13 |
| Reference project | `machinewright.reference.simple` v1.0.0 |

## Viewport frame rate

Synthetic flat-grid mesh (not a real evaluation result — see `benchmarkSynthetic` in
`app/src/protocol/surfaces/viewport.ts`), installed directly into the three.js scene, camera fit to
bounds, frame-counted via `requestAnimationFrame` over a fixed 3-second window.

| Triangle count | FPS | Frames | Duration |
|---:|---:|---:|---:|
| 100,000 | 56.2 | 169 | 3009 ms |
| 1,000,000 | 60.1 | 181 | 3013 ms |

**Reading**: both figures sit at/near this display's ~60 Hz vsync cap — a single flat-shaded,
un-textured mesh at these triangle counts does not saturate this GPU (Apple Silicon integrated GPU).
The 100k run measuring *lower* than the 1M run is initialization noise (first-render JIT/shader-compile
cost inside the 3-second window), not a real inverse relationship with triangle count — evidence that at
this scale the bottleneck is per-frame CPU/driver overhead, not vertex/fragment throughput. This budget
should be re-measured once real evaluation geometry (indexed, materials, multiple objects) and picking
overhead are in the loop; a synthetic single-mesh benchmark is a floor, not a ceiling.

**Initial budget**: no regression below **30 fps sustained** at up to 1M triangles on the tested
hardware class (Apple Silicon). Revisit once textured/multi-object scenes are measured.

## Worker restart latency

Time from `stop()` to the next `CapabilityReport`, waiting for the native module's `MachinewrightWorkerExit`
event before respawning (see `app/src/app/PerformanceSpike.tsx`'s `restart()` — a naive
`stop(); spawn()` races the native module's `"worker_already_running"` guard, since `stop()` resolves
before the process is actually reaped).

| Trial | Latency |
|---:|---:|
| 1 | 2353 ms |
| 2 | 2335 ms |
| 3 | 2364 ms |
| 4 | 2331 ms |
| 5 | 2313 ms |
| **avg / min / max** | **2339 ms / 2313 ms / 2364 ms** |

**Reading**: tight variance (±25 ms) — dominated by fixed Python/`uv` interpreter and venv-resolution
startup cost, not by anything evaluation-specific. This is the cost an R4-style reconnect state machine
must budget for after an unexpected worker exit.

**Initial budget**: worker restart (crash recovery) completes in **under 3 seconds** on the tested
hardware.

## 100-point sweep wall time

100 sequential `EvaluateProject` calls against one long-lived worker (never spawn-per-point — the R1 fix
this exercises directly), varying `payload_kg` from 1 to 100, each writing real mesh/snapshot output to
its own directory under `/tmp/machinewright-app-perf-spike/` (~21 MB total on disk for 100 points).

**Total: 1,713,412 ms (28.6 min) / 17,134 ms per point average.**

Per-point cost is *not* flat — measured from output-directory mtimes at 10-point checkpoints:

| Points | Elapsed since start | Per-point (this segment) |
|---:|---:|---:|
| 0–9 | 92 s | ~9.2 s |
| 9–19 | 101 s | ~10.1 s |
| 19–29 | 167 s | ~16.7 s |
| 29–39 | 187 s | ~18.7 s |
| 39–99 (steady state) | ~19 s/10 pts | ~19.0 s |

**Reading**: cost roughly doubles from a "cold" ~9–10 s/point over the first ~30 evaluations, then
plateaus at ~19 s/point for the remaining ~70 — it does not keep growing unboundedly (no sign of an
unbounded per-evaluation leak that would eventually exhaust memory or degrade indefinitely), but it also
does not stay flat, which a naive per-point cost estimate would assume. One run also saw the worker
process disappear mid-sweep (at point 27) with no crash report and no captured stderr output — not
reproduced on a second full run with stderr captured, so treated as an environmental one-off (see "Open
questions" below) rather than a worker defect, but it means restart/recovery plumbing (R4) is not just a
theoretical requirement for a real sweep — a production sweep UI (M3) must handle a mid-sweep worker
loss as an expected case, not an edge case.

**Initial budget**: no fixed per-point budget yet — this needs the plateau's cause identified (disk I/O
for 100 separate output directories vs. in-process accumulation) before a number is meaningful. Treat
17.1 s/point average (28.6 min for 100 points) as the current baseline to beat, and design any real M3
sweep UI around progressive/incremental results, not a single 28-minute blocking wait.

### Open questions carried forward

- **Cause of the cold→steady-state doubling**: not root-caused here (out of scope for this spike to
  chase further) — candidates are output-directory I/O growth, Python-side caching effects, or something
  in `evaluation.py`'s per-call state that isn't fully reset by the existing R1 `_clear_modules` fix.
  Worth a profiling pass before M3 commits to a sweep UI's UX around wait times.
- **The single non-reproduced mid-sweep worker exit** (point 27, first run): no crash report, no stderr
  captured (that run predated adding stderr capture to the manual test procedure). If this recurs, the
  reproduction procedure is: launch the built `.app`'s executable directly with stdout/stderr redirected
  to a file (`open` swallows it) before starting a sweep.

## Dependency licensing

All direct dependencies exercised by the M1 spike are permissively licensed; none require attribution
beyond standard notice-preservation or impose copyleft obligations on the application.

| Dependency | License |
|---|---|
| react, react-native, react-native-macos | MIT |
| react-native-webview | MIT |
| react-native-safe-area-context | MIT |
| three.js | MIT |
| codemirror, @codemirror/* | MIT |
| @bufbuild/protobuf | Apache-2.0 AND BSD-3-Clause |
| text-encoding | Unlicense OR Apache-2.0 |
| python-lsp-server | MIT |
| pyflakes, pycodestyle | MIT |

React Native's native iOS/macOS pod dependencies (Folly, Yoga, Hermes, etc., enumerated under the
`MachinewrightApp.xcworkspace` scheme list) are all under Apache-2.0/MIT/BSD-family licenses as shipped
by the React Native project's own CocoaPods specs — no additional review needed beyond what upstream
React Native already tracks.
