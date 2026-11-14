import type { EditorHighlightSegment, SegmentEditSetting, SubtitleCue } from '@/types/app';

const SUBTITLES_KEY_PREFIX = 'editor-subtitles:';
const SUBTITLE_STYLE_KEY = 'editor-subtitle-style';

export interface SubtitleStyle {
  font: string;
  /** 영상 세로 길이 대비 글자 크기(%) */
  size: number;
  /** 영상 아래쪽에서 자막까지의 거리(세로 길이 대비 %) */
  position: number;
  color: string;
  box: boolean;
  /** 원문과 번역을 두 줄로 함께 표시 */
  bilingual: boolean;
  /** 다른 언어 자막을 아래 줄에 표시 */
  showExtra: boolean;
  /** 아래 줄 자막의 언어 코드 */
  extraLang: string;
  /** 화면에서 자막을 끌 때 격자(가운데·1/4 지점·여백)에 맞춘다 */
  snap: boolean;
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = { font: 'nanum-gothic', size: 3.5, position: 8, color: '#FFFFFF', box: false, bilingual: false, snap: true, showExtra: false, extraLang: 'en' };

/** id는 GPU 서버(SUBTITLE_FONTS)와 같아야 한다. css는 미리보기용 웹폰트 이름. */
export const SUBTITLE_FONT_OPTIONS = [
  { id: 'nanum-gothic', label: '나눔고딕', css: "'Nanum Gothic'", weight: 700 },
  { id: 'nanum-gothic-xbold', label: '나눔고딕 굵게', css: "'Nanum Gothic'", weight: 800 },
  { id: 'gothic-a1', label: '고딕 A1', css: "'Gothic A1'", weight: 700 },
  { id: 'gothic-a1-black', label: '고딕 A1 블랙', css: "'Gothic A1'", weight: 900 },
  { id: 'plex-kr', label: 'IBM Plex 한글', css: "'IBM Plex Sans KR'", weight: 700 },
  { id: 'nanum-myeongjo', label: '나눔명조', css: "'Nanum Myeongjo'", weight: 700 },
  { id: 'black-han-sans', label: '블랙한산스', css: "'Black Han Sans'", weight: 400 },
  { id: 'do-hyeon', label: '도현', css: "'Do Hyeon'", weight: 400 },
  { id: 'jua', label: '주아', css: "'Jua'", weight: 400 },
  { id: 'gowun-dodum', label: '고운돋움', css: "'Gowun Dodum'", weight: 400 },
  { id: 'nanum-pen', label: '나눔손글씨 펜', css: "'Nanum Pen Script'", weight: 400 },
] as const;

/** 흰색에서 검정까지 회색 그라데이션. 다른 색은 "직접 고르기"로 고른다. */
/** 아래 줄에 추가할 수 있는 언어. 코드는 백엔드 번역 API·GPU 서버 폰트 선택과 같다. */
export const EXTRA_LANGUAGES = [
  { code: 'en', label: '영어' },
  { code: 'ja', label: '일본어' },
  { code: 'zh', label: '중국어(간체)' },
  { code: 'es', label: '스페인어' },
  { code: 'fr', label: '프랑스어' },
  { code: 'de', label: '독일어' },
  { code: 'vi', label: '베트남어' },
  { code: 'th', label: '태국어' },
  { code: 'ko', label: '한국어' },
] as const;

export const SUBTITLE_COLORS = ['#FFFFFF', '#E6E6E6', '#CCCCCC', '#999999', '#666666', '#333333', '#000000'] as const;

export function loadSubtitleStyle(): SubtitleStyle {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SUBTITLE_STYLE_KEY) ?? 'null');
    return { ...DEFAULT_SUBTITLE_STYLE, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    return DEFAULT_SUBTITLE_STYLE;
  }
}

export function saveSubtitleStyle(style: SubtitleStyle): void {
  try {
    window.localStorage.setItem(SUBTITLE_STYLE_KEY, JSON.stringify(style));
  } catch {
    // localStorage may be unavailable in restricted browser contexts.
  }
}

/** 자막에 개별 스타일이 있으면 기본 스타일 위에 덮어쓴다. */
export function resolveCueStyle(cue: SubtitleCue | undefined, base: SubtitleStyle): SubtitleStyle {
  return cue?.style ? { ...base, ...cue.style } : base;
}

/** 이 자막이 선택한 장면(하이라이트 구간) 안에 걸쳐 있어서 내보내기에 쓰이는지 */
export function cueUsedBySegments(cue: SubtitleCue, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => Math.min(cue.end, range.end) - Math.max(cue.start, range.start) >= 0.1);
}

export interface CueLines {
  /** 원문(두 언어 표시일 때만) */
  top?: string;
  main: string;
  /** 아래 줄에 덧붙이는 다른 언어 자막 */
  bottom?: string;
}

/** 번역된 자막이면 원문을 위에, 번역문을 아래에 둔다. */
export function getCueLines(cue: SubtitleCue, bilingual: boolean, showExtra = false): CueLines {
  const lines: CueLines = bilingual && cue.original ? { top: cue.original, main: cue.text } : { main: cue.text };
  return showExtra && cue.extra?.trim() ? { ...lines, bottom: cue.extra.trim() } : lines;
}

export type SubtitleSetKey = 'voice' | 'scenario';

