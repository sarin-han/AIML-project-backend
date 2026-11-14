import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { IconName } from '@/components/icons';
import type { ChatMessage as AppChatMessage, EditorHighlightSegment, HighlightAnalysisData, SegmentEditSetting, SubtitleCue } from '@/types/app';

export interface EditorScreenProps {
  onBack: () => void;
  analysis?: HighlightAnalysisData;
  projectName?: string;
  videoPath?: string;
  videoUrl?: string;
  videoName?: string;
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
  onCueDrop: (cueId: number, time: number) => void;
  onCueMove: (cueId: number, start: number) => void;
  onCueSelect: (cueId: number) => void;
  selectedCueId: number | null;
  onCueTimeChange: (cueId: number, edge: 'start' | 'end', time: number) => void;
  onSegmentChange: (segmentId: number, edge: 'start' | 'end', time: number) => void;
  progress: number;
  segments: EditorHighlightSegment[];
  setPlaying: Dispatch<SetStateAction<boolean>>;
  setProgress: Dispatch<SetStateAction<number>>;
  subtitleCues: SubtitleCue[];
  waveHeights: number[];
}

export interface HighlightListProps {
  activeSegment: number | null;
  onSegmentClick: (index: number) => void;
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
