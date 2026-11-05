// 브라우저 진입점: Three.js 장면, 입력, HUD, Web Audio 효과음.
// 게임 규칙(발사·명중 선택·재장전·점수·라운드 시간)은 모두 rules.mjs가 소유한다.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js';
import {
  PHASE,
  createGame,
  startRound,
  tick,
  fire,
  startReload,
  pause,
  resume,
  remainingMs,
  reloadProgress,
  targetsToPlace,
  gameClockMs,
} from './rules.mjs';

const EYE_HEIGHT = 1.6;
const MOUSE_SENSITIVITY = 0.0022;
const MAX_YAW = THREE.MathUtils.degToRad(70);
const MAX_PITCH = THREE.MathUtils.degToRad(40);

// 표적 자리: x, z, 표적 중심 높이 y, 좌우 흔들림 폭(m). 일부는 엄폐물 뒤에 있다.
const SLOTS = [
  { x: -6, z: -12, y: 1.4, sway: 0 },
  { x: -2, z: -14, y: 1.2, sway: 0.8 },
  { x: 3, z: -13, y: 1.5, sway: 0 },
  { x: 7, z: -15, y: 1.3, sway: 0.6 },
  { x: -8, z: -20, y: 1.7, sway: 0 },
  { x: -3.5, z: -21, y: 1.3, sway: 0 },
  { x: 1, z: -22, y: 1.6, sway: 1.2 },
  { x: 5.5, z: -20, y: 1.3, sway: 0 },
  { x: 9, z: -24, y: 1.8, sway: 0 },
  { x: -6, z: -29, y: 1.6, sway: 1.0 },
  { x: 0, z: -30, y: 2.0, sway: 0 },
  { x: 6, z: -30, y: 1.6, sway: 0 },
];

// 낮은 엄폐물(차단물). 일부 표적의 아랫부분을 가린다.
const COVERS = [
  { x: -2, z: -13, w: 2.2, h: 0.9, d: 0.6 },
  { x: 5.5, z: -19, w: 2.0, h: 1.0, d: 0.6 },
  { x: -3.5, z: -20, w: 1.6, h: 1.1, d: 0.6 },
  { x: 0, z: -28.5, w: 2.4, h: 1.4, d: 0.6 },
];

const $ = (id) => document.getElementById(id);
const ui = {
  canvas: $('scene'),
  score: $('hud-score'),
  time: $('hud-time'),
  timeBox: $('hud-time').parentElement,
  ammo: $('hud-ammo'),
  ammoBox: $('hud-ammo').parentElement,
  status: $('hud-status'),
  reloadBar: $('reload-bar'),
  reloadFill: $('reload-fill'),
  hitmarker: $('hitmarker'),
  overlay: $('overlay'),
  panels: { start: $('panel-start'), pause: $('panel-pause'), end: $('panel-end') },
  finalScore: $('final-score'),
  finalDetail: $('final-detail'),
  error: $('overlay-error'),
  btnStart: $('btn-start'),
  btnResume: $('btn-resume'),
  btnRestart: $('btn-restart'),
  btnPauseRestart: $('btn-pause-restart'),
};

const state = createGame({ slotCount: SLOTS.length });

// ---------------------------------------------------------------- 렌더러·장면
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas: ui.canvas, antialias: true });
} catch (err) {
  showError(`WebGL을 시작할 수 없습니다: ${err.message}`);
  ui.btnStart.disabled = true;
  throw err;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fc3e0);
scene.fog = new THREE.Fog(0x9fc3e0, 30, 70);

const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.03, 200);
camera.position.set(0, EYE_HEIGHT, 0);
camera.rotation.order = 'YXZ';
scene.add(camera);

scene.add(new THREE.HemisphereLight(0xdfefff, 0x5a4b3a, 1.1));
const sun = new THREE.DirectionalLight(0xfff3dd, 2.2);
sun.position.set(8, 18, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20, near: 1, far: 60 });
sun.target.position.set(0, 0, -18);
scene.add(sun, sun.target);

/** 광선이 막히는 메시(벽·바닥·엄폐물·표적 기둥). */
const blockers = [];
/** 표적의 명중 영역 메시. 화면에 보이는 원판 자체다. */
const targetHitMeshes = [];

