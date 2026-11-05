// Playwright 시나리오의 읽기 전용 관측·입력 헬퍼.
// 게임 상태·카메라·타이머를 바꾸거나 게임 함수를 호출하지 않는다.
// 입력은 Playwright의 실제 마우스·키보드(CDP Input 이벤트)로만 보낸다.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

export const CDN_PREFIX = 'https://cdn.jsdelivr.net/npm/three@0.170.0/';
export const MOUSE_SENSITIVITY = 0.0022; // docs/js/game.mjs와 같은 값(조준 각도 → 마우스 이동량 환산용)
const VERTICAL_FOV_DEG = 72; // docs/js/game.mjs의 PerspectiveCamera FOV

/** 증거 출력 경로. 반복 실행은 test-results/(무시됨), 보존할 대표 실행만 EVIDENCE_DIR로 지정한다. */
export const EVIDENCE_DIR = path.resolve(process.env.EVIDENCE_DIR || 'test-results/evidence');

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return '(git 정보를 읽지 못함)';
  }
}

/** 기준 SHA와 작업 트리 변경 식별 정보. */
export function revisionInfo() {
  const diff = git(['diff', 'HEAD', '--', 'docs']);
  return {
    head: git(['rev-parse', 'HEAD']),
    statusShort: git(['status', '--short', '--untracked-files=all', '--', '.', ':!node_modules', ':!test-results']).split('\n').filter(Boolean),
    docsDiffVsHead: diff === '' ? 'none' : `sha256:${createHash('sha256').update(diff).digest('hex')}`,
    docsTreeHash: git(['hash-object', 'docs/index.html', 'docs/styles.css', 'docs/js/game.mjs', 'docs/js/rules.mjs']).split('\n'),
  };
}

/**
 * 시나리오별 기록. 단계마다 단조 시계(ms)와 HUD·패널·잠금 상태를 남기고 끝에 JSON으로 저장한다.
 */
