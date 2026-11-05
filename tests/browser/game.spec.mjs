// 실제 헤드리스 Chromium(SwiftShader WebGL)에서 게임 흐름을 검증한다.
// 입력은 Playwright의 실제 마우스·키보드, 잠금은 실제 Pointer Lock, 시간은 실제 시간이다.
// 게임 상태·카메라·타이머를 바꾸거나 게임 함수를 직접 호출하지 않는다.
import { test, expect } from '@playwright/test';
import { performance } from 'node:perf_hooks';
import {
  Aim,
  CDN_PREFIX,
  Evidence,
  aimAtVisibleTarget,
  ammoOf,
  analyze,
  clickForLock,
  pauseGame,
  readHud,
  sceneDiff,
  skyGroundContrast,
  visibleStaticTargets,
  waitFrames,
} from './helpers.mjs';

const URL = '/docs/index.html';
const SHOT_GAP_MS = 250; // 발사 간격(110ms)보다 충분히 길게

let ev;
test.beforeEach(async ({ page, browser }, testInfo) => {
  ev = new Evidence(testInfo.title.split(':')[0], page, browser);
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    await ev.shot('failure').catch(() => {});
    await ev.step('실패 시점 상태').catch(() => {});
  }
  ev.save(testInfo.status);
  // 수집한 오류는 시나리오와 관계없이 실패로 처리한다(허용 목록 없음).
  const origin = new globalThis.URL(page.url()).origin;
  const external = ev.data.requests.filter((r) => !r.url.startsWith(origin));
  expect(ev.data.pageErrors, 'pageerror').toEqual([]);
  expect(ev.data.console.filter((m) => m.type === 'error' || m.type === 'warning'), 'console error/warning').toEqual([]);
  expect(ev.data.failedRequests, 'requestfailed').toEqual([]);
  expect(ev.data.httpErrors, 'HTTP >= 400').toEqual([]);
  expect(external.filter((r) => !r.url.startsWith(CDN_PREFIX)), '버전 고정 CDN 외 외부 요청').toEqual([]);
});

async function openGame(page) {
  await page.goto(URL);
  await expect(page.locator('#panel-start')).toBeVisible();
  // 첫 프레임이 그려질 때까지 HUD가 아닌 장면 자체(하늘·바닥 밝기 차이)를 관측한다.
  // 시작 안내의 반투명 배경이 표적을 가리므로 표적은 시작 직후 첫 화면에서 따로 확인한다.
  await expect.poll(async () => skyGroundContrast(await analyze(page)), { timeout: 30_000 }).toBeGreaterThan(15);
}