function addBlocker(mesh) {
  mesh.userData.targetId = null;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  blockers.push(mesh);
  scene.add(mesh);
  return mesh;
}

// 환경: 바닥, 사선, 측벽, 뒷벽, 레인 구분선, 엄폐물.
{
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x8a7a5c, roughness: 1 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 80), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.z = -25;
  addBlocker(ground).castShadow = false;

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x6f7b85, roughness: 0.9 });
  const backWall = new THREE.Mesh(new THREE.BoxGeometry(30, 7, 1), wallMat);
  backWall.position.set(0, 3.5, -36);
  addBlocker(backWall);
  for (const side of [-1, 1]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(1, 4, 40), wallMat);
    wall.position.set(side * 13, 2, -17);
    addBlocker(wall);
  }

  const counterMat = new THREE.MeshStandardMaterial({ color: 0x5b3d26, roughness: 0.8 });
  const counter = new THREE.Mesh(new THREE.BoxGeometry(6, 1.05, 0.7), counterMat);
  counter.position.set(0, 0.525, -1.1);
  addBlocker(counter);

  const lineMat = new THREE.MeshStandardMaterial({ color: 0xe8e2cf, roughness: 1 });
  const lineGeo = new THREE.BoxGeometry(0.08, 0.02, 34);
  for (const x of [-10, -5, 0, 5, 10]) {
    const line = new THREE.Mesh(lineGeo, lineMat);
    line.position.set(x, 0.01, -19);
    line.receiveShadow = true;
    scene.add(line);
  }

  const coverMat = new THREE.MeshStandardMaterial({ color: 0x8b6a3e, roughness: 0.85 });
  for (const c of COVERS) {
    const cover = new THREE.Mesh(new THREE.BoxGeometry(c.w, c.h, c.d), coverMat);
    cover.position.set(c.x, c.h / 2, c.z);
    addBlocker(cover);
  }
  const bermMat = new THREE.MeshStandardMaterial({ color: 0x6d5a3f, roughness: 1 });
  const berm = new THREE.Mesh(new THREE.BoxGeometry(30, 2.2, 3), bermMat);
  berm.position.set(0, 1.1, -34);
  addBlocker(berm);
}

// ---------------------------------------------------------------- 표적
// 기하·재질은 모든 표적이 공유하고, 표적 객체는 처음에 한 번 만든 뒤 재사용한다.
const TARGET_RADIUS = 0.5;
const targetGeo = {
  ring: [0.5, 0.36, 0.22, 0.09].map((r, i) => {
    const g = new THREE.CylinderGeometry(r, r, 0.05, 40);
    g.rotateX(Math.PI / 2);
    g.translate(0, 0, i * 0.006);
    return g;
  }),
  post: new THREE.BoxGeometry(0.08, 1, 0.08),
};
const targetMats = {
  rings: [0xf4f1e8, 0xd8352a, 0xf4f1e8, 0xd8352a].map(
    (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.6 }),
  ),
  post: new THREE.MeshStandardMaterial({ color: 0x3b3b3b, roughness: 0.7 }),
};

const targetViews = state.targets.map((target) => {
  const group = new THREE.Group();
  const face = new THREE.Group();
  group.add(face);
  targetGeo.ring.forEach((geo, i) => {
    const ring = new THREE.Mesh(geo, targetMats.rings[i]);
    ring.castShadow = true;
    ring.userData.targetId = target.id;
    face.add(ring);
    targetHitMeshes.push(ring);
  });
  const post = new THREE.Mesh(targetGeo.post, targetMats.post);
  post.castShadow = true;
  post.userData.targetId = null;
  group.add(post);
  blockers.push(post);
  scene.add(group);
  return { group, face, post, slot: -1, shownSpawn: -1, anim: 'idle', animT: 0, phaseOffset: target.id * 1.7 };
});

