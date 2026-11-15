import { expect, test, type Page, type Route } from '@playwright/test';
import { createProject, mockAnalysisApi, uploadSampleVideo } from './support/flows';

const RECOMMENDED = ['재료 손질', '물을 붓고 끓이기', '김치를 넣고 볶기', '양념 넣기', '간 맞추기', '끓어오르는 찌개', '완성된 찌개 플레이팅', '한 숟갈 맛보기'];
/** 추천 응답: 장면마다 영상에서의 구간(초)이 같이 온다. */
const recommendedScenes = (names: string[]) => names.map((text, index) => ({ text, start: index * 30, end: index * 30 + 12 }));
const HIGHLIGHTS = [
  { id: 1, start: 8, end: 20, label: '양념 재료 그릇에 넣기' },
  { id: 2, start: 22, end: 34, label: '손으로 양념 비비기' },
  { id: 3, start: 126, end: 138, label: '젓가락으로 양념 버무리기' },
];
const DURATION = 298;

function json(route: Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

async function mockRecommendApi(page: Page) {
  const counter = { calls: 0 };
  await page.route('**/recommend', async (route) => {
    counter.calls += 1;
    // 두 번째 요청에는 다른 목록을 준다. 직접 쓴 항목이 유지되는지 보려는 것이다.
    const names = counter.calls === 1 ? RECOMMENDED : RECOMMENDED.map((scene) => `${scene} (다시)`);
    await json(route, { scenes: recommendedScenes(names) });
  });
  return counter;
}

async function mockHighlightApi(page: Page, options: { running?: boolean } = {}) {
  const counter = { starts: 0 };
  await page.route('**/highlights/jobs', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    counter.starts += 1;
    return json(route, { status: 'queued', job_id: `mock-hl-${counter.starts}` });
  });
  await page.route('**/highlights/jobs/mock-hl-*', async (route) => {
    if (options.running) {
      return json(route, { status: 'running', progress: 42, step_id: 3, step_label: '오디오 파형 분석', message: '음량 변화 추출 중', logs: ['✓  영상 파일 수신'], project: 'p', found: [HIGHLIGHTS[0]] });
    }
    return json(route, {
      status: 'success',
      progress: 100,
      step_id: 5,
      step_label: '후보 구간 확정',
      message: '완료',
      logs: ['✓  후보 구간 확정'],
      project: 'p',
      video_path: '/tmp/mock.mp4',
      result: {
        duration: DURATION,
        highlights: HIGHLIGHTS,
        audio: { barCount: 88, amplitudes: Array.from({ length: 88 }, (_, i) => Number((0.1 + Math.abs(Math.sin(i * 0.4)) * 0.8).toFixed(3))) },
      },
    });
  });
  return counter;
}