/** 영상 음성으로 만든 자막과 시나리오로 만든 자막을 따로 보관하고, active인 쪽을 보여준다. */
export interface SubtitleSets {
  voice: SubtitleCue[];
  scenario: SubtitleCue[];
  active: SubtitleSetKey;
}

const EMPTY_SUBTITLE_SETS: SubtitleSets = { voice: [], scenario: [], active: 'voice' };

export function loadSubtitleSets(videoPath: string | undefined): SubtitleSets {
  if (!videoPath || typeof window === 'undefined') return EMPTY_SUBTITLE_SETS;

  try {
    const parsed = JSON.parse(window.localStorage.getItem(SUBTITLES_KEY_PREFIX + videoPath) ?? 'null');

    // 이전 버전은 자막 배열 하나만 저장했다. 음성 자막으로 취급한다.
    if (Array.isArray(parsed)) return { ...EMPTY_SUBTITLE_SETS, voice: parsed };
    if (parsed && Array.isArray(parsed.voice) && Array.isArray(parsed.scenario)) {
      return { voice: parsed.voice, scenario: parsed.scenario, active: parsed.active === 'scenario' ? 'scenario' : 'voice' };
    }
  } catch {
    // 저장값이 깨졌으면 빈 상태로 시작한다.
  }

  return EMPTY_SUBTITLE_SETS;
}

export function saveSubtitleSets(videoPath: string | undefined, sets: SubtitleSets): void {
  if (!videoPath) return;

  try {
    window.localStorage.setItem(SUBTITLES_KEY_PREFIX + videoPath, JSON.stringify(sets));
  } catch {
    // localStorage may be unavailable in restricted browser contexts.
  }
}

/** 지금 재생 위치에 걸친 자막. 겹치면 선택한 자막을 우선한다. */
export function findActiveCue(cues: SubtitleCue[], time: number, preferredId?: number | null): SubtitleCue | undefined {
  const covering = cues.filter((cue) => time >= cue.start && time < cue.end);
  return covering.find((cue) => cue.id === preferredId) ?? covering[0];
}

export const SUBTITLE_POSITION_PRESETS = [
  { label: '상단', value: 82 },
  { label: '중앙', value: 45 },
  { label: '하단', value: 8 },
] as const;

export function formatCueTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${(safe % 60).toFixed(1).padStart(4, '0')}`;
}

function formatSrtTime(seconds: number): string {
  const totalMs = Math.round(Math.max(0, seconds) * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');

  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(ms, 3)}`;
}

export interface TimelineCue {
  start: number;
  end: number;
  text: string;
  top?: string;
  bottom?: string;
  x?: number;
  y?: number;
  font?: string;
  size?: number;
  color?: string;
  box?: boolean;
}

/** 편집된 타임라인(선택한 구간 순서, 배속 반영) 기준으로 자막 시간을 다시 계산한다. */
export function mapCuesToTimeline(cues: SubtitleCue[], segments: EditorHighlightSegment[], editSettings: SegmentEditSetting[], bilingual = false, showExtra = false): TimelineCue[] {
  const speedBySegmentId = new Map(editSettings.map((setting) => [setting.segmentId, setting.speed]));
  const entries: TimelineCue[] = [];
  let offset = 0;

  for (const segment of segments) {
    const speed = speedBySegmentId.get(segment.id) || 1;

    for (const cue of cues) {
      const clipStart = Math.max(cue.start, segment.start);
      const clipEnd = Math.min(cue.end, segment.end);
      if (clipEnd - clipStart < 0.1) continue;

      const { top, main, bottom } = getCueLines(cue, bilingual, showExtra);
      if (!main.trim() && !top?.trim() && !bottom) continue;

      entries.push({
        start: offset + (clipStart - segment.start) / speed,
        end: offset + (clipEnd - segment.start) / speed,
        text: main.trim(),
        ...(top ? { top: top.trim() } : {}),
        ...(bottom ? { bottom } : {}),
        ...(cue.x !== undefined ? { x: cue.x } : {}),
        ...(cue.y !== undefined ? { y: cue.y } : {}),
        ...(cue.style ?? {}),
      });
    }

    offset += (segment.end - segment.start) / speed;
  }

  return entries;
}

export function buildSrt(cues: SubtitleCue[], segments: EditorHighlightSegment[], editSettings: SegmentEditSetting[], bilingual = false, showExtra = false): string {
  return mapCuesToTimeline(cues, segments, editSettings, bilingual, showExtra)
    .map((entry, index) => {
      const text = [entry.top, entry.text, entry.bottom].filter(Boolean).join('\n');
      return `${index + 1}\n${formatSrtTime(entry.start)} --> ${formatSrtTime(entry.end)}\n${text}\n`;
    })
    .join('\n');
}

export function downloadTextFile(content: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const CUE_DRAG_PREFIX = 'clipcraft-cue:';

/** 자막 목록 → 파형/영상 화면으로 끌어다 놓을 때 쓰는 드래그 데이터 */
export function setCueDragData(dataTransfer: DataTransfer, cueId: number): void {
  dataTransfer.effectAllowed = 'move';
  dataTransfer.setData('text/plain', `${CUE_DRAG_PREFIX}${cueId}`);
}

export function readCueDragData(dataTransfer: DataTransfer): number | null {
  const value = dataTransfer.getData('text/plain');
  if (!value.startsWith(CUE_DRAG_PREFIX)) return null;

  const cueId = Number(value.slice(CUE_DRAG_PREFIX.length));
  return Number.isFinite(cueId) ? cueId : null;
}