/** 시작 버튼 위에서 클릭하여 잠금을 얻고, 그 커서 위치에서 상대 이동을 시작한다. */
async function startRound(page, selector = '#btn-start') {
  const box = await page.locator(selector).boundingBox();
  const aim = new Aim(page, Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
  await page.mouse.move(aim.x, aim.y);
  const tClick = performance.now();
  await clickForLock(page, selector, ev);
  return { aim, tClick };
}

async function fireOnce(page, aim) {
  await aim.click();
  await page.waitForTimeout(SHOT_GAP_MS);
  return readHud(page);
}

/** 하늘을 향해(표적·벽 위) 조준한다. pitch 상한 40°로 제한된다. */
async function lookAtSky(aim) {
  await aim.move(0, -260);
}

test('01-play-hit-miss-reload: 초기 렌더링, 조준·명중·빗나감, 탄창 소진과 R 재장전', async ({ page }) => {
  await openGame(page);
  const initial = await analyze(page);
  const gl = await page.evaluate(() => {
    // 게임이 이미 만든 WebGL2 컨텍스트를 되돌려받아 렌더러 이름만 읽는다.
    const ctx = document.getElementById('scene').getContext('webgl2');
    const dbg = ctx && ctx.getExtension('WEBGL_debug_renderer_info');
    return ctx ? { version: ctx.getParameter(ctx.VERSION), renderer: dbg ? ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER) } : null;
  });
  await ev.step('초기 화면', { webgl: gl, skyGroundContrast: skyGroundContrast(initial), redBlobs: initial.redBlobs, gunDarkPixels: initial.gunDark });
  await ev.shot('initial');
  expect(gl, 'WebGL2 컨텍스트').not.toBeNull();
  await expect(page.locator('#panel-start')).toContainText('표적 사격장');
  await expect(page.locator('#panel-start')).toContainText('60초 동안 최대한 많은 표적을 맞히세요.');
  await expect(page.locator('#btn-start')).toHaveText('시작');
  expect(ev.data.requests.some((r) => r.url === `${CDN_PREFIX}build/three.module.js`)).toBe(true);

  const { aim } = await startRound(page);
  let hud = await ev.step('시작 직후');
  expect(hud.pointerLock).toBe('#scene');
  expect(hud.panel).toBeNull();
  expect(hud.score).toBe('0');
  expect(hud.ammo).toBe('12 / 12');
  await waitFrames(page, 2);
  const { shot: started, found: visibleAtStart } = await visibleStaticTargets(page);
  await ev.step('시작 직후 장면', { gunDarkPixels: started.gunDark, redBlobs: started.redBlobs.length, visibleStaticSlots: visibleAtStart.map((f) => f.slot) });
  expect(started.gunDark, '총기 모델(오른쪽 아래 어두운 픽셀)').toBeGreaterThan(750);
  expect(started.redBlobs.length, '장면의 표적 원판').toBeGreaterThan(0);
  await ev.shot('started');

  // 조준: 실제 마우스 이동 전후의 화면 변화와 표적 위치 이동.
  await aim.move(120, 0);
  await waitFrames(page, 2);
  const turned = await analyze(page);
  const turnDiff = sceneDiff(started, turned);
  await ev.step('마우스 오른쪽 120px 이동 후', { sceneDiff: turnDiff, before: started.redBlobs, after: turned.redBlobs });
  expect(turnDiff, '조준 이동에 따른 화면 변화').toBeGreaterThan(3);
  await aim.move(-120, 0);

  // 보이는 표적 명중: 정확히 +100, 탄약 -1.
  let shots = 0;
  let hitHud = null;
  const tried = [];
  for (let attempt = 1; attempt <= 2 && !hitHud; attempt += 1) {
    const prev = await readHud(page);
    const aimed = await aimAtVisibleTarget(page, aim, ev, tried);
    tried.push(aimed.target.slot);
    await ev.shot(`aimed-${attempt}`);
    hud = await fireOnce(page, aim);
    shots += 1;
    const delta = Number(hud.score) - Number(prev.score);
    await ev.step(`표적 사격 시도 ${attempt}`, { target: aimed.target, centeredBeforeShot: aimed.centered, scoreDelta: delta });
    expect(ammoOf(hud)).toBe(ammoOf(prev) - 1);
    expect([0, 100]).toContain(delta);
    if (delta === 100) hitHud = hud;
  }
  expect(hitHud, '보이는 표적 명중').not.toBeNull();
  await ev.shot('hit');
  const afterHit = await analyze(page);
  await ev.step('명중 뒤 장면', { redBlobs: afterHit.redBlobs });

  // 빗나감: 하늘 사격은 점수를 바꾸지 않고 한 발만 소모한다.
  await lookAtSky(aim);
  await page.waitForTimeout(200);
  let prev = await readHud(page);
  hud = await fireOnce(page, aim);
  shots += 1;
  await ev.step('하늘 사격(빗나감)');
  expect(hud.score).toBe(prev.score);
  expect(ammoOf(hud)).toBe(ammoOf(prev) - 1);

  // 탄창 소진: 남은 탄을 하늘에 쏜다. 클릭마다 정확히 한 발.
  while (ammoOf(hud) > 0) {
    prev = hud;
    hud = await fireOnce(page, aim);
    shots += 1;
    expect(ammoOf(hud)).toBe(ammoOf(prev) - 1);
    expect(hud.score).toBe(prev.score);
  }
  await ev.step('탄창 소진', { shots });
  expect(shots).toBe(12);
  const finalScoreBeforeReload = hud.score;

  // 빈 탄창 클릭: 탄약·점수 불변.
  hud = await fireOnce(page, aim);
  await ev.step('빈 탄창 클릭');
  expect(hud.ammo).toBe('0 / 12');
  expect(hud.score).toBe(finalScoreBeforeReload);

  // R 재장전: 표시 등장, 재장전 중 클릭 차단, 1.4초 뒤 12발.
  const tR = performance.now();
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(150);
  hud = await ev.step('R 직후');
  expect(hud.reloadBarHidden).toBe(false);
  expect(hud.status).toBe('재장전 중…');
  await ev.shot('reloading');
  await aim.click();
  await page.waitForTimeout(150);
  hud = await ev.step('재장전 중 클릭');
  expect(hud.ammo).toBe('0 / 12');
  expect(hud.score).toBe(finalScoreBeforeReload);
  expect(hud.reloadBarHidden).toBe(false);
  await expect.poll(async () => (await readHud(page)).ammo, { timeout: 10_000, intervals: [50] }).toBe('12 / 12');
  const reloadObservedMs = performance.now() - tR;
  hud = await ev.step('재장전 완료 관측', { msSinceR: Math.round(reloadObservedMs) });
  expect(reloadObservedMs, '실제 1.4초 이상 경과 뒤 복구').toBeGreaterThanOrEqual(1_400);
  expect(hud.reloadBarHidden).toBe(true);
  await ev.shot('reloaded');

  prev = hud;
  hud = await fireOnce(page, aim);
  await ev.step('재장전 후 첫 발사');
  expect(hud.ammo).toBe('11 / 12');
  expect(hud.score).toBe(prev.score);
  ev.note('이 시나리오는 라운드 종료(60초)를 기다리지 않는다. 03 시나리오에서 별도 검증.');
});