test.describe('찾는 방법 패널', () => {
  test.beforeEach(async ({ page }) => {
    await mockAnalysisApi(page);
    await createProject(page);
  });

  test('추천받기는 8개를 채우기만 하고 검색은 시작하지 않으며, 직접 쓴 항목은 다시 추천해도 남는다', async ({ page }) => {
    const recommend = await mockRecommendApi(page);
    let analyzeStarted = false;
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/analyze/jobs')) analyzeStarted = true;
    });

    await page.getByTestId('method-tab-recommend').click();
    await expect(page.getByTestId('recommend-button')).toBeDisabled(); // 영상 없이는 추천받을 수 없다

    await uploadSampleVideo(page);
    await page.getByTestId('recommend-button').click();

    await expect(page.getByTestId('scenario-item-input')).toHaveCount(8);
    await expect(page.getByText('AI가 8개를 추천했어요 · 시작하면 이 구간 그대로 써요')).toBeVisible();
    expect(analyzeStarted).toBe(false);
    await expect(page.getByTestId('analyze-start-button')).toHaveText('시나리오로 장면 찾기 · 8개');

    // 하나를 직접 고치면 추천 표시가 사라지고, 다시 추천해도 그대로 남는다
    const first = page.getByTestId('scenario-item-input').first();
    await first.fill('내가 고친 장면');
    await first.blur();
    await page.getByTestId('method-tab-manual').click();
    await page.getByTestId('scenario-input').fill('내가 쓴 장면');
    await page.getByTestId('add-scenario-button').click();
    await page.getByTestId('method-tab-recommend').click();
    await page.getByTestId('recommend-button').click();

    expect(recommend.calls).toBe(2);
    await expect(page.getByTestId('scenario-item-input')).toHaveCount(10); // 직접 쓴 2개 + 새 추천 8개
    await expect(page.getByTestId('scenario-item-input').first()).toHaveValue('내가 고친 장면');
    await expect(page.locator('[data-testid=scenario-item-input][value*="(다시)"]')).toHaveCount(8);
  });

  test('추천받은 장면은 다시 검색하지 않고, 추천 때 받은 구간을 분석 요청에 실어 보낸다', async ({ page }) => {
    await mockRecommendApi(page);
    let analyzeBody = '';
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/analyze/jobs')) analyzeBody = request.postData() ?? '';
    });

    await uploadSampleVideo(page);
    await page.getByTestId('method-tab-recommend').click();
    await page.getByTestId('recommend-button').click();
    await expect(page.getByTestId('scenario-item-range')).toHaveCount(8);
    await expect(page.getByTestId('scenario-item-range').first()).toHaveText('00:00–00:12');

    // 첫 장면을 고치면 다른 장면이 된 것이므로 구간을 버리고 새로 찾는다
    const first = page.getByTestId('scenario-item-input').first();
    await first.fill('내가 고친 장면');
    await first.blur();
    await expect(page.getByTestId('scenario-item-range')).toHaveCount(7);

    await page.getByTestId('analyze-start-button').click();
    await expect(page.getByTestId('result-card')).toHaveCount(3);

    const known = JSON.parse(/name="known_segments"\r?\n\r?\n([^\r\n]+)/.exec(analyzeBody)?.[1] ?? 'null');
    expect(known).toHaveLength(8);
    expect(known[0]).toBeNull();
    expect(known[1]).toEqual({ start: 30, end: 42 });
    expect(known[7]).toEqual({ start: 210, end: 222 });
  });

  test('하이라이트는 시나리오 없이 시작하고, 결과에서 고른 구간만 시간 순서로 편집 화면에 넘어간다', async ({ page }) => {
    const highlights = await mockHighlightApi(page);
    await uploadSampleVideo(page);
    await page.getByTestId('method-tab-highlight').click();

    const cta = page.getByTestId('analyze-start-button');
    await expect(cta).toHaveText('하이라이트 추출하기');
    await expect(cta).toBeEnabled();
    await cta.click();

    await expect(page).toHaveURL(/\/highlights$/);
    expect(highlights.starts).toBe(1);
    await expect(page.getByTestId('highlight-title')).toHaveText('하이라이트 3곳을 찾았어요');
    await expect(page.getByTestId('highlight-row')).toHaveCount(3);
    await expect(page.getByTestId('highlight-summary')).toHaveText('3개 선택 · 총 00:36');

    // 하나를 제외하면 합계가 줄고 타임라인에서 해치로 바뀐다
    await page.getByRole('checkbox', { name: '손으로 양념 비비기 제외' }).click();
    await expect(page.getByTestId('highlight-summary')).toHaveText('2개 선택 · 총 00:24');
    await expect(page.getByTestId('timeline-range-2')).toHaveAttribute('data-selected', 'false');

    // 전부 빼면 주 버튼이 막히고 안내가 보인다
    for (const row of await page.getByTestId('highlight-check').all()) {
      if ((await row.getAttribute('aria-checked')) === 'true') await row.click();
    }
    await expect(page.getByTestId('highlight-start-editing')).toBeDisabled();
    await expect(page.getByText('편집할 구간을 하나 이상 선택해 주세요.')).toBeVisible();

    // 3번 → 1번 순서로 켜도 편집 화면에는 시간 순서대로 들어간다
    await page.getByRole('checkbox', { name: '젓가락으로 양념 버무리기 포함' }).click();
    await page.getByRole('checkbox', { name: '양념 재료 그릇에 넣기 포함' }).click();
    await page.getByTestId('highlight-start-editing').click();

    await expect(page).toHaveURL(/\/editor\/mock-hl-1$/);
    const cards = page.getByTestId('result-card');
    await expect(cards).toHaveCount(2);
    await expect(page.getByTestId('result-start-time').first()).toHaveText('0:08');
    await expect(page.getByTestId('result-start-time').last()).toHaveText('2:06');
  });

  test('다시 추출은 같은 영상으로 새 작업을 시작한다', async ({ page }) => {
    const highlights = await mockHighlightApi(page);
    await uploadSampleVideo(page);
    await page.getByTestId('method-tab-highlight').click();
    await page.getByTestId('analyze-start-button').click();
    await expect(page.getByTestId('highlight-title')).toBeVisible();

    await page.getByTestId('highlight-retry').click();
    await expect.poll(() => highlights.starts).toBe(2);
    await expect(page.getByTestId('highlight-title')).toBeVisible();
  });

  test('분석을 취소하고 돌아오면 영상·방법·입력한 장면이 그대로 남는다', async ({ page }) => {
    await mockHighlightApi(page, { running: true });
    await uploadSampleVideo(page);
    await page.getByTestId('scenario-input').fill('남아 있어야 하는 장면');
    await page.getByTestId('add-scenario-button').click();
    await page.getByTestId('method-tab-highlight').click();
    await page.getByTestId('analyze-start-button').click();

    await expect(page.getByTestId('scan-strip')).toBeVisible();
    await expect(page.getByText('찾은 하이라이트')).toBeVisible();
    await page.getByTestId('analysis-cancel').click();

    await expect(page).toHaveURL(/\/upload$/);
    await expect(page.getByText('sample.mp4')).toBeVisible();
    await expect(page.getByTestId('method-tab-highlight')).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId('method-tab-manual').click();
    await expect(page.getByTestId('scenario-item-input')).toHaveValue('남아 있어야 하는 장면');
    await expect(page.getByTestId('project-title-input')).toHaveValue('김치찌개 브이로그 쇼츠');
  });
});