export class Evidence {
  constructor(name, page, browser) {
    this.name = name;
    this.page = page;
    this.t0 = performance.now();
    this.dir = path.join(EVIDENCE_DIR, name);
    mkdirSync(this.dir, { recursive: true });
    this.data = {
      scenario: name,
      startedAt: new Date().toISOString(),
      revision: revisionInfo(),
      environment: {
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        browser: `chromium ${browser.version()}`,
        launchArgs: ['channel=chromium (new headless)', '--headless', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
        command: process.env.npm_lifecycle_script ? `npm run ${process.env.npm_lifecycle_event}` : process.argv.join(' '),
      },
      steps: [],
      console: [],
      pageErrors: [],
      requests: [],
      failedRequests: [],
      httpErrors: [],
      screenshots: [],
      result: 'incomplete',
    };
    page.on('console', (m) => this.data.console.push({ t: this.now(), type: m.type(), text: m.text() }));
    page.on('pageerror', (e) => this.data.pageErrors.push({ t: this.now(), message: String(e) }));
    page.on('request', (r) => {
      if (!r.url().startsWith('data:')) this.data.requests.push({ t: this.now(), method: r.method(), url: r.url() });
    });
    page.on('requestfailed', (r) => this.data.failedRequests.push({ t: this.now(), url: r.url(), error: r.failure()?.errorText }));
    page.on('response', (r) => {
      if (r.status() >= 400) this.data.httpErrors.push({ t: this.now(), url: r.url(), status: r.status() });
    });
  }

  now() {
    return Math.round(performance.now() - this.t0);
  }

  /** HUD·패널·잠금 상태를 DOM에서 읽어 단계 기록에 추가한다. */
  async step(label, extra = {}) {
    const hud = await readHud(this.page);
    const entry = { t: this.now(), step: label, ...hud, ...extra };
    this.data.steps.push(entry);
    return entry;
  }

  note(label, extra = {}) {
    const entry = { t: this.now(), step: label, ...extra };
    this.data.steps.push(entry);
    return entry;
  }

  async shot(label) {
    const file = `${String(this.data.screenshots.length + 1).padStart(2, '0')}-${label}.jpg`;
    await this.page.screenshot({ path: path.join(this.dir, file), type: 'jpeg', quality: 70 });
    this.data.screenshots.push({ t: this.now(), file, label });
  }

  save(result) {
    this.data.result = result;
    this.data.finishedAt = new Date().toISOString();
    writeFileSync(path.join(this.dir, 'log.json'), `${JSON.stringify(this.data, null, 2)}\n`);
  }
}

/** HUD와 오버레이를 읽는다(읽기 전용). */
export function readHud(page) {
  return page.evaluate(() => {
    const $ = (id) => document.getElementById(id);
    const panel = ['panel-start', 'panel-pause', 'panel-end'].find((id) => !$(id).hidden && !$('overlay').hidden) || null;
    return {
      score: $('hud-score').textContent,
      ammo: $('hud-ammo').textContent,
      time: $('hud-time').textContent,
      status: $('hud-status').textContent,
      reloadBarHidden: $('reload-bar').hidden,
      panel,
      panelText: panel ? $(panel).innerText.replace(/\s+/g, ' ').trim() : null,
      error: $('overlay-error').hidden ? null : $('overlay-error').textContent,
      pointerLock: document.pointerLockElement ? `#${document.pointerLockElement.id}` : null,
    };
  });
}

export const ammoOf = (hud) => Number(hud.ammo.split('/')[0].trim());

/**
 * 스크린샷을 분석한다(읽기 전용). 페이지 안의 별도 OffscreenCanvas에서 PNG를 디코딩하며 게임 캔버스·상태를 건드리지 않는다.
 * - redBlobs: 표적 원판의 빨간 고리를 연결 성분으로 묶은 화면 좌표
 * - signature: 장면 비교용 32×20 회색조 축소 이미지
 * - gunDark: 총기 영역(오른쪽 아래)의 어두운 무채색 픽셀 수
 */
export async function analyze(page) {
  const png = await page.screenshot({ type: 'png' });
  // 분석용 별도 탭을 열면 게임 탭의 화면 갱신이 멈추므로 같은 페이지에서 분석한다. 비용을 줄이려고 2픽셀 간격으로 표본을 뽑는다.
  return page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const img = await createImageBitmap(blob);
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const { data, width, height } = g.getImageData(0, 0, img.width, img.height);
    const CELL = 4;
    const gw = Math.ceil(width / CELL);
    const gh = Math.ceil(height / CELL);
    const cells = new Uint16Array(gw * gh);
    const top = 90; // 위쪽 HUD 제외
    const bottom = height - 90; // 아래쪽 HUD 제외
    let gunDark = 0;
    const sig = new Float64Array(32 * 20);
    const sigN = new Float64Array(32 * 20);
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const i = (y * width + x) * 4;
        const r = data[i];
        const gg = data[i + 1];
        const b = data[i + 2];
        const s = Math.floor((y * 20) / height) * 32 + Math.floor((x * 32) / width);
        sig[s] += (r + gg + b) / 3;
        sigN[s] += 1;
        if (y >= top && y < bottom && r > 60 && r > gg * 2 && r > b * 2) {
          cells[Math.floor(y / CELL) * gw + Math.floor(x / CELL)] += 1;
        }
        if (x > width * 0.6 && y > height * 0.65 && Math.max(r, gg, b) < 90 && Math.max(r, gg, b) - Math.min(r, gg, b) < 25) gunDark += 1;
      }
    }
    // 빨간 칸을 2칸 이내 이웃까지 연결하여 같은 표적의 고리·중심을 하나로 묶는다.
    const label = new Int32Array(gw * gh).fill(-1);
    const blobs = [];
    for (let k = 0; k < gw * gh; k += 1) {
      if (cells[k] < 1 || label[k] !== -1) continue;
      const id = blobs.length;
      const stack = [k];
      label[k] = id;
      let sx = 0;
      let sy = 0;
      let n = 0;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      while (stack.length) {
        const cur = stack.pop();
        const cx = cur % gw;
        const cy = Math.floor(cur / gw);
        sx += (cx + 0.5) * CELL * cells[cur];
        sy += (cy + 0.5) * CELL * cells[cur];
        n += cells[cur];
        minX = Math.min(minX, cx * CELL);
        maxX = Math.max(maxX, (cx + 1) * CELL);
        minY = Math.min(minY, cy * CELL);
        maxY = Math.max(maxY, (cy + 1) * CELL);
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
            const nk = ny * gw + nx;
            if (cells[nk] >= 1 && label[nk] === -1) {
              label[nk] = id;
              stack.push(nk);
            }
          }
        }
      }
      blobs.push({ x: sx / n, y: sy / n, pixels: n, w: maxX - minX, h: maxY - minY });
    }
    return {
      width,
      height,
      redBlobs: blobs.filter((bl) => bl.pixels >= 4),
      signature: Array.from(sig, (v, i) => v / sigN[i]),
      gunDark,
    };
  }, png.toString('base64'));
}

