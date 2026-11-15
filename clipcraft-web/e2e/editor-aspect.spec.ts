import { expect, test } from '@playwright/test';
import { addScenarios, createProject, mockAnalysisApi, projectName, runAnalysisFlow, scenarios, uploadSampleVideo } from './support/flows';

// 샘플 영상(H.264)을 재생하려면 코덱이 있는 시스템 Chrome이 필요하다.
test.use({ channel: 'chrome' });

test('editor previews the original aspect ratio only (no ratio picker)', async ({ page }) => {
  await runAnalysisFlow(page);

  const video = page.locator('video').first();
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.videoWidth)).toBeGreaterThan(0);
  const natural = await video.evaluate((element: HTMLVideoElement) => element.videoWidth / element.videoHeight);
  const box = await video.locator('xpath=..').boundingBox();

  await expect(page.getByTestId('aspect-select')).toHaveCount(0);
  expect(box ? box.width / box.height : 0).toBeCloseTo(natural, 1);
});

test('export request never carries output_aspect (original ratio)', async ({ page }) => {
  await mockAnalysisApi(page);
  // 내보내기 버튼은 분석 결과에 영상 경로가 있어야 켜진다
  await page.route('**/analyze/jobs/mock-job', async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        error: null,
        logs: [],
        message: 'mock analysis complete',
        progress: 100,
        project: projectName,
        results: scenarios.map((scenario, index) => ({
          audio: { amplitudes: Array.from({ length: 88 }, () => 0.5), barCount: 88, duration: 90 },
          end: 20 + index * 20,
          id: index + 1,
          project_name: projectName,
          scenario,
          score: 0.9,
          start: 12 + index * 20,
          title: scenario,
        })),
        status: 'success',
        step_id: 5,
        step_label: '하이라이트 구간 확정',
        video_path: '/tmp/mock-source.mp4',
      }),
      contentType: 'application/json',
      status: 200,
    });
  });
  await createProject(page);
  await uploadSampleVideo(page);
  await addScenarios(page);
  await page.getByTestId('analyze-start-button').click();
  await expect(page).toHaveURL(/\/editor\/mock-job$/);
  await expect(page.getByTestId('result-card')).toHaveCount(3);
  await page.waitForTimeout(800);

  const bodies: Array<Record<string, unknown>> = [];
  await page.route('**/export/jobs', async (route) => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({ body: JSON.stringify({ status: 'queued', job_id: 'j1' }), contentType: 'application/json', status: 200 });
  });
  await page.route('**/export/jobs/j1', async (route) => {
    await route.fulfill({ body: JSON.stringify({ status: 'success', progress: 100 }), contentType: 'application/json', status: 200 });
  });
  await page.route('**/export/jobs/j1/download', async (route) => {
    await route.fulfill({ body: Buffer.from('mp4'), contentType: 'video/mp4', status: 200 });
  });

  const exportButton = page.getByRole('button', { name: 'MP4로 내보내기' });

  await exportButton.click();
  await expect.poll(() => bodies.length).toBe(1);
  expect('output_aspect' in bodies[0]).toBe(false);
});
