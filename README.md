# gun-shooter

브라우저에서 바로 실행되는 1인칭 3D 표적 사격 게임입니다. Three.js와 순수 JavaScript(ES modules)로 만들었고 빌드 과정이 없습니다. 무기·표적·사격장·파티클 효과는 코드에서 만든 Three.js geometry/material로, 효과음은 Web Audio로 합성합니다. 외부 이미지·모델·음원 파일을 쓰지 않습니다.

## 실행

```sh
# 저장소 루트에서
python3 -m http.server 8000
```

브라우저에서 <http://localhost:8000/docs/> 를 엽니다(`/docs/index.html`과 같습니다). `file://`로 직접 열면 ES module이 로드되지 않으므로 반드시 HTTP 서버를 사용하세요.

- 지원 환경: 마우스가 있는 데스크톱 Chrome·Edge·Firefox 최신 버전. WebGL, Pointer Lock, Web Audio가 필요합니다. 모바일·터치는 지원하지 않습니다.
- 인터넷 연결: Three.js `0.170.0`을 CDN(`https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js`)에서 불러옵니다. 이 주소에 연결할 수 없으면 장면이 표시되지 않습니다.
- GitHub Pages에서는 `docs/` 폴더를 게시 원본으로 지정하면 그대로 제공됩니다(이 저장소 설정은 별도로 바꿔야 합니다).

## 조작법

| 입력 | 동작 |
| --- | --- |
| 마우스 이동 | 조준(시점 회전) |
| 왼쪽 클릭 | 한 발 발사 |
| `R` | 재장전 |
| `Esc` | 마우스 잠금 해제 → 일시 정지. 일시 정지 화면에서 **계속하기** 또는 **다시 시작** |

## 라운드 규칙

1. **시작** 버튼을 누르면 마우스 잠금(Pointer Lock)과 오디오가 켜지고 60초 라운드가 시작됩니다. 잠금에 실패하면 오류 안내가 표시되고 시작 화면이 유지됩니다. 버튼을 다시 누르세요.
2. 탄창은 12발입니다. 클릭 한 번에 한 발을 쏘고, 연속 클릭은 짧은 발사 간격(110 ms)으로 제한됩니다.
3. 탄창이 비거나 재장전 중(1.4초)에는 발사되지 않습니다. `R`로 재장전합니다.
4. 표적 원판을 맞히면 100점을 얻고, 표적은 쓰러진 뒤 잠시 후 다른 자리에 다시 나타납니다. 엄폐물·벽에 가려진 표적, 이미 쓰러진 표적은 점수를 주지 않습니다.
5. `Esc`로 잠금이 풀리면 타이머·재장전과 표적의 움직임이 함께 멈춥니다. **계속하기**로 재개합니다. Chrome은 잠금 해제 직후 약 1초 동안 재잠금을 거부할 수 있으니 이때는 잠시 후 다시 누르세요.
6. 게임 도중 처음부터 다시 하려면 `Esc`를 누른 뒤 일시 정지 화면의 **다시 시작**을 누릅니다. 플레이 중 HUD 위쪽과 시작 화면에 이 경로(`Esc` 일시 정지 / 다시 시작)가 표시됩니다. 마우스 잠금을 다시 얻은 순간에 점수·발사·명중 수가 0, 탄약이 12발, 남은 시간이 60초인 새 라운드가 시작됩니다. 진행 중이던 재장전과 표적 재등장 대기, 시점 방향, 반동·총구 섬광·명중 표시·탄착 표시·파티클, HUD 안내 문구도 지워집니다.
   - 잠금이 거부되면 일시 정지 화면과 현재 라운드(점수·탄약·남은 시간)가 그대로 유지되고 오류 안내가 표시됩니다. 잠시 후 **다시 시작**을 다시 누르거나 **계속하기**로 기존 라운드를 이어갈 수 있습니다.
   - 버튼을 누르는 동작은 사격으로 처리되지 않습니다. 잠금 요청 결과를 기다리는 동안 누른 버튼은 무시됩니다.
7. 60초가 지나면 사격이 멈추고 최종 점수와 명중률, **다시 시작** 버튼이 표시됩니다. 종료 순간의 입력이 클릭·`R`·`Esc` 중 무엇이어도 같은 종료 화면이 나옵니다. 다시 시작하면 점수·탄약·시간·표적이 모두 초기화됩니다.

## 구조

- `docs/index.html`, `docs/styles.css`: 화면과 HUD
- `docs/js/game.mjs`: Three.js 장면, 입력, HUD, 파티클, Web Audio. 렌더링 루프는 하나만 실행하고 표적·파티클 자원은 처음에 만든 뒤 재사용합니다. 시간은 프레임·발사·재장전·일시 정지 입력에서 모두 진행되므로, 화면은 매 프레임과 입력 직후 규칙 상태를 기준으로 다시 나타난 표적과 라운드 종료를 반영합니다.
- `docs/js/rules.mjs`: 발사·명중 대상 선택·재장전·점수·라운드 시간 규칙, 화면에 배치할 표적 선택(`targetsToPlace`), 일시 정지 중 멈추는 애니메이션 시계(`gameClockMs`). 시간은 인자로 전달되어 테스트에서 제어할 수 있습니다.