// 표적 애니메이션은 일시 정지 중 멈추는 게임 시계(gameClockMs)를 쓴다.
function placeTarget(id) {
  const now = gameClockMs(state);
  const view = targetViews[id];
  const slot = SLOTS[state.targets[id].slot];
  view.slot = state.targets[id].slot;
  view.shownSpawn = state.targets[id].spawnCount;
  view.group.position.set(slot.x, 0, slot.z);
  view.group.rotation.set(0, Math.atan2(-slot.x, -slot.z), 0);
  view.face.rotation.x = 0;
  view.face.position.y = slot.y;
  view.post.scale.y = slot.y - TARGET_RADIUS;
  view.post.position.y = (slot.y - TARGET_RADIUS) / 2;
  view.group.visible = true;
  // 게임 시계가 멈춰 있는 시작 화면에서는 등장 애니메이션 없이 바로 세운다.
  view.anim = state.phase === PHASE.RUNNING ? 'rising' : 'idle';
  view.animT = now;
  updateTargetView(view, slot, now);
}

function updateTargetView(view, slot, now) {
  if (slot.sway) {
    view.group.position.x = slot.x + Math.sin(now / 900 + view.phaseOffset) * slot.sway;
  }
  const t = now - view.animT;
  if (view.anim === 'rising') {
    const k = Math.min(1, t / 220);
    view.group.scale.set(1, k, 1);
    if (k >= 1) view.anim = 'idle';
  } else if (view.anim === 'falling') {
    const k = Math.min(1, t / 200);
    view.face.rotation.x = -k * (Math.PI / 2);
    if (k >= 1) {
      view.group.visible = false;
      view.anim = 'hidden';
    }
  } else if (view.anim === 'idle') {
    view.group.scale.set(1, 1, 1);
    view.face.rotation.x = 0;
  }
  view.group.updateMatrixWorld(true);
}

function syncAllTargets() {
  for (const target of state.targets) {
    if (target.alive) placeTarget(target.id);
    else targetViews[target.id].group.visible = false;
  }
}

/** 규칙 상태에서 다시 나타난 표적을 화면에 배치한다. 시간을 진행한 경로와 관계없이 동작한다. */
function syncRespawnedTargets() {
  for (const id of targetsToPlace(state, targetViews.map((view) => view.shownSpawn))) placeTarget(id);
}

/** 라운드가 끝나 진행 중인 등장·퇴장 애니메이션을 최종 모양으로 맞춘다. */
function settleTargetAnimations() {
  for (const view of targetViews) {
    if (view.anim === 'falling') {
      view.group.visible = false;
      view.anim = 'hidden';
    } else if (view.anim === 'rising') {
      view.anim = 'idle';
      view.group.scale.set(1, 1, 1);
    }
  }
}

// ---------------------------------------------------------------- 총기 모델과 효과
const gun = new THREE.Group();
{
  const metal = new THREE.MeshStandardMaterial({ color: 0x5a6068, roughness: 0.4, metalness: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2c3036, roughness: 0.5, metalness: 0.2 });
  const grip = new THREE.MeshStandardMaterial({ color: 0x4a3426, roughness: 0.9 });
  const parts = [
    [new THREE.BoxGeometry(0.07, 0.07, 0.34), metal, [0, 0, -0.05]],
    [new THREE.BoxGeometry(0.075, 0.03, 0.36), dark, [0, 0.045, -0.05]],
    [new THREE.CylinderGeometry(0.014, 0.014, 0.12, 12).rotateX(Math.PI / 2), dark, [0, 0.01, -0.27]],
    [new THREE.BoxGeometry(0.06, 0.16, 0.08).rotateX(-0.25), grip, [0, -0.1, 0.07]],
    [new THREE.BoxGeometry(0.012, 0.02, 0.012), dark, [0, 0.07, -0.22]],
    [new THREE.BoxGeometry(0.04, 0.02, 0.012), dark, [0, 0.07, 0.11]],
    [new THREE.TorusGeometry(0.03, 0.006, 6, 16, Math.PI).rotateZ(Math.PI).rotateY(Math.PI / 2), dark, [0, -0.04, -0.01]],
  ];
  for (const [geo, mat, [x, y, z]] of parts) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    gun.add(mesh);
  }
}
const GUN_REST = new THREE.Vector3(0.24, -0.24, -0.6);
gun.scale.setScalar(0.85);
gun.position.copy(GUN_REST);
camera.add(gun);

