// docs/js/game.mjs가 실제로 사용하는 규칙 모듈을 검사한다. DOM·WebGL·네트워크가 필요 없다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  PHASE,
  createGame,
  createRng,
  startRound,
  tick,
  fire,
  startReload,
  pause,
  resume,
  pickHitTarget,
  remainingMs,
  isReloading,
  reloadProgress,
} from '../docs/js/rules.mjs';

const T0 = 10_000;
const GAP = DEFAULT_CONFIG.fireIntervalMs;

function running(config = {}) {
  const state = createGame(config, createRng(42));
  startRound(state, T0);
  return state;
}

/** 발사 간격을 지키며 n발을 쏜다. 마지막 시각을 반환한다. */
function shootMany(state, n, start, intersections = []) {
  let t = start;
  for (let i = 0; i < n; i += 1) {
    const r = fire(state, t, intersections);
    assert.equal(r.fired, true, `shot ${i} should fire`);
    t += GAP;
  }
  return t;
}

test('라운드 시작 전에는 발사되지 않는다', () => {
  const state = createGame({}, createRng(1));
  assert.equal(state.phase, PHASE.READY);
  const r = fire(state, T0, [{ distance: 5, targetId: 0 }]);
  assert.equal(r.fired, false);
  assert.equal(r.reason, 'not-running');
  assert.equal(state.ammo, DEFAULT_CONFIG.magazineSize);
  assert.equal(state.score, 0);
});

test('조준한 표적을 맞히면 점수가 정확히 한 번 증가하고 표적이 제거된다', () => {
  const state = running();
  const r = fire(state, T0 + 10, [{ distance: 8, targetId: 2 }]);
  assert.equal(r.fired, true);
  assert.equal(r.hit, true);
  assert.equal(r.targetId, 2);
  assert.equal(state.score, DEFAULT_CONFIG.pointsPerHit);
  assert.equal(state.hits, 1);
  assert.equal(state.targets[2].alive, false);
});

test('빗나간 발사는 탄약만 소모하고 점수를 올리지 않는다', () => {
  const state = running();
  const r = fire(state, T0 + 10, []);
  assert.equal(r.fired, true);
  assert.equal(r.hit, false);
  assert.equal(state.score, 0);
  assert.equal(state.ammo, DEFAULT_CONFIG.magazineSize - 1);
  const wall = fire(state, T0 + 10 + GAP, [{ distance: 20, targetId: null }]);
  assert.equal(wall.hit, false);
  assert.equal(state.score, 0);
});

test('여러 교차 중 가장 가까운 표적만 처리한다', () => {
  const state = running();
  const r = fire(state, T0 + 10, [
    { distance: 30, targetId: 1 },
    { distance: 12, targetId: 3 },
    { distance: 18, targetId: 4 },
  ]);
  assert.equal(r.targetId, 3);
  assert.equal(state.targets[3].alive, false);
  assert.equal(state.targets[1].alive, true);
  assert.equal(state.targets[4].alive, true);
  assert.equal(state.score, DEFAULT_CONFIG.pointsPerHit);
});

test('더 가까운 차단물에 가려진 표적은 맞지 않는다', () => {
  const state = running();
  const r = fire(state, T0 + 10, [
    { distance: 15, targetId: 0 },
    { distance: 6, targetId: null },
  ]);
  assert.equal(r.fired, true);
  assert.equal(r.hit, false);
  assert.equal(state.targets[0].alive, true);
  assert.equal(state.score, 0);
});

test('이미 제거된 표적은 중복 점수를 주지 않고 뒤의 표적이나 차단물로 넘어간다', () => {
  const state = running();
  fire(state, T0 + 10, [{ distance: 10, targetId: 0 }]);
  assert.equal(state.score, 100);
  // 같은 표적을 다시 쏜다.
  const again = fire(state, T0 + 10 + GAP, [{ distance: 10, targetId: 0 }]);
  assert.equal(again.fired, true);
  assert.equal(again.hit, false);
  assert.equal(state.score, 100);
  // 제거된 표적 뒤에 살아 있는 표적이 있으면 그것을 맞힌다.
  const behind = fire(state, T0 + 10 + 2 * GAP, [
    { distance: 10, targetId: 0 },
    { distance: 25, targetId: 5 },
  ]);
  assert.equal(behind.targetId, 5);
  assert.equal(state.score, 200);
  // 같은 교차 목록에 같은 표적이 여러 번 있어도 한 번만 처리한다.
  const state2 = running();
  fire(state2, T0 + 10, [
    { distance: 10, targetId: 1 },
    { distance: 10.2, targetId: 1 },
  ]);
  assert.equal(state2.score, 100);
  assert.equal(state2.hits, 1);
});

