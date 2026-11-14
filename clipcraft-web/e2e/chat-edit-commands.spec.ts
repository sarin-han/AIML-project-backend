import { expect, test } from '@playwright/test';
import { applyChatEditCommands } from '../src/lib/chatEditCommands';
import type { ChatEditState } from '../src/lib/chatEditCommands';

const segment = (id: number, start: number, end: number) => ({ id, sourceId: id, scenario: `장면 ${id}`, start, end });

const base = (): ChatEditState => ({
  deletedSegmentIds: [],
  segmentEditSettings: [],
  segments: [segment(1, 10, 40), segment(2, 50, 80), segment(3, 90, 120)],
  subtitles: [],
  baseSubtitleSize: 3.5,
  baseSubtitlePosition: 8,
});

test('subtitle commands add, restyle, move and remove captions on a clip', () => {
  let state = applyChatEditCommands(base(), [{ type: 'ADD_SUBTITLE', clip_id: 2, text: '진짜 맛있겠다' }]);
  expect(state.subtitles).toEqual([{ id: 1, start: 50, end: 80, text: '진짜 맛있겠다' }]);

  state = applyChatEditCommands(state, [
    { type: 'MOVE_SUBTITLE', clip_id: 2, vertical: 'top', horizontal: 'left' },
    { type: 'STYLE_SUBTITLE', clip_id: 2, size_factor: 2, color: '#FFD400', box: true },
  ]);
  expect(state.subtitles[0]).toMatchObject({ x: 30, y: 88, style: { size: 7, color: '#FFD400', box: true } });

  state = applyChatEditCommands(state, [{ type: 'MOVE_SUBTITLE', clip_id: 2, vertical: 'bottom' }]);
  expect(state.subtitles[0].y).toBe(8);

  state = applyChatEditCommands(state, [{ type: 'SET_SUBTITLE_TEXT', clip_id: 2, text: '바꾼 문구' }]);
  expect(state.subtitles).toHaveLength(1);
  expect(state.subtitles[0].text).toBe('바꾼 문구');

  state = applyChatEditCommands(state, [{ type: 'DELETE_SUBTITLE', clip_id: 2 }]);
  expect(state.subtitles).toHaveLength(0);
});

test('caption commands on a clip without captions are skipped and counted', () => {
  const state = applyChatEditCommands(base(), [
    { type: 'MOVE_SUBTITLE', clip_id: 1, vertical: 'top' },
    { type: 'STYLE_SUBTITLE', clip_id: 3, size_factor: 1.3 },
    { type: 'MOVE_SUBTITLE', clip_id: 99, vertical: 'top' }, // 없는 클립은 건너뛰되 센 수에는 넣지 않는다
  ]);
  expect(state.skippedSubtitleCommands).toBe(2);
  expect(state.subtitles).toEqual([]);
});

test('swap, trim and delete apply in order against the same ids', () => {
  const state = applyChatEditCommands(base(), [
    { type: 'SWAP', clip_id: 1, with_clip_id: 3 },
    { type: 'SET_RANGE', clip_id: 2, start: 50, end: 70 },
    { type: 'DELETE', clip_id: 1 },
  ]);
  expect(state.segments.map((item) => item.id)).toEqual([3, 2]);
  expect(state.segments[1]).toMatchObject({ start: 50, end: 70 });
  expect(state.deletedSegmentIds).toEqual([1]);
});
