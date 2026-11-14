export type Density = 'compact' | 'comfortable' | 'spacious';

export interface ThemeTweaks {
  accent: string;
  darkSidebar: boolean;
  density: Density;
}

export interface ScenarioItem {
  id: number;
  ko: string;
  en: string;
}

export interface HighlightSegment {
  score?: number;
  scenario: string;
  start: number;
  end: number;
  title?: string;
}

export interface EditorHighlightSegment extends HighlightSegment {
  id: number;
  sourceId: number;
}

export interface SegmentEditSetting {
  segmentId: number;
  speed: number;
  muted: boolean;
}

export interface EditChatMessage {
  id: number;
  role: 'user' | 'system';
  content: string;
  createdAt: string;
}

export interface HighlightAnalysisData {
  segments: EditorHighlightSegment[];
  duration: number;
  barCount: number;
  amplitudes: number[];
}

export interface HighlightAnalysisResult extends HighlightAnalysisData {
  projectName?: string;
  videoPath?: string;
  videoUrl?: string;
  videoName?: string;
}

export interface PendingHighlightAnalysis {
  file: File;
  projectName: string;
  scenarios: ScenarioItem[];
  videoPath: string;
  videoUrl: string;
  videoName: string;
}

export interface Segment {
  id: number;
  label: string;
  time: string;
}

export interface OverlaySegment {
  left: number;
  width: number;
  label: string;
  sub: string;
  bg: string;
  border: string;
  text: string;
}

export type ExportState = 'idle' | 'loading' | 'done';

export type BadgeStyle = 'outline' | 'solid';

export type ChatMessage =
  | {
      role: 'user';
      text: string;
    }
  | {
      role: 'bot';
      result: {
        title: string;
        bullets: string[];
        note?: string;
        badge: {
          label: string;
          style: BadgeStyle;
        };
      };
    };

/** 이 자막만 기본 스타일 대신 쓰는 값 */
export interface SubtitleCueStyle {
  font?: string;
  size?: number;
  color?: string;
  box?: boolean;
}

export interface SubtitleCue {
  id: number;
  start: number;
  end: number;
  text: string;
  original?: string;
  /** 아래 줄에 덧붙이는 다른 언어 자막(번역). 언어는 자막 스타일의 extraLang */
  extra?: string;
  /** 자막 가운데의 가로 위치(영상 가로 대비 %). 없으면 가운데 */
  x?: number;
  /** 영상 아래쪽에서 자막까지의 거리(세로 대비 %). 없으면 스타일의 기본 위치 */
  y?: number;
  /** 이 자막만의 폰트·크기·색·박스 */
  style?: SubtitleCueStyle;
}
