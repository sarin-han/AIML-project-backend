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
  /** AI가 추천한 항목이면 true. 사용자가 직접 쓰거나 고치면 false/undefined가 된다. */
  rec?: boolean;
  /**
   * 추천받을 때 함께 받은 구간(초). 있으면 분석할 때 이 장면을 다시 검색하지 않고 이 시간을 그대로 쓴다.
   * 사용자가 문구를 고치면 장면이 달라진 것이므로 지운다.
   */
  start?: number;
  end?: number;
}

/** 업로드 화면에서 고르는 "찾는 방법" */
export type FindMethod = 'manual' | 'recommend' | 'highlight';

/** 분석 모드: scenario는 입력한 장면을 찾고, highlight는 시나리오 없이 영상 전체를 분석하고, recommend는 AI가 시나리오(장면 구성)를 추천한다. */
export type AnalysisMode = 'scenario' | 'highlight' | 'recommend';

/** 하이라이트 후보 구간 (초 단위) */
export interface HighlightCandidate {
  id: number;
  start: number;
  end: number;
  label: string;
  /** 서버가 주는 썸네일 URL. 없으면 화면에서 영상 프레임을 직접 캡처한다. */
  thumbnail?: string;
}

/** 하이라이트 추출 결과 */
export interface HighlightExtractionResult {
  duration: number;
  highlights: HighlightCandidate[];
  barCount: number;
  amplitudes: number[];
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
  /** 분석을 돌린 서버 작업 ID. 편집 화면 주소(/editor/:jobId)에 쓴다. */
  jobId?: string;
  /** 이 편집이 속한 서버 프로젝트 ID. 있으면 편집 내용을 서버에 저장한다. */
  projectId?: string;
  projectName?: string;
  videoPath?: string;
  videoUrl?: string;
  videoName?: string;
}

export interface PendingHighlightAnalysis {
  file: File;
  projectName: string;
  /** 업로드한 영상을 붙일 서버 프로젝트 ID */
  projectId?: string;
  /** 기본값은 'scenario'. 'highlight'이면 scenarios는 비어 있다. */
  mode?: AnalysisMode;
  /** "다시 추출"처럼 같은 요청을 새 작업으로 다시 돌릴 때 올린다. */
  attempt?: number;
  /** 올린 영상의 전체 길이(초). 분석 중 화면의 스캔 줄에 쓴다. */
  videoDuration?: number;
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
  id: number;
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