const flashMat = new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.9, depthWrite: false });
const flash = new THREE.Mesh(new THREE.OctahedronGeometry(0.045, 0), flashMat);
flash.position.set(0, 0.01, -0.36);
flash.visible = false;
gun.add(flash);
const flashLight = new THREE.PointLight(0xffc266, 0, 6, 2);
flashLight.position.set(0, 0.02, -0.4);
gun.add(flashLight);

// 탄착 표시: 작은 구체를 미리 만들어 돌려 쓴다.
const impactGeo = new THREE.SphereGeometry(0.05, 8, 6);
const impacts = Array.from({ length: 10 }, () => {
  const mesh = new THREE.Mesh(impactGeo, new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true }));
  mesh.visible = false;
  scene.add(mesh);
  return { mesh, born: 0 };
});
let impactIndex = 0;

const fx = { recoil: 0, flashUntil: 0, hitmarkerTimer: 0 };

// ---------------------------------------------------------------- 파티클 효과
// 하나의 THREE.Points와 고정 크기 버퍼를 돌려 쓴다. 발사마다 GPU 자원을 새로 만들지 않는다.
const PARTICLE_MAX = 600;
const particleGeo = new THREE.BufferGeometry();
const pPos = new Float32Array(PARTICLE_MAX * 3);
const pCol = new Float32Array(PARTICLE_MAX * 3);
const pVel = new Float32Array(PARTICLE_MAX * 3);
const pLife = new Float32Array(PARTICLE_MAX); // 남은 수명(초). 0이면 비활성.
const pMaxLife = new Float32Array(PARTICLE_MAX);
const pGravity = new Float32Array(PARTICLE_MAX);
const pBase = new Float32Array(PARTICLE_MAX * 3);
for (let i = 0; i < PARTICLE_MAX; i += 1) pPos[i * 3 + 1] = -1000;
particleGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3).setUsage(THREE.DynamicDrawUsage));
particleGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3).setUsage(THREE.DynamicDrawUsage));
const particleMat = new THREE.PointsMaterial({
  size: 0.09,
  vertexColors: true,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  sizeAttenuation: true,
});
const particlePoints = new THREE.Points(particleGeo, particleMat);
particlePoints.frustumCulled = false;
scene.add(particlePoints);
let particleCursor = 0;
const tmpColor = new THREE.Color();

/**
 * @param {THREE.Vector3} origin
 * @param {number} count
 * @param {{ color: number, spread: number, speed: number, life: number, gravity: number, dir?: THREE.Vector3 }} opt
 */
function emitParticles(origin, count, opt) {
  tmpColor.setHex(opt.color);
  for (let n = 0; n < count; n += 1) {
    const i = particleCursor;
    particleCursor = (particleCursor + 1) % PARTICLE_MAX;
    const k = i * 3;
    // 단위 구 안의 임의 방향 + 선택적 주 방향.
    let x = Math.random() * 2 - 1;
    let y = Math.random() * 2 - 1;
    let z = Math.random() * 2 - 1;
    const len = Math.hypot(x, y, z) || 1;
    x = (x / len) * opt.spread;
    y = (y / len) * opt.spread;
    z = (z / len) * opt.spread;
    if (opt.dir) {
      x += opt.dir.x;
      y += opt.dir.y;
      z += opt.dir.z;
    }
    const speed = opt.speed * (0.4 + Math.random() * 0.6);
    pPos[k] = origin.x;
    pPos[k + 1] = origin.y;
    pPos[k + 2] = origin.z;
    pVel[k] = x * speed;
    pVel[k + 1] = y * speed;
    pVel[k + 2] = z * speed;
    const jitter = 0.75 + Math.random() * 0.25;
    pBase[k] = tmpColor.r * jitter;
    pBase[k + 1] = tmpColor.g * jitter;
    pBase[k + 2] = tmpColor.b * jitter;
    pLife[i] = opt.life * (0.6 + Math.random() * 0.4);
    pMaxLife[i] = pLife[i];
    pGravity[i] = opt.gravity;
  }
}

