import { expect, test } from '@playwright/test';
import { runAnalysisFlow } from './support/flows';

test('editor undo and redo restore previous edits via buttons and shortcuts', async ({ page }) => {
  await runAnalysisFlow(page);
  const times = async () => ((await page.getByTestId('result-card').first().innerText()).match(/\d+:\d\d/g) ?? []).join('~');
  await page.waitForTimeout(1200);
    const undo = page.getByTestId('undo-button');
  const redo = page.getByTestId('redo-button');
  const original = await times();
  await expect(undo).toBeDisabled();

  // 구간 시작 지점을 끌어서 편집
  await page.getByTestId('segment-start-input').first().hover();
  await page.mouse.down();
  await page.mouse.move(300, 200, { steps: 8 });
  await page.mouse.up();
  const edited = await times();
  expect(edited).not.toBe(original);
  await expect(undo).toBeEnabled();

  await undo.click();
  const afterUndo = await times();
  expect(afterUndo).toBe(original);
  await expect(redo).toBeEnabled();

  await redo.click();
  expect(await times()).toBe(edited);

  // 단축키: Ctrl+Z (맥의 ⌘+Z와 같은 처리), Ctrl+Shift+Z
  await page.keyboard.press('Control+z');
  expect(await times()).toBe(original);
  await page.keyboard.press('Control+Shift+z');
  expect(await times()).toBe(edited);
  await page.keyboard.press('Meta+z');
  expect(await times()).toBe(original);

  // 두 번 연속 편집은 각각 되돌려진다(700ms 이상 간격)
  await page.getByTestId('segment-end-input').first().hover();
  await page.mouse.down();
  await page.mouse.move(520, 200, { steps: 6 });
  await page.mouse.up();
  const afterEnd = await times();
  await page.waitForTimeout(900);
  await page.getByTestId('segment-start-input').first().hover();
  await page.mouse.down();
  await page.mouse.move(280, 200, { steps: 6 });
  await page.mouse.up();
  const afterBoth = await times();
  await page.keyboard.press('Control+z');
  expect(await times()).toBe(afterEnd);
  await page.keyboard.press('Control+z');
  expect(await times()).toBe(original);
});
