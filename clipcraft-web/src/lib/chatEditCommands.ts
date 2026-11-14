import type { ChatEditCommand } from '@/api/chatEdit';
import type { EditorHighlightSegment, SegmentEditSetting, SubtitleCue } from '@/types/app';

export interface ChatEditState {
  deletedSegmentIds: number[];
  segmentEditSettings: SegmentEditSetting[];
  segments: EditorHighlightSegment[];
  /** 지금 보이는(편집 대상인) 자막 묶음 */
  subtitles: SubtitleCue[];
  /** 자막 크기를 비율로 바꿀 때 기준이 되는 기본 크기(영상 세로 대비 %) */
  baseSubtitleSize: number;
  /** 자막 기본 위치(영상 아래쪽에서의 거리 %) */
  baseSubtitlePosition: number;
}

export interface ChatEditResult extends ChatEditState {
  /** 자막이 없어서 건너뛴 자막 명령 수 */
  skippedSubtitleCommands: number;
}

/** 자막 위치(영상 아래쪽에서의 거리 %, 가로 가운데 %). */
const VERTICAL_POSITION = { top: 88, middle: 50 } as const;
const HORIZONTAL_POSITION = { left: 30, center: 50, right: 70 } as const;
const MIN_CUE_SIZE = 1;
const MAX_CUE_SIZE = 12;

/** 클립 구간 안에 가운데가 들어오는 자막 */
function cuesInSegment(cues: SubtitleCue[], segment: EditorHighlightSegment): SubtitleCue[] {
  return cues.filter((cue) => {
    const middle = (cue.start + cue.end) / 2;
    return middle >= segment.start && middle <= segment.end;
  });
}

function upsertSetting(settings: SegmentEditSetting[], segmentId: number, patch: Partial<SegmentEditSetting>): SegmentEditSetting[] {
  const index = settings.findIndex((setting) => setting.segmentId === segmentId);
  if (index < 0) return [...settings, { segmentId, speed: 1, muted: false, ...patch }];
  return settings.map((setting, i) => (i === index ? { ...setting, ...patch } : setting));
}

/**
 * Agent가 보낸 명령을 현재 편집 상태에 순서대로 적용한 새 상태를 돌려준다.
 * 한 번에 새 상태를 만들어 반영하므로 말 한 번이 되돌리기 한 번이 된다. 없는 클립을 가리키는 명령은 건너뛴다.
 */
export function applyChatEditCommands(state: ChatEditState, commands: ChatEditCommand[]): ChatEditResult {
  let { deletedSegmentIds, segmentEditSettings, segments, subtitles } = state;
  let skippedSubtitleCommands = 0;
  const patchCues = (ids: Set<number>, patch: (cue: SubtitleCue) => SubtitleCue) => {
    subtitles = subtitles.map((cue) => (ids.has(cue.id) ? patch(cue) : cue));
  };

  for (const command of commands) {
    const index = segments.findIndex((segment) => segment.id === command.clip_id);
    if (index < 0) continue;

    switch (command.type) {
      case 'SET_RANGE':
        segments = segments.map((segment, i) => (i === index ? { ...segment, start: command.start, end: command.end } : segment));
        break;
      case 'SET_SPEED':
        segmentEditSettings = upsertSetting(segmentEditSettings, command.clip_id, { speed: command.speed });
        break;
      case 'SET_MUTED':
        segmentEditSettings = upsertSetting(segmentEditSettings, command.clip_id, { muted: command.muted });
        break;
      case 'MOVE': {
        const next = [...segments];
        const [moved] = next.splice(index, 1);
        next.splice(Math.min(Math.max(command.to_index, 0), next.length), 0, moved);
        segments = next;
        break;
      }
      case 'SWAP': {
        const other = segments.findIndex((segment) => segment.id === command.with_clip_id);
        if (other < 0) break;
        const next = [...segments];
        [next[index], next[other]] = [next[other], next[index]];
        segments = next;
        break;
      }
      case 'DELETE':
        segments = segments.filter((segment) => segment.id !== command.clip_id);
        segmentEditSettings = segmentEditSettings.filter((setting) => setting.segmentId !== command.clip_id);
        deletedSegmentIds = Array.from(new Set([...deletedSegmentIds, command.clip_id]));
        break;
      case 'ADD_SUBTITLE':
      case 'SET_SUBTITLE_TEXT': {
        const segment = segments[index];
        const existing = command.type === 'SET_SUBTITLE_TEXT' ? cuesInSegment(subtitles, segment) : [];
        if (existing.length > 0) {
          patchCues(new Set(existing.map((cue) => cue.id)), (cue) => {
            // 번역·원문은 옛 문구 기준이므로 새 문구로 바꿀 때 함께 지운다
            const { extra: _extra, original: _original, ...rest } = cue;
            return { ...rest, text: command.text };
          });
        } else {
          const id = subtitles.reduce((max, cue) => Math.max(max, cue.id), 0) + 1;
          subtitles = [...subtitles, { id, start: segment.start, end: segment.end, text: command.text }].sort((a, b) => a.start - b.start);
        }
        break;
      }
      case 'DELETE_SUBTITLE': {
        const ids = new Set(cuesInSegment(subtitles, segments[index]).map((cue) => cue.id));
        if (ids.size === 0) skippedSubtitleCommands += 1;
        subtitles = subtitles.filter((cue) => !ids.has(cue.id));
        break;
      }
      case 'MOVE_SUBTITLE': {
        const ids = new Set(cuesInSegment(subtitles, segments[index]).map((cue) => cue.id));
        if (ids.size === 0) {
          skippedSubtitleCommands += 1;
          break;
        }
        const y = command.vertical === 'bottom' ? state.baseSubtitlePosition : command.vertical ? VERTICAL_POSITION[command.vertical] : undefined;
        const x = command.horizontal ? HORIZONTAL_POSITION[command.horizontal] : undefined;
        patchCues(ids, (cue) => ({ ...cue, ...(y !== undefined ? { y } : {}), ...(x !== undefined ? { x } : {}) }));
        break;
      }
      case 'STYLE_SUBTITLE': {
        const ids = new Set(cuesInSegment(subtitles, segments[index]).map((cue) => cue.id));
        if (ids.size === 0) {
          skippedSubtitleCommands += 1;
          break;
        }
        patchCues(ids, (cue) => {
          const size = command.size_factor !== undefined ? Math.min(MAX_CUE_SIZE, Math.max(MIN_CUE_SIZE, Math.round((cue.style?.size ?? state.baseSubtitleSize) * command.size_factor * 10) / 10)) : undefined;
          return {
            ...cue,
            style: {
              ...cue.style,
              ...(size !== undefined ? { size } : {}),
              ...(command.color !== undefined ? { color: command.color } : {}),
              ...(command.box !== undefined ? { box: command.box } : {}),
              ...(command.font !== undefined ? { font: command.font } : {}),
            },
          };
        });
        break;
      }
    }
  }

  return { ...state, deletedSegmentIds, segmentEditSettings, segments, subtitles, skippedSubtitleCommands };
}
