import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { EditorSavedState } from '@/api/projects';
import type { IconName } from '@/components/icons';
import type { ChatMessage as AppChatMessage, EditorHighlightSegment, HighlightAnalysisData, SegmentEditSetting, SubtitleCue } from '@/types/app';

export interface EditorScreenProps {
  onBack: () => void;
  analysis?: HighlightAnalysisData;
  projectName?: string;
  videoPath?: string;
  videoUrl?: string;
  videoName?: string;
  /** 서버에 저장되는 프로젝트의 ID. 있으면 편집 내용을 자동 저장한다. */
  projectId?: string;
  jobId?: string;
  /** 프로젝트를 다시 열 때 서버에서 불러온 편집 내용 */
  initialEditor?: EditorSavedState;
}

export interface PlayerControlsProps {
  accent: string;
  dragging: boolean;
  duration: number;
  muted: boolean;
  onSeekForward: () => void;
  onToggleMute: () => void;
  playing: boolean;
  progress: number;
  scrubberRef: RefObject<HTMLDivElement | null>;
  setDragging: Dispatch<SetStateAction<boolean>>;
  setPlaying: Dispatch<SetStateAction<boolean>>;
  setProgress: Dispatch<SetStateAction<number>>;
}

export interface WaveformTimelineProps {
  accent: string;
  activeCueId?: number;
  duration: number;
  onCueAdd: (time: number) => void;
  onCueMove: (cueId: number, start: number) => void;
  onCueSelect: (cueId: number) => void;
  selectedCueId: number | null;
  onCueTimeChange: (cueId: number, edge: 'start' | 'end', time: number) => void;
  onSegmentChange: (segmentId: number, edge: 'start' | 'end', time: number) => void;
  /** 타임라인의 번호 핀을 눌렀을 때(목록 순서 기준 index) */
  onSegmentPick: (index: number) => void;
  activeSegmentId: number | null;
  /** 자막 트랙 접기/펴기 */
  subtitleTrackOpen: boolean;
  onSubtitleTrackToggle: () => void;
  progress: number;
  segments: EditorHighlightSegment[];
  setPlaying: Dispatch<SetStateAction<boolean>>;
  setProgress: Dispatch<SetStateAction<number>>;
  subtitleCues: SubtitleCue[];
  waveHeights: number[];
}

export interface HighlightListProps {
  activeSegment: number | null;
  /** 지금 재생 위치(초). 이 시간이 속한 구간도 선택처럼 강조한다. */
  currentTime: number;
  onSegmentClick: (index: number) => void;
  onSegmentDelete: (segmentId: number) => void;
  onSegmentsReorder: (fromIndex: number, toIndex: number) => void;
  segmentEditSettings: SegmentEditSetting[];
  segments: EditorHighlightSegment[];
  thumbnails: Record<number, string>;
}

export interface AccentProps {
  accent: string;
}

export interface ChatMessageProps extends AccentProps {
  message: AppChatMessage;
}

export interface NaturalLanguageCommandResult {
  message: string;
  status: 'success' | 'error';
  /** 삭제처럼 승인이 필요한 요청이면 true. 채팅창이 승인/거절 버튼을 보여준다. */
  needsConfirm?: boolean;
}

export interface AiAssistantProps extends AccentProps {
  onApplyCommand: (command: string, confirm?: boolean) => NaturalLanguageCommandResult | Promise<NaturalLanguageCommandResult>;
  onReset?: () => void;
  onClose?: () => void;
}

export interface RoundIconButtonProps {
  active?: boolean;
  ariaLabel?: string;
  icon: IconName;
  onClick?: () => void;
  size?: number;
}

export type EditorChatMessage = AppChatMessage;
