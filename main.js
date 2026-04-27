/**
 * main.js — GLB Scatter + MediaPipe Hand Gesture control
 *
 * GESTURE MAPPING
 * ──────────────────────────────────────────────────────
 * Open hand (pinch = 0)   → fully scattered
 * Closing pinch (0 → 1)   → lerps pieces toward origin in real-time
 * Full pinch held 300 ms  → snaps to assembled with GSAP (locks in)
 * Open hand again         → re-scatters
 *
 * MediaPipe is loaded via CDN script tag in index.html — no npm install.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import gsap from "gsap";

// ─────────────────────────────────────
// CONFIG
// ─────────────────────────────────────

const MODEL_URL = "./wedo.glb";

const SCATTER = {
  radius: 320,
  randomRotation: true,
};
const REASSEMBLE = {
  snapDuration: 0.8, // GSAP snap-to-finish duration (seconds)
  ease: "power3.out",
};

// Pinch thresholds (normalised landmark distance, ~0–0.35 range)
const PINCH_CLOSED = 0.045; // below this → fully assembled
const PINCH_OPEN = 0.18; // above this → fully scattered
const PINCH_HOLD_MS = 300; // ms to hold full pinch before snap-lock

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

const meshes = []; // leaf Mesh objects
const originMap = new Map(); // Mesh → Vector3 local-space origin
const scatterMap = new Map(); // Mesh → Vector3 scatter position
let modelRoot = null;
let appState = "idle"; // 'idle' | 'scattered' | 'hand-control' | 'snapped'

// Hand / gesture state
const hand = {
  pinch: PINCH_OPEN + 0.01, // start as open hand so t=0 before MediaPipe fires
  rawPinch: PINCH_OPEN + 0.01,
  fullPinchSince: null,
  wasOpen: false,
};

// Lerp progress driven by pinch (separate from GSAP)
// 0 = scattered positions, 1 = origin positions
let assembleProgress = 0;
let assembleT = 0; // smoothed version of assembleProgress used for actual lerp
let handControlActive = false; // true while MediaPipe is running & model is scattered

const ui = {
  meshCount: document.getElementById("status-mesh"),
  stateEl: document.getElementById("status-state"),
  dropHint: document.getElementById("drop-hint"),
  pinchBar: document.getElementById("pinch-bar"),
  pinchFill: document.getElementById("pinch-fill"),
  pinchLabel: document.getElementById("pinch-label"),
  handDot: document.getElementById("hand-dot"),
};

function setStatus(s) {
  appState = s;
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
      setTimeout(scatter, 400);
    },
    (xhr) =>
      setStatus(`loading ${Math.round((xhr.loaded / xhr.total) * 100)}%`),
    (err) => {
      console.error(err);
      setStatus("error — check console");
    },
  );
}

if (MODEL_URL) {
  loadModel(MODEL_URL);
} else {
  loadPlaceholder();
}

// ─────────────────────────────────────
// PLACEHOLDER
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
  setStatus("placeholder");

  setTimeout(() => {
    scatter();
  }, 400);
}

// ─────────────────────────────────────
// TRAVERSE
// ─────────────────────────────────────

function collectLeafMeshes(root) {
  meshes.length = 0;
  root.traverse((node) => {
    if (!node.isMesh) return;
    if (node.children.some((c) => c.isMesh)) return;
    node.updateWorldMatrix(true, false);
    meshes.push(node);
  });
}

// ─────────────────────────────────────
// SNAPSHOT
// ─────────────────────────────────────

function snapshotOrigins() {
  originMap.clear();
  for (const mesh of meshes) {
    originMap.set(mesh, mesh.position.clone());
  }
}

// ─────────────────────────────────────
// SCATTER
// ─────────────────────────────────────

function scatter() {
  if (!meshes.length) return;
  gsap.killTweensOf(meshes.map((m) => m.position));
  gsap.killTweensOf(meshes.map((m) => m.rotation));
  scatterMap.clear();
  assembleProgress = 0;
  handControlActive = true;
  setStatus("hand-control");

  for (const mesh of meshes) {
    const dir = new THREE.Vector3(
      Math.random() * 2 - 1,
      Math.random() * 2 - 1,
      Math.random() * 2 - 1,
    ).normalize();
    const dist = SCATTER.radius * (0.8 + Math.random() * 0.4);
    const target = dir.multiplyScalar(dist);

    scatterMap.set(mesh, target.clone());
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
// SNAP — GSAP finish (locks assembly)
// ─────────────────────────────────────

function snapToAssembled() {
  if (!meshes.length) return;
  handControlActive = false;
  setStatus("snapping…");

  meshes.forEach((mesh, i) => {
    const origin = originMap.get(mesh);
    if (!origin) return;
    gsap.to(mesh.position, {
      x: origin.x,
      y: origin.y,
      z: origin.z,
      duration: REASSEMBLE.snapDuration,
      ease: REASSEMBLE.ease,
      onComplete:
        i === meshes.length - 1 ? () => setStatus("assembled") : undefined,
    });
    gsap.to(mesh.rotation, {
      x: 0,
      y: 0,
      z: 0,
      duration: REASSEMBLE.snapDuration,
      ease: REASSEMBLE.ease,
    });
  });
}

// ─────────────────────────────────────
// PER-FRAME LERP driven by pinch progress
// ─────────────────────────────────────

const _lerpPos = new THREE.Vector3();

function applyAssembleProgress(t) {
  // t: 0 = scattered, 1 = at origin
  for (const mesh of meshes) {
    const origin = originMap.get(mesh);
    const scatter = scatterMap.get(mesh);
    if (!origin || !scatter) continue;
    _lerpPos.lerpVectors(scatter, origin, t);
    mesh.position.copy(_lerpPos);
  }
}

// ─────────────────────────────────────
// MEDIAPIPE HANDS SETUP
// ─────────────────────────────────────

// MediaPipe is loaded via CDN in index.html (no npm install).
// We initialise it after the window loads so the global is available.

let handsModel = null;

async function initMediaPipe() {
  // Hands is available as window.Hands after CDN script loads
  if (!window.Hands) {
    console.warn(
      "MediaPipe Hands not loaded. Add the CDN script to index.html.",
    );
    return;
  }

  // Hidden video feed
  const video = document.getElementById("mp-video");
  const handCanvas = document.getElementById("mp-canvas");
  const ctx = handCanvas.getContext("2d");

  handsModel = new window.Hands({
    locateFile: (file) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
  });

  handsModel.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.7,
    minTrackingConfidence: 0.6,
  });

  handsModel.onResults((results) => {
    // Draw landmarks on debug canvas (small overlay)
    ctx.clearRect(0, 0, handCanvas.width, handCanvas.height);

    if (!results.multiHandLandmarks?.length) {
      // No hand visible — show dot as inactive
      ui.handDot?.classList.remove("active");
      hand.rawPinch = PINCH_OPEN + 0.01; // treat as open
      return;
    }

    ui.handDot?.classList.add("active");
    const landmarks = results.multiHandLandmarks[0];

    // Draw skeleton on debug overlay
    if (window.drawConnectors && window.HAND_CONNECTIONS) {
      drawConnectors(ctx, landmarks, HAND_CONNECTIONS, {
        color: "rgba(255,255,255,0.25)",
        lineWidth: 1,
      });
      drawLandmarks(ctx, landmarks, {
        color: "rgba(255,255,255,0.6)",
        lineWidth: 1,
        radius: 2,
      });
    }

    // ── Pinch distance: thumb tip (4) ↔ index tip (8) ──
    const thumb = landmarks[4];
    const index = landmarks[8];
    const dx = thumb.x - index.x;
    const dy = thumb.y - index.y;
    hand.rawPinch = Math.sqrt(dx * dx + dy * dy);
  });

  // Camera stream
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 320, height: 240, facingMode: "user" },
    audio: false,
  });
  video.srcObject = stream;
  video.play();

  // Feed frames to MediaPipe
  const mpCamera = new window.Camera(video, {
    onFrame: async () => {
      handCanvas.width = video.videoWidth;
      handCanvas.height = video.videoHeight;
      await handsModel.send({ image: video });
    },
    width: 320,
    height: 240,
  });
  mpCamera.start();

  setStatus("hand-ready — scatter to begin");
}

// ─────────────────────────────────────
// PINCH → PROGRESS each frame
// ─────────────────────────────────────

function tickHandControl() {
  // Layer 1: smooth raw sensor noise (fast EMA)
  hand.pinch += (hand.rawPinch - hand.pinch) * 0.15;

  // Map pinch distance → raw progress [0=scattered, 1=assembled]
  const rawT =
    1 -
    THREE.MathUtils.clamp(
      (hand.pinch - PINCH_CLOSED) / (PINCH_OPEN - PINCH_CLOSED),
      0,
      1,
    );

  // Layer 2: smooth the progress value itself (slower EMA, kills jitter)
  assembleT += (rawT - assembleT) * 0.08;

  assembleProgress = assembleT;

  // Debug HUD
  if (ui.pinchFill)
    ui.pinchFill.style.width = `${Math.round(assembleT * 100)}%`;
  if (ui.pinchLabel)
    ui.pinchLabel.textContent = `raw:${hand.rawPinch.toFixed(3)}  t:${assembleT.toFixed(2)}  ${appState}`;

  // ── Re-scatter on wide-open hand (works in any active state) ──
  if (appState === "assembled" || appState === "hand-control") {
    if (assembleT < 0.12) {
      if (!hand.wasOpen) {
        hand.wasOpen = true;
        if (appState === "assembled") scatter(); // only re-scatter when locked
      }
    } else if (assembleT > 0.35) {
      hand.wasOpen = false; // arm for next open gesture
    }
  }

  if (!handControlActive) return;

  // Drive mesh positions with the smoothed value
  applyAssembleProgress(assembleT);

  // ── Full pinch hold → snap lock ──
  if (assembleT >= 0.95) {
    if (!hand.fullPinchSince) hand.fullPinchSince = Date.now();
    if (Date.now() - hand.fullPinchSince >= PINCH_HOLD_MS) {
      hand.fullPinchSince = null;
      hand.wasOpen = false;
      snapToAssembled();
    }
  } else {
    hand.fullPinchSince = null;
  }
}

// ─────────────────────────────────────
// BUTTONS (fallback / manual control)
// ─────────────────────────────────────

document.getElementById("btn-scatter")?.addEventListener("click", scatter);
document
  .getElementById("btn-reassemble")
  ?.addEventListener("click", snapToAssembled);

// ─────────────────────────────────────
// DRAG & DROP
// ─────────────────────────────────────

document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (!file || !file.name.endsWith(".glb")) return;
  loadModel(URL.createObjectURL(file));
});

// ─────────────────────────────────────
// UTILS
// ─────────────────────────────────────

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
  tickHandControl();
  controls.update();
  renderer.render(scene, camera);
}
animate();

// ─────────────────────────────────────
// INIT MEDIAPIPE (after page load)
// ─────────────────────────────────────

window.addEventListener("load", initMediaPipe);