function updateParticles(dt) {
  for (let i = 0; i < PARTICLE_MAX; i += 1) {
    if (pLife[i] <= 0) continue;
    const k = i * 3;
    pLife[i] -= dt;
    if (pLife[i] <= 0) {
      pLife[i] = 0;
      pPos[k + 1] = -1000;
      pCol[k] = pCol[k + 1] = pCol[k + 2] = 0;
      continue;
    }
    pVel[k + 1] -= pGravity[i] * dt;
    const drag = 1 - Math.min(1, dt * 2.5);
    pVel[k] *= drag;
    pVel[k + 1] *= drag;
    pVel[k + 2] *= drag;
    pPos[k] += pVel[k] * dt;
    pPos[k + 1] += pVel[k + 1] * dt;
    pPos[k + 2] += pVel[k + 2] * dt;
    if (pPos[k + 1] < 0.02) {
      pPos[k + 1] = 0.02;
      pVel[k + 1] *= -0.3;
    }
    const fade = pLife[i] / pMaxLife[i];
    pCol[k] = pBase[k] * fade;
    pCol[k + 1] = pBase[k + 1] * fade;
    pCol[k + 2] = pBase[k + 2] * fade;
  }
  particleGeo.attributes.position.needsUpdate = true;
  particleGeo.attributes.color.needsUpdate = true;
}

function clearParticles() {
  pLife.fill(0);
  pCol.fill(0);
  for (let i = 0; i < PARTICLE_MAX; i += 1) pPos[i * 3 + 1] = -1000;
  particleGeo.attributes.position.needsUpdate = true;
  particleGeo.attributes.color.needsUpdate = true;
}

// 사격장 공기 중에 떠다니는 먼지(별도의 작은 Points, 처음 한 번만 생성).
const DUST_COUNT = 260;
const dustPos = new Float32Array(DUST_COUNT * 3);
for (let i = 0; i < DUST_COUNT; i += 1) {
  dustPos[i * 3] = (Math.random() - 0.5) * 24;
  dustPos[i * 3 + 1] = Math.random() * 5;
  dustPos[i * 3 + 2] = -2 - Math.random() * 32;
}
const dustGeo = new THREE.BufferGeometry();
dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3).setUsage(THREE.DynamicDrawUsage));
const dust = new THREE.Points(
  dustGeo,
  new THREE.PointsMaterial({ color: 0xfff4d6, size: 0.035, transparent: true, opacity: 0.55, depthWrite: false }),
);
scene.add(dust);

function updateDust(now, dt) {
  for (let i = 0; i < DUST_COUNT; i += 1) {
    const k = i * 3;
    dustPos[k] += Math.sin(now / 2300 + i) * dt * 0.08;
    dustPos[k + 1] += dt * (0.05 + (i % 5) * 0.01);
    if (dustPos[k + 1] > 5) dustPos[k + 1] = 0;
  }
  dustGeo.attributes.position.needsUpdate = true;
}

const muzzleWorld = new THREE.Vector3();
const aimDir = new THREE.Vector3();
const tmpVec = new THREE.Vector3();

// ---------------------------------------------------------------- Web Audio 효과음
const sfx = {
  ctx: null,
  noise: null,
  master: null,
  /** 사용자 제스처(시작 버튼) 안에서 호출해야 한다. */
  unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      const len = Math.floor(this.ctx.sampleRate * 0.5);
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  },
  burst(start, dur, freq, q, gain) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, start);
    g.gain.exponentialRampToValueAtTime(0.001, start + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(start);
    src.stop(start + dur + 0.02);
  },
  tone(start, dur, f0, f1, gain, type = 'sine') {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, start);
    osc.frequency.exponentialRampToValueAtTime(f1, start + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, start);
    g.gain.exponentialRampToValueAtTime(0.001, start + dur);
    osc.connect(g).connect(this.master);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  },
  play(name) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    if (name === 'shot') {
      this.burst(t, 0.18, 1400, 0.7, 1.0);
      this.tone(t, 0.12, 160, 45, 0.9);
    } else if (name === 'hit') {
      this.tone(t + 0.03, 0.16, 1800, 1500, 0.35, 'triangle');
      this.tone(t + 0.03, 0.22, 2700, 2600, 0.15);
    } else if (name === 'empty') {
      this.burst(t, 0.04, 3200, 4, 0.5);
    } else if (name === 'reload-start') {
      this.burst(t, 0.06, 900, 3, 0.6);
      this.burst(t + 0.12, 0.05, 2200, 5, 0.4);
    } else if (name === 'reload-end') {
      this.burst(t, 0.05, 1600, 4, 0.6);
      this.burst(t + 0.08, 0.07, 700, 3, 0.7);
    } else if (name === 'end') {
      this.tone(t, 0.5, 880, 440, 0.3, 'square');
    }
  },
};

