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
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = { font: 'nanum-gothic', size: 3.5, position: 8, color: '#FFFFFF', box: false, bilingual: false };

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

export const SUBTITLE_COLORS = ['#FFFFFF', '#FFE600', '#7CFFB2', '#6EC8FF', '#FF9AD5', '#000000'] as const;

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

export interface CueLines {
  /** 원문(두 언어 표시일 때만) */
  top?: string;
  main: string;
}

/** 번역된 자막이면 원문을 위에, 번역문을 아래에 둔다. */
export function getCueLines(cue: SubtitleCue, bilingual: boolean): CueLines {
  return bilingual && cue.original ? { top: cue.original, main: cue.text } : { main: cue.text };
}

export function loadSubtitles(videoPath: string | undefined): SubtitleCue[] {
  if (!videoPath || typeof window === 'undefined') return [];

  try {
    const parsed = JSON.parse(window.localStorage.getItem(SUBTITLES_KEY_PREFIX + videoPath) ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveSubtitles(videoPath: string | undefined, cues: SubtitleCue[]): void {
  if (!videoPath) return;

  try {
    window.localStorage.setItem(SUBTITLES_KEY_PREFIX + videoPath, JSON.stringify(cues));
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
  x?: number;
  y?: number;
}

/** 편집된 타임라인(선택한 구간 순서, 배속 반영) 기준으로 자막 시간을 다시 계산한다. */
export function mapCuesToTimeline(cues: SubtitleCue[], segments: EditorHighlightSegment[], editSettings: SegmentEditSetting[], bilingual = false): TimelineCue[] {
  const speedBySegmentId = new Map(editSettings.map((setting) => [setting.segmentId, setting.speed]));
  const entries: TimelineCue[] = [];
  let offset = 0;

  for (const segment of segments) {
    const speed = speedBySegmentId.get(segment.id) || 1;

    for (const cue of cues) {
      const clipStart = Math.max(cue.start, segment.start);
      const clipEnd = Math.min(cue.end, segment.end);
      if (clipEnd - clipStart < 0.1) continue;

      const { top, main } = getCueLines(cue, bilingual);
      if (!main.trim() && !top?.trim()) continue;

      entries.push({
        start: offset + (clipStart - segment.start) / speed,
        end: offset + (clipEnd - segment.start) / speed,
        text: main.trim(),
        ...(top ? { top: top.trim() } : {}),
        ...(cue.x !== undefined ? { x: cue.x } : {}),
        ...(cue.y !== undefined ? { y: cue.y } : {}),
      });
    }

    offset += (segment.end - segment.start) / speed;
  }

  return entries;
}

export function buildSrt(cues: SubtitleCue[], segments: EditorHighlightSegment[], editSettings: SegmentEditSetting[], bilingual = false): string {
  return mapCuesToTimeline(cues, segments, editSettings, bilingual)
    .map((entry, index) => {
      const text = entry.top ? `${entry.top}\n${entry.text}` : entry.text;
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