## 테스트

Node.js 22 이상에서 저장소 루트에서 실행합니다. 의존성 설치가 필요 없습니다(`npm ci`를 하지 않아도 됩니다).

```sh
node --test
```

`tests/game-rules.test.mjs`는 게임이 실제로 사용하는 `docs/js/rules.mjs`를 DOM·WebGL·네트워크 없이 검사합니다.

## 브라우저 검증

브라우저 동작은 두 방법으로 확인합니다. 자동 검증이 렌더링·입력·시간 흐름을 확인하고, 사람은 효과음 청취와 실제 마우스 조작감만 확인합니다.

### 자동 브라우저 검증(Playwright)

Playwright는 개발용 검증 도구입니다. 게임 실행·배포(`docs/`)에는 npm이나 빌드가 필요하지 않습니다. `node --test`는 Playwright를 설치하지 않아도 그대로 동작하고 브라우저 테스트(`tests/browser/*.spec.mjs`)를 찾지 않습니다.

사전 조건: Node.js 22 이상, Python 3, 인터넷 연결(브라우저 설치와 CDN Three.js 로드).

```sh
# 저장소 루트에서
npm ci                            # @playwright/test 1.65.0 (package-lock.json 고정)
npx playwright install chromium   # 사용자 캐시(~/.cache/ms-playwright)에 Chromium 설치
npm run test:browser              # 정적 서버를 띄우고 3개 시나리오를 실행
```

- 설정은 [`playwright.config.mjs`](playwright.config.mjs)에 있습니다. `python3 -m http.server 8123`으로 저장소 루트를 제공하고 `/docs/index.html`을 엽니다. 포트가 사용 중이면 `GUN_SHOOTER_PORT=8130 npm run test:browser`처럼 바꿉니다.
- 브라우저는 전체 Chromium의 헤드리스 모드(`channel: 'chromium'`)이며 WebGL은 `--use-angle=swiftshader --enable-unsafe-swiftshader`(CPU 렌더링)로 실행합니다. worker 1개, viewport 960×600, 자동 재시도 없음입니다.
- 실행 시간은 약 2분입니다. 03 시나리오가 실제 60초 라운드를 기다립니다.
- 시나리오(`tests/browser/game.spec.mjs`):
  - `01-play-hit-miss-reload`: 초기 WebGL 장면·총기·시작 안내, 실제 Pointer Lock, 마우스 조준에 따른 화면 변화, 보이는 표적 명중(+100점, 1발), 빗나감(점수 불변), 12발 소진·빈 탄창 클릭 차단, `R` 재장전 표시·재장전 중 클릭 차단·1.4초 뒤 12발 복구와 다음 발사.
  - `02-pause-resume-restart`: 일시 정지와 시간 정지, 계속하기, 명중 후·재장전 중 일시 정지 화면의 다시 시작, 두 번 다시 시작한 뒤 첫 클릭이 한 발만 소모.
  - `03-full-round`: 타이머를 건드리지 않은 실제 60초 종료, 최종 점수, 종료 후 클릭·`R`·마우스 이동 차단, 종료 화면의 다시 시작.
- 모든 시나리오는 `console` 오류·경고, `pageerror`, 실패한 요청, HTTP 400 이상 응답, `https://cdn.jsdelivr.net/npm/three@0.170.0/` 밖의 외부 요청이 하나라도 있으면 실패합니다.

산출물: 시나리오마다 `test-results/evidence/<시나리오>/`에 `log.json`(기준 SHA·작업 트리 변경·`docs/` diff 해시, 환경·브라우저 버전·실행 인자, 단계별 단조 시각과 HUD·패널 텍스트, 콘솔·요청 기록)과 JPEG 스크린샷이 생깁니다. 실패하면 `test-results/artifacts/`에 실패 화면과 오류 위치가 남습니다. 두 폴더는 `.gitignore`로 제외됩니다. 검토용 대표 실행은 `EVIDENCE_DIR=tests/browser/evidence npm run test:browser`로 저장소에 남깁니다.

자동 검증이 인정하는 근거와 한계, 실패 진단은 [`tests/browser-verification.md`](tests/browser-verification.md)의 0장에 있습니다.

### 사람의 확인

자동 검증으로 대신할 수 없는 항목은 효과음 청취와 실제 마우스 조작감입니다. [`tests/browser-verification.md`](tests/browser-verification.md)의 4장 양식으로 확인합니다. 자동 검증이 실패하거나 다른 브라우저에서 재현해야 할 때는 같은 문서 3장의 수동 절차를 사용합니다.

- 검증 전에 대상 SHA(`git rev-parse HEAD`), 작업 트리 변경(`git status --short`), OS, 브라우저 전체 버전, 실행 일시, 서버 명령과 URL을 기록합니다.
- 서버는 저장소 루트에서 `python3 -m http.server 8000`으로 실행하고 <http://localhost:8000/docs/index.html>에 접속합니다.
- 기록 사본은 저장소 작업 트리 밖에 만들어 증거와 함께 제출합니다. 기록란이 비어 있거나 증거가 없는 항목은 미실행입니다.
