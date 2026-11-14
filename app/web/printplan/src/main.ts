/**
 * Print-plate viewer: a bed (grid, outline, build volume) with one plate STL
 * on it, orbitable. Z is up and the STL is already in bed coordinates, so no
 * per-part transforms happen here. Owns its own scene and render loop; driven
 * only by the commands in protocol/surfaces/printplan.ts.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import theme from "../../design-system/generated/viewport-theme.json";
import {
  deserializePrintPlanHostCommand,
  serializePrintPlanSurfaceEvent,
  type PlateBed,
  type PlateViewPart,
} from "../../../src/protocol/surfaces/printplan";

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void };
  }
}

function post(event: Parameters<typeof serializePrintPlanSurfaceEvent>[0]): void {
  window.ReactNativeWebView?.postMessage(serializePrintPlanSurfaceEvent(event));
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(theme["color-surface-display"]);

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 1, 20000);
camera.up.set(0, 0, 1);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.499; // never orbit under the bed

scene.add(new THREE.AmbientLight(0xffffff, 0.65));
const key = new THREE.DirectionalLight(0xffffff, 0.8);
key.position.set(-1, -2, 3);
scene.add(key);

// The floating tool boxes are native views over this WebView. A press that lands on one can
// still reach the page as a pointerdown, while its release goes to the native control and never
// arrives here — OrbitControls would then keep rotating with the bare mouse until the next click.
// A pointer move with no button held proves the press is over, so release the drag ourselves.
let pointerDown = false;
renderer.domElement.addEventListener("pointerdown", () => (pointerDown = true), true);
for (const type of ["pointerup", "pointercancel"] as const) document.addEventListener(type, () => (pointerDown = false), true);
document.addEventListener(
  "pointermove",
  (event) => {
    if (!pointerDown || event.buttons !== 0) return;
    pointerDown = false;
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: event.pointerId, pointerType: event.pointerType, bubbles: true }));
  },
  true,
);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

let bed: PlateBed = { bedX: 220, bedY: 220, maxZ: 250, origin: "corner", margin: 5 };
const bedGroup = new THREE.Group();
scene.add(bedGroup);
const plateGroup = new THREE.Group();
scene.add(plateGroup);

function disposeChildren(group: THREE.Group): void {
  for (const child of [...group.children]) {
    group.remove(child);
    child.traverse((object) => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose();
    });
  }
}

function buildBed(): void {
  disposeChildren(bedGroup);
  const x0 = bed.origin === "center" ? -bed.bedX / 2 : 0;
  const y0 = bed.origin === "center" ? -bed.bedY / 2 : 0;
  const cx = x0 + bed.bedX / 2;
  const cy = y0 + bed.bedY / 2;

  const surface = new THREE.Mesh(
    new THREE.PlaneGeometry(bed.bedX, bed.bedY),
    new THREE.MeshBasicMaterial({ color: theme["color-surface-panel"] }),
  );
  surface.position.set(cx, cy, -0.05);
  bedGroup.add(surface);

  // 10 mm grid across the bed.
  const points: number[] = [];
  for (let x = 0; x <= bed.bedX + 1e-6; x += 10) points.push(x0 + x, y0, 0, x0 + x, y0 + bed.bedY, 0);
  for (let y = 0; y <= bed.bedY + 1e-6; y += 10) points.push(x0, y0 + y, 0, x0 + bed.bedX, y0 + y, 0);
  const gridGeometry = new THREE.BufferGeometry();
  gridGeometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  bedGroup.add(
    new THREE.LineSegments(gridGeometry, new THREE.LineBasicMaterial({ color: theme["color-border-subtle"], transparent: true, opacity: 0.55 })),
  );

  // Build volume outline (bed edge up to the printer's max height).
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(bed.bedX, bed.bedY, bed.maxZ).translate(cx, cy, bed.maxZ / 2)),
    new THREE.LineBasicMaterial({ color: theme["color-text-secondary"], transparent: true, opacity: 0.4 }),
  );
  bedGroup.add(edges);

  // Origin marker: copper X, green Y.
  const axes = new THREE.AxesHelper(Math.min(bed.bedX, bed.bedY) * 0.12);
  axes.setColors(new THREE.Color(theme["color-accent-action"]), new THREE.Color(theme["color-status-success"]), new THREE.Color(theme["color-accent-selection"]));
  axes.position.set(0, 0, 0.05);
  bedGroup.add(axes);
}

function fitCamera(): void {
  const x0 = bed.origin === "center" ? -bed.bedX / 2 : 0;
  const y0 = bed.origin === "center" ? -bed.bedY / 2 : 0;
  const target = new THREE.Vector3(x0 + bed.bedX / 2, y0 + bed.bedY / 2, 0);
  const span = Math.max(bed.bedX, bed.bedY);
  controls.target.copy(target);
  camera.position.set(target.x - span * 0.35, target.y - span * 1.0, span * 0.85);
  camera.lookAt(target);
  controls.update();
}

function loadArrayBuffer(url: string): Promise<ArrayBuffer> {
  // XMLHttpRequest, not fetch(): WKWebView's fetch rejects file:// URLs (see viewport/src/main.ts).
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("GET", url, true);
    request.responseType = "arraybuffer";
    request.onload = () => {
      if (request.status !== 0 && request.status >= 400) reject(new Error(`GET ${url} failed: ${request.status}`));
      else resolve(request.response as ArrayBuffer);
    };
    request.onerror = () => reject(new Error(`GET ${url} failed (network error)`));
    request.send();
  });
}

let currentKey = "";
const loader = new STLLoader();

/** A part of the shown plate as its own mesh, so it can be dragged. `x`/`y` are its current corner. */
interface PlatePart {
  readonly view: PlateViewPart;
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshStandardMaterial;
  x: number;
  y: number;
}
let plateParts: PlatePart[] = [];