/** 장면 서명에서 위쪽(하늘)과 아래쪽(바닥) 4행의 평균 밝기 차이. 빈 캔버스나 단색 화면이면 0에 가깝다. */
export function skyGroundContrast(a) {
  const row = (r) => a.signature.slice(r * 32, r * 32 + 32).reduce((x, y) => x + y, 0) / 32;
  const top = [0, 1, 2, 3].map(row).reduce((x, y) => x + y, 0) / 4;
  const low = [16, 17, 18, 19].map(row).reduce((x, y) => x + y, 0) / 4;
  return Math.abs(top - low);
}

/** 두 장면 서명의 평균 절대 차이(0~255). */
export function sceneDiff(a, b) {
  let sum = 0;
  for (let i = 0; i < a.signature.length; i += 1) sum += Math.abs(a.signature[i] - b.signature[i]);
  return sum / a.signature.length;
}

/**
 * 실제 마우스 이동으로 시점을 돌린다. Pointer Lock 중 Chromium은 이동량을 movementX/Y로 전달한다.
 * 커서 좌표를 추적하여 상대 이동만 만든다. (ox, oy)는 라운드 시작(yaw=0, pitch=0) 시점의 커서 위치다.
 */
export class Aim {
  constructor(page, startX, startY) {
    this.page = page;
    this.x = startX;
    this.y = startY;
    this.rebase();
  }

  /** 라운드가 새로 시작되어 시점이 정면으로 초기화된 뒤 현재 커서 위치를 기준점으로 삼는다. */
  rebase(x = this.x, y = this.y) {
    this.x = x;
    this.y = y;
    this.ox = x;
    this.oy = y;
  }

  async move(dx, dy) {
    this.x += Math.round(dx);
    this.y += Math.round(dy);
    await this.page.mouse.move(this.x, this.y, { steps: 4 });
  }

  /** 기준점에서 yaw·pitch(rad)만큼 돌린 시점이 되도록 마우스를 움직인다. 게임: yaw -= movementX·감도, pitch -= movementY·감도. */
  async lookAt(yawRad, pitchRad) {
    const tx = this.ox - Math.round(yawRad / MOUSE_SENSITIVITY);
    const ty = this.oy - Math.round(pitchRad / MOUSE_SENSITIVITY);
    await this.move(tx - this.x, ty - this.y);
  }

  async click() {
    await this.page.mouse.down();
    await this.page.mouse.up();
  }
}

/** 게임이 화면을 n번 더 그릴 때까지 기다린다(읽기 전용). 카메라 회전은 렌더링 루프에서 반영된다. */
export function waitFrames(page, n = 2) {
  return page.evaluate(
    (count) =>
      new Promise((resolve) => {
        let left = count;
        const step = () => (left-- <= 0 ? resolve() : requestAnimationFrame(step));
        requestAnimationFrame(step);
      }),
    n,
  );
}

// 장면 배치(docs/js/game.mjs의 SLOTS 중 흔들림이 없는 자리). 카메라는 (0, 1.6, 0)에서 -z를 본다.
const EYE_HEIGHT = 1.6;
const TARGET_RADIUS = 0.5;
export const STATIC_SLOTS = [
  { slot: 0, x: -6, z: -12, y: 1.4 },
  { slot: 2, x: 3, z: -13, y: 1.5 },
  { slot: 4, x: -8, z: -20, y: 1.7 },
  { slot: 5, x: -3.5, z: -21, y: 1.3 },
  { slot: 7, x: 5.5, z: -20, y: 1.3 },
  { slot: 8, x: 9, z: -24, y: 1.8 },
  { slot: 10, x: 0, z: -30, y: 2.0 },
  { slot: 11, x: 6, z: -30, y: 1.6 },
];

/** 정면 시점(yaw=0, pitch=0)에서 자리 중심이 투영되는 화면 좌표와 원판 반지름(px). */
function projectFront(s, width, height) {
  const f = height / 2 / Math.tan(((VERTICAL_FOV_DEG / 2) * Math.PI) / 180);
  const depth = -s.z;
  return { px: width / 2 + (f * s.x) / depth, py: height / 2 - (f * (s.y - EYE_HEIGHT)) / depth, r: (f * TARGET_RADIUS) / depth };
}

/**
 * 정면 시점 스크린샷 한 장에서 실제로 표적 원판(빨간 고리)이 보이는 정지 자리를 찾는다.
 * 각 자리의 투영 원판 안쪽(반지름 70%)에 빨간 연결 성분의 중심이 있어야 보이는 표적으로 인정한다.
 */
