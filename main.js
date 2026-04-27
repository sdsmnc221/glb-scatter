/**
 * main.js — GLB Scatter + Rapier physics + MediaPipe hand gesture
 *
 * PHYSICS FLOW
 * ──────────────────────────────────────────────────────────────
 * scatter()        → spawn RigidBody per mesh, apply random impulse outward
 * hand-control     → each physics step, apply spring force toward origin
 *                    scaled by assembleT (pinch progress 0→1)
 * snapToAssembled()→ kill all bodies, GSAP-tween to exact origin
 * assembled        → open hand → re-scatter (impulse again)
 *
 * GESTURE
 * ──────────────────────────────────────────────────────────────
 * Open hand  → pieces tumble freely (no spring)
 * Pinch      → spring pulls pieces toward origin (proportional)
 * Hold pinch → snaps + locks with GSAP
 * Open again → re-scatter with new impulse
 */

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import gsap from "gsap";
import RAPIER from "@dimforge/rapier3d-compat";

// ─────────────────────────────────────
// CONFIG
// ─────────────────────────────────────

const MODEL_URL = "./wedo.glb";

const SCATTER = {
  impulseScale: 280, // must overpower gravity + damping to reach ~radius 320
  torqueScale: 60,
  randomVariance: 0.35,
};

const PHYSICS = {
  gravity: -2,
  linearDamping: 0.8, // higher damping so pieces don't overshoot when spring fires
  angularDamping: 0.6,
  springStiffness: 1.2, // at dist=320, full pinch = 384 N — felt gradually across range
  snapDuration: 0.7,
  snapEase: "power3.out",
};

// Pinch thresholds (normalised landmark distance)
// Calibrated from debug: open hand ~0.30, full pinch ~0.05
const PINCH_CLOSED = 0.05; // below this → t=1 (fully assembled)
const PINCH_OPEN = 0.3; // above this → t=0 (fully scattered)
const PINCH_HOLD_MS = 300;

// Auto-calibration — derived from first N frames of open hand
// Never set manually; tickHandControl reads from calibrated.*
const calibrated = {
  open: null, // set after sampling
  closed: null,
  ready: false,
  samples: [],
  SAMPLE_COUNT: 40, // frames to sample open hand
};

// Ratio of closed/open — geometrically stable across hand sizes + distances
const PINCH_CLOSED_RATIO = 0.2; // full pinch ≈ 20% of open spread
// Active mapping range: map [closed, open*0.85] → [1, 0]
// The 0.85 ceiling gives headroom so you don't need to stretch fingers fully

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
  100000,
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

const meshes = []; // leaf THREE.Mesh objects
const originMap = new Map(); // Mesh → Vector3 (local-space origin)
let modelRoot = null;
let appState = "idle";

// Rapier
let rapierWorld = null;
const bodyMap = new Map(); // Mesh → RAPIER.RigidBody
let physicsActive = false;

// Hand gesture
const hand = {
  pinch: 0.3, // safe open-hand default before calibration
  rawPinch: 0.3,
  fullPinchSince: null,
  wasOpen: false,
};
let assembleT = 0;
let handControlActive = false;

const ui = {
  meshCount: document.getElementById("status-mesh"),
  stateEl: document.getElementById("status-state"),
  dropHint: document.getElementById("drop-hint"),
  pinchFill: document.getElementById("pinch-fill"),
  pinchLabel: document.getElementById("pinch-label"),
  handDot: document.getElementById("hand-dot"),
};

function setStatus(s) {
  appState = s;
  if (ui.stateEl) ui.stateEl.textContent = `state — ${s}`;
}
function setMeshCount(n) {
  if (ui.meshCount) ui.meshCount.textContent = `meshes — ${n}`;
}

// ─────────────────────────────────────
// RAPIER INIT
// ─────────────────────────────────────

async function initRapier() {
  await RAPIER.init();
  rapierWorld = new RAPIER.World({ x: 0, y: PHYSICS.gravity, z: 0 });
  console.log("Rapier ready");
}

// ─────────────────────────────────────
// LOAD
// ─────────────────────────────────────

const loader = new GLTFLoader();

function loadModel(url) {
  destroyAllBodies();
  if (modelRoot) {
    scene.remove(modelRoot);
    meshes.length = 0;
    originMap.clear();
  }
  if (ui.dropHint) ui.dropHint.classList.add("hidden");
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
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(size, size, size),
          new THREE.MeshStandardMaterial({
            color: new THREE.Color().setHSL(
              (x / cols + y / rows + z / deps) / 3,
              0.55,
              0.62,
            ),
            roughness: 0.4,
            metalness: 0.1,
          }),
        );
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
  setTimeout(scatter, 400);
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
// SNAPSHOT origins (local space)
// ─────────────────────────────────────

function snapshotOrigins() {
  originMap.clear();
  for (const mesh of meshes) {
    originMap.set(mesh, mesh.position.clone());
  }
}