test('02-pause-resume-restart: 일시 정지·시간 정지·계속하기·게임 도중 다시 시작', async ({ page }) => {
  await openGame(page);
  const { aim } = await startRound(page);
  const started = await analyze(page);
  let hud = await ev.step('시작');

  // 명중 후 일시 정지.
  let hit = null;
  const tried = [];
  for (let attempt = 1; attempt <= 2 && !hit; attempt += 1) {
    tried.push((await aimAtVisibleTarget(page, aim, ev, tried)).target.slot);
    hud = await fireOnce(page, aim);
    if (hud.score === '100') hit = hud;
    await ev.step(`표적 사격 시도 ${attempt}`);
  }
  expect(hit, '일시 정지 전 명중').not.toBeNull();
  await aim.move(150, -120); // 시점을 돌려 재시작의 조준 초기화를 관측할 수 있게 한다
  await waitFrames(page, 2);
  const turned = await analyze(page);

  let p = await pauseGame(page, ev);
  hud = await ev.step('일시 정지 진입', { escKeyReleasedLock: p.escReleased, releasedVia: p.via });
  expect(hud.panel).toBe('panel-pause');
  expect(hud.pointerLock).toBeNull();
  const pausedTime = hud.time;
  await ev.shot('paused');
  await page.waitForTimeout(3_000);
  hud = await ev.step('일시 정지 3초 후');
  expect(hud.time, '일시 정지 중 시간 정지').toBe(pausedTime);
  expect(hud.score).toBe('100');

  // 계속하기: 잠금 해제 직후 재잠금 제한이 있으면 clickForLock이 기록 후 재시도한다.
  await clickForLock(page, '#btn-resume', ev);
  await page.waitForTimeout(1_500);
  hud = await ev.step('계속하기 후 1.5초');
  expect(hud.panel).toBeNull();
  expect(Number(hud.time)).toBeLessThan(Number(pausedTime));
  expect(Number(hud.time)).toBeGreaterThan(Number(pausedTime) - 5);
  expect(hud.score).toBe('100');

  // 명중 후 일시 정지 화면의 다시 시작.
  p = await pauseGame(page, ev);
  await ev.step('두 번째 일시 정지', { escKeyReleasedLock: p.escReleased, releasedVia: p.via });
  // 버튼은 잠금 뒤 숨겨지므로 클릭 위치(=다시 시작 뒤 조준 기준점)를 먼저 읽는다.
  const box = await page.locator('#btn-pause-restart').boundingBox();
  await page.locator('#btn-pause-restart').hover();
  await clickForLock(page, '#btn-pause-restart', ev);
  await page.waitForTimeout(400);
  hud = await ev.step('명중 후 다시 시작');
  expect(hud.score).toBe('0');
  expect(hud.ammo).toBe('12 / 12');
  expect(Number(hud.time)).toBeGreaterThan(58);
  expect(hud.reloadBarHidden).toBe(true);
  aim.rebase(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
  await waitFrames(page, 2);
  const restarted1 = await analyze(page);
  // 조준 초기화: 다시 시작 직후 장면이 돌린 시점보다 처음 시작한 시점에 가깝다(표적 배치는 무작위로 바뀐다).
  const dStart = sceneDiff(restarted1, started);
  const dTurned = sceneDiff(restarted1, turned);
  await ev.step('조준 초기화 관측', { diffToInitialView: dStart, diffToTurnedView: dTurned });
  expect(dStart).toBeLessThan(dTurned);
  await ev.shot('restart-after-hit');

  // 재장전 중 다시 시작.
  await lookAtSky(aim);
  hud = await fireOnce(page, aim);
  expect(hud.ammo).toBe('11 / 12');
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(100);
  hud = await ev.step('재장전 시작');
  expect(hud.reloadBarHidden).toBe(false);
  p = await pauseGame(page, ev);
  hud = await ev.step('재장전 중 일시 정지', { escKeyReleasedLock: p.escReleased, releasedVia: p.via });
  expect(hud.reloadBarHidden).toBe(false);
  await ev.shot('paused-during-reload');
  const box2 = await page.locator('#btn-pause-restart').boundingBox();
  await clickForLock(page, '#btn-pause-restart', ev);
  await page.waitForTimeout(400);
  hud = await ev.step('재장전 중 다시 시작');
  expect(hud.score).toBe('0');
  expect(hud.ammo).toBe('12 / 12');
  expect(Number(hud.time)).toBeGreaterThan(58);
  expect(hud.reloadBarHidden).toBe(true);
  expect(hud.status).toBe('');
  const restarted2 = await analyze(page);
  await ev.step('두 번째 재시작 조준 초기화', { diffToInitialView: sceneDiff(restarted2, started) });
  expect(sceneDiff(restarted2, started)).toBeLessThan(sceneDiff(restarted2, turned));
  await ev.shot('restart-during-reload');

  // 두 차례 재시작 뒤: 메뉴 클릭은 탄약을 쓰지 않았고 첫 클릭은 한 발만 소모한다.
  aim.rebase(Math.round(box2.x + box2.width / 2), Math.round(box2.y + box2.height / 2));
  await lookAtSky(aim);
  hud = await fireOnce(page, aim);
  await ev.step('재시작 2회 후 첫 클릭');
  expect(hud.ammo).toBe('11 / 12');
  expect(hud.score).toBe('0');
});

test('03-full-round: 실제 60초 라운드 종료, 종료 후 입력 차단, 다시 시작', async ({ page }) => {
  test.setTimeout(150_000);
  await openGame(page);
  const { aim, tClick } = await startRound(page);
  await ev.step('라운드 시작');

  // 한 발 명중을 시도하여 최종 점수가 0이 아닌 경우도 검증한다(명중 여부는 기록만 한다).
  await aimAtVisibleTarget(page, aim, ev);
  let hud = await fireOnce(page, aim);
  await ev.step('사격 1발');
  const scoreAtShot = hud.score;

  // 활성 플레이 시간 관측: 일시 정지 없이 60초. 1초 간격으로 단조 시계와 HUD를 기록한다.
  let endT = null;
  let lastRunningHud = hud;
  while (performance.now() - tClick < 75_000) {
    await page.waitForTimeout(1_000);
    hud = await readHud(page);
    const sinceClick = Math.round(performance.now() - tClick);
    ev.note('시간 관측', { sinceClickMs: sinceClick, time: hud.time, panel: hud.panel, score: hud.score });
    if (hud.panel === 'panel-end') {
      endT = sinceClick;
      break;
    }
    expect(hud.panel, '종료 전 다른 패널이 나타나지 않음').toBeNull();
    lastRunningHud = hud;
  }
  expect(endT, '75초 안에 종료 화면').not.toBeNull();
  // 시작 클릭 이전 시각을 기준으로 한 경과가 60초보다 짧으면 조기 종료다.
  expect(endT).toBeGreaterThanOrEqual(60_000);
  hud = await ev.step('종료 화면', { sinceClickMs: endT, lastRunningTime: lastRunningHud.time });
  expect(hud.time).toBe('0.0');
  expect(hud.pointerLock).toBeNull();
  expect(hud.score).toBe(scoreAtShot);
  const finalScore = await page.locator('#final-score').textContent();
  expect(finalScore).toBe(scoreAtShot);
  await expect(page.locator('#final-detail')).toContainText('발사 1');
  await ev.shot('ended');

  // 종료 후 입력: 화면 클릭, R, 마우스 이동은 점수·탄약을 바꾸지 않는다.
  await page.mouse.click(100, 300);
  await page.keyboard.press('KeyR');
  await page.mouse.move(300, 200, { steps: 3 });
  await page.waitForTimeout(400);
  const after = await ev.step('종료 후 입력');
  expect(after.score).toBe(hud.score);
  expect(after.ammo).toBe(hud.ammo);
  expect(after.panel).toBe('panel-end');
  expect(after.reloadBarHidden).toBe(true);

  const box = await page.locator('#btn-restart').boundingBox();
  aim.rebase(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
  await page.mouse.move(aim.x, aim.y);
  await clickForLock(page, '#btn-restart', ev);
  await page.waitForTimeout(300);
  hud = await ev.step('종료 화면에서 다시 시작');
  expect(hud.score).toBe('0');
  expect(hud.ammo).toBe('12 / 12');
  expect(Number(hud.time)).toBeGreaterThan(58);
  expect(hud.panel).toBeNull();
  await page.waitForTimeout(1_500);
  const later = await ev.step('다시 시작 1.5초 후');
  expect(Number(later.time)).toBeLessThan(Number(hud.time));
  await ev.shot('restarted');
});
