/**
 * B.4: three.js viewport (RFD-19 "3D viewport" / architecture-spike steps
 * 6, 7, 15). Owns its own scene, camera, GPU resources, and animation
 * loop entirely inside the WebView (RFD line 340-341) — never driven by
 * React renders. Wired to app/src/protocol/surfaces/viewport.ts's
 * prepare/commit two-phase snapshot install (the R7-derived fix: geometry
 * is staged per generation and only swapped into the visible scene once
 * every mesh has loaded, never partially).
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { parseMwm } from "./mwm";
import {
  deserializeViewportHostCommand,
  serializeViewportSurfaceEvent,
  type MeshRefLite,
} from "../../../src/protocol/surfaces/viewport";
import { isStaleGeneration } from "../../../src/protocol/surfaces/version";

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void };
  }
}

function post(event: Parameters<typeof serializeViewportSurfaceEvent>[0]): void {
  window.ReactNativeWebView?.postMessage(serializeViewportSurfaceEvent(event));
}

// --- Scene setup -----------------------------------------------------------

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x202329); // surface.display token

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 10000);
camera.position.set(50, 50, 50);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const directional = new THREE.DirectionalLight(0xffffff, 0.8);
directional.position.set(1, 2, 3);
scene.add(directional);
scene.add(new THREE.AxesHelper(20));

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- WebGL context loss / restore (spike step 16) ---------------------------
//
// A *context* loss (this) is lighter-weight than a WKWebView content-
// process crash (handled by the RN host's onContentProcessDidTerminate,
// which reloads the whole page) — recoverable in place from cached raw
// mesh bytes without any new RN round-trip or Python reevaluation.

renderer.domElement.addEventListener(
  "webglcontextlost",
  (event) => {
    event.preventDefault();
    post({ kind: "contextLost" });
  },
  false,
);
renderer.domElement.addEventListener("webglcontextrestored", () => {
  rebuildCommittedGroupFromCache();
  post({ kind: "contextRestored" });
});

// --- Snapshot staging/commit -------------------------------------------------

interface StagedMesh {
  readonly graphNodeId: string;
  readonly parsed: ReturnType<typeof parseMwm>;
}

const meshCache = new Map<string, ReturnType<typeof parseMwm>>(); // keyed by mesh URL
const staging = new Map<string, { total: number; loaded: StagedMesh[]; failed: boolean }>(); // keyed by generation (decimal string)
let committedGeneration = -1n;
let committedGroup: THREE.Group | null = null;
let hasFitCameraOnce = false;

function buildMeshObject(staged: StagedMesh): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(staged.parsed.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(staged.parsed.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(staged.parsed.indices, 1));
  const material = new THREE.MeshStandardMaterial({ color: 0xfafaf8, metalness: 0.1, roughness: 0.7 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.graphNodeId = staged.graphNodeId;
  return mesh;
}

function rebuildCommittedGroupFromCache(): void {
  if (!committedGroup) return;
  const rebuilt = new THREE.Group();
  for (const child of committedGroup.children) {
    if (!(child instanceof THREE.Mesh)) continue;
    const graphNodeId = child.userData.graphNodeId as string;
    // Positions/normals/indices are still valid JS-heap data even after a
    // GPU context loss (only the uploaded buffers are gone) — nothing to
    // re-fetch, just re-upload by constructing fresh THREE objects.
    rebuilt.add(buildMeshObject({ graphNodeId, parsed: (child.geometry as THREE.BufferGeometry).userData.parsed }));
  }
  scene.remove(committedGroup);
  committedGroup = rebuilt;
  scene.add(committedGroup);
}

/**
 * WKWebView's `fetch()` rejects `file://` URLs with a bare "TypeError:
 * Load failed" even when `allowingReadAccessToURL` grants read access
 * (a known WebKit quirk — fetch()'s CORS-style checks treat the file:
 * scheme more restrictively than ordinary resource loading does).
 * XMLHttpRequest does not have this restriction, so mesh bytes are loaded
 * through it instead.
 */
function loadArrayBuffer(url: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("GET", url, true);
    request.responseType = "arraybuffer";
    request.onload = () => {
      if (request.status !== 0 && request.status >= 400) {
        reject(new Error(`GET ${url} failed: ${request.status}`));
        return;
      }
      resolve(request.response as ArrayBuffer);
    };
    request.onerror = () => reject(new Error(`GET ${url} failed (network error)`));
    request.send();
  });
}

async function handlePrepareSnapshot(
  generation: bigint,
  meshes: readonly MeshRefLite[],
): Promise<void> {
  const key = generation.toString();
  const entry = { total: meshes.length, loaded: [] as StagedMesh[], failed: false };
  staging.set(key, entry);

  await Promise.all(
    meshes.map(async (ref) => {
      try {
        let parsed = meshCache.get(ref.url);
        if (!parsed) {
          parsed = parseMwm(await loadArrayBuffer(ref.url));
          meshCache.set(ref.url, parsed);
        }
        entry.loaded.push({ graphNodeId: ref.graphNodeId, parsed });
      } catch (error) {
        entry.failed = true;
        if (isStaleGeneration(committedGeneration, generation) === false) {
          post({ kind: "prepareFailed", generation, reason: String(error) });
        }
      }
    }),
  );

  if (!entry.failed && staging.has(key)) {
    post({ kind: "prepared", generation });
  }
}

