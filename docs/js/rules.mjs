// 순수 게임 규칙 모듈.
// DOM·WebGL·네트워크에 의존하지 않는다. 브라우저(game.mjs)와 Node 테스트가 같은 모듈을 사용한다.
// 모든 시간 인자(now)는 밀리초 단위의 단조 증가 값(performance.now() 등)이다.
// 라운드 시간·재장전·재등장은 "진행 중(running)"일 때만 흐르는 게임 시간(elapsedMs)으로 계산한다.

export const DEFAULT_CONFIG = Object.freeze({
  roundMs: 60_000,
  magazineSize: 12,
  reloadMs: 1_400,
  fireIntervalMs: 110,
  pointsPerHit: 100,
  targetCount: 6,
  slotCount: 12,
  respawnDelayMs: 700,
});

export const PHASE = Object.freeze({
  READY: 'ready',
  RUNNING: 'running',
  PAUSED: 'paused',
  ENDED: 'ended',
});

/** 결정적 테스트를 위한 간단한 시드 난수 생성기(mulberry32). */
export function createRng(seed = 1) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 게임 상태를 만든다. 라운드는 startRound로 시작한다.
 * @param {Partial<typeof DEFAULT_CONFIG>} [config]
 * @param {() => number} [rng] 0 이상 1 미만을 반환하는 난수 함수
 */
export function createGame(config = {}, rng = Math.random) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (cfg.targetCount > cfg.slotCount) {
    throw new RangeError('targetCount must not exceed slotCount');
  }
  const state = {
    config: cfg,
    rng,
    phase: PHASE.READY,
    round: 0,
    score: 0,
    shots: 0,
    hits: 0,
    ammo: cfg.magazineSize,
    reloadEndsAt: null,
    lastShotAt: -Infinity,
    elapsedMs: 0,
    lastTickAt: null,
    targets: [],
  };
  resetTargets(state);
  return state;
}

function resetTargets(state) {
  const { targetCount, slotCount } = state.config;
  const slots = shuffledSlots(slotCount, state.rng).slice(0, targetCount);
  state.targets = slots.map((slot, id) => ({ id, slot, alive: true, respawnAt: null, spawnCount: 1 }));
}