// ---------------------------------------------------------------- 입력·포인터 잠금
let pendingAction = null; // 'start' | 'resume' | null
let yaw = 0;
let pitch = 0;
const raycaster = new THREE.Raycaster();
const SCREEN_CENTER = new THREE.Vector2(0, 0);

function isLocked() {
  return document.pointerLockElement === ui.canvas;
}

/**
 * 버튼 클릭에서 Pointer Lock을 요청한다. 라운드 상태는 잠금 획득(pointerlockchange) 뒤에만 바꾼다.
 * 이미 잠겨 있거나 앞선 요청의 결과를 기다리는 중이면 새 요청을 무시한다.
 * 따라서 중복 클릭이 pendingAction을 덮어쓰거나 초기화를 두 번 실행하지 않는다.
 * @param {'start' | 'resume'} action
 */
function requestLock(action) {
  if (isLocked() || pendingAction !== null) return;
  hideError();
  sfx.unlock();
  if (!ui.canvas.requestPointerLock) {
    showError('이 브라우저는 Pointer Lock을 지원하지 않습니다. 데스크톱 Chrome·Edge·Firefox를 사용하세요.');
    return;
  }
  pendingAction = action;
  try {
    const result = ui.canvas.requestPointerLock();
    if (result && typeof result.catch === 'function') result.catch(onLockError);
  } catch (err) {
    onLockError(err);
  }
}

function onLockError(err) {
  if (pendingAction === null) return;
  pendingAction = null;
  const detail = err && err.message ? ` (${err.message})` : '';
  showError(`마우스 잠금(Pointer Lock)에 실패했습니다${detail}. 잠시 후 버튼을 다시 눌러 주세요.`);
}

document.addEventListener('pointerlockerror', () => onLockError(null));

document.addEventListener('pointerlockchange', () => {
  const now = performance.now();
  if (isLocked()) {
    const action = pendingAction;
    pendingAction = null;
    if (action === 'start') {
      beginNewRound(now);
    } else if (action === 'resume') {
      resume(state, now);
    }
    if (state.phase === PHASE.RUNNING) {
      showPanel(null);
    } else {
      document.exitPointerLock();
    }
    return;
  }
  if (state.phase === PHASE.RUNNING) {
    if (pause(state, now)) showPanel('pause');
    syncRoundView();
  }
});

ui.btnStart.addEventListener('click', () => requestLock('start'));
ui.btnRestart.addEventListener('click', () => requestLock('start'));
ui.btnPauseRestart.addEventListener('click', () => requestLock('start'));
ui.btnResume.addEventListener('click', () => requestLock('resume'));

document.addEventListener('mousemove', (event) => {
  if (!isLocked() || state.phase !== PHASE.RUNNING) return;
  yaw = THREE.MathUtils.clamp(yaw - event.movementX * MOUSE_SENSITIVITY, -MAX_YAW, MAX_YAW);
  pitch = THREE.MathUtils.clamp(pitch - event.movementY * MOUSE_SENSITIVITY, -MAX_PITCH, MAX_PITCH);
});

document.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || !isLocked() || state.phase !== PHASE.RUNNING) return;
  shoot(performance.now());
});