test('pickHitTarget은 비정상 거리 값을 무시한다', () => {
  const state = running();
  assert.equal(pickHitTarget(state, [{ distance: NaN, targetId: 1 }]), null);
  assert.equal(pickHitTarget(state, [{ distance: -1, targetId: 1 }, { distance: 3, targetId: 2 }]), 2);
  assert.equal(pickHitTarget(state, [{ distance: 3, targetId: 99 }]), null);
});

test('발사 간격 안의 연속 입력은 발사되지 않는다', () => {
  const state = running();
  assert.equal(fire(state, T0 + 10, []).fired, true);
  const quick = fire(state, T0 + 10 + GAP - 1, []);
  assert.equal(quick.fired, false);
  assert.equal(quick.reason, 'cooldown');
  assert.equal(state.ammo, DEFAULT_CONFIG.magazineSize - 1);
  assert.equal(fire(state, T0 + 10 + GAP, []).fired, true);
});

test('탄창을 비우면 발사되지 않고 R 재장전 후 다시 발사된다', () => {
  const state = running();
  let t = shootMany(state, DEFAULT_CONFIG.magazineSize, T0 + 10, [{ distance: 5, targetId: null }]);
  assert.equal(state.ammo, 0);
  const empty = fire(state, t, [{ distance: 5, targetId: 0 }]);
  assert.equal(empty.fired, false);
  assert.equal(empty.reason, 'empty');
  assert.equal(state.score, 0);
  assert.equal(state.shots, DEFAULT_CONFIG.magazineSize);

  const reload = startReload(state, t);
  assert.deepEqual(reload, { started: true, reason: null });
  assert.equal(isReloading(state), true);
  assert.equal(reloadProgress(state), 0);

  // 재장전 중에는 발사·중복 재장전이 되지 않는다.
  const during = fire(state, t + DEFAULT_CONFIG.reloadMs / 2, [{ distance: 5, targetId: 0 }]);
  assert.equal(during.fired, false);
  assert.equal(during.reason, 'reloading');
  assert.ok(Math.abs(reloadProgress(state) - 0.5) < 1e-9);
  assert.equal(startReload(state, t + 10).reason, 'reloading');

  t += DEFAULT_CONFIG.reloadMs;
  const done = tick(state, t);
  assert.equal(done.reloaded, true);
  assert.equal(state.ammo, DEFAULT_CONFIG.magazineSize);
  assert.equal(isReloading(state), false);
  assert.equal(fire(state, t, [{ distance: 5, targetId: 0 }]).hit, true);
});

test('탄창이 가득 차 있으면 재장전을 시작하지 않는다', () => {
  const state = running();
  assert.deepEqual(startReload(state, T0 + 1), { started: false, reason: 'full' });
});

test('점수는 명중마다 누적되고 표적은 지연 후 다른 자리에서 다시 나타난다', () => {
  const state = running();
  const before = state.targets[0].slot;
  let t = T0 + 10;
  for (const id of [0, 1, 2]) {
    assert.equal(fire(state, t, [{ distance: 9, targetId: id }]).hit, true);
    t += GAP;
  }
  assert.equal(state.score, 300);
  assert.equal(state.hits, 3);

  const r = tick(state, T0 + 10 + DEFAULT_CONFIG.respawnDelayMs);
  assert.deepEqual(r.respawned, [0]);
  assert.equal(state.targets[0].alive, true);
  assert.notEqual(state.targets[0].slot, before);
  // 살아 있는 표적끼리 자리가 겹치지 않는다.
  tick(state, t + DEFAULT_CONFIG.respawnDelayMs);
  const slots = state.targets.filter((x) => x.alive).map((x) => x.slot);
  assert.equal(new Set(slots).size, slots.length);
  assert.equal(fire(state, t + DEFAULT_CONFIG.respawnDelayMs, [{ distance: 9, targetId: 0 }]).hit, true);
  assert.equal(state.score, 400);
});

