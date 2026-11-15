import { expect, test, type Page, type Route } from '@playwright/test';
import { addScenarios, createProject, mockAnalysisApi, projectName, scenarios, uploadSampleVideo } from './support/flows';

const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

/** 분석을 끝내고 편집 화면에 들어간다. 편집 화면의 "시나리오 추가"는 서버에 있는 분석 영상(video_path)이 필요하다. */
async function openEditor(page: Page) {
  await mockAnalysisApi(page);
  await page.route('**/analyze/jobs/mock-job', (route) =>
    json(route, {
      status: 'success',
      progress: 100,
      step_id: 5,
      step_label: '하이라이트 구간 확정',
      message: 'mock analysis complete',
      logs: [],
      project: projectName,
      video_path: '/tmp/tmpmock.mp4',
      error: null,
      results: scenarios.map((scenario, index) => ({
        project_name: projectName,
        id: index + 1,
        scenario,
        title: scenario,
        start: 12 + index * 20,
        end: 20 + index * 20,
        audio: { duration: 90, barCount: 88, amplitudes: Array.from({ length: 88 }, () => 0.5) },
      })),
    }),
  );
  await createProject(page);
  await uploadSampleVideo(page);
  await addScenarios(page);
  await page.getByTestId('analyze-start-button').click();
  await expect(page.getByTestId('result-card')).toHaveCount(3);
  // 화면을 연 직후 0.8초 안의 변경은 편집 기록에 넣지 않는다(저장값 동기화와 구분하려는 것). 실제 사용에서는 그 뒤에 추가한다.
  await page.waitForTimeout(1000);
}

test.describe('편집 화면 시나리오 추가', () => {
  test('찾은 구간을 목록 끝에 추가하고, 되돌리기로 뺄 수 있다', async ({ page }) => {
    await openEditor(page);
    let requested: { video_path: string; scenarios: string[] } | null = null;
    await page.route('**/analyze/scenarios', (route) => {
      requested = route.request().postDataJSON();
      return json(route, { results: [{ scenario: '새로 찾은 장면', start: 61.2, end: 70 }] });
    });

    await page.getByTestId('editor-scenario-input').fill('새로 찾은 장면');
    await page.getByTestId('editor-scenario-add-button').click();

    await expect(page.getByTestId('result-card')).toHaveCount(4);
    await expect(page.getByTestId('result-card').last()).toContainText('새로 찾은 장면');
    await expect(page.getByTestId('result-card').last()).toHaveAttribute('data-active', 'true');
    await expect(page.getByTestId('result-start-time').last()).toHaveText('1:01');
    await expect(page.getByTestId('editor-scenario-input')).toHaveValue('');
    expect(requested).toEqual({ video_path: '/tmp/tmpmock.mp4', scenarios: ['새로 찾은 장면'] });

    await page.getByTestId('undo-button').click();
    await expect(page.getByTestId('result-card')).toHaveCount(3);
    await page.getByTestId('redo-button').click();
    await expect(page.getByTestId('result-card')).toHaveCount(4);
  });

  test('영상에서 찾지 못하면 안내를 보여 주고 목록은 그대로다', async ({ page }) => {
    await openEditor(page);
    await page.route('**/analyze/scenarios', (route) => json(route, { results: [null] }));

    await page.getByTestId('editor-scenario-input').fill('없는 장면');
    await page.getByTestId('editor-scenario-add-button').click();

    await expect(page.getByTestId('editor-scenario-error')).toContainText('없는 장면');
    await expect(page.getByTestId('result-card')).toHaveCount(3);
    await expect(page.getByTestId('editor-scenario-input')).toHaveValue('없는 장면'); // 고쳐서 다시 시도할 수 있게 남긴다
  });

  test('이미 있는 구간이면 중복으로 넣지 않는다', async ({ page }) => {
    await openEditor(page);
    await page.route('**/analyze/scenarios', (route) => json(route, { results: [{ scenario: '같은 구간', start: 12, end: 20 }] }));

    await page.getByTestId('editor-scenario-input').fill('같은 구간');
    await page.getByTestId('editor-scenario-add-button').click();

    await expect(page.getByTestId('editor-scenario-error')).toContainText('이미 목록에 있는 구간');
    await expect(page.getByTestId('result-card')).toHaveCount(3);
  });

  test('서버 오류 문구를 그대로 보여 준다', async ({ page }) => {
    await openEditor(page);
    await page.route('**/analyze/scenarios', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: '분석 서버(ReVision)가 아직 준비되지 않았습니다. 잠시 후 다시 시도해 주세요.' }) }));

    await page.getByTestId('editor-scenario-input').fill('아무 장면');
    await page.getByTestId('editor-scenario-add-button').click();

    await expect(page.getByTestId('editor-scenario-error')).toContainText('ReVision');
    await expect(page.getByTestId('result-card')).toHaveCount(3);
  });
});