document.addEventListener('keydown', (event) => {
  if (event.code !== 'KeyR' || event.repeat || state.phase !== PHASE.RUNNING) return;
  const result = startReload(state, performance.now());
  if (result.ticked.reloaded) sfx.play('reload-end');
  if (result.started) sfx.play('reload-start');
  syncRoundView();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden || state.phase !== PHASE.RUNNING) return;
  if (pause(state, performance.now())) showPanel('pause');
  syncRoundView();
  if (isLocked()) document.exitPointerLock();
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function collectIntersections() {
  camera.updateMatrixWorld(true);
  raycaster.setFromCamera(SCREEN_CENTER, camera);
  const visibleTargets = targetHitMeshes.filter((mesh) => isShown(mesh));
  const hits = raycaster.intersectObjects([...visibleTargets, ...blockers.filter(isShown)], false);
  return hits.map((hit) => ({ distance: hit.distance, targetId: hit.object.userData.targetId, point: hit.point }));
}

function isShown(object) {
  for (let o = object; o; o = o.parent) if (!o.visible) return false;
  return true;
}

function shoot(now) {
  const intersections = collectIntersections();
  const result = fire(state, now, intersections);
  if (result.ticked.reloaded) sfx.play('reload-end');
  if (!result.fired) {
    if (result.reason === 'empty') {
      sfx.play('empty');
      flashStatus('탄창이 비었습니다 — R 재장전');
    }
    syncRoundView();
    return;
  }
  sfx.play('shot');
  fx.recoil = 1;
  fx.flashUntil = now + 45;
  flash.getWorldPosition(muzzleWorld);
  camera.getWorldDirection(aimDir);
  emitParticles(muzzleWorld, 14, { color: 0xffb347, spread: 0.6, speed: 4, life: 0.18, gravity: 2, dir: aimDir });
  if (result.hit) {
    const view = targetViews[result.targetId];
    view.anim = 'falling';
    view.animT = gameClockMs(state);
    const point = intersections.find((x) => x.targetId === result.targetId).point;
    emitParticles(point, 36, { color: 0xff4a32, spread: 1, speed: 6, life: 0.9, gravity: 9 });
    emitParticles(point, 22, { color: 0xfff1d0, spread: 1, speed: 4.5, life: 0.7, gravity: 9 });
    emitParticles(point, 10, { color: 0xffd34d, spread: 1, speed: 9, life: 0.25, gravity: 0 });
    sfx.play('hit');
    ui.hitmarker.classList.add('show');
    clearTimeout(fx.hitmarkerTimer);
    fx.hitmarkerTimer = setTimeout(() => ui.hitmarker.classList.remove('show'), 90);
  } else {
    const first = intersections.slice().sort((a, b) => a.distance - b.distance)[0];
    if (first) {
      const impact = impacts[impactIndex];
      impactIndex = (impactIndex + 1) % impacts.length;
      impact.mesh.position.copy(first.point);
      impact.mesh.visible = true;
      impact.mesh.material.opacity = 0.8;
      impact.born = now;
      tmpVec.copy(aimDir).multiplyScalar(-0.8);
      emitParticles(first.point, 16, { color: 0x9c8460, spread: 0.7, speed: 2.5, life: 0.8, gravity: 3, dir: tmpVec });
      emitParticles(first.point, 6, { color: 0xffc070, spread: 1, speed: 5, life: 0.15, gravity: 0 });
    }
  }
  syncRoundView();
}

// ---------------------------------------------------------------- HUD·오버레이
let statusUntil = 0;
let statusText = '';
function flashStatus(text) {
  statusText = text;
  statusUntil = performance.now() + 900;
}

function showPanel(name) {
  for (const [key, panel] of Object.entries(ui.panels)) panel.hidden = key !== name;
  ui.overlay.hidden = name === null;
  if (name !== null) ui.error.hidden = ui.error.textContent === '';
}

function showError(message) {
  ui.error.textContent = message;
  ui.error.hidden = false;
  ui.overlay.hidden = false;
}

function hideError() {
  ui.error.textContent = '';
  ui.error.hidden = true;
}

let roundFinished = false;

/**
 * 시작·종료 후 다시 시작·일시 정지 중 다시 시작이 공유하는 새 라운드 초기화.
 * Pointer Lock을 얻은 뒤 한 번만 호출한다. 규칙 상태(점수·탄약·시간·재장전·발사 간격·표적 재등장)는
 * startRound가 초기화하고, 여기서는 이전 라운드의 시점과 일시적 화면 효과를 지운다.
 * 게임 도중 다시 시작하면 반동·섬광·명중 표시·파티클이 진행 중일 수 있으므로 모두 정리한다.
 */
function beginNewRound(now) {
  startRound(state, now);
  yaw = 0;
  pitch = 0;
  fx.recoil = 0;
  fx.flashUntil = 0;
  clearTimeout(fx.hitmarkerTimer);
  ui.hitmarker.classList.remove('show');
  for (const impact of impacts) impact.mesh.visible = false;
  clearParticles();
  statusText = '';
  statusUntil = 0;
  roundFinished = false;
  syncAllTargets();
}

/**
 * 시간을 진행한 모든 경로(프레임·발사·재장전·일시 정지) 뒤에 호출한다.
 * 다시 나타난 표적을 배치하고, 라운드가 끝났으면 입력 종류와 관계없이 종료 화면을 한 번 표시한다.
 */
function syncRoundView() {
  syncRespawnedTargets();
  if (state.phase === PHASE.ENDED && !roundFinished) finishRound();
}

function finishRound() {
  roundFinished = true;
  settleTargetAnimations();
  ui.finalScore.textContent = String(state.score);
  const accuracy = state.shots ? Math.round((state.hits / state.shots) * 100) : 0;
  ui.finalDetail.textContent = `명중 ${state.hits} / 발사 ${state.shots} (명중률 ${accuracy}%)`;
  showPanel('end');
  sfx.play('end');
  if (isLocked()) document.exitPointerLock();
}

let lastHud = '';
function updateHud(now) {
  const seconds = remainingMs(state) / 1000;
  const progress = reloadProgress(state);
  let status = '';
  if (progress !== null) status = '재장전 중…';
  else if (now < statusUntil) status = statusText;
  else if (state.phase === PHASE.RUNNING && state.ammo === 0) status = 'R 키로 재장전';
  const key = `${state.score}|${state.ammo}|${seconds.toFixed(1)}|${status}|${progress}`;
  if (key === lastHud) return;
  lastHud = key;
  ui.score.textContent = String(state.score);
  ui.time.textContent = seconds.toFixed(1);
  ui.timeBox.classList.toggle('low', seconds <= 10 && state.phase !== PHASE.READY);
  ui.ammo.textContent = `${state.ammo} / ${state.config.magazineSize}`;
  ui.ammoBox.classList.toggle('low', state.ammo <= 3);
  ui.status.textContent = status;
  ui.reloadBar.hidden = progress === null;
  if (progress !== null) ui.reloadFill.style.width = `${Math.round(progress * 100)}%`;
}

// ---------------------------------------------------------------- 단일 렌더링 루프
let lastFrame = performance.now();
function frame() {
  // 입력 처리와 같은 시계(performance.now)를 써서 규칙 모듈의 시간이 뒤로 가지 않게 한다.
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  if (state.phase === PHASE.RUNNING) {
    const result = tick(state, now);
    if (result.reloaded) sfx.play('reload-end');
  }
  syncRoundView();

  camera.rotation.set(pitch, yaw, 0);

  const clock = gameClockMs(state);
  for (const view of targetViews) {
    if (view.group.visible && view.slot >= 0) updateTargetView(view, SLOTS[view.slot], clock);
  }

  // 총기 반동과 재장전 자세.
  fx.recoil = Math.max(0, fx.recoil - dt * 9);
  const progress = reloadProgress(state);
  const reloadDip = progress === null ? 0 : Math.sin(progress * Math.PI);
  gun.position.set(GUN_REST.x, GUN_REST.y - reloadDip * 0.12, GUN_REST.z + fx.recoil * 0.06);
  gun.rotation.set(fx.recoil * 0.18 - reloadDip * 0.6, 0, reloadDip * 0.5);
  const flashing = now < fx.flashUntil;
  flash.visible = flashing;
  flash.rotation.z = Math.random() * Math.PI;
  flashLight.intensity = flashing ? 3 : 0;

  for (const impact of impacts) {
    if (!impact.mesh.visible) continue;
    const age = now - impact.born;
    impact.mesh.material.opacity = Math.max(0, 0.8 - age / 1500);
    if (age > 1200) impact.mesh.visible = false;
  }

  updateParticles(dt);
  updateDust(now, dt);

  updateHud(now);
  renderer.render(scene, camera);
}

syncAllTargets();
showPanel('start');
renderer.setAnimationLoop(frame);