test('60초가 지나면 라운드가 끝나고 이후 사격·재장전으로 상태가 바뀌지 않는다', () => {
  const state = running();
  fire(state, T0 + 10, [{ distance: 9, targetId: 0 }]);
  assert.equal(remainingMs(state), DEFAULT_CONFIG.roundMs - 10);
  const mid = tick(state, T0 + DEFAULT_CONFIG.roundMs - 1);
  assert.equal(mid.ended, false);
  assert.equal(state.phase, PHASE.RUNNING);

  const end = tick(state, T0 + DEFAULT_CONFIG.roundMs);
  assert.equal(end.ended, true);
  assert.equal(state.phase, PHASE.ENDED);
  assert.equal(remainingMs(state), 0);

  const scoreAtEnd = state.score;
  const ammoAtEnd = state.ammo;
  const late = fire(state, T0 + DEFAULT_CONFIG.roundMs + 500, [{ distance: 9, targetId: 1 }]);
  assert.equal(late.fired, false);
  assert.equal(late.reason, 'not-running');
  assert.equal(state.score, scoreAtEnd);
  assert.equal(state.ammo, ammoAtEnd);
  assert.equal(startReload(state, T0 + DEFAULT_CONFIG.roundMs + 600).started, false);
});

test('시간이 지난 뒤 들어온 발사는 종료 처리되며 점수를 올리지 않는다', () => {
  const state = running();
  const r = fire(state, T0 + DEFAULT_CONFIG.roundMs + 5, [{ distance: 9, targetId: 0 }]);
  assert.equal(r.fired, false);
  assert.equal(r.ended, true);
  assert.equal(state.phase, PHASE.ENDED);
  assert.equal(state.score, 0);
});

test('일시 정지 중에는 시간·재장전이 흐르지 않고 발사되지 않는다', () => {
  const state = running();
  fire(state, T0 + 10, []);
  startReload(state, T0 + 1000);
  assert.equal(pause(state, T0 + 2000), true);
  assert.equal(state.phase, PHASE.PAUSED);
  const frozen = remainingMs(state);
  const progress = reloadProgress(state);
  tick(state, T0 + 50_000);
  assert.equal(fire(state, T0 + 50_000, [{ distance: 1, targetId: 0 }]).fired, false);
  assert.equal(remainingMs(state), frozen);
  assert.equal(reloadProgress(state), progress);
  assert.equal(resume(state, T0 + 100_000), true);
  tick(state, T0 + 100_500);
  assert.equal(remainingMs(state), frozen - 500);
  assert.equal(resume(state, T0 + 100_600), false);
});

test('다시 시작하면 점수·탄약·시간·표적·재장전 상태가 초기화된다', () => {
  const state = running();
  let t = shootMany(state, 5, T0 + 10, [{ distance: 9, targetId: 0 }]);
  fire(state, t, [{ distance: 9, targetId: 1 }]);
  startReload(state, t + GAP);
  tick(state, T0 + DEFAULT_CONFIG.roundMs + 1);
  assert.equal(state.phase, PHASE.ENDED);
  assert.ok(state.score > 0);

  for (let round = 0; round < 3; round += 1) {
    const now = 200_000 + round * 100_000;
    startRound(state, now);
    assert.equal(state.phase, PHASE.RUNNING);
    assert.equal(state.score, 0);
    assert.equal(state.shots, 0);
    assert.equal(state.hits, 0);
    assert.equal(state.ammo, DEFAULT_CONFIG.magazineSize);
    assert.equal(isReloading(state), false);
    assert.equal(remainingMs(state), DEFAULT_CONFIG.roundMs);
    assert.equal(state.targets.length, DEFAULT_CONFIG.targetCount);
    assert.ok(state.targets.every((x) => x.alive && x.respawnAt === null));
    assert.equal(new Set(state.targets.map((x) => x.slot)).size, DEFAULT_CONFIG.targetCount);
    // 새 라운드는 시작 시각부터 다시 60초다.
    assert.equal(fire(state, now + 1, [{ distance: 9, targetId: 0 }]).hit, true);
    assert.equal(state.score, DEFAULT_CONFIG.pointsPerHit);
    tick(state, now + DEFAULT_CONFIG.roundMs);
    assert.equal(state.phase, PHASE.ENDED);
  }
  assert.equal(state.round, 4);
});

test('표적 수가 자리 수보다 많으면 설정 오류다', () => {
  assert.throws(() => createGame({ targetCount: 5, slotCount: 4 }), RangeError);
});