export async function visibleStaticTargets(page) {
  const shot = await analyze(page);
  const found = [];
  for (const s of STATIC_SLOTS) {
    const p = projectFront(s, shot.width, shot.height);
    const blob = shot.redBlobs.find((b) => Math.hypot(b.x - p.px, b.y - p.py) <= Math.max(3, p.r * 0.7));
    if (blob) found.push({ ...s, screen: { x: Math.round(p.px), y: Math.round(p.py), r: Math.round(p.r * 10) / 10 }, blob });
  }
  // 가까운(화면에서 큰) 표적을 먼저 고른다.
  found.sort((a, b) => b.screen.r - a.screen.r);
  return { shot, found };
}

/** 정지 자리 중심을 향하는 yaw·pitch(rad). */
export function anglesTo(s) {
  return { yaw: Math.atan2(-s.x, -s.z), pitch: Math.atan2(s.y - EYE_HEIGHT, Math.hypot(s.x, s.z)) };
}

/**
 * 정면 시점에서 보이는 정지 표적을 골라 실제 마우스 이동으로 조준한다.
 * 조준 뒤 렌더링된 화면에서 화면 중앙에 빨간 원판이 있는지 다시 관측해 기록한다.
 * 호출 전 시점은 정면(라운드 시작 직후 또는 aim.lookAt(0, 0) 후)이어야 한다.
 */
export async function aimAtVisibleTarget(page, aim, ev, exclude = []) {
  await aim.lookAt(0, 0);
  await waitFrames(page, 2);
  const { shot: before, found } = await visibleStaticTargets(page);
  const candidates = found.filter((f) => !exclude.includes(f.slot));
  ev?.note('aim: 정면 시점에서 보이는 정지 표적', { visible: found.map((f) => ({ slot: f.slot, screen: f.screen })) });
  if (candidates.length === 0) throw new Error('정면 시점에 보이는 정지 표적이 없습니다');
  const target = candidates[0];
  const { yaw, pitch } = anglesTo(target);
  await aim.lookAt(yaw, pitch);
  await waitFrames(page, 2);
  const after = await analyze(page);
  const cx = after.width / 2;
  const cy = after.height / 2;
  const centered = after.redBlobs.find((b) => Math.hypot(b.x - cx, b.y - cy) <= Math.max(4, Math.min(b.w, b.h) / 2));
  ev?.note('aim: 조준 후 화면 중앙 관측', { slot: target.slot, yawRad: yaw, pitchRad: pitch, centeredBlob: centered || null });
  return { before, after, target, centered: Boolean(centered) };
}

/**
 * 버튼 클릭으로 실제 Pointer Lock을 요청한다. Chromium이 잠금 해제 직후 재잠금을 거부하면
 * 문서의 절차대로 오류 안내를 기록하고 1.5초 기다린 뒤 다시 누른다(최대 3회).
 */
export async function clickForLock(page, selector, ev) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.click(selector);
    const locked = await page
      // 잠금 요소가 정해진 뒤 pointerlockchange 처리기가 라운드를 바꾸고 오버레이를 닫는다. 둘 다 관측될 때까지 기다린다.
      .waitForFunction(() => document.pointerLockElement?.id === 'scene' && document.getElementById('overlay').hidden, null, { timeout: 3_000 })
      .then(() => true, () => false);
    if (locked) {
      await ev.step(`${selector} 클릭 → Pointer Lock 획득`, { attempt });
      return attempt;
    }
    await ev.step(`${selector} 클릭 → 잠금 거부, 대기 후 재시도`, { attempt });
    await page.waitForTimeout(1_500);
  }
  throw new Error(`${selector}로 Pointer Lock을 얻지 못했습니다`);
}

/**
 * 일시 정지 진입. 먼저 실제 Esc 키 입력을 보내고 잠금 해제 여부를 기록한다.
 * 헤드리스 Chromium에서 Esc가 잠금을 풀지 않으면 document.exitPointerLock()(브라우저 API)으로 해제하고
 * 그 사실을 따로 기록한다. 이 경로는 Esc 키 검증으로 간주하지 않는다.
 */
export async function pauseGame(page, ev) {
  await page.keyboard.press('Escape');
  const escReleased = await page
    .waitForFunction(() => document.pointerLockElement === null, null, { timeout: 1_000 })
    .then(() => true, () => false);
  let via = 'Escape 키';
  if (!escReleased) {
    via = 'document.exitPointerLock() (Esc 키는 헤드리스에서 잠금을 해제하지 않음)';
    await page.evaluate(() => document.exitPointerLock());
    await page.waitForFunction(() => document.pointerLockElement === null);
  }
  const t = performance.now();
  return { escReleased, via, t };
}