const PART_COLOR = new THREE.Color(theme["color-material-printed"]);
const CLASH_COLOR = new THREE.Color(theme["color-status-error"]);

function newMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: PART_COLOR, metalness: 0.05, roughness: 0.65 });
}

/**
 * Splits the plate's triangles into one mesh per part. The plan's footprints never overlap, so a
 * triangle belongs to the part whose footprint (where it sits in the file) contains its centroid.
 */
function buildParts(source: THREE.BufferGeometry, views: readonly PlateViewPart[]): void {
  const offsetX = bed.origin === "center" ? -bed.bedX / 2 : 0;
  const offsetY = bed.origin === "center" ? -bed.bedY / 2 : 0;
  const positions = source.getAttribute("position");
  const buckets: number[][] = views.map(() => []);
  const rest: number[] = [];
  const EPS = 1e-3;
  for (let tri = 0; tri < positions.count; tri += 3) {
    let cx = 0;
    let cy = 0;
    for (let k = 0; k < 3; k++) {
      cx += positions.getX(tri + k) / 3;
      cy += positions.getY(tri + k) / 3;
    }
    cx -= offsetX;
    cy -= offsetY;
    const target = views.findIndex(
      (v) => cx >= v.originX - EPS && cx <= v.originX + v.width + EPS && cy >= v.originY - EPS && cy <= v.originY + v.depth + EPS,
    );
    const bucket = target < 0 ? rest : buckets[target];
    for (let k = 0; k < 3; k++) bucket.push(positions.getX(tri + k), positions.getY(tri + k), positions.getZ(tri + k));
  }
  const make = (flat: number[]): THREE.Mesh => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(flat, 3));
    geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, newMaterial());
  };
  views.forEach((view, index) => {
    if (buckets[index].length === 0) return;
    const mesh = make(buckets[index]);
    mesh.position.set(view.x - view.originX, view.y - view.originY, 0);
    plateGroup.add(mesh);
    plateParts.push({ view, mesh, material: mesh.material as THREE.MeshStandardMaterial, x: view.x, y: view.y });
  });
  if (rest.length > 0) plateGroup.add(make(rest));
}

async function showPlate(plateKey: string, url: string | null, views: readonly PlateViewPart[]): Promise<void> {
  currentKey = plateKey;
  dragging = null;
  if (url === null) {
    disposeChildren(plateGroup);
    plateParts = [];
    return;
  }
  try {
    const geometry = loader.parse(await loadArrayBuffer(url));
    if (currentKey !== plateKey) {
      geometry.dispose();
      return; // superseded while loading
    }
    disposeChildren(plateGroup);
    plateParts = [];
    if (views.length > 0) {
      buildParts(geometry, views);
      geometry.dispose();
    } else {
      geometry.computeVertexNormals();
      plateGroup.add(new THREE.Mesh(geometry, newMaterial()));
    }
    post({ kind: "plateLoaded", key: plateKey });
  } catch (error) {
    if (currentKey === plateKey) post({ kind: "plateFailed", key: plateKey, reason: String(error) });
  }
}

