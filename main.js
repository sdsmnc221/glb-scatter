/**
 * main.js — GLB Scatter dev entry
 *
 * ① Set MODEL_URL to your .glb path (drop the file in /public/models/)
 * ② pnpm dev — a placeholder cube loads if MODEL_URL is null
 *
 * Drag & drop a .glb onto the canvas at runtime too.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import gsap from "gsap";

// ─────────────────────────────────────
// CONFIG — edit these
// ─────────────────────────────────────

const MODEL_URL = "./wedo.glb"; // e.g. '/models/your-file.glb'  — null uses placeholder cube

const SCATTER = {
  radius: 320, // world-unit sphere radius
  randomRotation: true,
};
const REASSEMBLE = {
  duration: 1.8, // seconds per mesh tween
  stagger: 0.018, // delay between each mesh (seconds)
  ease: "power3.out",
};

// ─────────────────────────────────────
// SCENE
// ─────────────────────────────────────

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.01,
  1000,
);
camera.position.set(0, 2, 8);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;

scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const key = new THREE.DirectionalLight(0xffffff, 2);
key.position.set(4, 8, 5);
scene.add(key);
const fill = new THREE.DirectionalLight(0x8899ff, 0.4);
fill.position.set(-6, 2, -4);
scene.add(fill);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ─────────────────────────────────────
// STATE
// ─────────────────────────────────────

const meshes = []; // all collected leaf Mesh objects
const originMap = new Map(); // Mesh → Vector3 (world-space origin)
const scatterMap = new Map(); // Mesh → Vector3 (scatter target)
let modelRoot = null; // current model group in scene
let state = "idle"; // 'idle' | 'scattered' | 'animating'

const ui = {
  meshCount: document.getElementById("status-mesh"),
  stateEl: document.getElementById("status-state"),
  dropHint: document.getElementById("drop-hint"),
};

function setStatus(s) {
  state = s;
  ui.stateEl.textContent = `state — ${s}`;
}
function setMeshCount(n) {
  ui.meshCount.textContent = `meshes — ${n}`;
}

// ─────────────────────────────────────
// LOAD
// ─────────────────────────────────────

const loader = new GLTFLoader();

function loadModel(url) {
  if (modelRoot) {
    scene.remove(modelRoot);
    meshes.length = 0;
    originMap.clear();
    scatterMap.clear();
  }
  ui.dropHint.classList.add("hidden");
  setStatus("loading…");

  loader.load(
    url,
    (gltf) => {
      modelRoot = gltf.scene;
      scene.add(modelRoot);
      fitToCamera(modelRoot, camera);
      collectLeafMeshes(modelRoot);
      snapshotOrigins();
      setMeshCount(meshes.length);
      setStatus("ready");
    },
    (xhr) =>
      setStatus(`loading ${Math.round((xhr.loaded / xhr.total) * 100)}%`),
    (err) => {
      console.error(err);
      setStatus("error — check console");
    },
  );
}

// Load on start if URL provided, otherwise show placeholder
if (MODEL_URL) {
  loadModel(MODEL_URL);
} else {
  loadPlaceholder();
}

// ─────────────────────────────────────
// PLACEHOLDER — segmented box (no .glb needed)
// ─────────────────────────────────────

function loadPlaceholder() {
  const group = new THREE.Group();
  const cols = 4,
    rows = 4,
    deps = 4;
  const size = 0.38,
    gap = 0.46;

  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) {
      for (let z = 0; z < deps; z++) {
        const geo = new THREE.BoxGeometry(size, size, size);
        const mat = new THREE.MeshStandardMaterial({
          color: new THREE.Color().setHSL(
            (x / cols + y / rows + z / deps) / 3,
            0.55,
            0.62,
          ),
          roughness: 0.4,
          metalness: 0.1,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(
          (x - cols / 2 + 0.5) * gap,
          (y - rows / 2 + 0.5) * gap,
          (z - deps / 2 + 0.5) * gap,
        );
        group.add(mesh);
      }
    }
  }

  modelRoot = group;
  scene.add(modelRoot);
  collectLeafMeshes(modelRoot);
  snapshotOrigins();
  setMeshCount(meshes.length);
  setStatus("placeholder — drop a .glb to replace");

  // Auto-trigger a scatter+reassemble so something moves on first load
  setTimeout(() => {
    scatter();
    setTimeout(() => reassemble(), 600);
  }, 400);
}

// ─────────────────────────────────────
// TRAVERSE — collect leaf Meshes
// ─────────────────────────────────────

function collectLeafMeshes(root) {
  meshes.length = 0;
  root.traverse((node) => {
    if (!node.isMesh) return;
    const hasChildMesh = node.children.some((c) => c.isMesh);
    if (hasChildMesh) return;
    node.updateWorldMatrix(true, false);
    meshes.push(node);
  });
}

// ─────────────────────────────────────
// SNAPSHOT — store world-space origins
// ─────────────────────────────────────

function snapshotOrigins() {
  originMap.clear();
  for (const mesh of meshes) {
    originMap.set(mesh, mesh.position.clone()); // ← local space (matches what reassemble tweens)
  }
}

// ─────────────────────────────────────
// SCATTER
// ─────────────────────────────────────

function scatter() {
  if (!meshes.length) return;
  gsap.killTweensOf(meshes.map((m) => m.position));
  scatterMap.clear();
  setStatus("scattered");

  for (const mesh of meshes) {
    const dir = new THREE.Vector3(
      Math.random() * 2 - 1,
      Math.random() * 2 - 1,
      Math.random() * 2 - 1,
    ).normalize();
    const dist = SCATTER.radius * (0.8 + Math.random() * 0.4); // 60–100% of radius
    const target = dir.multiplyScalar(dist);

    scatterMap.set(mesh, target);
    mesh.position.copy(target);
    if (SCATTER.randomRotation) {
      mesh.rotation.set(
        Math.random() * Math.PI * 2,
        Math.random() * Math.PI * 2,
        Math.random() * Math.PI * 2,
      );
    }
  }
}

// ─────────────────────────────────────
// REASSEMBLE
// ─────────────────────────────────────

function reassemble() {
  if (!meshes.length) return;
  setStatus("animating…");

  meshes.forEach((mesh, i) => {
    const origin = originMap.get(mesh);
    if (!origin) return;

    gsap.to(mesh.position, {
      x: origin.x,
      y: origin.y,
      z: origin.z,
      duration: REASSEMBLE.duration,
      delay: i * REASSEMBLE.stagger,
      ease: REASSEMBLE.ease,
      onComplete:
        i === meshes.length - 1 ? () => setStatus("ready") : undefined,
    });
    gsap.to(mesh.rotation, {
      x: 0,
      y: 0,
      z: 0,
      duration: REASSEMBLE.duration,
      delay: i * REASSEMBLE.stagger,
      ease: REASSEMBLE.ease,
    });
  });
}

// ─────────────────────────────────────
// BUTTONS
// ─────────────────────────────────────

document.getElementById("btn-scatter").addEventListener("click", scatter);
document.getElementById("btn-reassemble").addEventListener("click", reassemble);

// ─────────────────────────────────────
// DRAG & DROP .glb at runtime
// ─────────────────────────────────────

document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (!file || !file.name.endsWith(".glb")) return;
  const url = URL.createObjectURL(file);
  loadModel(url);
});

// ─────────────────────────────────────
// UTILS
// ─────────────────────────────────────

function randomInSphere(r) {
  const v = new THREE.Vector3();
  do {
    v.set(
      (Math.random() * 2 - 1) * r,
      (Math.random() * 2 - 1) * r,
      (Math.random() * 2 - 1) * r,
    );
  } while (v.lengthSq() > r * r);
  return v;
}

function fitToCamera(model, cam) {
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  model.position.sub(center);
  const maxDim = Math.max(size.x, size.y, size.z);
  const fovRad = (cam.fov * Math.PI) / 180;
  cam.position.z = (maxDim / 2 / Math.tan(fovRad / 2)) * 1.6;
  cam.near = maxDim * 0.001;
  cam.far = maxDim * 200;
  cam.updateProjectionMatrix();
  controls.target.set(0, 0, 0);
  controls.update();
}

// ─────────────────────────────────────
// RENDER LOOP
// ─────────────────────────────────────

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();