// ─────────────────────────────────────
// RAPIER BODY HELPERS
// ─────────────────────────────────────

function createBody(mesh) {
  if (!rapierWorld) return null;

  const wp = new THREE.Vector3();
  mesh.getWorldPosition(wp);

  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(wp.x, wp.y, wp.z)
    .setLinearDamping(PHYSICS.linearDamping)
    .setAngularDamping(PHYSICS.angularDamping);

  const body = rapierWorld.createRigidBody(bodyDesc);

  // Ball collider sized to mesh bounding sphere — good enough for scatter dynamics
  const box = new THREE.Box3().setFromObject(mesh);
  const size = box.getSize(new THREE.Vector3());
  const r = Math.max(size.x, size.y, size.z) * 0.35;
  rapierWorld.createCollider(RAPIER.ColliderDesc.ball(Math.max(r, 0.01)), body);

  return body;
}

function destroyAllBodies() {
  if (!rapierWorld) return;
  for (const body of bodyMap.values()) {
    rapierWorld.removeRigidBody(body);
  }
  bodyMap.clear();
  physicsActive = false;
}

// ─────────────────────────────────────
// SCATTER — impulse-based
// ─────────────────────────────────────

function scatter() {
  if (!meshes.length) return;

  gsap.killTweensOf(meshes.map((m) => m.position));
  gsap.killTweensOf(meshes.map((m) => m.rotation));
  destroyAllBodies();

  assembleT = 0;
  handControlActive = true;
  setStatus("hand-control");

  for (const mesh of meshes) {
    const origin = originMap.get(mesh);

    // Reset to origin so body starts at rest position
    mesh.position.copy(origin);
    mesh.rotation.set(0, 0, 0);

    const body = createBody(mesh);
    if (!body) continue;
    bodyMap.set(mesh, body);

    // Random outward impulse
    const dir = new THREE.Vector3(
      Math.random() * 2 - 1,
      Math.random() * 2 - 1,
      Math.random() * 2 - 1,
    ).normalize();
    const mag =
      SCATTER.impulseScale *
      (1 - SCATTER.randomVariance + Math.random() * SCATTER.randomVariance * 2);
    body.applyImpulse({ x: dir.x * mag, y: dir.y * mag, z: dir.z * mag }, true);

    // Random torque
    body.applyTorqueImpulse(
      {
        x: (Math.random() - 0.5) * SCATTER.torqueScale,
        y: (Math.random() - 0.5) * SCATTER.torqueScale,
        z: (Math.random() - 0.5) * SCATTER.torqueScale,
      },
      true,
    );
  }

  physicsActive = true;
}

// ─────────────────────────────────────
// PHYSICS TICK — spring force + sync meshes
// ─────────────────────────────────────

const _springForce = new THREE.Vector3();
const _bodyPos = new THREE.Vector3();
const _parentQuat = new THREE.Quaternion();
const _bodyQuat = new THREE.Quaternion();
const _worldOrigin = new THREE.Vector3();

function tickPhysics() {
  if (!physicsActive || !rapierWorld) return;

  // Apply spring force toward each mesh's world-space origin, scaled by assembleT
  if (assembleT > 0.01) {
    for (const [mesh, body] of bodyMap) {
      const localOrigin = originMap.get(mesh);
      if (!localOrigin) continue;

      // Convert local origin → world space
      _worldOrigin.copy(localOrigin);
      if (mesh.parent) {
        mesh.parent.updateWorldMatrix(true, false);
        _worldOrigin.applyMatrix4(mesh.parent.matrixWorld);
      }

      const t = body.translation();
      _bodyPos.set(t.x, t.y, t.z);

      _springForce
        .subVectors(_worldOrigin, _bodyPos)
        .multiplyScalar(PHYSICS.springStiffness * assembleT);

      body.addForce(
        { x: _springForce.x, y: _springForce.y, z: _springForce.z },
        true,
      );
    }
  }

  rapierWorld.step();

  // Sync THREE.Mesh transforms from Rapier bodies
  for (const [mesh, body] of bodyMap) {
    const t = body.translation();
    const r = body.rotation();

    // World position → local space of parent
    _bodyPos.set(t.x, t.y, t.z);
    if (mesh.parent) {
      mesh.parent.updateWorldMatrix(true, false);
      mesh.parent.worldToLocal(_bodyPos);
    }
    mesh.position.copy(_bodyPos);

    // World quaternion → local quaternion of parent
    _bodyQuat.set(r.x, r.y, r.z, r.w);
    if (mesh.parent) {
      mesh.parent.getWorldQuaternion(_parentQuat);
      _bodyQuat.premultiply(_parentQuat.invert());
    }
    mesh.quaternion.copy(_bodyQuat);
  }
}

// ─────────────────────────────────────
// SNAP — kill physics, GSAP to exact origin
// ─────────────────────────────────────