function handleCommitSnapshot(generation: bigint): void {
  const key = generation.toString();
  const entry = staging.get(key);
  if (!entry || entry.failed) return;
  // R7 regression guard: a newer generation may have already committed
  // while this one was staging (network/fetch timing) — never let a
  // stale commit win.
  if (isStaleGeneration(committedGeneration, generation)) {
    staging.delete(key);
    return;
  }

  if (committedGroup) {
    scene.remove(committedGroup);
    for (const child of committedGroup.children) {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
  }

  const group = new THREE.Group();
  for (const staged of entry.loaded) {
    const mesh = buildMeshObject(staged);
    // Keep the parsed CPU-side data attached so a later context-loss
    // rebuild doesn't need to re-fetch (see rebuildCommittedGroupFromCache).
    (mesh.geometry as THREE.BufferGeometry).userData.parsed = staged.parsed;
    group.add(mesh);
  }
  scene.add(group);
  committedGroup = group;
  committedGeneration = generation;
  staging.delete(key);

  // R7: camera is explicit view state, fit only on first load or an
  // explicit command — never implicitly on every accepted snapshot.
  if (!hasFitCameraOnce) {
    fitCameraToGroup(group);
    hasFitCameraOnce = true;
  }
}

function handleDiscardSnapshot(generation: bigint): void {
  staging.delete(generation.toString());
}

function fitCameraToGroup(group: THREE.Group): void {
  const box = new THREE.Box3().setFromObject(group);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z) || 1;
  const distance = maxDimension * 2;
  camera.position.set(center.x + distance, center.y + distance, center.z + distance);
  controls.target.copy(center);
  camera.updateProjectionMatrix();
}

// --- B.7 synthetic-triangle-count benchmark ----------------------------------
//
// Measures actual frame rate at a target triangle count instead of assuming
// one (RFD-19 "Responsiveness and resource budgets"). Bypasses the prepare/
// commit staging path entirely — there is no real generation or worker
// evaluation behind a synthetic mesh, so it is installed directly.

function buildSyntheticMesh(triangleCount: number): THREE.Mesh {
  // A flat grid of unit quads (2 triangles each) is cheap to generate
  // exactly up to a requested triangle count and exercises the same
  // BufferGeometry/vertex/index upload path as a real .mwm2 mesh.
  const quadCount = Math.ceil(triangleCount / 2);
  const cols = Math.ceil(Math.sqrt(quadCount));
  const rows = Math.ceil(quadCount / cols);
  const geometry = new THREE.PlaneGeometry(cols, rows, cols, rows);
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    color: 0xfafaf8,
    metalness: 0.1,
    roughness: 0.7,
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(geometry, material);
}

function runBenchmark(triangleCount: number): void {
  if (committedGroup) {
    scene.remove(committedGroup);
    for (const child of committedGroup.children) {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
  }
  const group = new THREE.Group();
  group.add(buildSyntheticMesh(triangleCount));
  scene.add(group);
  committedGroup = group;
  fitCameraToGroup(group);

  const durationMs = 3000;
  let frames = 0;
  const start = performance.now();

  function tick(): void {
    frames += 1;
    const elapsed = performance.now() - start;
    if (elapsed < durationMs) {
      requestAnimationFrame(tick);
      return;
    }
    post({
      kind: "benchmarkResult",
      triangleCount,
      fps: (frames / elapsed) * 1000,
      frames,
      durationMs: elapsed,
    });
  }
  requestAnimationFrame(tick);
}

// --- Picking (spike step 7) --------------------------------------------------

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

renderer.domElement.addEventListener("click", (event) => {
  if (!committedGroup) return;
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(committedGroup.children, false);
  const hit = hits[0]?.object;
  post({
    kind: "pickResult",
    generation: committedGeneration,
    graphNodeId: (hit?.userData.graphNodeId as string | undefined) ?? null,
    geometryEntityId: null,
  });
});

// --- Host command dispatch ---------------------------------------------------

window.addEventListener("message", (event: MessageEvent<string>) => {
  const command = deserializeViewportHostCommand(event.data);
  switch (command.kind) {
    case "prepareSnapshot":
      void handlePrepareSnapshot(command.generation, command.meshes);
      break;
    case "commitSnapshot":
      handleCommitSnapshot(command.generation);
      break;
    case "discardSnapshot":
      handleDiscardSnapshot(command.generation);
      break;
    case "setSelection": {
      if (!committedGroup) break;
      for (const child of committedGroup.children) {
        if (!(child instanceof THREE.Mesh)) continue;
        const material = child.material as THREE.MeshStandardMaterial;
        const selected = command.nodeIds.includes(child.userData.graphNodeId as string);
        material.emissive.set(selected ? 0x007ea8 : 0x000000); // accent.selection token
      }
      break;
    }
    case "fitCamera":
      if (committedGroup) fitCameraToGroup(committedGroup);
      break;
    case "benchmarkSynthetic":
      runBenchmark(command.triangleCount);
      break;
  }
});

// --- Animation loop -----------------------------------------------------------

function animate(): void {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

post({ kind: "ready" });