function shuffledSlots(slotCount, rng) {
  const slots = Array.from({ length: slotCount }, (_, i) => i);
  for (let i = slots.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  return slots;
}

/** 라운드를 처음부터 시작한다. 점수·탄약·시간·표적을 모두 초기화한다. */
export function startRound(state, now) {
  const cfg = state.config;
  state.phase = PHASE.RUNNING;
  state.round += 1;
  state.score = 0;
  state.shots = 0;
  state.hits = 0;
  state.ammo = cfg.magazineSize;
  state.reloadEndsAt = null;
  state.lastShotAt = -Infinity;
  state.elapsedMs = 0;
  state.lastTickAt = now;
  resetTargets(state);
  return state;
}

export function remainingMs(state) {
  return Math.max(0, state.config.roundMs - state.elapsedMs);
}

export function isReloading(state) {
  return state.reloadEndsAt !== null;
}

/** 재장전 진행률(0~1). 재장전 중이 아니면 null. */
export function reloadProgress(state) {
  if (state.reloadEndsAt === null) return null;
  const left = state.reloadEndsAt - state.elapsedMs;
  return Math.min(1, Math.max(0, 1 - left / state.config.reloadMs));
}

/**
 * 게임 시간을 now까지 진행한다. 진행 중이 아닐 때는 시간이 흐르지 않는다.
 * @returns {{ ended: boolean, reloaded: boolean, respawned: number[] }}
 */
export function tick(state, now) {
  const result = { ended: false, reloaded: false, respawned: [] };
  if (state.phase !== PHASE.RUNNING) return result;
  const delta = Math.max(0, now - state.lastTickAt);
  state.lastTickAt = now;
  state.elapsedMs = Math.min(state.config.roundMs, state.elapsedMs + delta);

  if (state.reloadEndsAt !== null && state.elapsedMs >= state.reloadEndsAt) {
    state.reloadEndsAt = null;
    state.ammo = state.config.magazineSize;
    result.reloaded = true;
  }

  for (const target of state.targets) {
    if (!target.alive && target.respawnAt !== null && state.elapsedMs >= target.respawnAt) {
      target.slot = pickFreeSlot(state, target.slot);
      target.alive = true;
      target.respawnAt = null;
      target.spawnCount += 1;
      result.respawned.push(target.id);
    }
  }

  if (state.elapsedMs >= state.config.roundMs) {
    state.phase = PHASE.ENDED;
    state.reloadEndsAt = null;
    result.ended = true;
  }
  return result;
}

/** 다른 표적이 쓰지 않는 자리를 고른다. 가능하면 직전 자리는 피한다. */
function pickFreeSlot(state, previousSlot) {
  const used = new Set(state.targets.filter((t) => t.alive || t.respawnAt !== null).map((t) => t.slot));
  used.delete(previousSlot);
  const free = [];
  for (let i = 0; i < state.config.slotCount; i += 1) {
    if (!used.has(i) && i !== previousSlot) free.push(i);
  }
  if (free.length === 0) return previousSlot;
  return free[Math.floor(state.rng() * free.length)];
}

/** Esc 등으로 포인터 잠금이 풀렸을 때 호출한다. */
export function pause(state, now) {
  if (state.phase !== PHASE.RUNNING) return false;
  tick(state, now);
  if (state.phase !== PHASE.RUNNING) return false;
  state.phase = PHASE.PAUSED;
  return true;
}

export function resume(state, now) {
  if (state.phase !== PHASE.PAUSED) return false;
  state.phase = PHASE.RUNNING;
  state.lastTickAt = now;
  return true;
}

/** 발사 불가 이유. 발사 가능하면 null. tick 이후 상태 기준으로 판단한다. */
export function fireBlockReason(state) {
  if (state.phase !== PHASE.RUNNING) return 'not-running';
  if (state.reloadEndsAt !== null) return 'reloading';
  if (state.ammo <= 0) return 'empty';
  if (state.elapsedMs - state.lastShotAt < state.config.fireIntervalMs) return 'cooldown';
  return null;
}

/**
 * 시선 광선과의 교차 결과에서 실제로 맞은 대상을 고른다.
 * 교차 항목은 { distance, targetId } 형태이며 targetId가 null이면 벽·엄폐물 같은 차단물이다.
 * 가장 가까운 유효한 항목만 처리한다. 제거된(alive=false) 표적은 무시하고,
 * 그보다 가까운 차단물이 있으면 빗나감(null)이다.
 * @returns {number|null} 맞은 표적 id
 */
export function pickHitTarget(state, intersections) {
  const sorted = [...intersections]
    .filter((hit) => Number.isFinite(hit.distance) && hit.distance >= 0)
    .sort((a, b) => a.distance - b.distance);
  for (const hit of sorted) {
    if (hit.targetId === null || hit.targetId === undefined) return null;
    const target = state.targets[hit.targetId];
    if (target && target.alive) return target.id;
  }
  return null;
}

/**
 * 한 발을 발사한다. 발사되면 탄약 1발을 소모하고 명중 시 점수를 한 번 더한다.
 * @param {Array<{distance:number, targetId:number|null}>} intersections 발사 순간의 교차 결과
 * @returns {{ fired: boolean, reason: string|null, hit: boolean, targetId: number|null, ended: boolean }}
 */
export function fire(state, now, intersections = []) {
  const ticked = tick(state, now);
  const reason = fireBlockReason(state);
  if (reason !== null) {
    return { fired: false, reason, hit: false, targetId: null, ended: ticked.ended, ticked };
  }
  state.ammo -= 1;
  state.shots += 1;
  state.lastShotAt = state.elapsedMs;
  const targetId = pickHitTarget(state, intersections);
  if (targetId !== null) {
    const target = state.targets[targetId];
    target.alive = false;
    target.respawnAt = state.elapsedMs + state.config.respawnDelayMs;
    state.hits += 1;
    state.score += state.config.pointsPerHit;
  }
  return { fired: true, reason: null, hit: targetId !== null, targetId, ended: false, ticked };
}

/**
 * 재장전을 시작한다.
 * @returns {{ started: boolean, reason: string|null }}
 */
export function startReload(state, now) {
  tick(state, now);
  if (state.phase !== PHASE.RUNNING) return { started: false, reason: 'not-running' };
  if (state.reloadEndsAt !== null) return { started: false, reason: 'reloading' };
  if (state.ammo >= state.config.magazineSize) return { started: false, reason: 'full' };
  state.reloadEndsAt = state.elapsedMs + state.config.reloadMs;
  return { started: true, reason: null };
}
