import { expect, test } from '@playwright/test';
import { runAnalysisFlow } from './support/flows';

type ChatBody = { clips: Array<{ id: number; start: number; end: number }>; confirm?: boolean; message: string; thread_id: string };

async function send(page: import('@playwright/test').Page, message: string) {
  if (!(await page.getByTestId('chat-input').isVisible())) await page.getByTestId('assistant-toggle').click();
  await page.getByTestId('chat-input').fill(message);
  await page.getByTestId('chat-send-button').click();
}

const cardTitles = (page: import('@playwright/test').Page) => page.getByTestId('result-card').evaluateAll((cards) => cards.map((card) => card.textContent ?? ''));

test('chat edit applies agent commands as one undo step and asks before deleting', async ({ page }) => {
  await runAnalysisFlow(page);
  // 화면을 연 직후 0.8초 동안의 변화는 되돌리기 기록에 넣지 않는다
  await page.waitForTimeout(1000);

  const bodies: ChatBody[] = [];
  let reply: Record<string, unknown> = {};
  await page.route('**/chat/edit', async (route) => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({ body: JSON.stringify(reply), contentType: 'application/json', status: 200 });
  });

  // 첫 요청에서 현재 클립 id를 받아 와서 명령을 만든다
  reply = { reply: '아무것도 안 해요.', commands: [], needs_confirm: false, question: null };
  await send(page, '안녕');
  await expect.poll(() => bodies.length).toBe(1);
  const [first, second, third] = bodies[0].clips;
  const before = await cardTitles(page);
  expect(bodies[0].thread_id).toBeTruthy();

  // 순서 교환 + 배속: 한 요청 = 되돌리기 한 번
  reply = {
    reply: '편집 2건을 적용했어요.',
    commands: [
      { type: 'SWAP', clip_id: first.id, with_clip_id: third.id },
      { type: 'SET_SPEED', clip_id: second.id, speed: 2 },
    ],
    needs_confirm: false,
    question: null,
  };
  await send(page, '1이랑 3 바꾸고 2는 2배속');
  await expect(page.getByText('편집 2건을 적용했어요.')).toBeVisible();
  await expect.poll(() => cardTitles(page)).not.toEqual(before);
  await expect(page.getByTestId('playback-rate-indicator')).toHaveCount(1);
  expect(bodies[1].thread_id).toBe(bodies[0].thread_id);

  await page.waitForTimeout(800);
  await page.getByTestId('undo-button').click();
  await expect.poll(() => cardTitles(page)).toEqual(before);
  await expect(page.getByTestId('playback-rate-indicator')).toHaveCount(0);

  // 삭제는 승인 버튼을 거친다
  reply = { reply: '클립 3을(를) 삭제할까요?', commands: [], needs_confirm: true, question: '클립 3을(를) 삭제할까요?' };
  await send(page, '마지막 삭제해줘');
  await expect(page.getByTestId('chat-confirm-yes')).toBeVisible();
  await expect(page.getByTestId('result-card')).toHaveCount(3);

  reply = { reply: '삭제했어요.', commands: [{ type: 'DELETE', clip_id: third.id }], needs_confirm: false, question: null };
  await page.getByTestId('chat-confirm-yes').click();
  await expect(page.getByTestId('result-card')).toHaveCount(2);
  expect(bodies[bodies.length - 1].confirm).toBe(true);
  await expect(page.getByTestId('chat-confirm-yes')).toHaveCount(0);
});

test('chat edit trims a clip range from agent commands', async ({ page }) => {
  await runAnalysisFlow(page);

  let clipId = 0;
  let start = 0;
  await page.route('**/chat/edit', async (route) => {
    const body = route.request().postDataJSON() as ChatBody;
    clipId = body.clips[1].id;
    start = body.clips[1].start;
    await route.fulfill({
      body: JSON.stringify({ reply: '편집 1건을 적용했어요.', commands: [{ type: 'SET_RANGE', clip_id: clipId, start, end: start + 5 }], needs_confirm: false, question: null }),
      contentType: 'application/json',
      status: 200,
    });
  });

  await send(page, '클립 2 5초만 남겨줘');
  await expect(page.getByText('편집 1건을 적용했어요.')).toBeVisible();
  const end = await page.getByTestId('result-end-time').nth(1).textContent();
  const begin = await page.getByTestId('result-start-time').nth(1).textContent();
  const toSeconds = (text: string | null) => (text ?? '0:0').split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
  expect(toSeconds(end) - toSeconds(begin)).toBeCloseTo(5, 0);
});
