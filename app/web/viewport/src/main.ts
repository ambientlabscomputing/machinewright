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
import theme from "../../design-system/generated/viewport-theme.json";
import { parseMwm } from "./mwm";
import { materialClass, type MaterialClass } from "./materials";
import { createViewportPanel, EXPLODE_SCALE_DEFAULT, type PanelPart, type ViewMode } from "./panel";
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
scene.background = new THREE.Color(theme["color-surface-display"]);

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
const axes = new THREE.AxesHelper(20);
// Approved highlight palette only: copper (x), PCB green (y), Cherenkov blue (z).
axes.setColors(
  new THREE.Color(theme["color-accent-action"]),
  new THREE.Color(theme["color-status-success"]),
  new THREE.Color(theme["color-accent-selection"]),
);
scene.add(axes);

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
  readonly label: string;
  readonly materialName: string | null;
  readonly materialProcess: string | null;
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
  const cls = materialClass(staged.materialName, staged.materialProcess);
  const material = new THREE.MeshStandardMaterial({ color: theme[`color-material-${cls}`], metalness: 0.1, roughness: 0.7 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.graphNodeId = staged.graphNodeId;
  mesh.userData.label = staged.label;
  mesh.userData.materialName = staged.materialName;
  mesh.userData.materialProcess = staged.materialProcess;
  mesh.userData.materialClass = cls;
  // Geometry is already in world space, so exploding is a pure translation.
  mesh.visible = !hiddenNodeIds.has(staged.graphNodeId);
  // Keep the parsed CPU-side data attached so a later context-loss
  // rebuild doesn't need to re-fetch (see rebuildCommittedGroupFromCache).
  geometry.userData.parsed = staged.parsed;
  return mesh;
}

// --- View state: exploded view + per-part visibility ------------------------
//
// Both are presentation state owned by the viewport (like the camera), so
// they survive new snapshot generations: hidden parts are tracked by graph
// node id and re-applied whenever a group is built.

const hiddenNodeIds = new Set<string>();
let viewMode: ViewMode = "assembled";
let explodeProgress = 0; // 0 = assembled, 1 = fully exploded; eased toward the target in animate()
// Per-axis multiplier on each part's unscaled offset from the assembly center (panel sliders).
const explodeScale = new THREE.Vector3().setScalar(EXPLODE_SCALE_DEFAULT);

const panel = createViewportPanel(theme, {
  onModeChange: (mode) => {
    viewMode = mode;
  },
  onVisibilityChange: (ids, visible) => {
    for (const id of ids) {
      if (visible) hiddenNodeIds.delete(id);
      else hiddenNodeIds.add(id);
    }
    applyVisibility();
  },
  onExplodeScaleChange: (axis, value) => {
    explodeScale[axis] = value;
    applyExplodeProgress();
  },
  onToggleMaximize: () => post({ kind: "toggleMaximize" }),
});

let maximized = false;
// Escape leaves the maximized layout (the shell owns it; just ask).
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && maximized) post({ kind: "toggleMaximize" });
});

function meshesOf(group: THREE.Group | null): THREE.Mesh[] {
  return group ? group.children.filter((child): child is THREE.Mesh => child instanceof THREE.Mesh) : [];
}

function applyVisibility(): void {
  for (const mesh of meshesOf(committedGroup)) {
    mesh.visible = !hiddenNodeIds.has(mesh.userData.graphNodeId as string);
  }
  panel.setHidden(hiddenNodeIds);
}

/**
 * Offsets each part away from the assembly center, proportional to its own
 * distance from it (scaled per axis by `explodeScale` when applied). Computed from *all* parts (visible or not) so hiding a
 * part never shifts the others. Parts that sit at the very center (nested
 * or coaxial with identical centers) are fanned out along z instead, so
 * they still separate.
 */
