// 개발용 브라우저 검증 설정. 게임(docs/)의 실행·배포에는 사용하지 않는다.
// 실행: npm ci && npx playwright install chromium && npm run test:browser
import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.GUN_SHOOTER_PORT || 8123);

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '*.spec.mjs',
  // 실제 60초 라운드와 CPU(SwiftShader) 렌더링을 고려한 시나리오별 상한.
  timeout: 180_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  // 실패를 감추지 않도록 자동 재시도는 하지 않는다.
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results/artifacts',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: 'chromium',
    // 전체 Chromium(new headless)을 사용한다. chrome-headless-shell은 Pointer Lock 중 mousemove의
    // movementX/Y를 절대 좌표와 (0,0) 복귀 이벤트 쌍으로 보내 이동량이 상쇄된다(tests/browser-verification.md 참조).
    channel: 'chromium',
    headless: true,
    viewport: { width: 960, height: 600 },
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
    trace: 'off', // SwiftShader에서 trace 기록이 프레임과 스크린샷을 크게 늦춘다. 실패 시 스크린샷과 단계 기록을 남긴다.
    screenshot: 'only-on-failure',
  },
  webServer: {
    // 저장소 루트를 제공하여 /docs/index.html을 연다.
    command: `python3 -m http.server ${PORT} --bind 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/docs/index.html`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