function snapToAssembled() {
  if (!meshes.length) return;

  // Zero velocities before destroying so meshes don't lurch
  for (const body of bodyMap.values()) {
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }
  destroyAllBodies();
  handControlActive = false;
  setStatus("snapping…");

  meshes.forEach((mesh, i) => {
    const origin = originMap.get(mesh);
    if (!origin) return;
    gsap.to(mesh.position, {
      x: origin.x,
      y: origin.y,
      z: origin.z,
      duration: PHYSICS.snapDuration,
      ease: PHYSICS.snapEase,
      onComplete:
        i === meshes.length - 1 ? () => setStatus("assembled") : undefined,
    });
    gsap.to(mesh.rotation, {
      x: 0,
      y: 0,
      z: 0,
      duration: PHYSICS.snapDuration,
      ease: PHYSICS.snapEase,
    });
  });
}

// ─────────────────────────────────────
// MEDIAPIPE HANDS
// ─────────────────────────────────────

let handsModel = null;

async function initMediaPipe() {
  if (!window.Hands) {
    console.warn("MediaPipe Hands not loaded — check index.html CDN scripts.");
    return;
  }

  const video = document.getElementById("mp-video");
  const handCanvas = document.getElementById("mp-canvas");
  const ctx = handCanvas.getContext("2d");

  handsModel = new window.Hands({
    locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`,
  });
  handsModel.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.7,
    minTrackingConfidence: 0.6,
  });

  handsModel.onResults((results) => {
    ctx.clearRect(0, 0, handCanvas.width, handCanvas.height);

    if (!results.multiHandLandmarks?.length) {
      ui.handDot?.classList.remove("active");
      hand.rawPinch = hand.pinch; // hold last value — don't treat no-hand as open
      return;
    }

    ui.handDot?.classList.add("active");
    const landmarks = results.multiHandLandmarks[0];

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

    const thumb = landmarks[4];
    const index = landmarks[8];
    const dx = thumb.x - index.x;
    const dy = thumb.y - index.y;
    hand.rawPinch = Math.sqrt(dx * dx + dy * dy);

    // ── Auto-calibration: sample open hand on first detection ──
    if (!calibrated.ready) {
      calibrated.samples.push(hand.rawPinch);
      const pct = Math.round(
        (calibrated.samples.length / calibrated.SAMPLE_COUNT) * 100,
      );
      setStatus(`calibrating… hold hand open ${pct}%`);
      if (ui.pinchLabel)
        ui.pinchLabel.textContent = `sampling raw: ${hand.rawPinch.toFixed(3)}`;

      if (calibrated.samples.length >= calibrated.SAMPLE_COUNT) {
        // Use median (not mean) — robust against accidental partial pinches during sampling
        const sorted = [...calibrated.samples].sort((a, b) => a - b);
        calibrated.open = sorted[Math.floor(sorted.length / 2)];
        calibrated.closed = calibrated.open * PINCH_CLOSED_RATIO;
        calibrated.ready = true;
        console.log(
          `Calibrated — open: ${calibrated.open.toFixed(3)}, closed: ${calibrated.closed.toFixed(3)}`,
        );
        setStatus("hand-ready — scatter to begin");
      }
    }
  });

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 320, height: 240, facingMode: "user" },
    audio: false,
  });
  video.srcObject = stream;
  video.play();

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
// PINCH TICK
// ─────────────────────────────────────

function tickHandControl() {
  // Smooth raw sensor noise
  hand.pinch += (hand.rawPinch - hand.pinch) * 0.15;

  // Don't drive anything until calibrated
  if (!calibrated.ready) return;

  const rangeOpen = calibrated.open * 0.85; // ceiling — don't need full stretch
  const rangeClosed = calibrated.closed; // floor — full pinch

  // Map [rangeOpen → rangeClosed] to [0 → 1]
  // pinch distance shrinks as hand closes, so invert
  assembleT = THREE.MathUtils.clamp(
    1 - (hand.pinch - rangeClosed) / (rangeOpen - rangeClosed),
    0,
    1,
  );

  if (ui.pinchFill)
    ui.pinchFill.style.width = `${Math.round(assembleT * 100)}%`;
  if (ui.pinchLabel)
    ui.pinchLabel.textContent = `raw:${hand.rawPinch.toFixed(3)}  t:${assembleT.toFixed(2)}  open:${calibrated.open.toFixed(3)}  ${appState}`;

  // Open-hand re-scatter
  if (appState === "assembled" || appState === "hand-control") {
    if (assembleT < 0.12) {
      if (!hand.wasOpen) {
        hand.wasOpen = true;
        if (appState === "assembled") scatter();
      }
    } else if (assembleT > 0.35) {
      hand.wasOpen = false;
    }
  }

  if (!handControlActive) return;

  // Full pinch hold → snap
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
// BUTTONS
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
  tickPhysics();
  controls.update();
  renderer.render(scene, camera);
}
animate();

// ─────────────────────────────────────
// BOOT — Rapier first, then MediaPipe
// ─────────────────────────────────────

window.addEventListener("load", async () => {
  await initRapier();
  initMediaPipe();
});
