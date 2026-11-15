import { expect, test } from '@playwright/test';
import { openEditorWithVideoPath } from './support/flows';

const json = (body: unknown, status = 200) => ({ body: JSON.stringify(body), contentType: 'application/json', status });

test('export runs as a job: shows progress, then downloads the finished video', async ({ page }) => {
  await openEditorWithVideoPath(page);

  const started: unknown[] = [];
  let polls = 0;
  await page.route('**/export/jobs', async (route) => {
    started.push(route.request().postDataJSON());
    await route.fulfill(json({ status: 'queued', job_id: 'job1' }));
  });
  await page.route('**/export/jobs/job1', async (route) => {
    polls += 1;
    await route.fulfill(json(polls < 3 ? { status: 'running', progress: 40 * polls, message: '구간을 자르는 중' } : { status: 'success', progress: 100 }));
  });
  await page.route('**/export/jobs/job1/download', async (route) => {
    await route.fulfill({ body: Buffer.from('mp4-data'), contentType: 'video/mp4', status: 200 });
  });

  const download = page.waitForEvent('download');
  const exportButton = page.getByRole('button', { name: 'MP4로 내보내기' });
  await exportButton.click();

  await expect(page.getByRole('button', { name: /내보내는 중… \d+%/ })).toBeVisible();
  expect((await download).suggestedFilename()).toBe('clipcraft_export.mp4');
  await expect(page.getByText('내보내기가 완료됐어요')).toBeVisible();
  expect(started).toHaveLength(1);
  expect(polls).toBeGreaterThanOrEqual(3);
});

test('export shows the server error when the job fails', async ({ page }) => {
  await openEditorWithVideoPath(page);

  await page.route('**/export/jobs', (route) => route.fulfill(json({ status: 'queued', job_id: 'job2' })));
  await page.route('**/export/jobs/job2', (route) => route.fulfill(json({ status: 'error', progress: 20, error: '자막 폰트 폴더를 찾을 수 없습니다.' })));

  await page.getByRole('button', { name: 'MP4로 내보내기' }).click();

  await expect(page.getByText('내보내기에 실패했어요: 자막 폰트 폴더를 찾을 수 없습니다.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'MP4로 내보내기' })).toBeEnabled();
});

test('export reports a restarted server (job not found)', async ({ page }) => {
  await openEditorWithVideoPath(page);

  await page.route('**/export/jobs', (route) => route.fulfill(json({ status: 'queued', job_id: 'job3' })));
  await page.route('**/export/jobs/job3', (route) => route.fulfill(json({ detail: 'Export job not found' }, 404)));

  await page.getByRole('button', { name: 'MP4로 내보내기' }).click();

  await expect(page.getByText(/서버가 다시 시작돼서 내보내기가 중단됐어요/)).toBeVisible();
});