// --- Dragging parts across the bed -----------------------------------------------------------
// A press on a part drags it along the horizontal plane through the point grabbed; a press on
// empty space orbits as before. The press is intercepted on the document in the capture phase so
// OrbitControls never sees it. A drop that overlaps another part snaps back, so the layout the
// shell holds is always valid.

interface Drag {
  readonly part: PlatePart;
  readonly plane: THREE.Plane;
  readonly grab: THREE.Vector3;
  readonly startX: number;
  readonly startY: number;
}
let dragging: Drag | null = null;
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();

function aimRay(event: PointerEvent): void {
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNdc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointerNdc, camera);
}

function partUnderPointer(event: PointerEvent): { part: PlatePart; point: THREE.Vector3 } | null {
  if (plateParts.length === 0) return null;
  aimRay(event);
  const hit = raycaster.intersectObjects(plateParts.map((p) => p.mesh), false)[0];
  const part = hit ? plateParts.find((p) => p.mesh === hit.object) : undefined;
  return hit && part ? { part, point: hit.point } : null;
}

function overlaps(a: PlatePart, b: PlatePart): boolean {
  const eps = 1e-6;
  return (
    a.x < b.x + b.view.width - eps && b.x < a.x + a.view.width - eps && a.y < b.y + b.view.depth - eps && b.y < a.y + a.view.depth - eps
  );
}

function clashes(part: PlatePart): boolean {
  return plateParts.some((other) => other !== part && overlaps(part, other));
}

function placePart(part: PlatePart, x: number, y: number): void {
  part.x = x;
  part.y = y;
  part.mesh.position.set(x - part.view.originX, y - part.view.originY, 0);
}

function clampToBed(value: number, size: number, extent: number): number {
  const low = bed.margin;
  const high = extent - bed.margin - size;
  return high < low ? low : Math.min(Math.max(value, low), high);
}

function endDrag(): void {
  const drag = dragging;
  if (!drag) return;
  dragging = null;
  const { part } = drag;
  part.material.color.copy(PART_COLOR);
  if (clashes(part)) placePart(part, drag.startX, drag.startY);
  if (part.x !== drag.startX || part.y !== drag.startY) post({ kind: "partMoved", key: currentKey, id: part.view.id, x: part.x, y: part.y });
  renderer.domElement.style.cursor = "";
}

document.addEventListener(
  "pointerdown",
  (event) => {
    if (event.button !== 0 || event.target !== renderer.domElement) return;
    const hit = partUnderPointer(event);
    if (!hit) return;
    event.stopPropagation();
    event.preventDefault();
    dragging = {
      part: hit.part,
      plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), -hit.point.z),
      grab: hit.point.clone(),
      startX: hit.part.x,
      startY: hit.part.y,
    };
    renderer.domElement.style.cursor = "grabbing";
  },
  true,
);

document.addEventListener(
  "pointermove",
  (event) => {
    if (dragging && event.buttons === 0) {
      endDrag(); // the release went elsewhere (a native tool box over the page)
      return;
    }
    if (dragging) {
      aimRay(event);
      const point = raycaster.ray.intersectPlane(dragging.plane, new THREE.Vector3());
      if (!point) return;
      const { part, grab, startX, startY } = dragging;
      placePart(
        part,
        clampToBed(startX + point.x - grab.x, part.view.width, bed.bedX),
        clampToBed(startY + point.y - grab.y, part.view.depth, bed.bedY),
      );
      part.material.color.copy(clashes(part) ? CLASH_COLOR : PART_COLOR);
      return;
    }
    if (event.buttons === 0 && event.target === renderer.domElement) renderer.domElement.style.cursor = partUnderPointer(event) ? "grab" : "";
  },
  true,
);

for (const type of ["pointerup", "pointercancel"] as const) document.addEventListener(type, () => endDrag(), true);

function handleMessage(data: unknown): void {
  if (typeof data !== "string") return;
  const command = deserializePrintPlanHostCommand(data);
  switch (command.kind) {
    case "setBed": {
      const first = bed.bedX === command.bed.bedX && bed.bedY === command.bed.bedY && bed.origin === command.bed.origin;
      bed = command.bed;
      buildBed();
      if (!first) fitCamera();
      return;
    }
    case "showPlate":
      void showPlate(command.key, command.url, command.parts);
      return;
    case "fitCamera":
      fitCamera();
      return;
  }
}

window.addEventListener("message", (event) => handleMessage(event.data));

buildBed();
fitCamera();
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
post({ kind: "ready" });