function computeExplodeOffsets(group: THREE.Group): void {
  const meshes = meshesOf(group);
  const centers = meshes.map((mesh) => {
    mesh.geometry.computeBoundingBox();
    return mesh.geometry.boundingBox!.getCenter(new THREE.Vector3());
  });
  const overall = new THREE.Box3();
  for (const mesh of meshes) overall.union(mesh.geometry.boundingBox!);
  if (overall.isEmpty()) return;
  const center = overall.getCenter(new THREE.Vector3());
  const size = overall.getSize(new THREE.Vector3());
  const epsilon = Math.max(size.x, size.y, size.z) * 0.02;
  let fanIndex = 0;
  meshes.forEach((mesh, index) => {
    const offset = centers[index].clone().sub(center);
    if (offset.length() < epsilon) {
      fanIndex += 1;
      // Pre-divided by the default scale so the default look is unchanged.
      offset.set(0, 0, (fanIndex * size.z * 0.25) / EXPLODE_SCALE_DEFAULT);
    }
    mesh.userData.explodeOffset = offset;
  });
}

function applyExplodeProgress(): void {
  for (const mesh of meshesOf(committedGroup)) {
    const offset = mesh.userData.explodeOffset as THREE.Vector3 | undefined;
    if (offset) mesh.position.copy(offset).multiply(explodeScale).multiplyScalar(explodeProgress);
  }
}

function syncPanelParts(): void {
  const parts: PanelPart[] = meshesOf(committedGroup).map((mesh) => ({
    id: mesh.userData.graphNodeId as string,
    label: mesh.userData.label as string,
    materialClass: mesh.userData.materialClass as MaterialClass,
  }));
  panel.setParts(parts, hiddenNodeIds);
}

function rebuildCommittedGroupFromCache(): void {
  if (!committedGroup) return;
  const rebuilt = new THREE.Group();
  for (const child of meshesOf(committedGroup)) {
    // Positions/normals/indices are still valid JS-heap data even after a
    // GPU context loss (only the uploaded buffers are gone) — nothing to
    // re-fetch, just re-upload by constructing fresh THREE objects.
    const mesh = buildMeshObject({
      graphNodeId: child.userData.graphNodeId as string,
      label: child.userData.label as string,
      materialName: child.userData.materialName as string | null,
      materialProcess: child.userData.materialProcess as string | null,
      parsed: (child.geometry as THREE.BufferGeometry).userData.parsed,
    });
    mesh.userData.explodeOffset = child.userData.explodeOffset;
    rebuilt.add(mesh);
  }
  scene.remove(committedGroup);
  committedGroup = rebuilt;
  scene.add(committedGroup);
  applyExplodeProgress();
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
        entry.loaded.push({
          graphNodeId: ref.graphNodeId,
          label: ref.label ?? ref.graphNodeId,
          materialName: ref.materialName ?? null,
          materialProcess: ref.materialProcess ?? null,
          parsed,
        });
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
    group.add(buildMeshObject(staged));
  }
  computeExplodeOffsets(group);
  scene.add(group);
  committedGroup = group;
  applyExplodeProgress();
  syncPanelParts();
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
  // Fit what is actually on screen: visible parts at their current
  // (possibly exploded) positions, falling back to everything if all are hidden.
  const meshes = meshesOf(group);
  const shown = meshes.filter((mesh) => mesh.visible);
  const box = new THREE.Box3();
  for (const mesh of shown.length > 0 ? shown : meshes) box.expandByObject(mesh);
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
    color: theme["color-text-primary"],
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
  // Raycaster does not skip hidden objects, so filter them out explicitly.
  const hits = raycaster.intersectObjects(meshesOf(committedGroup).filter((mesh) => mesh.visible), false);
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
        material.emissive.set(selected ? theme["color-accent-selection"] : 0x000000);
        material.emissiveIntensity = 0.45;
      }
      break;
    }
    case "setMaximized":
      maximized = command.maximized;
      panel.setMaximized(maximized);
      break;
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
  const target = viewMode === "exploded" ? 1 : 0;
  if (explodeProgress !== target) {
    const next = explodeProgress + (target - explodeProgress) * 0.15;
    explodeProgress = Math.abs(target - next) < 0.001 ? target : next;
    applyExplodeProgress();
  }
  controls.update();
  renderer.render(scene, camera);
}
animate();

post({ kind: "ready" });
