import { expect, test } from '@playwright/test';
import { createSilenceDetector, MAX_RECORDING_MS, NO_SPEECH_TIMEOUT_MS, SILENCE_STOP_MS } from '../src/lib/voiceRecorder';

/** 60ms 간격으로 level을 넣고, 처음으로 멈추라고 한 시각(ms)을 돌려준다. */
function run(levels: (elapsedMs: number) => number, untilMs = 40000) {
  const detector = createSilenceDetector();
  for (let t = 0; t <= untilMs; t += 60) {
    const state = detector.feed(levels(t), t);
    if (state !== 'speech' && state !== 'quiet') return { at: t, state };
  }
  return { at: null, state: 'running' as const };
}

test('stops shortly after speech ends', () => {
  // 0.5~2.0초 동안 말하고 그 뒤로 조용
  const result = run((t) => (t >= 500 && t < 2000 ? 0.15 : 0.003));
  expect(result.state).toBe('silence');
  expect(result.at).toBeGreaterThanOrEqual(2000 + SILENCE_STOP_MS - 60);
  expect(result.at).toBeLessThan(2000 + SILENCE_STOP_MS + 200);
});

test('a short pause inside a sentence does not stop the recording', () => {
  // 말하다가 0.8초 쉬고 다시 말하면 끝나지 않는다
  const result = run((t) => (t >= 500 && t < 1500) || (t >= 2300 && t < 3500) ? 0.15 : 0.003, 4500);
  expect(result.state === 'running' || result.at! > 3500).toBe(true);
});

test('gives up when nobody speaks', () => {
  const result = run(() => 0.003);
  expect(result.state).toBe('no-speech');
  expect(result.at).toBeGreaterThanOrEqual(NO_SPEECH_TIMEOUT_MS);
});

test('adapts to a noisy room and still detects the end of speech', () => {
  // 주변 소음이 0.03이어도 그 위로 말하면 말로 듣고, 소음만 남으면 끝낸다
  const result = run((t) => (t >= 800 && t < 2500 ? 0.2 : 0.03));
  expect(result.state).toBe('silence');
});

test('stops at the maximum length even if the speaker never pauses', () => {
  const result = run((t) => (t >= 500 ? 0.2 : 0.003));
  expect(result.state).toBe('max-length');
  expect(result.at).toBeGreaterThanOrEqual(MAX_RECORDING_MS);
});
