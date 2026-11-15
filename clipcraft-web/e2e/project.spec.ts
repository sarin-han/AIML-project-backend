import { expect, test } from '@playwright/test';
import { createProject, projectName } from './support/flows';

test('new project button goes straight to upload and asks for a project title', async ({ page }) => {
  await createProject(page);

  await expect(page.getByTestId('video-upload-area')).toBeVisible();
  await expect(page.getByTestId('project-title-input')).toHaveValue(projectName);
  await expect(page.getByTestId('project-aspect-ratio')).toHaveCount(0);
  // 제목을 비우면 분석을 시작할 수 없다.
  await page.getByTestId('project-title-input').fill('');
  await expect(page.getByTestId('analyze-start-button')).toBeDisabled();
});
