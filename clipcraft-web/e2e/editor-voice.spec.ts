import { expect, test } from '@playwright/test';
import { runAnalysisFlow } from './support/flows';

// 가짜 마이크로 녹음한다(실제 소리는 필요 없다).
test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  permissions: ['microphone'],
});

test('voice button records, transcribes and sends the text like a chat message', async ({ page }) => {
  // 가짜 마이크는 소리가 일정하지 않아 자동 종료가 흔들리므로, 이 시험은 직접 눌러서 끝낸다
  await page.addInitScript(() => {
    (window as unknown as { __CLIPCRAFT_NO_VOICE_AUTOSTOP__: boolean }).__CLIPCRAFT_NO_VOICE_AUTOSTOP__ = true;
  });
  await runAnalysisFlow(page);

  let uploaded = 0;
  await page.route('**/chat/transcribe', async (route) => {
    uploaded = route.request().postDataBuffer()?.length ?? 0;
    await route.fulfill({ body: JSON.stringify({ text: '클립 2 2배속으로 해줘' }), contentType: 'application/json', status: 200 });
  });
  const sent: string[] = [];
  await page.route('**/chat/edit', async (route) => {
    const body = route.request().postDataJSON() as { clips: Array<{ id: number }>; message: string };
    sent.push(body.message);
    await route.fulfill({
      body: JSON.stringify({ reply: '편집 1건을 적용했어요.', commands: [{ type: 'SET_SPEED', clip_id: body.clips[1].id, speed: 2 }], needs_confirm: false, question: null }),
      contentType: 'application/json',
      status: 200,
    });
  });

  await page.getByTestId('assistant-toggle').click();
  const mic = page.getByTestId('chat-voice-button');
  await mic.click();
  await expect(mic).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('chat-voice-status')).toHaveAttribute('data-voice', 'recording');

  await page.waitForTimeout(1200);
  await mic.click();

  // 인식된 문장이 사용자 말풍선으로 들어가고, 채팅과 같은 경로로 편집이 적용된다
  await expect(page.getByText('클립 2 2배속으로 해줘')).toBeVisible();
  await expect(page.getByText('편집 1건을 적용했어요.')).toBeVisible();
  await expect(page.getByTestId('playback-rate-indicator')).toHaveCount(1);
  expect(sent).toEqual(['클립 2 2배속으로 해줘']);
  expect(uploaded).toBeGreaterThan(1000);
  await expect(mic).toHaveAttribute('aria-pressed', 'false');
});

test('voice button reports a denied microphone', async ({ browser }) => {
  const context = await browser.newContext(); // 마이크 권한을 주지 않는다
  const page = await context.newPage();
  await runAnalysisFlow(page);
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
  });

  await page.getByTestId('assistant-toggle').click();
  await page.getByTestId('chat-voice-button').click();
  await expect(page.getByTestId('chat-voice-status')).toContainText('마이크 권한');
  await context.close();
});

test('voice cancel button discards the recording without sending anything', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __CLIPCRAFT_NO_VOICE_AUTOSTOP__: boolean }).__CLIPCRAFT_NO_VOICE_AUTOSTOP__ = true;
  });
  await runAnalysisFlow(page);
  let requests = 0;
  await page.route('**/chat/transcribe', async (route) => {
    requests += 1;
    await route.fulfill({ body: JSON.stringify({ text: 'x' }), contentType: 'application/json', status: 200 });
  });

  await page.getByTestId('assistant-toggle').click();
  await page.getByTestId('chat-voice-button').click();
  await expect(page.getByTestId('chat-voice-status')).toHaveAttribute('data-voice', 'recording');
  await page.getByTestId('chat-voice-cancel').click();
  await expect(page.getByTestId('chat-voice-status')).toHaveCount(0);
  expect(requests).toBe(0);
});
